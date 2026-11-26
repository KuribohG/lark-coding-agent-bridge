//! The mount: one directory per workspace, served to the kernel.
//!
//! The kernel is told to keep what it learns for a year, and is told again when a workspace's commit is
//! replaced. It is not asked to open files or directories: a read or a write names the node, so reading a
//! file the kernel has cached costs no request at all.

use crate::index::{FILE_NANOS, FILE_TIME};
use crate::store::{Kind, Store};
use crate::workspace::{join, orphan_beside, split, Found, Low, Orphan, Workspace, HASH_BITS, HIDDEN};
use fuser::{
    Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, InitFlags, KernelConfig,
    LockOwner, Notifier, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyDirectoryPlus,
    ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request, TimeOrNow, WriteFlags,
};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::ffi::{CString, OsStr};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long the kernel keeps an entry and its attributes without asking.
pub const KEEP: Duration = Duration::from_secs(365 * 24 * 3600);
/// The list of workspaces changes without the kernel taking part.
const BRIEF: Duration = Duration::from_secs(1);
/// Files of workspaces held open for reads and writes.
const OPEN_FILES: usize = 512;

type Res<T> = Result<T, Errno>;

fn stale() -> Errno {
    Errno::from_i32(libc::ESTALE)
}

/// The workspaces served, by slot and by name. A slot is never used twice, so a node number the kernel
/// still holds for a removed workspace finds nothing.
#[derive(Default)]
pub struct Table {
    pub by_slot: HashMap<u64, Arc<Workspace>>,
    pub by_name: BTreeMap<String, u64>,
    /// Names being created.
    pub pending: std::collections::HashSet<String>,
    pub slots: u64,
}

/// By node: the file, whether it can be written, and when it was last used.
type Open = HashMap<u64, (Arc<File>, bool, u64)>;

/// Files of workspaces kept open, by node. A file follows its node through a rename.
#[derive(Default)]
pub struct Files {
    open: Mutex<(Open, u64)>,
}

impl Files {
    fn get(&self, id: u64, write: bool, path: impl FnOnce() -> PathBuf) -> io::Result<Arc<File>> {
        {
            let mut open = self.open.lock().unwrap();
            open.1 += 1;
            let tick = open.1;
            if let Some((file, writable, used)) = open.0.get_mut(&id) {
                if *writable || !write {
                    *used = tick;
                    return Ok(file.clone());
                }
            }
        }
        let path = path();
        let (file, writable) = match OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(file) => (file, true),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied && !write => (
                OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&path)?,
                false,
            ),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                // A file opened for writing stays writable when its mode is changed after.
                let mode = fs::symlink_metadata(&path)?.permissions().mode();
                fs::set_permissions(&path, fs::Permissions::from_mode(mode | 0o200))?;
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&path);
                fs::set_permissions(&path, fs::Permissions::from_mode(mode))?;
                (file?, true)
            }
            Err(error) => return Err(error),
        };
        Ok(self.put(id, file, writable))
    }

    fn put(&self, id: u64, file: File, writable: bool) -> Arc<File> {
        let file = Arc::new(file);
        // What leaves the table is closed after the lock is given back: closing a written file can take
        // as long as writing it.
        let _closed = {
            let mut open = self.open.lock().unwrap();
            open.1 += 1;
            let tick = open.1;
            let replaced = open.0.insert(id, (file.clone(), writable, tick));
            let oldest = if open.0.len() > OPEN_FILES {
                open.0.iter().min_by_key(|(_, (_, _, used))| *used).map(|(&id, _)| id)
            } else {
                None
            };
            (replaced, oldest.and_then(|id| open.0.remove(&id)))
        };
        file
    }

    pub fn close(&self, id: u64) {
        let _closed = self.open.lock().unwrap().0.remove(&id);
    }

    pub fn close_slot(&self, slot: u64) {
        let _closed: Vec<_> = {
            let mut open = self.open.lock().unwrap();
            let ids: Vec<u64> = open.0.keys().copied().filter(|id| id >> HASH_BITS == slot).collect();
            ids.into_iter().filter_map(|id| open.0.remove(&id)).collect()
        };
    }

    pub fn len(&self) -> usize {
        self.open.lock().unwrap().0.len()
    }
}

/// The tree an index was made for, its content and its number of entries.
type Index = (gix::ObjectId, Arc<crate::index::Built>);

pub struct Shared {
    pub store: Store,
    /// Where the workspaces keep what differs.
    pub state: PathBuf,
    pub mount: PathBuf,
    pub uid: u32,
    pub gid: u32,
    pub threads: usize,
    pub table: RwLock<Table>,
    pub notifier: OnceLock<Notifier>,
    pub files: Files,
    pub paths: Arc<crate::workspace::Paths>,
    /// The index last written: its tree, content and number of entries. Workspaces made together stand on
    /// one commit, and the index of a commit is the same in each.
    pub index: Mutex<Option<Index>>,
    /// When the list of workspaces last changed, in seconds.
    pub listed: AtomicU64,
    /// Requests served, by `Count`.
    pub requests: [AtomicU64; 6],
}

#[derive(Clone, Copy)]
pub enum Count {
    Lookup,
    Attr,
    List,
    Read,
    Write,
    Change,
}

impl Shared {
    /// Writes the index of the tree `root` into the Git directory `git_dir`, with the files of `times` at
    /// the times the workspace reports for them. Answers the number of entries.
    pub fn write_index(&self, git_dir: &Path, root: &gix::ObjectId, times: &HashMap<u64, u64>) -> io::Result<u32> {
        let built = {
            let mut last = self.index.lock().unwrap();
            match &*last {
                Some((tree, built)) if tree == root => built.clone(),
                _ => {
                    let built = Arc::new(crate::index::build(
                        &self.store,
                        root,
                        &crate::workspace::natural,
                        self.uid,
                        self.gid,
                    )?);
                    *last = Some((*root, built.clone()));
                    built
                }
            }
        };
        if times.is_empty() {
            crate::workspace::write_whole(&git_dir.join("index"), &built.content)?;
        } else {
            crate::workspace::write_whole(&git_dir.join("index"), &built.at(times))?;
        }
        Ok(built.entries)
    }

    /// Gives back to the system the memory that making an index, or decoding many directories, took for a
    /// moment.
    pub fn trim(&self) {
        // SAFETY: the call takes no pointer and may be made at any time.
        #[cfg(target_env = "gnu")]
        unsafe {
            libc::malloc_trim(0);
        }
    }

    fn count(&self, what: Count) {
        self.requests[what as usize].fetch_add(1, Ordering::Relaxed);
    }
}

fn time(seconds: u64, nanos: u32) -> SystemTime {
    UNIX_EPOCH + Duration::new(seconds, nanos)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

fn kind_of(meta: &Metadata) -> FileType {
    FileType::from_std(meta.file_type()).unwrap_or(FileType::RegularFile)
}

fn timespec(time: SystemTime) -> libc::timespec {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    libc::timespec {
        tv_sec: since.as_secs() as libc::time_t,
        tv_nsec: since.subsec_nanos() as _,
    }
}

impl Shared {
    pub fn changed_list(&self) {
        self.listed.store(now(), Ordering::Relaxed);
        if let Some(notifier) = self.notifier.get() {
            let _ = notifier.inval_inode(INodeNo::ROOT, 0, 0);
        }
    }

    fn workspace(&self, id: u64) -> Res<Arc<Workspace>> {
        self.table
            .read()
            .unwrap()
            .by_slot
            .get(&(id >> HASH_BITS))
            .cloned()
            .ok_or_else(stale)
    }

    fn named(&self, name: &[u8]) -> Res<Arc<Workspace>> {
        let table = self.table.read().unwrap();
        let name = std::str::from_utf8(name).map_err(|_| Errno::ENOENT)?;
        table
            .by_name
            .get(name)
            .and_then(|slot| table.by_slot.get(slot))
            .cloned()
            .ok_or(Errno::ENOENT)
    }

    fn directory(&self, id: u64, modified: u64, perm: u16) -> FileAttr {
        let modified = time(modified, 0);
        FileAttr {
            ino: INodeNo(id),
            size: 0,
            blocks: 0,
            atime: modified,
            mtime: modified,
            ctime: modified,
            crtime: modified,
            kind: FileType::Directory,
            perm,
            nlink: 1,
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: 4096,
            flags: 0,
        }
    }

    fn mount_attr(&self) -> FileAttr {
        self.directory(1, self.listed.load(Ordering::Relaxed), 0o755)
    }

    /// The attributes of an entry of the commit: those the index records for it. `modified` is the time of
    /// a file, in nanoseconds.
    fn lower_attr(&self, id: u64, low: &Low, generation: u64, modified: u64) -> FileAttr {
        let (kind, perm) = match low.kind {
            Kind::File => (FileType::RegularFile, 0o644),
            Kind::Exec => (FileType::RegularFile, 0o755),
            Kind::Link => (FileType::Symlink, 0o777),
            // A directory's time moves when the commit is replaced, so the kernel lists it again.
            Kind::Dir | Kind::Module => return self.directory(id, FILE_TIME + generation, 0o755),
        };
        let modified = time(modified / 1_000_000_000, (modified % 1_000_000_000) as u32);
        FileAttr {
            size: low.size,
            blocks: low.size.div_ceil(512),
            kind,
            perm,
            atime: modified,
            mtime: modified,
            ctime: modified,
            crtime: modified,
            ..self.directory(id, FILE_TIME, 0)
        }
    }

    fn upper_attr(&self, id: u64, meta: &Metadata) -> FileAttr {
        let modified = time(meta.mtime().max(0) as u64, meta.mtime_nsec() as u32);
        FileAttr {
            ino: INodeNo(id),
            size: if meta.is_dir() { 0 } else { meta.size() },
            blocks: meta.blocks(),
            atime: modified,
            mtime: modified,
            // The real file's change time moves when the file is only moved, and Git would read it again.
            ctime: modified,
            crtime: modified,
            kind: kind_of(meta),
            perm: (meta.mode() & 0o7777) as u16,
            nlink: 1,
            uid: meta.uid(),
            gid: meta.gid(),
            rdev: meta.rdev() as u32,
            blksize: 4096,
            flags: 0,
        }
    }

    fn attr(&self, ws: &Workspace, path: &[u8], id: u64, found: &Found, generation: u64) -> Res<FileAttr> {
        Ok(match found {
            Found::GitFile => FileAttr {
                perm: 0o444,
                ..self.lower_attr(
                    id,
                    &Low {
                        kind: Kind::File,
                        oid: self.store.null(),
                        size: ws.gitfile.len() as u64,
                    },
                    0,
                    FILE_NANOS,
                )
            },
            Found::Lower(low) => self.lower_attr(id, low, generation, ws.modified(path)),
            Found::Upper { .. } => self.upper_attr(id, &fs::symlink_metadata(ws.real(path))?),
        })
    }

    fn find(&self, ws: &Workspace, path: &[u8]) -> Res<(Option<Found>, u64)> {
        let view = ws.view.read().unwrap();
        Ok((view.find(&self.store, path)?, view.generation))
    }

    fn stat(&self, ws: &Workspace, path: &[u8], id: u64) -> Res<FileAttr> {
        let (found, generation) = self.find(ws, path)?;
        self.attr(ws, path, id, &found.ok_or(Errno::ENOENT)?, generation)
    }

    /// The path of the node `id`, which must still follow one.
    fn path(&self, ws: &Workspace, id: u64) -> Res<Vec<u8>> {
        match ws.nodes.lock().unwrap().at(id) {
            Some((path, None)) => Ok(path),
            Some(_) => Err(Errno::ENOENT),
            None => Err(stale()),
        }
    }

    /// The path a new entry `name` gets in the directory `parent`, which must be one and not have it.
    fn vacant(&self, ws: &Workspace, parent: u64, name: &[u8]) -> Res<Vec<u8>> {
        if name.starts_with(HIDDEN) {
            return Err(Errno::EINVAL);
        }
        let dir = self.path(ws, parent)?;
        let path = join(&dir, name);
        let view = ws.view.read().unwrap();
        match view.find(&self.store, &dir)? {
            Some(found) if found.is_dir() => {}
            Some(_) => return Err(Errno::ENOTDIR),
            None => return Err(Errno::ENOENT),
        }
        if view.find(&self.store, &path)?.is_some() {
            return Err(Errno::EEXIST);
        }
        Ok(path)
    }

    /// Counts a reference for the new entry at `path` and answers its attributes.
    fn entered(&self, ws: &Workspace, path: &[u8]) -> Res<FileAttr> {
        let id = ws.nodes.lock().unwrap().enter(path);
        self.stat(ws, path, id).inspect_err(|_| {
            ws.nodes.lock().unwrap().forget(id, 1);
        })
    }

    /// The file behind the node `id`, to read or to write. A file of the commit becomes the workspace's own
    /// before it is written.
    fn file(&self, ws: &Workspace, id: u64, write: bool) -> Res<Data> {
        for _ in 0..4 {
            let (path, orphan) = ws.nodes.lock().unwrap().at(id).ok_or_else(stale)?;
            let opened = match orphan {
                Some(Orphan::Gone) => return Err(stale()),
                Some(Orphan::File(kept)) => self.files.get(id, write, || kept.to_path_buf()),
                Some(Orphan::Blob(low)) if write => {
                    // Written through a descriptor opened before the file was deleted.
                    ws.materialize(&self.store, &low, &ws.orphan_path(id), false, ws.modified(&path))?;
                    ws.nodes
                        .lock()
                        .unwrap()
                        .set_orphan(id, Orphan::File(Arc::new(ws.orphan_path(id))));
                    continue;
                }
                Some(Orphan::Blob(low)) => return Ok(Data::Blob(self.store.blob(&low.oid)?)),
                None => match self.find(ws, &path)?.0 {
                    None => return Err(Errno::ENOENT),
                    Some(Found::GitFile) if write => return Err(Errno::EACCES),
                    Some(Found::GitFile) => return Ok(Data::Blob(Arc::new(ws.gitfile.clone()))),
                    Some(found) if found.is_dir() => return Err(Errno::EISDIR),
                    Some(Found::Lower(low)) if write => {
                        ws.copy_up(&self.store, &path, &low, false)?;
                        self.files.close(id);
                        continue;
                    }
                    Some(Found::Lower(low)) => return Ok(Data::Blob(self.store.blob(&low.oid)?)),
                    Some(Found::Upper { .. }) => self.files.get(id, write, || ws.real(&path)),
                },
            };
            match opened {
                Ok(file) => return Ok(Data::File(file)),
                // The file was moved or deleted between finding it and opening it.
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(Errno::ENOENT)
    }
}

enum Data {
    Blob(Arc<Vec<u8>>),
    File(Arc<File>),
}

thread_local! {
    static BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

pub struct Mount(pub Arc<Shared>);

/// Takes the workspace of a node and its gate, or answers the error.
macro_rules! enter {
    ($shared:expr, $id:expr, $reply:expr) => {{
        let workspace = match $shared.workspace($id) {
            Ok(workspace) => workspace,
            Err(error) => return $reply.error(error),
        };
        workspace
    }};
}

macro_rules! answer {
    ($result:expr, $reply:expr, $ok:expr) => {
        match $result {
            Ok(value) => $ok(value),
            Err(error) => $reply.error(error),
        }
    };
}

impl Mount {
    fn lookup_in(&self, parent: u64, name: &[u8]) -> Res<FileAttr> {
        let shared = &self.0;
        if parent == 1 {
            let ws = shared.named(name)?;
            let _gate = ws.gate.read().unwrap();
            return shared.stat(&ws, b"", ws.root_id());
        }
        let ws = shared.workspace(parent)?;
        let _gate = ws.gate.read().unwrap();
        let path = join(&shared.path(&ws, parent)?, name);
        let (found, generation) = shared.find(&ws, &path)?;
        let found = found.ok_or(Errno::ENOENT)?;
        let id = ws.nodes.lock().unwrap().enter(&path);
        shared.attr(&ws, &path, id, &found, generation).inspect_err(|_| {
            ws.nodes.lock().unwrap().forget(id, 1);
        })
    }

    fn attr_of(&self, id: u64) -> Res<FileAttr> {
        let shared = &self.0;
        let ws = shared.workspace(id)?;
        let _gate = ws.gate.read().unwrap();
        let (path, orphan) = ws.nodes.lock().unwrap().at(id).ok_or_else(stale)?;
        match orphan {
            None => shared.stat(&ws, &path, id),
            Some(Orphan::Blob(low)) => Ok(FileAttr {
                nlink: 0,
                ..shared.lower_attr(id, &low, 0, ws.modified(&path))
            }),
            Some(Orphan::File(kept)) => Ok(FileAttr {
                nlink: 0,
                ..shared.upper_attr(id, &fs::symlink_metadata(&*kept)?)
            }),
            Some(Orphan::Gone) => Err(stale()),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn set_attr(
        &self,
        id: u64,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<TimeOrNow>,
        mtime: Option<TimeOrNow>,
    ) -> Res<FileAttr> {
        let shared = &self.0;
        let ws = shared.workspace(id)?;
        let _gate = ws.gate.read().unwrap();
        let (path, orphan) = ws.nodes.lock().unwrap().at(id).ok_or_else(stale)?;
        let real = match &orphan {
            Some(Orphan::Gone) => return Err(stale()),
            Some(Orphan::Blob(low)) => {
                ws.materialize(
                    &shared.store,
                    low,
                    &ws.orphan_path(id),
                    size == Some(0),
                    ws.modified(&path),
                )?;
                ws.nodes
                    .lock()
                    .unwrap()
                    .set_orphan(id, Orphan::File(Arc::new(ws.orphan_path(id))));
                ws.orphan_path(id)
            }
            Some(Orphan::File(kept)) => kept.to_path_buf(),
            None => {
                match shared.find(&ws, &path)?.0.ok_or(Errno::ENOENT)? {
                    Found::GitFile => return Err(Errno::EPERM),
                    Found::Lower(low) if low.kind.is_dir() => ws.ensure_dirs(&path)?,
                    Found::Lower(low) => {
                        ws.copy_up(&shared.store, &path, &low, size == Some(0))?;
                        shared.files.close(id);
                    }
                    Found::Upper { .. } => {}
                }
                ws.real(&path)
            }
        };
        if let Some(size) = size {
            match shared.file(&ws, id, true)? {
                Data::File(file) => file.set_len(size)?,
                Data::Blob(_) => return Err(Errno::EIO),
            }
        }
        if let Some(mode) = mode {
            fs::set_permissions(&real, fs::Permissions::from_mode(mode & 0o7777))?;
        }
        if uid.is_some_and(|uid| uid != shared.uid) || gid.is_some() {
            let name = CString::new(real.as_os_str().as_bytes()).map_err(|_| Errno::EINVAL)?;
            // SAFETY: the path is a NUL-terminated string.
            if unsafe { libc::lchown(name.as_ptr(), uid.unwrap_or(u32::MAX), gid.unwrap_or(u32::MAX)) } != 0 {
                return Err(io::Error::last_os_error().into());
            }
        }
        if atime.is_some() || mtime.is_some() {
            let at = |time: TimeOrNow| match time {
                TimeOrNow::SpecificTime(time) => timespec(time),
                TimeOrNow::Now => libc::timespec {
                    tv_sec: 0,
                    tv_nsec: libc::UTIME_NOW,
                },
            };
            crate::workspace::set_times(&real, atime.map(at), mtime.map(at))?;
        }
        Ok(FileAttr {
            nlink: u32::from(orphan.is_none()),
            ..shared.upper_attr(id, &fs::symlink_metadata(&real)?)
        })
    }

    fn read_link(&self, id: u64) -> Res<Vec<u8>> {
        let shared = &self.0;
        let ws = shared.workspace(id)?;
        let _gate = ws.gate.read().unwrap();
        let path = shared.path(&ws, id)?;
        match shared.find(&ws, &path)?.0.ok_or(Errno::ENOENT)? {
            Found::Lower(Low {
                kind: Kind::Link, oid, ..
            }) => Ok(shared.store.blob(&oid)?.to_vec()),
            Found::Upper { dir: false, .. } => Ok(fs::read_link(ws.real(&path))?.into_os_string().into_encoded_bytes()),
            _ => Err(Errno::EINVAL),
        }
    }

    /// Makes something new at `name` in `parent` with `make`, which is given where it goes on the real
    /// filesystem, and answers its attributes.
    fn make(&self, parent: u64, name: &[u8], dir: bool, make: impl FnOnce(&Path) -> io::Result<()>) -> Res<FileAttr> {
        let shared = &self.0;
        if parent == 1 {
            return Err(Errno::EPERM);
        }
        let ws = shared.workspace(parent)?;
        let _gate = ws.gate.read().unwrap();
        let path = shared.vacant(&ws, parent, name)?;
        ws.ensure_dirs(split(&path).0)?;
        make(&ws.real(&path))?;
        ws.view.write().unwrap().add_upper(&path, dir);
        shared.entered(&ws, &path)
    }

    fn remove(&self, parent: u64, name: &[u8], dir: bool) -> Res<()> {
        let shared = &self.0;
        if parent == 1 {
            return Err(Errno::EPERM);
        }
        let ws = shared.workspace(parent)?;
        let _gate = ws.gate.read().unwrap();
        let path = join(&shared.path(&ws, parent)?, name);
        let _one = ws.copy.lock().unwrap();
        let found = shared.find(&ws, &path)?.0.ok_or(Errno::ENOENT)?;
        match (found.is_dir(), dir) {
            (true, false) => return Err(Errno::EISDIR),
            (false, true) => return Err(Errno::ENOTDIR),
            _ => {}
        }
        if dir {
            let view = ws.view.read().unwrap();
            if !view
                .list(&shared.store, &path, &found)?
                .is_none_or(|listing| listing.is_empty())
            {
                return Err(Errno::ENOTEMPTY);
            }
        }
        match found {
            Found::GitFile => Err(Errno::EPERM),
            Found::Lower(low) => {
                ws.delete(&mut ws.view.write().unwrap(), &path)?;
                ws.nodes
                    .lock()
                    .unwrap()
                    .orphan(&path, if dir { Orphan::Gone } else { Orphan::Blob(low) });
                Ok(())
            }
            Found::Upper { under, .. } => {
                let real = ws.real(&path);
                // A file the kernel holds may be open: it stays readable until the kernel forgets it.
                let kept = match ws.nodes.lock().unwrap().peek(&path) {
                    Some(id) if !dir => Some(Arc::new(orphan_beside(&real, id))),
                    _ => None,
                };
                match &kept {
                    Some(kept) => fs::rename(&real, &***kept)?,
                    None if dir => ws.remove_dir(&path)?,
                    None => fs::remove_file(&real)?,
                }
                let mut view = ws.view.write().unwrap();
                view.remove_upper(&path);
                if under.is_some() {
                    ws.delete(&mut view, &path)?;
                }
                ws.nodes
                    .lock()
                    .unwrap()
                    .orphan(&path, kept.map_or(Orphan::Gone, Orphan::File));
                Ok(())
            }
        }
    }

    fn rename_in(&self, parent: u64, name: &[u8], new_parent: u64, new_name: &[u8], flags: RenameFlags) -> Res<()> {
        let shared = &self.0;
        if parent == 1 || new_parent == 1 {
            return Err(Errno::EPERM);
        }
        if parent >> HASH_BITS != new_parent >> HASH_BITS {
            return Err(Errno::EXDEV);
        }
        if flags.intersects(RenameFlags::RENAME_EXCHANGE | RenameFlags::RENAME_WHITEOUT) {
            return Err(Errno::EINVAL);
        }
        let ws = shared.workspace(parent)?;
        // Moving a directory changes the path of everything below it, so nothing else may run.
        let moves_dir = {
            let _gate = ws.gate.read().unwrap();
            let from = join(&shared.path(&ws, parent)?, name);
            shared.find(&ws, &from)?.0.ok_or(Errno::ENOENT)?.is_dir()
        };
        let (_shared_gate, _whole_gate) = if moves_dir {
            (None, Some(ws.gate.write().unwrap()))
        } else {
            (Some(ws.gate.read().unwrap()), None)
        };
        let from = join(&shared.path(&ws, parent)?, name);
        let to = join(&shared.path(&ws, new_parent)?, new_name);
        if new_name.starts_with(HIDDEN) {
            return Err(Errno::EINVAL);
        }
        if from == to {
            return Ok(());
        }
        let _one = ws.copy.lock().unwrap();
        let source = shared.find(&ws, &from)?.0.ok_or(Errno::ENOENT)?;
        let target = shared.find(&ws, &to)?.0;
        if matches!(source, Found::GitFile) || matches!(target, Some(Found::GitFile)) {
            return Err(Errno::EPERM);
        }
        if target.is_some() && flags.contains(RenameFlags::RENAME_NOREPLACE) {
            return Err(Errno::EEXIST);
        }
        if source.is_dir() != moves_dir {
            return Err(Errno::EAGAIN);
        }
        let covered = |found: &Found| matches!(found, Found::Lower(_) | Found::Upper { under: Some(_), .. });
        if moves_dir {
            // A directory that shows files of the commit would have to be copied whole: the caller is told
            // to copy and delete, as across filesystems.
            if !matches!(source, Found::Upper { dir: true, under: None }) || crate::workspace::within(&to, &from) {
                return Err(Errno::EXDEV);
            }
            if let Some(target) = &target {
                if !target.is_dir() {
                    return Err(Errno::ENOTDIR);
                }
                let view = ws.view.read().unwrap();
                if !view
                    .list(&shared.store, &to, target)?
                    .is_none_or(|listing| listing.is_empty())
                {
                    return Err(Errno::ENOTEMPTY);
                }
            }
            ws.ensure_dirs(split(&to).0)?;
            fs::rename(ws.real(&from), ws.real(&to))?;
            let mut view = ws.view.write().unwrap();
            view.remove_upper(&to);
            view.rename_tree(&from, &to);
            // The directory brought its own content: what the commit has at the new path stays out of it.
            if target.as_ref().is_some_and(covered) {
                ws.delete(&mut view, &to)?;
            }
            let mut nodes = ws.nodes.lock().unwrap();
            nodes.orphan(&to, Orphan::Gone);
            nodes.rename_tree(&from, &to);
            return Ok(());
        }
        if target.as_ref().is_some_and(Found::is_dir) {
            return Err(Errno::EISDIR);
        }
        ws.ensure_dirs(split(&to).0)?;
        // What the new path was stays readable through a node the kernel holds for it.
        let replaced = match (&target, ws.nodes.lock().unwrap().peek(&to)) {
            (Some(Found::Upper { .. }), Some(id)) => {
                let kept = Arc::new(orphan_beside(&ws.real(&to), id));
                fs::rename(ws.real(&to), &**kept)?;
                Some(Orphan::File(kept))
            }
            (Some(Found::Lower(low)), _) => Some(Orphan::Blob(*low)),
            _ => None,
        };
        match &source {
            Found::Lower(low) => ws.materialize(&shared.store, low, &ws.real(&to), false, ws.modified(&from))?,
            _ => fs::rename(ws.real(&from), ws.real(&to))?,
        }
        let mut view = ws.view.write().unwrap();
        view.remove_upper(&from);
        view.add_upper(&to, false);
        if covered(&source) {
            ws.delete(&mut view, &from)?;
        }
        let mut nodes = ws.nodes.lock().unwrap();
        if let Some(replaced) = replaced {
            nodes.orphan(&to, replaced);
        }
        nodes.rename(&from, &to);
        Ok(())
    }

    /// Fills a listing of the directory `id` from `offset` with `add`, which answers true when it is full.
    fn list(
        &self,
        id: u64,
        offset: u64,
        plus: bool,
        mut add: impl FnMut(u64, u64, &[u8], &FileAttr) -> bool,
    ) -> Res<()> {
        let shared = &self.0;
        if id == 1 {
            let names: Vec<(String, Arc<Workspace>)> = {
                let table = shared.table.read().unwrap();
                table
                    .by_name
                    .iter()
                    .filter_map(|(name, slot)| Some((name.clone(), table.by_slot.get(slot)?.clone())))
                    .collect()
            };
            let here = shared.mount_attr();
            for (index, name) in [&b"."[..], &b".."[..]]
                .into_iter()
                .chain(names.iter().map(|(name, _)| name.as_bytes()))
                .enumerate()
                .skip(offset as usize)
            {
                let attr = match index.checked_sub(2) {
                    Some(at) => shared.directory(names[at].1.root_id(), FILE_TIME, 0o755),
                    None => here,
                };
                if add(attr.ino.0, index as u64 + 1, name, &attr) {
                    break;
                }
            }
            return Ok(());
        }
        let ws = shared.workspace(id)?;
        let _gate = ws.gate.read().unwrap();
        let path = shared.path(&ws, id)?;
        let (found, listing, generation) = {
            let view = ws.view.read().unwrap();
            let found = view.find(&shared.store, &path)?.ok_or(Errno::ENOENT)?;
            let listing = view.list(&shared.store, &path, &found)?.ok_or(Errno::ENOTDIR)?;
            (found, listing, view.generation)
        };
        // The entries are numbered: the directory, the one above it, the link to the Git directory at the
        // root, then the listing in its order.
        let fixed = if path.is_empty() { 3 } else { 2 };
        for index in offset as usize..fixed + listing.len() {
            let (name, child, found): (&[u8], Vec<u8>, Found) = match index {
                0 => (b".", path.clone(), found),
                1 => (
                    b"..",
                    split(&path).0.to_vec(),
                    Found::Lower(Low {
                        kind: Kind::Dir,
                        oid: shared.store.null(),
                        size: 0,
                    }),
                ),
                2 if path.is_empty() => (b".git", b".git".to_vec(), Found::GitFile),
                _ => match listing.get(index - fixed) {
                    Some((name, found)) => (name, join(&path, name), found),
                    None => continue,
                },
            };
            let named = index >= 2;
            let node = match index {
                0 => id,
                1 if path.is_empty() => 1,
                // The kernel counts a reference for every entry it is given with its attributes.
                _ if named && plus => ws.nodes.lock().unwrap().enter(&child),
                _ => ws
                    .nodes
                    .lock()
                    .unwrap()
                    .peek(&child)
                    .unwrap_or(ws.root_id() | crate::workspace::natural(&child)),
            };
            let attr = match shared.attr(&ws, &child, node, &found, generation) {
                Ok(attr) => attr,
                Err(_) => {
                    // The file went away while the directory was being listed.
                    if named && plus {
                        ws.nodes.lock().unwrap().forget(node, 1);
                    }
                    continue;
                }
            };
            if add(node, index as u64 + 1, name, &attr) {
                if named && plus {
                    ws.nodes.lock().unwrap().forget(node, 1);
                }
                break;
            }
        }
        Ok(())
    }
}

impl Filesystem for Mount {
    fn init(&mut self, _request: &Request, config: &mut KernelConfig) -> io::Result<()> {
        for flag in [
            InitFlags::FUSE_DO_READDIRPLUS,
            InitFlags::FUSE_PARALLEL_DIROPS,
            InitFlags::FUSE_CACHE_SYMLINKS,
            InitFlags::FUSE_NO_OPENDIR_SUPPORT,
            InitFlags::FUSE_NO_OPEN_SUPPORT,
        ] {
            if config.add_capabilities(flag).is_err() {
                log::warn!("the kernel does not support {flag:?}");
            }
        }
        let _ = config.set_max_readahead(1 << 20);
        let _ = config.set_max_write(1 << 20);
        Ok(())
    }

    fn lookup(&self, _request: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        self.0.count(Count::Lookup);
        let ttl = if parent.0 == 1 { BRIEF } else { KEEP };
        match self.lookup_in(parent.0, name.as_bytes()) {
            Ok(attr) => reply.entry(&ttl, &attr, Generation(0)),
            // That a name is not there is kept by the kernel too, until it makes the name itself or is told:
            // Git looks for a `.gitignore` in every directory, every time.
            Err(error) if error == Errno::ENOENT && parent.0 != 1 => {
                reply.entry(&KEEP, &self.0.directory(0, 0, 0), Generation(0))
            }
            Err(error) => reply.error(error),
        }
    }

    fn forget(&self, _request: &Request, id: INodeNo, count: u64) {
        let Ok(ws) = self.0.workspace(id.0) else { return };
        let forgotten = ws.nodes.lock().unwrap().forget(id.0, count);
        if let Some(orphan) = forgotten {
            self.0.files.close(id.0);
            if let Some(Orphan::File(kept)) = orphan {
                let _ = fs::remove_file(&**kept);
            }
        }
    }

    fn getattr(&self, _request: &Request, id: INodeNo, _handle: Option<FileHandle>, reply: ReplyAttr) {
        self.0.count(Count::Attr);
        if id.0 == 1 {
            return reply.attr(&BRIEF, &self.0.mount_attr());
        }
        answer!(self.attr_of(id.0), reply, |attr| reply.attr(&KEEP, &attr))
    }

    fn setattr(
        &self,
        _request: &Request,
        id: INodeNo,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<TimeOrNow>,
        mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        _handle: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<fuser::BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        self.0.count(Count::Change);
        if id.0 == 1 {
            return reply.error(Errno::EPERM);
        }
        answer!(self.set_attr(id.0, mode, uid, gid, size, atime, mtime), reply, |attr| {
            reply.attr(&KEEP, &attr)
        })
    }

    fn readlink(&self, _request: &Request, id: INodeNo, reply: ReplyData) {
        answer!(self.read_link(id.0), reply, |target: Vec<u8>| reply.data(&target))
    }

    fn mknod(
        &self,
        _request: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        _umask: u32,
        device: u32,
        reply: ReplyEntry,
    ) {
        self.0.count(Count::Change);
        let made = self.make(parent.0, name.as_bytes(), false, |real| {
            let path = CString::new(real.as_os_str().as_bytes())?;
            // SAFETY: the path is a NUL-terminated string.
            match unsafe { libc::mknod(path.as_ptr(), mode, libc::dev_t::from(device)) } {
                0 => Ok(()),
                _ => Err(io::Error::last_os_error()),
            }
        });
        answer!(made, reply, |attr| reply.entry(&KEEP, &attr, Generation(0)))
    }

    fn mkdir(&self, _request: &Request, parent: INodeNo, name: &OsStr, mode: u32, _umask: u32, reply: ReplyEntry) {
        self.0.count(Count::Change);
        let made = self.make(parent.0, name.as_bytes(), true, |real| {
            fs::DirBuilder::new().mode(mode & 0o7777).create(real)
        });
        answer!(made, reply, |attr| reply.entry(&KEEP, &attr, Generation(0)))
    }

    fn unlink(&self, _request: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        self.0.count(Count::Change);
        answer!(self.remove(parent.0, name.as_bytes(), false), reply, |()| reply.ok())
    }

    fn rmdir(&self, _request: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        self.0.count(Count::Change);
        answer!(self.remove(parent.0, name.as_bytes(), true), reply, |()| reply.ok())
    }

    fn symlink(&self, _request: &Request, parent: INodeNo, name: &OsStr, target: &Path, reply: ReplyEntry) {
        self.0.count(Count::Change);
        let made = self.make(parent.0, name.as_bytes(), false, |real| {
            std::os::unix::fs::symlink(target, real)
        });
        answer!(made, reply, |attr| reply.entry(&KEEP, &attr, Generation(0)))
    }

    fn rename(
        &self,
        _request: &Request,
        parent: INodeNo,
        name: &OsStr,
        new_parent: INodeNo,
        new_name: &OsStr,
        flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        self.0.count(Count::Change);
        let mut renamed = self.rename_in(parent.0, name.as_bytes(), new_parent.0, new_name.as_bytes(), flags);
        if renamed == Err(Errno::EAGAIN) {
            // What is renamed changed between a file and a directory while the gate was taken.
            renamed = self.rename_in(parent.0, name.as_bytes(), new_parent.0, new_name.as_bytes(), flags);
        }
        answer!(renamed, reply, |()| reply.ok())
    }

    fn open(&self, _request: &Request, _id: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        // The kernel stops asking after the first answer, and keeps the pages it has read.
        reply.error(Errno::ENOSYS);
    }

    fn read(
        &self,
        _request: &Request,
        id: INodeNo,
        _handle: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _owner: Option<LockOwner>,
        reply: ReplyData,
    ) {
        self.0.count(Count::Read);
        let ws = enter!(self.0, id.0, reply);
        let _gate = ws.gate.read().unwrap();
        match self.0.file(&ws, id.0, false) {
            Ok(Data::Blob(content)) => {
                let start = (offset as usize).min(content.len());
                reply.data(&content[start..(start + size as usize).min(content.len())]);
            }
            Ok(Data::File(file)) => BUFFER.with(|buffer| {
                let mut buffer = buffer.borrow_mut();
                buffer.resize(size as usize, 0);
                let mut filled = 0;
                while filled < buffer.len() {
                    match file.read_at(&mut buffer[filled..], offset + filled as u64) {
                        Ok(0) => break,
                        Ok(count) => filled += count,
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                        Err(error) => return reply.error(error.into()),
                    }
                }
                reply.data(&buffer[..filled]);
            }),
            Err(error) => reply.error(error),
        }
    }

    fn write(
        &self,
        _request: &Request,
        id: INodeNo,
        _handle: FileHandle,
        offset: u64,
        data: &[u8],
        _write_flags: WriteFlags,
        _flags: OpenFlags,
        _owner: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        self.0.count(Count::Write);
        let ws = enter!(self.0, id.0, reply);
        let _gate = ws.gate.read().unwrap();
        match self.0.file(&ws, id.0, true) {
            Ok(Data::File(file)) => match file.write_all_at(data, offset) {
                Ok(()) => reply.written(data.len() as u32),
                Err(error) => reply.error(error.into()),
            },
            Ok(Data::Blob(_)) => reply.error(Errno::EIO),
            Err(error) => reply.error(error),
        }
    }

    fn flush(&self, _request: &Request, _id: INodeNo, _handle: FileHandle, _owner: LockOwner, reply: ReplyEmpty) {
        reply.error(Errno::ENOSYS);
    }

    fn fsync(&self, _request: &Request, id: INodeNo, _handle: FileHandle, data_only: bool, reply: ReplyEmpty) {
        let ws = enter!(self.0, id.0, reply);
        let _gate = ws.gate.read().unwrap();
        match self.0.file(&ws, id.0, false) {
            Ok(Data::File(file)) => match if data_only { file.sync_data() } else { file.sync_all() } {
                Ok(()) => reply.ok(),
                Err(error) => reply.error(error.into()),
            },
            Ok(Data::Blob(_)) => reply.ok(),
            Err(error) => reply.error(error),
        }
    }

    fn opendir(&self, _request: &Request, _id: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        // As for files. The kernel keeps a listing until it changes the directory itself or is told.
        reply.error(Errno::ENOSYS);
    }

    fn readdir(&self, _request: &Request, id: INodeNo, _handle: FileHandle, offset: u64, mut reply: ReplyDirectory) {
        self.0.count(Count::List);
        let listed = self.list(id.0, offset, false, |node, next, name, attr| {
            reply.add(INodeNo(node), next, attr.kind, OsStr::from_bytes(name))
        });
        answer!(listed, reply, |()| reply.ok())
    }

    fn readdirplus(
        &self,
        _request: &Request,
        id: INodeNo,
        _handle: FileHandle,
        offset: u64,
        mut reply: ReplyDirectoryPlus,
    ) {
        self.0.count(Count::List);
        let ttl = if id.0 == 1 { BRIEF } else { KEEP };
        let listed = self.list(id.0, offset, true, |node, next, name, attr| {
            reply.add(INodeNo(node), next, OsStr::from_bytes(name), &ttl, attr, Generation(0))
        });
        answer!(listed, reply, |()| reply.ok())
    }

    fn fsyncdir(&self, _request: &Request, _id: INodeNo, _handle: FileHandle, _data_only: bool, reply: ReplyEmpty) {
        reply.ok();
    }

    fn statfs(&self, _request: &Request, _id: INodeNo, reply: ReplyStatfs) {
        let Ok(path) = CString::new(self.0.state.as_os_str().as_bytes()) else {
            return reply.error(Errno::EINVAL);
        };
        // SAFETY: the path is a NUL-terminated string and the structure is the one the call fills.
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
            return reply.error(io::Error::last_os_error().into());
        }
        reply.statfs(
            stat.f_blocks,
            stat.f_bfree,
            stat.f_bavail,
            stat.f_files,
            stat.f_ffree,
            stat.f_bsize as u32,
            255,
            stat.f_frsize as u32,
        );
    }

    fn create(
        &self,
        _request: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        _umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        self.0.count(Count::Change);
        let mut created = None;
        let made = self.make(parent.0, name.as_bytes(), false, |real| {
            created = Some(
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .mode(mode & 0o7777)
                    .open(real)?,
            );
            Ok(())
        });
        match made {
            Ok(attr) => {
                if let Some(file) = created {
                    self.0.files.put(attr.ino.0, file, true);
                }
                reply.created(&KEEP, &attr, Generation(0), FileHandle(0), FopenFlags::empty());
            }
            Err(error) => reply.error(error),
        }
    }
}

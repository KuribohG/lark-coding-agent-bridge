//! Replacing the commit of a workspace.
//!
//! The commit a workspace stands on is a pointer, so moving a workspace to another commit costs nothing for
//! the files it did not change. What is done here is for the files it did change: those the new commit now
//! holds are dropped from the workspace, which is how a workspace that follows a branch stays small.

use crate::fs::Shared;
use crate::index;
use crate::store::{Kind, Store};
use crate::workspace::{natural, split, write_whole, Low, Workspace};
use fuser::INodeNo;
use gix::ObjectId;
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// As `git reset --hard`: every tracked file becomes the new commit's. Untracked files stay.
    Reset,
    /// As `git checkout`: a file changed in the workspace stays changed, unless the new commit holds just
    /// that content. Refused when the new commit changed a file the workspace also changed.
    Keep,
}

impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Mode::Reset => "reset",
            Mode::Keep => "keep",
        }
    }

    pub fn named(name: &str) -> Option<Mode> {
        match name {
            "reset" => Some(Mode::Reset),
            "keep" => Some(Mode::Keep),
            _ => None,
        }
    }
}

pub struct Report {
    /// Files of the workspace dropped because the new commit holds them.
    pub dropped: usize,
    /// Files of the workspace that stay.
    pub kept: usize,
    /// Deletions that stay.
    pub deleted: usize,
    /// Nodes and names the kernel was told to read again.
    pub told: usize,
    /// How long requests to the workspace waited.
    pub held: std::time::Duration,
}

pub enum Outcome {
    Done(Report),
    /// Paths changed both in the workspace and between the two commits. Nothing was done.
    Conflicts(Vec<String>),
    /// The move was begun and could not be finished, for the reason given. The workspace is between the
    /// two commits and keeps the record of the move: a daemon that starts finishes it, and a later move
    /// takes its place.
    Unfinished(String),
}

/// How often the steps of a move that was begun are tried: a network filesystem fails now and then for a
/// moment, and a move left unfinished leaves the workspace between two commits.
const ATTEMPTS: u32 = 4;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Hit {
    None,
    Entry(Low),
    /// A directory on the way is not one in the commit.
    Blocked,
}

fn entry(store: &Store, root: &ObjectId, path: &[u8]) -> io::Result<Hit> {
    let (mut tree, mut start) = (store.tree(root)?, 0);
    loop {
        let end = path[start..]
            .iter()
            .position(|&byte| byte == b'/')
            .map_or(path.len(), |at| start + at);
        let Some(low) = tree.get(&path[start..end]).map(|entry| Low {
            kind: entry.kind,
            oid: entry.oid,
            size: entry.size,
        }) else {
            return Ok(Hit::None);
        };
        if end == path.len() {
            return Ok(Hit::Entry(low));
        }
        if low.kind != Kind::Dir {
            return Ok(Hit::Blocked);
        }
        tree = store.tree(&low.oid)?;
        start = end + 1;
    }
}

/// Whether the real file at `real` is what the commit holds as `low`: content, and whether it runs.
fn same_content(store: &Store, real: &Path, low: &Low) -> io::Result<bool> {
    let meta = fs::symlink_metadata(real)?;
    match low.kind {
        Kind::Link => {
            Ok(meta.file_type().is_symlink()
                && fs::read_link(real)?.as_os_str().as_bytes() == &store.blob(&low.oid)?[..])
        }
        Kind::File | Kind::Exec => {
            if !meta.is_file() || meta.len() != low.size || (meta.mode() & 0o100 != 0) != (low.kind == Kind::Exec) {
                return Ok(false);
            }
            let mut hash = Sha1::new();
            hash.update(format!("blob {}\0", meta.len()).as_bytes());
            let (mut file, mut buffer) = (fs::File::open(real)?, vec![0u8; 1 << 16]);
            loop {
                match file.read(&mut buffer)? {
                    0 => break,
                    count => hash.update(&buffer[..count]),
                }
            }
            Ok(hash.finalize()[..] == low.oid.as_bytes()[..])
        }
        Kind::Dir | Kind::Module => Ok(false),
    }
}

/// What the kernel may hold that is no longer so.
#[derive(Default)]
struct Changes {
    /// Paths whose content or attributes changed.
    paths: HashSet<Vec<u8>>,
    /// Paths that came, went, or changed between file, link and directory.
    names: HashSet<Vec<u8>>,
    /// Directories that came, went, or turned into a file, with all below them.
    subtrees: HashSet<Vec<u8>>,
}

impl Changes {
    fn content(&mut self, path: &[u8]) {
        self.paths.insert(path.to_vec());
    }

    fn name(&mut self, path: &[u8], subtree: bool) {
        self.paths.insert(path.to_vec());
        self.names.insert(path.to_vec());
        if subtree {
            self.subtrees.insert(path.to_vec());
        }
    }

    /// Whether `path` is below a directory that came or went.
    fn below(&self, path: &[u8]) -> bool {
        path.iter()
            .enumerate()
            .any(|(at, &byte)| byte == b'/' && self.subtrees.contains(&path[..at]))
    }
}

fn diff(store: &Store, old: &ObjectId, new: &ObjectId, path: &mut Vec<u8>, changes: &mut Changes) -> io::Result<()> {
    if old == new {
        return Ok(());
    }
    let (before, after) = (store.tree(old)?, store.tree(new)?);
    let length = path.len();
    let named = |path: &mut Vec<u8>, name: &[u8]| {
        if length > 0 {
            path.push(b'/');
        }
        path.extend_from_slice(name);
    };
    for entry in &before.entries {
        named(path, &entry.name);
        match after.get(&entry.name) {
            Some(other) if other.oid == entry.oid && other.kind == entry.kind => {}
            Some(other) if other.kind == Kind::Dir && entry.kind == Kind::Dir => {
                diff(store, &entry.oid, &other.oid, path, changes)?
            }
            // The same kind of file with other content, or one that only starts or stops being runnable.
            Some(other)
                if other.kind.is_dir() == entry.kind.is_dir()
                    && (other.kind == Kind::Link) == (entry.kind == Kind::Link) =>
            {
                changes.content(path)
            }
            other => changes.name(
                path,
                entry.kind == Kind::Dir || other.is_some_and(|other| other.kind == Kind::Dir),
            ),
        }
        path.truncate(length);
    }
    for entry in after.entries.iter().filter(|entry| before.get(&entry.name).is_none()) {
        named(path, &entry.name);
        changes.name(path, entry.kind == Kind::Dir);
        path.truncate(length);
    }
    Ok(())
}

/// The files of the tree `new` that the tree `old` does not hold just so, as the hashes of their paths. They
/// are the files a checkout by Git would write, and so the ones a build has to look at again.
fn changed_files(
    store: &Store,
    old: Option<&ObjectId>,
    new: &ObjectId,
    path: &mut Vec<u8>,
    keys: &mut Vec<u64>,
) -> io::Result<()> {
    let after = store.tree(new)?;
    let before = old.map(|old| store.tree(old)).transpose()?;
    let length = path.len();
    for entry in &after.entries {
        let was = before.as_ref().and_then(|before| before.get(&entry.name));
        if was.is_some_and(|was| was.oid == entry.oid && was.kind == entry.kind) {
            continue;
        }
        if length > 0 {
            path.push(b'/');
        }
        path.extend_from_slice(&entry.name);
        match entry.kind {
            Kind::Dir => {
                let below = was.filter(|was| was.kind == Kind::Dir).map(|was| &was.oid);
                changed_files(store, below, &entry.oid, path, keys)?;
            }
            Kind::Module => {}
            _ => keys.push(natural(path)),
        }
        path.truncate(length);
    }
    Ok(())
}

/// Runs `work` on every item, several at a time when they are many. Answers the outcome of each.
fn each<T: Sync>(items: &[T], work: impl Fn(&T) -> io::Result<()> + Sync) -> Vec<io::Result<()>> {
    let threads = (items.len() / 64).clamp(1, 16);
    let work = &work;
    std::thread::scope(|scope| {
        let workers: Vec<_> = items
            .chunks(items.len().div_ceil(threads).max(1))
            .map(|part| scope.spawn(move || part.iter().map(work).collect::<Vec<_>>()))
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|_| vec![Err(io::Error::other("a worker panicked"))])
            })
            .collect()
    })
}

/// Tells the kernel what it holds of `ws` that changed. Answers how many nodes and names it was told about.
fn tell(shared: &Shared, ws: &Workspace, changes: &Changes) -> usize {
    let Some(notifier) = shared.notifier.get() else {
        return 0;
    };
    let (nodes, names) = {
        let nodes = ws.nodes.lock().unwrap();
        // A name is told to the directory the kernel holds for it, whether or not the kernel holds the entry:
        // it may hold that the name is not there. The directory lists differently, so it is told too.
        let names: Vec<(u64, &[u8])> = changes
            .names
            .iter()
            .filter_map(|path| Some((nodes.peek(split(path).0)?, split(path).1)))
            .collect();
        let mut touched: Vec<u64> = changes
            .paths
            .iter()
            .filter_map(|path| nodes.peek(path))
            .chain(names.iter().map(|(parent, _)| *parent))
            .collect();
        if !changes.subtrees.is_empty() {
            touched.extend(nodes.select(|path| changes.below(path)).into_iter().map(|(id, _)| id));
        }
        touched.sort_unstable();
        touched.dedup();
        (touched, names)
    };
    // The attributes and the pages of a node, then the names. What the kernel dropped in the meantime is an
    // error to ignore.
    for id in &nodes {
        let _ = notifier.inval_inode(INodeNo(*id), 0, 0);
    }
    for (parent, name) in &names {
        let _ = notifier.inval_entry(INodeNo(*parent), OsStr::from_bytes(name));
    }
    nodes.len() + names.len()
}

/// `index.lock` in a workspace's Git directory, as Git makes it to write the index, removed when dropped.
struct IndexLock(std::path::PathBuf);

impl IndexLock {
    /// `stale` removes a lock found there first: the daemon that was moving this workspace made it and is gone.
    fn take(git_dir: &Path, stale: bool) -> io::Result<IndexLock> {
        let path = git_dir.join("index.lock");
        if stale {
            let _ = fs::remove_file(&path);
        }
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => Ok(IndexLock(path)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("a Git command holds {}", path.display()),
            )),
            // A workspace whose Git directory is the caller's may have none yet.
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(IndexLock(std::path::PathBuf::new())),
            Err(error) => Err(error),
        }
    }
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.0);
        }
    }
}

/// Points `HEAD` at the commit `to`, detached, and notes the move in the reflog as Git does: the commits a
/// workspace is moved away from can then be found again with `git reflog`.
fn detach_head(git_dir: &Path, to: &ObjectId) -> io::Result<()> {
    let head = git_dir.join("HEAD");
    let from = fs::read_to_string(&head)
        .ok()
        .and_then(|content| ObjectId::from_hex(content.trim().as_bytes()).ok());
    write_whole(&head, format!("{to}\n").as_bytes())?;
    if from == Some(*to) {
        return Ok(());
    }
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let line = format!(
        "{} {to} wsfs <wsfs@localhost> {seconds} +0000\twsfs: moving to {to}\n",
        from.unwrap_or(ObjectId::null(to.kind()))
    );
    // The reflog is a convenience: a move is not undone for it.
    let noted = fs::create_dir_all(git_dir.join("logs")).and_then(|()| {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(git_dir.join("logs/HEAD"))?
            .write_all(line.as_bytes())
    });
    if let Err(error) = noted {
        log::warn!("{}: the reflog was not written: {error}", git_dir.display());
    }
    Ok(())
}

/// Moves `ws` to the commit `to`. With `head`, the workspace's `HEAD` is set to the commit, detached.
/// `redo` finishes a replacement the daemon stopped in the middle of: what was decided then stands.
pub fn set_base(
    shared: &Shared,
    ws: &Workspace,
    to: ObjectId,
    mode: Mode,
    head: bool,
    redo: bool,
) -> io::Result<Outcome> {
    let store = &shared.store;
    let new_root = store.root(&to)?;
    store.load_all(&new_root, shared.threads)?;

    let gate = ws.gate.write().unwrap();
    if ws.gone.load(Ordering::Relaxed) {
        return Err(io::ErrorKind::NotFound.into());
    }
    let started = Instant::now();
    let mut view = ws.view.write().unwrap();
    let old_root = view.root;
    let index_path = ws.git_dir.join("index");
    let tracked: HashSet<Vec<u8>> = match mode {
        Mode::Keep => HashSet::new(),
        Mode::Reset => match index::paths(&index_path) {
            Ok(paths) => paths.into_iter().collect(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => HashSet::new(),
            Err(error) => return Err(error),
        },
    };

    let (mut dropped, mut kept, mut conflicts) = (Vec::new(), 0, Vec::new());
    for (path, dir) in view.uppers() {
        if dir {
            continue;
        }
        let new = entry(store, &new_root, &path)?;
        let drop = match mode {
            Mode::Reset => tracked.contains(&path) || new != Hit::None,
            Mode::Keep => match new {
                Hit::Entry(low) if same_content(store, &ws.real(&path), &low)? => true,
                _ if redo || new == entry(store, &old_root, &path)? => false,
                _ => {
                    conflicts.push(String::from_utf8_lossy(&path).into_owned());
                    false
                }
            },
        };
        if drop {
            // Whether a file is still there, now the commit's.
            dropped.push((path, matches!(new, Hit::Entry(low) if !low.kind.is_dir())));
        } else {
            kept += 1;
        }
    }
    // A file the workspace gives up because the commit holds just what it holds was not changed by the
    // move, and keeps its time: what a member built from its own change is not built again when the change
    // lands. Found now, while the files are there; a move that is being finished finds none.
    let unchanged = Mutex::new(Vec::new());
    for found in each(&dropped, |(path, still)| {
        let real = ws.real(path);
        let (Hit::Entry(low), true, Ok(meta)) = (entry(store, &new_root, path)?, *still, fs::symlink_metadata(&real))
        else {
            return Ok(());
        };
        if same_content(store, &real, &low).unwrap_or(false) {
            let at = (meta.mtime().max(0) as u64) * 1_000_000_000 + meta.mtime_nsec() as u64;
            unchanged.lock().unwrap().push((natural(path), at));
        }
        Ok(())
    }) {
        found?;
    }
    let unchanged = unchanged.into_inner().unwrap();
    let gone: HashSet<&[u8]> = dropped.iter().map(|(path, _)| &path[..]).collect();
    let (mut restored, mut deleted) = (Vec::new(), 0);
    for path in view.whites() {
        let new = entry(store, &new_root, &path)?;
        let keep = match mode {
            Mode::Reset => false,
            Mode::Keep if !matches!(new, Hit::Entry(_)) || gone.contains(&path[..]) => false,
            Mode::Keep if redo || new == entry(store, &old_root, &path)? => true,
            Mode::Keep => {
                conflicts.push(String::from_utf8_lossy(&path).into_owned());
                true
            }
        };
        if keep {
            deleted += 1;
        } else {
            restored.push(path);
        }
    }
    if !conflicts.is_empty() {
        conflicts.sort();
        return Ok(Outcome::Conflicts(conflicts));
    }

    // Git's own lock on the index, held for the move: a Git command in the workspace that writes the index
    // would otherwise put back the one it read before the move. One that holds the lock now is not waited
    // for, and nothing has been changed yet.
    let _locked = IndexLock::take(&ws.git_dir, redo)?;

    // From here the workspace is between two commits. The record lets a daemon that starts after this one
    // stopped do the same again: every step below can be repeated.
    let pending = ws.dir.join("pending.json");
    write_whole(
        &pending,
        serde_json::json!({ "base": to.to_string(), "mode": mode.name(), "head": head })
            .to_string()
            .as_bytes(),
    )?;

    let moved_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos() as u64);
    // The directories given up, across every attempt: the kernel is told of each.
    let mut pruned = Vec::new();
    let (mut failures, mut unfinished) = (0, None);
    loop {
        let mut steps = || -> io::Result<()> {
            for removed in each(&dropped, |(path, _)| match fs::remove_file(ws.real(path)) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            }) {
                removed?;
            }
            // A directory left empty by the files dropped from it goes too, as Git removes one: the deepest first,
            // each level at once.
            let mut emptied: BTreeMap<usize, HashSet<Vec<u8>>> = BTreeMap::new();
            let depth = |dir: &[u8]| dir.iter().filter(|&&byte| byte == b'/').count() + 1;
            for (path, _) in &dropped {
                view.remove_upper(path);
                let dir = split(path).0;
                if !dir.is_empty() {
                    emptied.entry(depth(dir)).or_default().insert(dir.to_vec());
                }
            }
            while let Some((_, level)) = emptied.pop_last() {
                let level: Vec<Vec<u8>> = level
                    .into_iter()
                    .filter(|dir| view.has_dir(dir) && view.upper_is_empty(dir))
                    .collect();
                let removed = each(&level, |dir| match ws.remove_dir(dir) {
                    Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
                    _ => Ok(()),
                });
                for (dir, removed) in level.into_iter().zip(removed) {
                    if let Err(error) = removed {
                        log::warn!("{}: {} stays: {error}", ws.name, String::from_utf8_lossy(&dir));
                        continue;
                    }
                    view.remove_upper(&dir);
                    let above = split(&dir).0;
                    if !above.is_empty() {
                        emptied.entry(depth(above)).or_default().insert(above.to_vec());
                    }
                    pruned.push(dir);
                }
            }
            if mode == Mode::Reset {
                view.clear_whites();
            } else {
                for path in &restored {
                    view.remove_white(path);
                }
            }
            ws.rewrite_whites(&view)?;

            // The files this move made what they are have its time, in the index as in what is reported.
            let mut touched = Vec::new();
            changed_files(store, Some(&old_root), &new_root, &mut Vec::new(), &mut touched)?;
            touched.extend(dropped.iter().map(|(path, _)| natural(path)));
            touched.extend(restored.iter().map(|path| natural(path)));
            let mut moved: Vec<(u64, u64)> = touched.into_iter().map(|key| (key, moved_at)).collect();
            moved.extend(&unchanged);
            ws.retime(&moved)?;
            shared.write_index(&ws.git_dir, &new_root, &ws.times.read().unwrap())?;
            if head {
                detach_head(&ws.git_dir, &to)?;
            }
            view.base = to;
            view.root = new_root;
            view.generation += 1;
            ws.save(&view)?;
            fs::remove_file(&pending)?;
            Ok(())
        };
        match steps() {
            Ok(()) => break,
            Err(error) => {
                failures += 1;
                log::warn!("{}: the move to {to} failed at attempt {failures}: {error}", ws.name);
                if failures == ATTEMPTS {
                    unfinished = Some(error.to_string());
                    break;
                }
                std::thread::sleep(Duration::from_millis(250 * u64::from(failures)));
            }
        }
    }
    shared.files.close_slot(ws.slot);

    let mut changes = Changes::default();
    diff(store, &old_root, &new_root, &mut Vec::new(), &mut changes)?;
    for (path, still) in &dropped {
        if *still {
            changes.content(path);
        } else {
            changes.name(path, false);
        }
    }
    for path in &restored {
        changes.name(path, false);
    }
    // A directory given up shows as the commit's, if the commit has it: what is below it did not change.
    for dir in &pruned {
        match entry(store, &new_root, dir)? {
            Hit::Entry(low) if low.kind.is_dir() => changes.content(dir),
            _ => changes.name(dir, false),
        }
    }
    let held = started.elapsed();
    drop(view);
    // The kernel is told after the gate is open: it may be waiting, with a directory locked, for a request
    // that waits at the gate.
    drop(gate);
    // Also of a move that stays unfinished: what the kernel holds of the paths it touched may be stale.
    let told = tell(shared, ws, &changes);
    if let Some(reason) = unfinished {
        return Ok(Outcome::Unfinished(reason));
    }
    Ok(Outcome::Done(Report {
        dropped: dropped.len(),
        kept,
        deleted,
        told,
        held,
    }))
}

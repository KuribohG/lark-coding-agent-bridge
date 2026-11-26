//! A workspace: a commit, and beside it only what differs from the commit.
//!
//! What differs is kept on a real filesystem, in the workspace's own directory: changed and new files are
//! plain files below `upper`, and a path of the commit that the workspace deleted is a record in `white.log`.
//! Both are read back when the workspace is opened. Memory holds an index of them, never the only copy.

use crate::index::FILE_NANOS;
use crate::store::{Kind, Store, Tree};
use gix::ObjectId;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{CString, OsStr};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

/// A node number is the workspace's slot above these bits and a hash of the path in them.
pub const HASH_BITS: u32 = 44;
const HASH_MASK: u64 = (1 << HASH_BITS) - 1;

/// The hash part of the number a path gets when nothing else has it. The root of a workspace is 0. Git's
/// index records the low 32 bits, so the index of a commit is the same in every workspace.
pub fn natural(path: &[u8]) -> u64 {
    if path.is_empty() {
        return 0;
    }
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for &byte in path {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
    }
    ((hash ^ (hash >> HASH_BITS)) & HASH_MASK).max(1)
}

pub fn join(dir: &[u8], name: &[u8]) -> Vec<u8> {
    let mut path = Vec::with_capacity(dir.len() + 1 + name.len());
    if !dir.is_empty() {
        path.extend_from_slice(dir);
        path.push(b'/');
    }
    path.extend_from_slice(name);
    path
}

/// The directory of `path` and its name there.
pub fn split(path: &[u8]) -> (&[u8], &[u8]) {
    match path.iter().rposition(|&byte| byte == b'/') {
        Some(at) => (&path[..at], &path[at + 1..]),
        None => (&[], path),
    }
}

/// Whether `path` is `dir` or below it.
pub fn within(path: &[u8], dir: &[u8]) -> bool {
    path.len() >= dir.len()
        && path.starts_with(dir)
        && (path.len() == dir.len() || dir.is_empty() || path[dir.len()] == b'/')
}

/// An entry of the commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Low {
    pub kind: Kind,
    pub oid: ObjectId,
    pub size: u64,
}

#[derive(Clone, Copy, Debug)]
pub enum Found {
    /// The link to the Git directory, at the root of every workspace.
    GitFile,
    /// In the commit, and not touched by the workspace.
    Lower(Low),
    /// The workspace's own. `under` is what the commit has at the path and the workspace has not deleted:
    /// below a directory of the workspace, a directory of the commit shows through.
    Upper { dir: bool, under: Option<Low> },
}

impl Found {
    pub fn is_dir(&self) -> bool {
        match self {
            Found::GitFile => false,
            Found::Lower(low) => low.kind.is_dir(),
            Found::Upper { dir, .. } => *dir,
        }
    }
}

pub enum Listing {
    /// A directory of the commit, and the names in it that the workspace deleted.
    Tree(Arc<Tree>, HashSet<Box<[u8]>>),
    Merged(Vec<(Box<[u8]>, Found)>),
}

impl Listing {
    pub fn len(&self) -> usize {
        match self {
            Listing::Tree(tree, _) => tree.entries.len(),
            Listing::Merged(items) => items.len(),
        }
    }

    /// The entry at `index`, unless it is deleted. Positions do not move when an entry is deleted.
    pub fn get(&self, index: usize) -> Option<(&[u8], Found)> {
        match self {
            Listing::Tree(tree, hidden) => {
                let entry = tree.entries.get(index)?;
                if hidden.contains(&entry.name) {
                    return None;
                }
                Some((
                    &entry.name,
                    Found::Lower(Low {
                        kind: entry.kind,
                        oid: entry.oid,
                        size: entry.size,
                    }),
                ))
            }
            Listing::Merged(items) => items.get(index).map(|(name, found)| (&name[..], *found)),
        }
    }

    pub fn is_empty(&self) -> bool {
        (0..self.len()).all(|index| self.get(index).is_none())
    }
}

/// The names in a directory below `upper`, and whether each is a directory.
type Names = BTreeMap<Box<[u8]>, bool>;

/// What a workspace shows: its commit, and the index of what differs.
pub struct View {
    pub base: ObjectId,
    pub root: ObjectId,
    /// Counts the times the commit was replaced.
    pub generation: u64,
    /// For each directory below `upper`, the names in it and whether each is a directory.
    upper: HashMap<Box<[u8]>, Names>,
    /// For a directory, the names of the commit deleted from it. A directory of the workspace at a deleted
    /// path shows nothing of the commit.
    white: HashMap<Box<[u8]>, HashSet<Box<[u8]>>>,
}

impl View {
    pub fn new(base: ObjectId, root: ObjectId, generation: u64) -> View {
        let mut upper = HashMap::new();
        upper.insert(Box::default(), BTreeMap::new());
        View {
            base,
            root,
            generation,
            upper,
            white: HashMap::new(),
        }
    }

    pub fn find(&self, store: &Store, path: &[u8]) -> io::Result<Option<Found>> {
        if path.is_empty() {
            return Ok(Some(Found::Upper {
                dir: true,
                under: Some(Low {
                    kind: Kind::Dir,
                    oid: self.root,
                    size: 0,
                }),
            }));
        }
        if path == b".git" {
            return Ok(Some(Found::GitFile));
        }
        // The directory walked so far: the tree of the commit that shows there, and whether the workspace
        // has the directory itself.
        let (mut low, mut up, mut start) = (Some(store.tree(&self.root)?), true, 0);
        loop {
            let end = path[start..]
                .iter()
                .position(|&byte| byte == b'/')
                .map_or(path.len(), |at| start + at);
            let (dir, name) = (&path[..start.saturating_sub(1)], &path[start..end]);
            let deleted = self.white.get(dir).is_some_and(|names| names.contains(name));
            let under = match (&low, deleted) {
                (Some(tree), false) => tree.get(name).map(|entry| Low {
                    kind: entry.kind,
                    oid: entry.oid,
                    size: entry.size,
                }),
                _ => None,
            };
            let above = if up {
                self.upper.get(dir).and_then(|names| names.get(name)).copied()
            } else {
                None
            };
            let last = end == path.len();
            match (above, under) {
                (Some(is_dir), _) => {
                    if last {
                        return Ok(Some(Found::Upper { dir: is_dir, under }));
                    }
                    if !is_dir {
                        return Ok(None);
                    }
                    low = match under {
                        Some(Low {
                            kind: Kind::Dir, oid, ..
                        }) => Some(store.tree(&oid)?),
                        _ => None,
                    };
                }
                (None, Some(entry)) => {
                    if last {
                        return Ok(Some(Found::Lower(entry)));
                    }
                    if entry.kind != Kind::Dir {
                        return Ok(None);
                    }
                    low = Some(store.tree(&entry.oid)?);
                    up = false;
                }
                (None, None) => return Ok(None),
            }
            start = end + 1;
        }
    }

    /// The entries of the directory at `path`, which was found as `found`.
    pub fn list(&self, store: &Store, path: &[u8], found: &Found) -> io::Result<Option<Listing>> {
        let deleted = self.white.get(path);
        match found {
            Found::Lower(Low {
                kind: Kind::Dir, oid, ..
            }) => Ok(Some(Listing::Tree(
                store.tree(oid)?,
                deleted.cloned().unwrap_or_default(),
            ))),
            Found::Lower(Low { kind: Kind::Module, .. }) => Ok(Some(Listing::Merged(Vec::new()))),
            Found::Upper { dir: true, under } => {
                let above = self.upper.get(path);
                let mut items = Vec::new();
                if let Some(Low {
                    kind: Kind::Dir, oid, ..
                }) = under
                {
                    let tree = store.tree(oid)?;
                    for entry in &tree.entries {
                        if deleted.is_some_and(|names| names.contains(&entry.name))
                            || above.is_some_and(|names| names.contains_key(&entry.name))
                        {
                            continue;
                        }
                        items.push((
                            entry.name.clone(),
                            Found::Lower(Low {
                                kind: entry.kind,
                                oid: entry.oid,
                                size: entry.size,
                            }),
                        ));
                    }
                }
                for (name, &dir) in above.into_iter().flatten() {
                    items.push((name.clone(), Found::Upper { dir, under: None }));
                }
                Ok(Some(Listing::Merged(items)))
            }
            _ => Ok(None),
        }
    }

    pub fn has_dir(&self, path: &[u8]) -> bool {
        self.upper.contains_key(path)
    }

    pub fn add_upper(&mut self, path: &[u8], dir: bool) {
        let (parent, name) = split(path);
        self.upper.entry(parent.into()).or_default().insert(name.into(), dir);
        if dir {
            self.upper.entry(path.into()).or_default();
        }
    }

    pub fn remove_upper(&mut self, path: &[u8]) {
        let (parent, name) = split(path);
        if let Some(names) = self.upper.get_mut(parent) {
            names.remove(name);
        }
        self.upper.remove(path);
    }

    /// Records that the commit's entry at `path` is deleted. Answers whether that is news.
    pub fn add_white(&mut self, path: &[u8]) -> bool {
        let (parent, name) = split(path);
        self.white.entry(parent.into()).or_default().insert(name.into())
    }

    pub fn remove_white(&mut self, path: &[u8]) {
        let (parent, name) = split(path);
        if let Some(names) = self.white.get_mut(parent) {
            names.remove(name);
            if names.is_empty() {
                self.white.remove(parent);
            }
        }
    }

    pub fn clear_whites(&mut self) {
        self.white.clear();
    }

    /// The directory of the workspace at `from`, and all below it, is now at `to`.
    pub fn rename_tree(&mut self, from: &[u8], to: &[u8]) {
        let (parent, name) = split(from);
        if let Some(names) = self.upper.get_mut(parent) {
            names.remove(name);
        }
        let moved: Vec<Box<[u8]>> = self.upper.keys().filter(|dir| within(dir, from)).cloned().collect();
        for dir in moved {
            let names = self.upper.remove(&dir).unwrap_or_default();
            let mut path = to.to_vec();
            path.extend_from_slice(&dir[from.len()..]);
            self.upper.insert(path.into(), names);
        }
        self.add_upper(to, true);
        // Nothing of the commit showed below a directory that could be moved.
        self.white.retain(|dir, _| !within(dir, from));
    }

    /// Every path below `upper`, and whether it is a directory.
    pub fn uppers(&self) -> Vec<(Vec<u8>, bool)> {
        let mut paths = Vec::new();
        for (dir, names) in &self.upper {
            for (name, &is_dir) in names {
                paths.push((join(dir, name), is_dir));
            }
        }
        paths
    }

    pub fn upper_is_empty(&self, dir: &[u8]) -> bool {
        self.upper.get(dir).is_none_or(BTreeMap::is_empty)
    }

    pub fn whites(&self) -> Vec<Vec<u8>> {
        let mut paths = Vec::new();
        for (dir, names) in &self.white {
            for name in names {
                paths.push(join(dir, name));
            }
        }
        paths
    }

    /// Files and directories below `upper`, and deleted paths.
    pub fn counts(&self) -> (usize, usize, usize) {
        let entries: usize = self.upper.values().map(BTreeMap::len).sum();
        let dirs = self.upper.len() - 1;
        (entries - dirs, dirs, self.white.values().map(HashSet::len).sum())
    }
}

/// Names that begin so, in a directory below `upper`, are the daemon's own and are shown to nobody.
///
/// A file is put under its final name, and a deleted file is put aside, by renaming it within its directory.
/// A rename between directories is serialised by the kernel across a whole filesystem, which every workspace
/// on that filesystem would wait for.
pub const HIDDEN: &[u8] = b".wsfs-";

/// Where the deleted file `real` stays while the kernel holds the node `id` for it.
pub fn orphan_beside(real: &Path, id: u64) -> PathBuf {
    real.with_file_name(format!(".wsfs-orphan-{id:x}"))
}

/// What a node the kernel still holds stands for once its path is given to something else.
#[derive(Clone, Debug)]
pub enum Orphan {
    /// A deleted file of the commit.
    Blob(Low),
    /// A deleted file of the workspace, kept at this place until the kernel forgets it.
    File(Arc<PathBuf>),
    Gone,
}

const SHARDS: u64 = 64;

/// By key: the path, and how many workspaces hold a node for it.
type Shard = HashMap<u64, (Box<[u8]>, u32)>;

/// The paths the kernel holds a node for, in any workspace. A node number is a workspace's slot and the key
/// of the path here, so a path is kept once however many workspaces show it, and a workspace keeps eight
/// bytes and a count for each node.
pub struct Paths {
    /// By key: the path, and how many workspaces hold a node for it. A key stays in the shard of the hash
    /// it started from.
    shards: Vec<Mutex<Shard>>,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            shards: (0..SHARDS).map(|_| Mutex::new(HashMap::new())).collect(),
        }
    }
}

impl Paths {
    fn shard(&self, key: u64) -> std::sync::MutexGuard<'_, Shard> {
        self.shards[(key % SHARDS) as usize].lock().unwrap()
    }

    /// The key that stands for `path` and that `taken` does not refuse: the hash of the path, or the next
    /// one free when another path, or a node of the asking workspace that left the path, has it. With
    /// `hold` the key is made if there is none, and counts one more holder unless `held` has it already.
    fn key(&self, path: &[u8], taken: impl Fn(u64) -> bool, hold: Option<&dyn Fn(u64) -> bool>) -> Option<u64> {
        let mut key = natural(path);
        let mut shard = self.shard(key);
        loop {
            match shard.get_mut(&key) {
                Some((kept, holders)) if **kept == *path && !taken(key) => {
                    if hold.is_some_and(|held| !held(key)) {
                        *holders += 1;
                    }
                    return Some(key);
                }
                Some(_) => {
                    key = if key + SHARDS > HASH_MASK {
                        key % SHARDS + SHARDS
                    } else {
                        key + SHARDS
                    }
                }
                None => {
                    hold?;
                    shard.insert(key, (path.into(), 1));
                    return Some(key);
                }
            }
        }
    }

    fn release(&self, key: u64) {
        let mut shard = self.shard(key);
        if let Some((_, holders)) = shard.get_mut(&key) {
            *holders -= 1;
            if *holders == 0 {
                shard.remove(&key);
            }
        }
    }

    fn path(&self, key: u64) -> Option<Vec<u8>> {
        self.shard(key).get(&key).map(|(path, _)| path.to_vec())
    }

    pub fn len(&self) -> usize {
        self.shards.iter().map(|shard| shard.lock().unwrap().len()).sum()
    }
}

/// The nodes the kernel holds for one workspace.
pub struct Nodes {
    base: u64,
    paths: Arc<Paths>,
    /// By node: the references the kernel counts.
    counts: HashMap<u64, u32>,
    /// The nodes that were renamed, and where they are now, both ways.
    moved: HashMap<u64, Box<[u8]>>,
    moved_at: HashMap<Box<[u8]>, u64>,
    orphans: HashMap<u64, Orphan>,
}

impl Drop for Nodes {
    fn drop(&mut self) {
        for id in self.counts.keys() {
            self.paths.release(id & HASH_MASK);
        }
    }
}

impl Nodes {
    fn new(slot: u64, paths: Arc<Paths>) -> Nodes {
        Nodes {
            base: slot << HASH_BITS,
            paths,
            counts: HashMap::new(),
            moved: HashMap::new(),
            moved_at: HashMap::new(),
            orphans: HashMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.counts.len()
    }

    /// Whether the node with this key stopped standing for the key's path.
    fn left(&self, key: u64) -> bool {
        self.moved.contains_key(&(self.base | key)) || self.orphans.contains_key(&(self.base | key))
    }

    /// The number the kernel holds for `path`.
    pub fn peek(&self, path: &[u8]) -> Option<u64> {
        if path.is_empty() {
            return Some(self.base);
        }
        if let Some(&id) = self.moved_at.get(path) {
            return Some(id);
        }
        let id = self.base | self.paths.key(path, |key| self.left(key), None)?;
        self.counts.contains_key(&id).then_some(id)
    }

    /// The number for `path`, counting one more reference from the kernel.
    pub fn enter(&mut self, path: &[u8]) -> u64 {
        if path.is_empty() {
            return self.base;
        }
        let id = match self.moved_at.get(path) {
            Some(&id) => id,
            None => {
                self.base
                    | self
                        .paths
                        .key(
                            path,
                            |key| self.left(key),
                            Some(&|key| self.counts.contains_key(&(self.base | key))),
                        )
                        .unwrap_or(0)
            }
        };
        let count = self.counts.entry(id).or_insert(0);
        *count = count.saturating_add(1);
        id
    }

    /// The path of a node, and what it stands for if the path is no longer its own.
    pub fn at(&self, id: u64) -> Option<(Vec<u8>, Option<Orphan>)> {
        if id == self.base {
            return Some((Vec::new(), None));
        }
        if !self.counts.contains_key(&id) {
            return None;
        }
        if let Some(orphan) = self.orphans.get(&id) {
            return Some((Vec::new(), Some(orphan.clone())));
        }
        match self.moved.get(&id) {
            Some(path) => Some((path.to_vec(), None)),
            None => Some((self.paths.path(id & HASH_MASK)?, None)),
        }
    }

    /// The kernel dropped `count` references. Answers what the node stood for when none is left.
    pub fn forget(&mut self, id: u64, count: u64) -> Option<Option<Orphan>> {
        let left = self.counts.get_mut(&id)?;
        // A count that reached its limit is not trusted again: the node stays.
        if *left == u32::MAX {
            return None;
        }
        *left = left.saturating_sub(count.min(u64::from(u32::MAX)) as u32);
        if *left > 0 {
            return None;
        }
        self.counts.remove(&id);
        self.paths.release(id & HASH_MASK);
        if let Some(path) = self.moved.remove(&id) {
            self.moved_at.remove(&path);
        }
        Some(self.orphans.remove(&id))
    }

    /// The node at `path`, if the kernel holds one, no longer follows the path.
    pub fn orphan(&mut self, path: &[u8], orphan: Orphan) -> Option<u64> {
        if path.is_empty() {
            return None;
        }
        let id = self.peek(path)?;
        if let Some(path) = self.moved.remove(&id) {
            self.moved_at.remove(&path);
        }
        self.orphans.insert(id, orphan);
        Some(id)
    }

    fn keeps_file(&self, id: u64) -> bool {
        matches!(self.orphans.get(&id), Some(Orphan::File(_)))
    }

    pub fn set_orphan(&mut self, id: u64, orphan: Orphan) {
        if self.counts.contains_key(&id) {
            self.orphans.insert(id, orphan);
        }
    }

    fn retarget(&mut self, id: u64, to: Vec<u8>) {
        if let Some(path) = self.moved.remove(&id) {
            self.moved_at.remove(&path);
        }
        // Back at the path its number stands for, a node is as any other.
        if self.paths.path(id & HASH_MASK).is_some_and(|path| path == to) {
            return;
        }
        self.moved_at.insert(to.clone().into(), id);
        self.moved.insert(id, to.into());
    }

    pub fn rename(&mut self, from: &[u8], to: &[u8]) {
        if let Some(id) = self.peek(from).filter(|_| !from.is_empty()) {
            self.retarget(id, to.to_vec());
        }
    }

    /// The directory at `from`, and every node below it, is now at `to`.
    pub fn rename_tree(&mut self, from: &[u8], to: &[u8]) {
        for (id, path) in self.select(|path| within(path, from)) {
            self.retarget(id, [to, &path[from.len()..]].concat());
        }
    }

    /// The numbers and paths of the nodes that follow a path, for which `pick` answers true.
    pub fn select(&self, pick: impl Fn(&[u8]) -> bool) -> Vec<(u64, Vec<u8>)> {
        let mut picked = Vec::new();
        for &id in self.counts.keys().filter(|id| !self.orphans.contains_key(id)) {
            let path = match self.moved.get(&id) {
                Some(path) => Some(path.to_vec()),
                None => self.paths.path(id & HASH_MASK),
            };
            picked.extend(path.filter(|path| pick(path)).map(|path| (id, path)));
        }
        picked
    }
}

pub struct Workspace {
    pub name: String,
    pub slot: u64,
    /// The workspace's directory on the real filesystem.
    pub dir: PathBuf,
    pub upper: PathBuf,
    pub git_dir: PathBuf,
    /// Whether the Git directory was made for the workspace and goes with it.
    pub registered: bool,
    /// The content of the `.git` file at the root.
    pub gitfile: Vec<u8>,
    /// Held shared by every request, and alone by what replaces the commit, moves a directory or removes
    /// the workspace.
    pub gate: RwLock<()>,
    pub view: RwLock<View>,
    pub nodes: Mutex<Nodes>,
    /// Held while a file of the commit becomes the workspace's own or is deleted.
    pub copy: Mutex<()>,
    pub gone: AtomicBool,
    /// When the files of the commit that a move changed last became what they are, in nanoseconds, by the
    /// hash of their paths. A file not here has the time every unchanged file has. Written only while the
    /// gate is held alone.
    pub times: RwLock<HashMap<u64, u64>>,
    log: Mutex<File>,
    temporary: AtomicU64,
}

/// The times recorded in the file at `path`: pairs of a path hash and a time, the later of two for one
/// path standing. A record cut short by a daemon that stopped is left out.
fn read_times(path: &Path) -> io::Result<HashMap<u64, u64>> {
    let records = match fs::read(path) {
        Ok(records) => records,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error),
    };
    let number = |bytes: &[u8]| u64::from_le_bytes(bytes.try_into().unwrap());
    Ok(records
        .chunks_exact(16)
        .map(|record| (number(&record[..8]), number(&record[8..])))
        .collect())
}

fn invalid(what: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.into())
}

/// The file mode mask the daemon was started with. The process itself runs with none, so that a file made
/// for the kernel gets the mode the kernel asks for; what the daemon makes for itself is masked by this.
pub static MASK: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0o022);

fn masked(mode: u32) -> u32 {
    mode & !MASK.load(Ordering::Relaxed)
}

/// Makes a directory of the daemon's own, with those above it when `all`.
pub fn make_dir(path: &Path, all: bool) -> io::Result<()> {
    std::os::unix::fs::DirBuilderExt::mode(fs::DirBuilder::new().recursive(all), masked(0o777)).create(path)
}

/// Replaces the file at `path` with `content`, whole or not at all.
pub fn write_whole(path: &Path, content: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension(format!("wsfs-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(masked(0o666))
        .open(&temporary)?;
    file.write_all(content)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)
}

pub fn real_path(base: &Path, path: &[u8]) -> PathBuf {
    if path.is_empty() {
        base.to_path_buf()
    } else {
        base.join(OsStr::from_bytes(path))
    }
}

fn scan(view: &mut View, real: &Path, path: &mut Vec<u8>) -> io::Result<()> {
    for entry in fs::read_dir(real)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.as_bytes().starts_with(HIDDEN) {
            // Left by a daemon that stopped: a file half copied, or a deleted file kept for a kernel that
            // no longer holds it.
            let _ = fs::remove_file(entry.path());
            continue;
        }
        let dir = entry.file_type()?.is_dir();
        let length = path.len();
        if length > 0 {
            path.push(b'/');
        }
        path.extend_from_slice(name.as_bytes());
        view.add_upper(path, dir);
        if dir {
            scan(view, &entry.path(), path)?;
        }
        path.truncate(length);
    }
    Ok(())
}

impl Workspace {
    fn assemble(
        slot: u64,
        name: &str,
        dir: PathBuf,
        git_dir: PathBuf,
        registered: bool,
        view: View,
        paths: &Arc<Paths>,
    ) -> io::Result<Workspace> {
        let log = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(masked(0o666))
            .open(dir.join("white.log"))?;
        let mut gitfile = b"gitdir: ".to_vec();
        gitfile.extend_from_slice(git_dir.as_os_str().as_bytes());
        gitfile.push(b'\n');
        Ok(Workspace {
            name: name.to_string(),
            slot,
            upper: dir.join("upper"),
            times: RwLock::new(read_times(&dir.join("times.log"))?),
            dir,
            git_dir,
            registered,
            gitfile,
            gate: RwLock::new(()),
            view: RwLock::new(view),
            nodes: Mutex::new(Nodes::new(slot, paths.clone())),
            copy: Mutex::new(()),
            gone: AtomicBool::new(false),
            log: Mutex::new(log),
            temporary: AtomicU64::new(0),
        })
    }

    /// Makes the directory of a new workspace on `base`, whose tree is `root`.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        dir: PathBuf,
        slot: u64,
        name: &str,
        base: ObjectId,
        root: ObjectId,
        git_dir: PathBuf,
        registered: bool,
        paths: &Arc<Paths>,
    ) -> io::Result<Workspace> {
        make_dir(&dir, false)?;
        make_dir(&dir.join("upper"), false)?;
        make_dir(&dir.join("tmp"), false)?;
        let workspace = Workspace::assemble(slot, name, dir, git_dir, registered, View::new(base, root, 0), paths)?;
        workspace.save(&workspace.view.read().unwrap())?;
        Ok(workspace)
    }

    /// Opens the workspace kept in `dir`. Answers also the commit a replacement was heading for, with the
    /// request that was being served, when the daemon stopped in the middle of one.
    pub fn open(
        dir: PathBuf,
        slot: u64,
        store: &Store,
        paths: &Arc<Paths>,
    ) -> io::Result<(Workspace, Option<serde_json::Value>)> {
        let meta: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("meta.json"))?).map_err(|error| invalid(error.to_string()))?;
        let text = |key: &str| {
            meta.get(key)
                .and_then(|value| value.as_str())
                .ok_or_else(|| invalid(format!("meta.json: no {key}")))
        };
        let name = text("name")?.to_string();
        let base = ObjectId::from_hex(text("base")?.as_bytes()).map_err(|error| invalid(error.to_string()))?;
        let git_dir = PathBuf::from(text("git_dir")?);
        let registered = meta
            .get("registered")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let generation = meta.get("generation").and_then(|value| value.as_u64()).unwrap_or(0);
        let mut view = View::new(base, store.root(&base)?, generation);
        scan(&mut view, &dir.join("upper"), &mut Vec::new())?;
        let mut records = 0;
        match fs::read(dir.join("white.log")) {
            Ok(log) => {
                for path in log.split(|&byte| byte == 0).filter(|path| !path.is_empty()) {
                    records += 1;
                    view.add_white(path);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        // What a stopped daemon left half done: files being copied, and deleted files it kept for the kernel.
        let _ = fs::remove_dir_all(dir.join("tmp"));
        make_dir(&dir.join("tmp"), true)?;
        let pending = match fs::read(dir.join("pending.json")) {
            Ok(pending) => Some(serde_json::from_slice(&pending).map_err(|error| invalid(error.to_string()))?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        let whites = view.counts().2;
        let workspace = Workspace::assemble(slot, &name, dir, git_dir, registered, view, paths)?;
        if records > 2 * whites + 64 {
            workspace.rewrite_whites(&workspace.view.read().unwrap())?;
        }
        Ok((workspace, pending))
    }

    pub fn root_id(&self) -> u64 {
        self.slot << HASH_BITS
    }

    /// Records the commit of `view` as the workspace's.
    pub fn save(&self, view: &View) -> io::Result<()> {
        let meta = serde_json::json!({
            "name": self.name,
            "base": view.base.to_string(),
            "generation": view.generation,
            "git_dir": self.git_dir.to_string_lossy(),
            "registered": self.registered,
        });
        write_whole(&self.dir.join("meta.json"), meta.to_string().as_bytes())
    }

    /// The modification time of the commit's file at `path`, in nanoseconds.
    pub fn modified(&self, path: &[u8]) -> u64 {
        self.times
            .read()
            .unwrap()
            .get(&natural(path))
            .copied()
            .unwrap_or(FILE_NANOS)
    }

    /// Gives files of the commit, named by the hashes of their paths, the times given with them: a move
    /// has just made them what they are. A build that made something from one of them before then makes it
    /// again, as after a checkout by Git.
    pub fn retime(&self, moved: &[(u64, u64)]) -> io::Result<()> {
        if moved.is_empty() {
            return Ok(());
        }
        let mut times = self.times.write().unwrap();
        times.extend(moved.iter().copied());
        let path = self.dir.join("times.log");
        let record = |(key, at): (&u64, &u64)| [key.to_le_bytes(), at.to_le_bytes()].concat();
        // Appended to, and written anew once most of it is of times that later ones replaced.
        let length = fs::metadata(&path).map_or(0, |meta| meta.len());
        if length > 4 * 16 * times.len() as u64 + (1 << 20) {
            return write_whole(&path, &times.iter().flat_map(record).collect::<Vec<u8>>());
        }
        let mut log = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(masked(0o666))
            .open(&path)?;
        log.write_all(
            &moved
                .iter()
                .flat_map(|(key, at)| record((key, at)))
                .collect::<Vec<u8>>(),
        )?;
        log.sync_data()
    }

    /// Where the workspace keeps its own file for `path`.
    pub fn real(&self, path: &[u8]) -> PathBuf {
        real_path(&self.upper, path)
    }

    /// Where a deleted file that has no directory to stay in is kept while the kernel holds the node `id`.
    pub fn orphan_path(&self, id: u64) -> PathBuf {
        self.dir.join(format!("tmp/orphan-{id:x}"))
    }

    /// A hidden name beside `to`, for a file being written before it takes the name.
    fn beside(&self, to: &Path) -> PathBuf {
        to.with_file_name(format!(".wsfs-new-{}", self.temporary.fetch_add(1, Ordering::Relaxed)))
    }

    /// Removes the workspace's own directory at `path`, in which nothing shows. Deleted files the kernel
    /// still holds are in it under hidden names: they are moved out first.
    pub fn remove_dir(&self, path: &[u8]) -> io::Result<()> {
        let real = self.real(path);
        match fs::remove_dir(&real) {
            Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => {}
            done => return done,
        }
        for entry in fs::read_dir(&real)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(rest) = name.as_bytes().strip_prefix(HIDDEN) else {
                continue;
            };
            let id = rest
                .strip_prefix(b"orphan-")
                .and_then(|id| u64::from_str_radix(std::str::from_utf8(id).ok()?, 16).ok());
            let mut nodes = self.nodes.lock().unwrap();
            match id.filter(|id| nodes.keeps_file(*id)) {
                Some(id) => {
                    let aside = self.orphan_path(id);
                    fs::rename(entry.path(), &aside)?;
                    nodes.set_orphan(id, Orphan::File(Arc::new(aside)));
                }
                None => {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        fs::remove_dir(&real)
    }

    /// Records in `view` and in the log that the commit's entry at `path` is deleted.
    pub fn delete(&self, view: &mut View, path: &[u8]) -> io::Result<()> {
        if view.add_white(path) {
            let mut record = path.to_vec();
            record.push(0);
            self.log.lock().unwrap().write_all(&record)?;
        }
        Ok(())
    }

    /// Writes the log again with the deleted paths of `view` alone.
    pub fn rewrite_whites(&self, view: &View) -> io::Result<()> {
        let mut content = Vec::new();
        for path in view.whites() {
            content.extend_from_slice(&path);
            content.push(0);
        }
        let mut log = self.log.lock().unwrap();
        write_whole(&self.dir.join("white.log"), &content)?;
        *log = OpenOptions::new().append(true).open(self.dir.join("white.log"))?;
        Ok(())
    }

    /// Makes the directory `dir`, and those above it, the workspace's own.
    pub fn ensure_dirs(&self, dir: &[u8]) -> io::Result<()> {
        let mut missing = Vec::new();
        {
            let view = self.view.read().unwrap();
            let mut end = dir.len();
            while !view.has_dir(&dir[..end]) {
                missing.push(end);
                end = dir[..end].iter().rposition(|&byte| byte == b'/').unwrap_or(0);
            }
        }
        for &end in missing.iter().rev() {
            // As the commit's directory it stands for is shown.
            match std::os::unix::fs::DirBuilderExt::mode(&mut fs::DirBuilder::new(), 0o755)
                .create(self.real(&dir[..end]))
            {
                Err(error) if error.kind() != io::ErrorKind::AlreadyExists => return Err(error),
                _ => {}
            }
            self.view.write().unwrap().add_upper(&dir[..end], true);
        }
        Ok(())
    }

    /// Writes the commit's file `low` at `to`, with the time `modified` that the file had as the commit's.
    /// `empty` leaves the content out, for a file about to be cut to nothing.
    pub fn materialize(&self, store: &Store, low: &Low, to: &Path, empty: bool, modified: u64) -> io::Result<()> {
        let temporary = self.beside(to);
        match low.kind {
            Kind::Link => std::os::unix::fs::symlink(OsStr::from_bytes(&store.blob(&low.oid)?), &temporary)?,
            Kind::File | Kind::Exec => {
                let mode = if low.kind == Kind::Exec { 0o755 } else { 0o644 };
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(mode)
                    .open(&temporary)?;
                if !empty {
                    file.write_all(&store.blob(&low.oid)?)?;
                }
                let unchanged = libc::timespec {
                    tv_sec: (modified / 1_000_000_000) as libc::time_t,
                    tv_nsec: (modified % 1_000_000_000) as libc::c_long,
                };
                // SAFETY: the descriptor is open and the array holds the two times the call reads.
                if unsafe { libc::futimens(file.as_raw_fd(), [unchanged, unchanged].as_ptr()) } != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Kind::Dir | Kind::Module => return Err(io::Error::from_raw_os_error(libc::EISDIR)),
        }
        fs::rename(&temporary, to)
    }

    /// Makes the commit's file at `path` the workspace's own, so it can be changed.
    pub fn copy_up(&self, store: &Store, path: &[u8], low: &Low, empty: bool) -> io::Result<()> {
        let _one = self.copy.lock().unwrap();
        // Another writer may have copied the file, or deleted it, while this one waited.
        match self.view.read().unwrap().find(store, path)? {
            Some(Found::Upper { dir: false, .. }) => return Ok(()),
            Some(Found::Lower(now)) if now.oid == low.oid => {}
            _ => return Err(io::ErrorKind::NotFound.into()),
        }
        self.ensure_dirs(split(path).0)?;
        self.materialize(store, low, &self.real(path), empty, self.modified(path))?;
        self.view.write().unwrap().add_upper(path, false);
        Ok(())
    }
}

/// Sets the times of the file at `path` itself, not of what a link points to. `None` leaves a time.
pub fn set_times(path: &Path, access: Option<libc::timespec>, modification: Option<libc::timespec>) -> io::Result<()> {
    let omit = libc::timespec {
        tv_sec: 0,
        tv_nsec: libc::UTIME_OMIT,
    };
    let times = [access.unwrap_or(omit), modification.unwrap_or(omit)];
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| invalid("a path holds a NUL"))?;
    // SAFETY: the path is a NUL-terminated string and the array holds the two times the call reads.
    if unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::tests::repository;

    #[test]
    fn paths_split_and_join() {
        assert_eq!(join(b"", b"a"), b"a");
        assert_eq!(join(b"a/b", b"c"), b"a/b/c");
        assert_eq!(split(b"a/b/c"), (&b"a/b"[..], &b"c"[..]));
        assert_eq!(split(b"c"), (&b""[..], &b"c"[..]));
        assert!(within(b"a/b", b"a") && within(b"a", b"a") && within(b"a", b""));
        assert!(!within(b"ab", b"a") && !within(b"a", b"a/b"));
        assert_eq!(natural(b""), 0);
        assert!(natural(b"a") != 0 && natural(b"a") != natural(b"b") && natural(b"a") <= HASH_MASK);
    }

    #[test]
    fn nodes_follow_renames_and_are_forgotten() {
        let paths = Arc::new(Paths::default());
        let (mut one, mut two) = (Nodes::new(1, paths.clone()), Nodes::new(2, paths.clone()));
        let a = one.enter(b"dir/a");
        assert_eq!(a, 1 << HASH_BITS | natural(b"dir/a"));
        assert_eq!(one.enter(b"dir/a"), a);
        // The same path in another workspace has the same key under the other slot, and is kept once.
        assert_eq!(two.enter(b"dir/a"), 2 << HASH_BITS | natural(b"dir/a"));
        assert_eq!(paths.len(), 1);
        assert_eq!(one.peek(b"dir/a"), Some(a));
        assert_eq!(one.peek(b"dir/b"), None);

        // Renamed, the node keeps its number and is found at the new path alone.
        one.rename(b"dir/a", b"dir/b");
        assert_eq!(one.peek(b"dir/b"), Some(a));
        assert_eq!(one.peek(b"dir/a"), None);
        assert_eq!(one.at(a).unwrap().0, b"dir/b");
        // A new file at the old path gets a number of its own.
        let again = one.enter(b"dir/a");
        assert_ne!(again, a);
        assert_eq!(one.peek(b"dir/a"), Some(again));
        assert_eq!(one.at(again).unwrap().0, b"dir/a");

        // A directory renamed takes what is below it along.
        one.enter(b"dir");
        one.rename_tree(b"dir", b"moved");
        assert_eq!(one.peek(b"moved/b"), Some(a));
        assert_eq!(one.peek(b"moved/a"), Some(again));
        assert_eq!(one.peek(b"dir/a"), None);

        // Deleted, a node stops following its path but stays until the kernel forgets it.
        assert_eq!(one.orphan(b"moved/b", Orphan::Gone), Some(a));
        assert_eq!(one.peek(b"moved/b"), None);
        assert!(matches!(one.at(a), Some((_, Some(Orphan::Gone)))));
        assert!(one.forget(a, 1).is_none());
        assert!(matches!(one.forget(a, 1), Some(Some(Orphan::Gone))));
        assert!(one.at(a).is_none());

        // The other workspace was not touched, and the paths go when the last holder does.
        assert_eq!(two.at(2 << HASH_BITS | natural(b"dir/a")).unwrap().0, b"dir/a");
        drop(one);
        assert_eq!(paths.len(), 1);
        drop(two);
        assert_eq!(paths.len(), 0);
    }

    #[test]
    fn a_view_lays_the_workspace_over_the_commit() {
        let (dir, head) = repository("view");
        let store = Store::open(&dir).unwrap();
        let mut view = View::new(head, store.root(&head).unwrap(), 0);
        let found = |view: &View, path: &[u8]| view.find(&store, path).unwrap();
        let names = |view: &View, path: &[u8]| {
            let listing = view.list(&store, path, &found(view, path).unwrap()).unwrap().unwrap();
            let mut names: Vec<String> = (0..listing.len())
                .filter_map(|at| listing.get(at))
                .map(|(name, _)| String::from_utf8_lossy(name).into_owned())
                .collect();
            names.sort();
            names
        };
        assert!(matches!(
            found(&view, b"a/b/two"),
            Some(Found::Lower(Low {
                kind: Kind::File,
                size: 3,
                ..
            }))
        ));
        assert!(matches!(
            found(&view, b"run"),
            Some(Found::Lower(Low { kind: Kind::Exec, .. }))
        ));
        assert!(matches!(
            found(&view, b"link"),
            Some(Found::Lower(Low { kind: Kind::Link, .. }))
        ));
        assert!(matches!(found(&view, b".git"), Some(Found::GitFile)));
        assert!(found(&view, b"a/none").is_none() && found(&view, b"top.txt/below").is_none());
        assert_eq!(names(&view, b"a"), ["b", "one"]);

        // A file of the workspace's own covers the commit's, and a new one shows beside the commit's.
        view.add_upper(b"a", true);
        view.add_upper(b"a/one", false);
        view.add_upper(b"a/new", false);
        assert!(matches!(
            found(&view, b"a/one"),
            Some(Found::Upper {
                dir: false,
                under: Some(_)
            })
        ));
        assert!(matches!(
            found(&view, b"a/new"),
            Some(Found::Upper {
                dir: false,
                under: None
            })
        ));
        assert!(matches!(found(&view, b"a/b/two"), Some(Found::Lower(_))));
        assert_eq!(names(&view, b"a"), ["b", "new", "one"]);

        // Deleted, the commit's entry is gone with all below it; a directory made there again is empty.
        assert!(view.add_white(b"a/b") && !view.add_white(b"a/b"));
        assert!(found(&view, b"a/b").is_none() && found(&view, b"a/b/two").is_none());
        assert_eq!(names(&view, b"a"), ["new", "one"]);
        view.add_upper(b"a/b", true);
        assert!(matches!(
            found(&view, b"a/b"),
            Some(Found::Upper { dir: true, under: None })
        ));
        assert!(found(&view, b"a/b/two").is_none());
        assert!(names(&view, b"a/b").is_empty());

        // Moved, a directory of the workspace takes its files along.
        view.add_upper(b"a/b/kept", false);
        view.rename_tree(b"a/b", b"c");
        assert!(matches!(found(&view, b"c/kept"), Some(Found::Upper { dir: false, .. })));
        assert!(found(&view, b"a/b").is_none());
        assert_eq!(view.counts(), (3, 2, 1));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

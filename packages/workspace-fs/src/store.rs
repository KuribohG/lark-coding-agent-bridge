//! The object database of one repository, read in process.
//!
//! Every tree is decoded once and kept by its id, so workspaces on nearby commits share all the
//! directories that did not change between them. File contents are not kept: a small cache spans the
//! chunks of the files being read now, and the kernel's page cache holds them afterwards.

use gix::objs::tree::EntryKind;
use gix::ObjectId;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

/// Contents kept for reads in progress. When full it is emptied: what was read is in the page cache.
const BLOB_CACHE_BYTES: usize = 64 << 20;
/// Sizes kept for files whose directory may be decoded again. Past this they are forgotten and asked again.
const SIZES_KEPT: usize = 4 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    File,
    Exec,
    Link,
    Dir,
    /// A submodule's commit. It is shown as an empty directory.
    Module,
}

impl Kind {
    /// The mode Git records for an entry of this kind.
    pub fn git_mode(self) -> u32 {
        match self {
            Kind::File => 0o100644,
            Kind::Exec => 0o100755,
            Kind::Link => 0o120000,
            Kind::Dir => 0o040000,
            Kind::Module => 0o160000,
        }
    }

    pub fn is_dir(self) -> bool {
        matches!(self, Kind::Dir | Kind::Module)
    }
}

pub struct Entry {
    pub name: Box<[u8]>,
    pub kind: Kind,
    pub oid: ObjectId,
    /// Bytes of a file or of a link's target; 0 for directories.
    pub size: u64,
}

pub struct Tree {
    /// In Git's order, which is the order of the index.
    pub entries: Vec<Entry>,
    /// Positions in `entries`, ordered by name.
    by_name: Vec<u32>,
}

impl Tree {
    pub fn get(&self, name: &[u8]) -> Option<&Entry> {
        self.by_name
            .binary_search_by(|&at| self.entries[at as usize].name.as_ref().cmp(name))
            .ok()
            .map(|at| &self.entries[self.by_name[at] as usize])
    }
}

type Contents = HashMap<ObjectId, Arc<Vec<u8>>>;

pub struct Store {
    id: usize,
    repo: gix::ThreadSafeRepository,
    trees: RwLock<HashMap<ObjectId, Arc<Tree>>>,
    sizes: RwLock<HashMap<ObjectId, u64>>,
    blobs: Mutex<(Contents, usize)>,
    /// The one content too large for `blobs`, kept while it is read piece by piece.
    large: Mutex<Option<(ObjectId, Arc<Vec<u8>>)>>,
}

static STORES: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    /// A repository handle is not shared between threads; each thread opens its own from the store's.
    static LOCAL: RefCell<HashMap<usize, gix::Repository>> = RefCell::new(HashMap::new());
}

fn other(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

fn missing(oid: &ObjectId) -> io::Error {
    io::Error::new(
        io::ErrorKind::NotFound,
        format!("object {oid} is not in the repository"),
    )
}

impl Store {
    /// Opens the repository at `path`: a Git directory, a work tree, or a linked worktree's Git directory.
    pub fn open(path: &Path) -> io::Result<Store> {
        // Trees are decoded once and contents are cached by the kernel, so Git's own object caches would
        // only hold memory.
        let options = gix::open::Options::default().config_overrides(["core.deltaBaseCacheLimit=0"]);
        let repo = gix::open_opts(path, options).map_err(other)?.into_sync();
        Ok(Store {
            id: STORES.fetch_add(1, Ordering::Relaxed),
            repo,
            trees: RwLock::new(HashMap::new()),
            sizes: RwLock::new(HashMap::new()),
            blobs: Mutex::new((HashMap::new(), 0)),
            large: Mutex::new(None),
        })
    }

    /// The directory the repository's objects and refs are in, shared by its worktrees.
    pub fn common_dir(&self) -> std::path::PathBuf {
        self.with_repo(|repo| repo.common_dir().to_path_buf())
    }

    /// The id that names no object.
    pub fn null(&self) -> ObjectId {
        ObjectId::null(gix::hash::Kind::Sha1)
    }

    fn with_repo<R>(&self, work: impl FnOnce(&gix::Repository) -> R) -> R {
        LOCAL.with(|local| {
            let mut local = local.borrow_mut();
            let repo = local.entry(self.id).or_insert_with(|| {
                let mut repo = self.repo.to_thread_local();
                repo.object_cache_size(0);
                repo
            });
            work(repo)
        })
    }

    /// The root tree of `commit`.
    pub fn root(&self, commit: &ObjectId) -> io::Result<ObjectId> {
        self.with_repo(|repo| {
            let object = repo
                .try_find_object(*commit)
                .map_err(other)?
                .ok_or_else(|| missing(commit))?;
            let commit = object.try_into_commit().map_err(other)?;
            Ok(commit.tree_id().map_err(other)?.detach())
        })
    }

    pub fn tree(&self, oid: &ObjectId) -> io::Result<Arc<Tree>> {
        if let Some(tree) = self.trees.read().unwrap().get(oid) {
            return Ok(tree.clone());
        }
        let tree = Arc::new(self.decode(oid)?);
        Ok(self.trees.write().unwrap().entry(*oid).or_insert(tree).clone())
    }

    fn decode(&self, oid: &ObjectId) -> io::Result<Tree> {
        self.with_repo(|repo| {
            let object = repo.try_find_object(*oid).map_err(other)?.ok_or_else(|| missing(oid))?;
            let tree = object.try_into_tree().map_err(other)?;
            let decoded = tree.decode().map_err(other)?;
            let mut entries = Vec::with_capacity(decoded.entries.len());
            {
                let sizes = self.sizes.read().unwrap();
                for entry in &decoded.entries {
                    let kind = match entry.mode.kind() {
                        EntryKind::Tree => Kind::Dir,
                        EntryKind::Blob => Kind::File,
                        EntryKind::BlobExecutable => Kind::Exec,
                        EntryKind::Link => Kind::Link,
                        EntryKind::Commit => Kind::Module,
                    };
                    let oid = entry.oid.to_owned();
                    let size = if kind.is_dir() {
                        0
                    } else {
                        sizes.get(&oid).copied().unwrap_or(u64::MAX)
                    };
                    entries.push(Entry {
                        name: entry.filename.to_vec().into_boxed_slice(),
                        kind,
                        oid,
                        size,
                    });
                }
            }
            let mut found = Vec::new();
            for entry in entries.iter_mut().filter(|entry| entry.size == u64::MAX) {
                let header = repo
                    .try_find_header(entry.oid)
                    .map_err(other)?
                    .ok_or_else(|| missing(&entry.oid))?;
                entry.size = header.size();
                found.push((entry.oid, entry.size));
            }
            if !found.is_empty() {
                self.sizes.write().unwrap().extend(found);
            }
            let mut by_name: Vec<u32> = (0..entries.len() as u32).collect();
            by_name.sort_by(|&a, &b| entries[a as usize].name.cmp(&entries[b as usize].name));
            Ok(Tree { entries, by_name })
        })
    }

    /// Decodes every tree below `root` that is not known yet, `threads` at a time.
    pub fn load_all(&self, root: &ObjectId, threads: usize) -> io::Result<()> {
        let mut level = vec![*root];
        while !level.is_empty() {
            let chunk = level.len().div_ceil(threads.max(1)).max(1);
            let results: Vec<io::Result<Vec<ObjectId>>> = std::thread::scope(|scope| {
                let workers: Vec<_> = level
                    .chunks(chunk)
                    .map(|part| {
                        scope.spawn(move || {
                            let mut below = Vec::new();
                            for oid in part {
                                let tree = self.tree(oid)?;
                                below.extend(
                                    tree.entries
                                        .iter()
                                        .filter(|entry| entry.kind == Kind::Dir)
                                        .map(|entry| entry.oid),
                                );
                            }
                            Ok(below)
                        })
                    })
                    .collect();
                workers
                    .into_iter()
                    .map(|worker| worker.join().unwrap_or_else(|_| Err(other("a loader panicked"))))
                    .collect()
            });
            let mut next = HashSet::new();
            for result in results {
                next.extend(result?);
            }
            let known = self.trees.read().unwrap();
            level = next.into_iter().filter(|oid| !known.contains_key(oid)).collect();
        }
        Ok(())
    }

    /// The content of a file, or the target of a link.
    pub fn blob(&self, oid: &ObjectId) -> io::Result<Arc<Vec<u8>>> {
        if let Some(data) = self.blobs.lock().unwrap().0.get(oid) {
            return Ok(data.clone());
        }
        if let Some((_, data)) = self.large.lock().unwrap().as_ref().filter(|(held, _)| held == oid) {
            return Ok(data.clone());
        }
        let data = self.with_repo(|repo| {
            let object = repo.try_find_object(*oid).map_err(other)?.ok_or_else(|| missing(oid))?;
            Ok::<_, io::Error>(Arc::new(object.detach().data))
        })?;
        if data.len() > BLOB_CACHE_BYTES / 4 {
            *self.large.lock().unwrap() = Some((*oid, data.clone()));
            return Ok(data);
        }
        let mut blobs = self.blobs.lock().unwrap();
        if blobs.1 + data.len() > BLOB_CACHE_BYTES {
            blobs.0.clear();
            blobs.1 = 0;
        }
        if blobs.0.insert(*oid, data.clone()).is_none() {
            blobs.1 += data.len();
        }
        Ok(data)
    }

    /// Forgets every tree that is not below one of `roots`.
    pub fn retain(&self, roots: &[ObjectId]) {
        let mut keep = HashSet::new();
        let mut pending: Vec<ObjectId> = roots.to_vec();
        {
            let trees = self.trees.read().unwrap();
            while let Some(oid) = pending.pop() {
                if !keep.insert(oid) {
                    continue;
                }
                if let Some(tree) = trees.get(&oid) {
                    pending.extend(
                        tree.entries
                            .iter()
                            .filter(|entry| entry.kind == Kind::Dir)
                            .map(|entry| entry.oid),
                    );
                }
            }
        }
        self.trees.write().unwrap().retain(|oid, _| keep.contains(oid));
        let mut sizes = self.sizes.write().unwrap();
        if sizes.len() > SIZES_KEPT {
            sizes.clear();
        }
    }

    /// Trees held, sizes held, and bytes of content held.
    pub fn held(&self) -> (usize, usize, usize) {
        (
            self.trees.read().unwrap().len(),
            self.sizes.read().unwrap().len(),
            self.blobs.lock().unwrap().1,
        )
    }
}

//! Git's index for a workspace, written without reading a file.
//!
//! Git takes a file as unchanged when what `lstat` says of it is what the index recorded. The index is
//! written here from the commit's trees with the values the filesystem reports for unchanged files (a
//! fixed time, an inode number computed from the path, the size of the content), so `git status` in a
//! workspace reads no file.

use crate::store::{Kind, Store};
use gix::ObjectId;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::io;
use std::path::Path;

/// The modification time of every file a workspace has not changed: 2020-01-01T00:00:00Z.
pub const FILE_TIME: u64 = 1_577_836_800;
/// The same in nanoseconds, the unit a workspace keeps the time of a file in.
pub const FILE_NANOS: u64 = FILE_TIME * 1_000_000_000;

/// The index of a tree with every file at `FILE_TIME`.
pub struct Built {
    /// The whole file, with the hash that ends it.
    pub content: Vec<u8>,
    pub entries: u32,
    /// Where in `content` the entry of each file begins, by what `ino` gave for its path.
    slots: HashMap<u64, u32>,
}

struct Writer<'a> {
    store: &'a Store,
    ino: &'a dyn Fn(&[u8]) -> u64,
    uid: u32,
    gid: u32,
    entries: Vec<u8>,
    count: u32,
    path: Vec<u8>,
    slots: HashMap<u64, u32>,
}

impl Writer<'_> {
    /// Appends the entries below the tree `oid` and its record of the cache tree to `cache`. Answers how
    /// many entries are below it.
    fn walk(&mut self, oid: &ObjectId, name: &[u8], cache: &mut Vec<u8>) -> io::Result<u32> {
        let tree = self.store.tree(oid)?;
        let (mut below, mut subtrees, mut children) = (0u32, 0u32, Vec::new());
        for entry in &tree.entries {
            let length = self.path.len();
            if length > 0 {
                self.path.push(b'/');
            }
            self.path.extend_from_slice(&entry.name);
            if entry.kind == Kind::Dir {
                subtrees += 1;
                below += self.walk(&entry.oid, &entry.name, &mut children)?;
            } else {
                // A submodule is a directory in the workspace; Git compares none of its values.
                let (time, ino, size) = if entry.kind == Kind::Module {
                    (0, 0, 0)
                } else {
                    let ino = (self.ino)(&self.path);
                    self.slots.insert(ino, 12 + self.entries.len() as u32);
                    (FILE_TIME as u32, ino as u32, entry.size as u32)
                };
                for value in [
                    time,
                    0,
                    time,
                    0,
                    0,
                    ino,
                    entry.kind.git_mode(),
                    self.uid,
                    self.gid,
                    size,
                ] {
                    self.entries.extend_from_slice(&value.to_be_bytes());
                }
                self.entries.extend_from_slice(entry.oid.as_bytes());
                self.entries
                    .extend_from_slice(&(self.path.len().min(0xfff) as u16).to_be_bytes());
                self.entries.extend_from_slice(&self.path);
                let padding = 8 - (62 + self.path.len()) % 8;
                self.entries.extend_from_slice(&[0u8; 8][..padding]);
                self.count += 1;
                below += 1;
            }
            self.path.truncate(length);
        }
        cache.extend_from_slice(name);
        cache.push(0);
        cache.extend_from_slice(format!("{below} {subtrees}\n").as_bytes());
        cache.extend_from_slice(oid.as_bytes());
        cache.extend_from_slice(&children);
        Ok(below)
    }
}

/// The index of the tree `root`. `ino` gives the inode number the filesystem reports for a path.
pub fn build(store: &Store, root: &ObjectId, ino: &dyn Fn(&[u8]) -> u64, uid: u32, gid: u32) -> io::Result<Built> {
    let mut writer = Writer {
        store,
        ino,
        uid,
        gid,
        entries: Vec::new(),
        count: 0,
        path: Vec::new(),
        slots: HashMap::new(),
    };
    let mut cache = Vec::new();
    writer.walk(root, b"", &mut cache)?;
    let mut content = Vec::with_capacity(12 + writer.entries.len() + 8 + cache.len() + 20);
    content.extend_from_slice(b"DIRC");
    content.extend_from_slice(&2u32.to_be_bytes());
    content.extend_from_slice(&writer.count.to_be_bytes());
    content.extend_from_slice(&writer.entries);
    content.extend_from_slice(b"TREE");
    content.extend_from_slice(&(cache.len() as u32).to_be_bytes());
    content.extend_from_slice(&cache);
    let hash = Sha1::digest(&content);
    content.extend_from_slice(&hash);
    Ok(Built {
        content,
        entries: writer.count,
        slots: writer.slots,
    })
}

impl Built {
    /// The index with the files of `times` at their times, in nanoseconds, by what `ino` gave for their paths.
    pub fn at(&self, times: &HashMap<u64, u64>) -> Vec<u8> {
        let mut content = self.content.clone();
        for (key, nanos) in times {
            let Some(&slot) = self.slots.get(key) else {
                continue;
            };
            let slot = slot as usize;
            let seconds = ((nanos / 1_000_000_000) as u32).to_be_bytes();
            let rest = ((nanos % 1_000_000_000) as u32).to_be_bytes();
            // The time the file's status changed, then the time its content did; Git compares both.
            for field in [slot, slot + 8] {
                content[field..field + 4].copy_from_slice(&seconds);
                content[field + 4..field + 8].copy_from_slice(&rest);
            }
        }
        let end = content.len() - 20;
        let hash = Sha1::digest(&content[..end]);
        content[end..].copy_from_slice(&hash);
        content
    }
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("index: {what}"))
}

/// The paths in the index at `path`, in its order. An index that is split or sparse is refused.
pub fn paths(path: &Path) -> io::Result<Vec<Vec<u8>>> {
    let data = std::fs::read(path)?;
    if data.len() < 32 || &data[..4] != b"DIRC" {
        return Err(bad("not an index"));
    }
    let word = |at: usize| u32::from_be_bytes(data[at..at + 4].try_into().unwrap());
    let (version, count) = (word(4), word(8) as usize);
    if !(2..=4).contains(&version) {
        return Err(bad("unknown version"));
    }
    let end = data.len() - 20;
    let (mut at, mut paths, mut previous) = (12usize, Vec::with_capacity(count), Vec::new());
    for _ in 0..count {
        if at + 62 > end {
            return Err(bad("cut short"));
        }
        let flags = u16::from_be_bytes(data[at + 60..at + 62].try_into().unwrap());
        let mut name = at + 62 + if flags & 0x4000 != 0 { 2 } else { 0 };
        if version == 4 {
            // The number of bytes to drop from the previous path, then what follows it, then a NUL.
            let (mut strip, mut shift) = (0usize, 0);
            loop {
                let byte = *data.get(name).ok_or_else(|| bad("cut short"))?;
                name += 1;
                strip += ((byte & 0x7f) as usize) << shift;
                if byte & 0x80 == 0 {
                    break;
                }
                // Git's offset encoding adds one for every continued byte.
                strip += 1 << (shift + 7);
                shift += 7;
            }
            let stop = data[name..end]
                .iter()
                .position(|&byte| byte == 0)
                .ok_or_else(|| bad("cut short"))?
                + name;
            let keep = previous.len().checked_sub(strip).ok_or_else(|| bad("bad prefix"))?;
            previous.truncate(keep);
            previous.extend_from_slice(&data[name..stop]);
            paths.push(previous.clone());
            at = stop + 1;
        } else {
            let length = (flags & 0xfff) as usize;
            let stop = if length < 0xfff {
                name + length
            } else {
                data[name..end]
                    .iter()
                    .position(|&byte| byte == 0)
                    .ok_or_else(|| bad("cut short"))?
                    + name
            };
            if stop > end {
                return Err(bad("cut short"));
            }
            paths.push(data[name..stop].to_vec());
            at += (stop - at + 8) & !7;
        }
    }
    while at + 8 <= end {
        let (signature, length) = (&data[at..at + 4], word(at + 4) as usize);
        if signature == b"link" || signature == b"sdir" {
            return Err(bad("a split or sparse index is not supported"));
        }
        at += 8 + length;
    }
    Ok(paths)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::workspace::natural;
    use std::path::PathBuf;
    use std::process::Command;

    pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .envs([
                ("GIT_AUTHOR_NAME", "t"),
                ("GIT_AUTHOR_EMAIL", "t@t"),
                ("GIT_COMMITTER_NAME", "t"),
                ("GIT_COMMITTER_EMAIL", "t@t"),
            ])
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("text")
    }

    /// A repository with one commit: files, a runnable file, a link, and directories whose names sort
    /// differently as a path and as a tree entry.
    pub(crate) fn repository(name: &str) -> (PathBuf, gix::ObjectId) {
        let dir = std::env::temp_dir().join(format!("wsfs-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::create_dir_all(dir.join("a-b")).unwrap();
        git(&dir, &["init", "-q", "-b", "main", "."]);
        for (path, content) in [
            ("top.txt", "top\n"),
            ("a/one", "1\n"),
            ("a/b/two", "22\n"),
            ("a-b/three", "333\n"),
            ("a.txt", "dot\n"),
            ("run", "#!/bin/sh\n"),
        ] {
            std::fs::write(dir.join(path), content).unwrap();
        }
        std::os::unix::fs::symlink("a/one", dir.join("link")).unwrap();
        std::fs::set_permissions(dir.join("run"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "first"]);
        let head = gix::ObjectId::from_hex(git(&dir, &["rev-parse", "HEAD"]).trim().as_bytes()).unwrap();
        (dir, head)
    }

    #[test]
    fn git_reads_the_index_written_here() {
        let (dir, head) = repository("index");
        let store = Store::open(&dir).unwrap();
        let root = store.root(&head).unwrap();
        let own = dir.join(".git/own-index");
        let built = build(&store, &root, &natural, 0, 0).unwrap();
        let count = built.entries;
        std::fs::write(&own, &built.content).unwrap();
        let listed = |index: &Path| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["ls-files", "-s"])
                .env("GIT_INDEX_FILE", index)
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8(output.stdout).unwrap()
        };
        // Git lists from it what it lists from the index it wrote itself, and takes its tree for the commit's.
        assert_eq!(listed(&own), listed(&dir.join(".git/index")));
        assert_eq!(count as usize, listed(&own).lines().count());
        let tree = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .arg("write-tree")
            .env("GIT_INDEX_FILE", &own)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&tree.stdout).trim(), root.to_string());

        // The paths are read back from this index, from Git's own, and from Git's compressed form of it.
        let expected: Vec<Vec<u8>> = git(&dir, &["ls-files"])
            .lines()
            .map(|line| line.as_bytes().to_vec())
            .collect();
        assert_eq!(paths(&own).unwrap(), expected);
        assert_eq!(paths(&dir.join(".git/index")).unwrap(), expected);
        git(&dir, &["update-index", "--index-version", "4"]);
        assert_eq!(paths(&dir.join(".git/index")).unwrap(), expected);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

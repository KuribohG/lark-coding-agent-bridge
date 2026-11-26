# workspace-fs

Git workspaces served straight from the object database. `wsfs` mounts one directory for one repository; each workspace is a subdirectory that shows a commit, read from the repository's objects as files are asked for, with the workspace's own changes laid over it. A workspace stores only what differs from its commit.

It is built for many agents working on one large repository, where a `git worktree` per agent costs a full checkout each, and an overlay over a checked-out baseline grows with every commit the agent follows.

The module is developed in the bridge repository and has no dependency on it. The bridge's workflow engine uses it for workspaces made with `isolation: "wsfs"` ([docs/workflow-worktrees.md](../../docs/workflow-worktrees.md#workspaces-served-from-the-object-database)): it starts one daemon for each workflow and repository, and talks to it over the control socket described below.

## What it changes

| | `git worktree` | wsfs |
| --- | --- | --- |
| Making a workspace | writes every file | writes the index (one file) |
| Disk per workspace | the whole tree | the files changed in it |
| Moving to another commit | Git rewrites every file that differs | a pointer moves; no file is written |
| After landing | the changed files stay as they are | the files the new commit holds are dropped from the workspace |
| `git status` | `lstat` of every file on the filesystem | answered from the kernel's cache; no file is read |

## Build

Linux only. Needs Rust 1.93 or later and `fusermount3` (package `fuse3`) at run time; no root.

```bash
cd packages/workspace-fs
cargo build --release --locked   # target/release/wsfs
cargo test --release             # unit tests; need git
WSFS=target/release/wsfs tests/smoke.sh   # the same edits in a workspace and in a plain worktree, compared
```

`Cargo.lock` is committed: the newest patch releases of some dependencies need a newer compiler than 1.93. In the bridge repository, `pnpm build:native` (part of `pnpm install`) builds the binary into `bin/wsfs` when `cargo` is there, with its intermediate files outside the tree, and the engine's own tests of these workspaces (`packages/workflow-engine/tests/wsfs-workspaces.test.ts`) run where that binary and FUSE are.

## Run

```bash
wsfs mount --repo <repository> --state <dir> --control <socket> [--threads <n>] <mountpoint>
wsfs ctl --control <socket> <operation> [<key>=<value> ...]
```

`mount` stays in the foreground and logs to stderr. It ends on `SIGTERM`, `SIGINT` or the `shutdown` operation. The socket appears once the mount is up, so a caller that can connect can use the workspaces. A daemon that was killed leaves a dead mount; the next `mount` on the same directory removes it first, and refuses a directory that another daemon is serving. A request that panics stops the whole daemon rather than leave the others serving beside what it held: nothing is lost by that, and whoever started the daemon starts another.

- `--repo`: a Git directory or a work tree. Only its objects are read. Workspaces are registered below its `worktrees/` unless a Git directory is given per workspace.
- `--state`: where workspaces keep what differs. Any real filesystem; see [Where to put the state](#where-to-put-the-state).
- `--control`: a Unix socket. It must be on a filesystem that has them (3FS does not). It is made for its owner alone: whoever can connect can remove every workspace.

Operations, also usable directly as one JSON object per line on the socket (`{"op":"create","name":"a","base":"<id>"}`), each answered by one line with `"ok"`:

| Operation | Fields | Effect |
| --- | --- | --- |
| `create` | `name`, `base`, `git_dir`?, `head`?, `prewarm`? | Makes `<mountpoint>/<name>` at the commit `base`. Without `git_dir` the workspace becomes a linked worktree of the repository, with `HEAD` detached at `base` or set to the ref `head`. With `git_dir`, that directory gets the index (and `HEAD` if `head` is given) and the rest is the caller's. |
| `set_base` | `name`, `base`, `mode`?, `head`? | Moves the workspace to another commit; see below. `head=true` detaches `HEAD` at it. |
| `remove` | `name` | Removes the workspace, its state, and the worktree record `create` made. |
| `warm` | `name` | Walks the workspace so the kernel holds every name before the first `git status`. `create` with `prewarm=true` does it in the background. |
| `list`, `stat` | | Workspaces with their commit and what they hold, and the daemon's version; counters and memory of the daemon. |
| `shutdown` | | Unmounts and exits. |

A commit is always given by its full id. Names are letters, digits, `.`, `_`, `-`.

### Moving a workspace: `set_base`

The commit a workspace stands on is a pointer. `set_base` moves it, rewrites the index for the new commit, and tells the kernel which of the names and files it holds changed. What it does with the workspace's own files depends on `mode`:

- `reset` (default), as `git reset --hard <base>`: every file that is tracked, or that the new commit has, becomes the new commit's. Untracked files stay, so a build directory survives.
- `keep`, as `git checkout <base>` with local changes: a changed file stays changed, unless the new commit holds exactly that content, in which case the workspace gives the file up. If the new commit changed a file the workspace also changed, nothing is done and the paths are returned as `conflicts`.

Neither mode merges. A caller that needs a merge does it in the object database (`git merge-tree --write-tree`, `git commit-tree`) and moves the workspace to the result; no file is written for that either.

After either mode, changes that were staged but not committed are unstaged: the index is written anew from the commit. With `head=true` the move is noted in the workspace's reflog (`wsfs: moving to <commit>`), as `git reset` notes its own.

A move holds Git's own lock on the workspace's index (`index.lock`), so a Git command that is writing the index cannot put the old one back afterwards. A move that the daemon refuses changes nothing, and says why (`conflicts`, an index it cannot read, a Git command that holds the lock). Once begun, a move is tried again a few times when the filesystem below fails; if it still cannot be finished the answer has `"unfinished": true`, the workspace stands between the two commits, and the move is finished by the next daemon that opens the workspace or replaced by the next move.

`set_base` stops requests to that workspace while it runs. The caller is expected to move a workspace when nothing is running in it.

## Layout

```
<state>/ws/<name>/meta.json     commit, Git directory
<state>/ws/<name>/upper/        the workspace's own files, as plain files at their paths
<state>/ws/<name>/white.log     paths of the commit the workspace deleted
<state>/ws/<name>/times.log     when the files of the commit that a move changed became what they are
<state>/ws/<name>/pending.json  present while a set_base is under way
<state>/ws/<name>/tmp/          deleted files still open somewhere
<mountpoint>/<name>/            the workspace
<mountpoint>/<name>/.git        a file naming the workspace's Git directory, as in any linked worktree
```

Everything that describes a workspace's changes is on disk. The daemon's memory holds indexes of it that are rebuilt when the workspace is opened, and caches that are bounded: the directories of the commits in use (shared by all workspaces on them), 64 MB of file content being read, one eight-byte entry per file the kernel currently holds per workspace, and each distinct path once.

## How it works

**Reading.** A workspace's directory tree is the commit's tree objects, decoded once and shared between all workspaces whose commits have them in common. File content is decoded from the object database on first read and then lives in the kernel's page cache.

**Writing.** The first write to a file of the commit copies it into `upper/`; new files are created there. Deleting a file of the commit appends its path to `white.log`. A directory made at a deleted path shows nothing of the commit. Lookups consult the workspace's own entries first, then the deletions, then the commit.

**Git.** `create` and `set_base` write `<git dir>/index` from the commit's trees, with exactly the `stat` data the filesystem reports for unchanged files: a fixed time (2020-01-01), the size of the content, and an inode number that is a hash of the path. Git then finds every unchanged file clean without reading it. Git itself works on the index and the object database outside the mount, at native speed.

**The kernel's cache.** Entries and attributes are given to the kernel with a lifetime of a year, including the fact that a name does not exist. Files and directories are not opened (`FUSE_NO_OPEN_SUPPORT`, `FUSE_NO_OPENDIR_SUPPORT`), so reading a cached file or listing a cached directory sends no request. The kernel keeps its cache right for changes made through the mount; `set_base` invalidates exactly the nodes and names that differ between the two commits.

**Crashes.** A daemon that stops loses nothing: the workspace's files and deletions are on disk and are read back at the next start. `set_base` records its goal in `pending.json` before changing anything and every step can be repeated, so a daemon that starts after one was interrupted finishes it. The record of a linked worktree is written beside `worktrees/` (in `wsfs-staging/`) and moved into place whole, so no Git command that lists the repository's worktrees finds half of one.

## What differs from a plain checkout

- No hard links (`link` fails with `EPERM`).
- Renaming a directory that shows files of the commit fails with `EXDEV`, as a rename across filesystems; `mv` then copies and deletes. Directories the workspace made itself (build output) are renamed in place.
- Files of the commit have the modes 0644 and 0755; directories of the commit are 0755. A file no move has changed has the time 2020-01-01. A file that a `set_base` changed has the time of that move, as a file Git checks out has the time it was written, so a build makes again what it made from it. A file the workspace held that the new commit holds just so keeps the time it had.
- Submodules show as empty directories.
- Names beginning `.wsfs-` cannot be created; the daemon uses them inside `upper/`.
- SHA-1 repositories only. Split and sparse indexes are refused by `set_base`.
- Files are served as the commit stores them: no end-of-line or encoding conversion, and no filters. A repository whose shared configuration turns sparse checkout on is not for these workspaces, since they show every file.
- One user: the mount is not shared with other users.

## Where to put the state

Every new or changed file is a real file below `--state`, so that filesystem's cost of creating a file is the workspace's cost of writing one. Measured on the machine the numbers below come from: creating and writing a small file took 11 ms on 3FS and 0.02 ms on local disk. State on a network filesystem survives the machine; state on local disk makes builds in the workspace as fast as local builds.

The daemon never renames between directories in a workspace's hot paths: the kernel serialises such renames across a whole filesystem.

## Measurements

One run on 2026-11-26, a repository of 124,932 files (1.2 GB) with the repository, the state and the mount point on 3FS (FUSE), on a busy machine (load 110–180). Times are wall clock.

| | |
| --- | --- |
| Mount | 0.1–0.9 s |
| Create a workspace | 0.13–0.32 s |
| Create 24 at once | 0.27 s |
| `git status`, kernel warm | 0.17–0.19 s |
| First `git status` with nothing warm | 1.8–2.1 s |
| `warm` | 0.5–0.6 s |
| First `git add -A`, `git diff HEAD` | 0.17 s, 0.04 s |
| Read every file once (16 readers) | 0.8–0.9 s |
| `set_base` across 2,566 / 2,754 / 1,237 changed paths | 0.21–0.26 s each |
| The same moves by `git reset --hard` through the mount | 26 s / 27–31 s / 12–14 s |
| A full build and test run of the project in a workspace (400 build steps, 32 jobs) | 288 s, all gates pass |
| Rebase a commit in the object database, then `set_base` to it | 0.07–0.10 s + 0.25–0.28 s |
| 19 workspaces each writing 220 new files at once | 2.1–2.2 s (0.13 s with the state on local disk) |
| Start again after `kill -9` | 0.6 s |
| Daemon memory with 25 workspaces fully walked (3.7 million files held by the kernel) | 119 MB |

`tests/bench.sh` runs these phases against any repository.

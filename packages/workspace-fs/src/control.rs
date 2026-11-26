//! The control channel: requests to make, move and remove workspaces, one JSON object per line over a
//! Unix socket, each answered by one line.

use crate::fs::Shared;
use crate::setbase::{self, Mode, Outcome};
use crate::workspace::{make_dir, write_whole, Workspace};
use fuser::INodeNo;
use gix::ObjectId;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn bad(what: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, what.into())
}

fn text<'a>(request: &'a Value, key: &str) -> io::Result<&'a str> {
    request
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(format!("{key} is required")))
}

fn flag(request: &Value, key: &str) -> bool {
    match request.get(key) {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => value == "true" || value == "1",
        _ => false,
    }
}

fn commit(request: &Value, key: &str) -> io::Result<ObjectId> {
    ObjectId::from_hex(text(request, key)?.as_bytes())
        .map_err(|_| bad(format!("{key} must be the full id of a commit")))
}

fn milliseconds(since: Instant) -> f64 {
    (since.elapsed().as_micros() as f64) / 1000.0
}

/// Opens every workspace kept below the state directory, and finishes what a stopped daemon left half done.
pub fn open_all(shared: &Arc<Shared>) -> io::Result<()> {
    let root = shared.state.join("ws");
    make_dir(&root, true)?;
    let _ = fs::remove_dir_all(shared.state.join("trash"));
    let mut pending = Vec::new();
    for entry in fs::read_dir(&root)? {
        let dir = entry?.path();
        if !dir.join("meta.json").exists() {
            log::warn!("{} is not a workspace: no meta.json", dir.display());
            continue;
        }
        let slot = {
            let mut table = shared.table.write().unwrap();
            table.slots += 1;
            table.slots
        };
        let started = Instant::now();
        match Workspace::open(dir.clone(), slot, &shared.store, &shared.paths) {
            Ok((workspace, unfinished)) => {
                let workspace = Arc::new(workspace);
                let (files, dirs, deleted) = workspace.view.read().unwrap().counts();
                log::info!(
                    "opened {}: {files} files, {dirs} directories, {deleted} deletions, {:.1} ms",
                    workspace.name,
                    milliseconds(started)
                );
                let mut table = shared.table.write().unwrap();
                table.by_name.insert(workspace.name.clone(), slot);
                table.by_slot.insert(slot, workspace.clone());
                pending.extend(unfinished.map(|request| (workspace, request)));
            }
            Err(error) => log::error!("{} is left closed: {error}", dir.display()),
        }
    }
    for (workspace, request) in pending {
        let mode = request
            .get("mode")
            .and_then(Value::as_str)
            .and_then(Mode::named)
            .unwrap_or(Mode::Reset);
        let done = commit(&request, "base")
            .and_then(|to| setbase::set_base(shared, &workspace, to, mode, flag(&request, "head"), true));
        match done {
            Ok(Outcome::Unfinished(reason)) => log::error!(
                "{}: the move to {} is not finished: {reason}",
                workspace.name,
                text(&request, "base").unwrap_or("?")
            ),
            Ok(_) => log::info!(
                "{}: finished the move to {}",
                workspace.name,
                text(&request, "base").unwrap_or("?")
            ),
            Err(error) => log::error!(
                "{}: the move to {} is not finished: {error}",
                workspace.name,
                text(&request, "base").unwrap_or("?")
            ),
        }
    }
    Ok(())
}

fn workspace(shared: &Shared, request: &Value) -> io::Result<Arc<Workspace>> {
    let name = text(request, "name")?;
    let table = shared.table.read().unwrap();
    table
        .by_name
        .get(name)
        .and_then(|slot| table.by_slot.get(slot))
        .cloned()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("no workspace {name}")))
}

/// The trees that workspaces stand on. All others can be forgotten.
fn retain(shared: &Shared) {
    let roots: Vec<ObjectId> = shared
        .table
        .read()
        .unwrap()
        .by_slot
        .values()
        .map(|workspace| workspace.view.read().unwrap().root)
        .collect();
    shared.store.retain(&roots);
}

fn create(shared: &Arc<Shared>, request: &Value) -> io::Result<Value> {
    let started = Instant::now();
    let name = text(request, "name")?;
    if name.is_empty()
        || name.starts_with('.')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(bad(
            "a name is letters, digits, '.', '_' and '-', and does not start with '.'",
        ));
    }
    let base = commit(request, "base")?;
    let root = shared.store.root(&base)?;
    shared.store.load_all(&root, shared.threads)?;
    let loaded = milliseconds(started);

    let slot = {
        let mut table = shared.table.write().unwrap();
        if table.by_name.contains_key(name) || !table.pending.insert(name.to_string()) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("workspace {name} exists"),
            ));
        }
        table.slots += 1;
        table.slots
    };
    let made = make(shared, request, name, slot, base, root);
    let mut table = shared.table.write().unwrap();
    table.pending.remove(name);
    let (workspace, entries) = made?;
    table.by_name.insert(name.to_string(), slot);
    table.by_slot.insert(slot, workspace.clone());
    drop(table);
    shared.changed_list();
    if flag(request, "prewarm") {
        let (shared, name) = (shared.clone(), name.to_string());
        std::thread::spawn(move || warm(&shared, &name));
    }
    Ok(json!({
        "path": shared.mount.join(name),
        "git_dir": workspace.git_dir,
        "entries": entries,
        "load_ms": loaded,
        "ms": milliseconds(started),
    }))
}

fn make(
    shared: &Shared,
    request: &Value,
    name: &str,
    slot: u64,
    base: ObjectId,
    root: ObjectId,
) -> io::Result<(Arc<Workspace>, u32)> {
    let dir = shared.state.join("ws").join(name);
    // Without a Git directory given, the workspace is made a linked worktree of the repository.
    let (git_dir, registered) = match request.get("git_dir").and_then(Value::as_str) {
        Some(git_dir) => (PathBuf::from(git_dir), false),
        None => (shared.store.common_dir().join("worktrees").join(name), true),
    };
    let head = match request.get("head").and_then(Value::as_str) {
        Some(head) if head.starts_with("refs/") => Some(format!("ref: {head}\n")),
        Some(head) => Some(format!(
            "{}\n",
            ObjectId::from_hex(head.as_bytes()).map_err(|_| bad("head is a ref name or the full id of a commit"))?
        )),
        None if registered => Some(format!("{base}\n")),
        None => None,
    };
    // Git reads every record below worktrees/ whenever it lists or adds one. This one is written beside them
    // and moved into place whole, so no Git command finds half of it.
    let building = if registered {
        let common = shared.store.common_dir();
        make_dir(&common.join("worktrees"), true)?;
        if git_dir.exists() {
            // A record this daemon knows no workspace for is what a removal that was cut short left.
            if !fs::read(git_dir.join("locked")).is_ok_and(|reason| reason.starts_with(LOCK_REASON.as_bytes())) {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("{} is another worktree's record", git_dir.display()),
                ));
            }
            discard(shared, &git_dir, name)?;
        }
        let building = staging(shared)?.join(format!("{name}.{}", std::process::id()));
        let _ = fs::remove_dir_all(&building);
        make_dir(&building, false)?;
        building
    } else {
        make_dir(&git_dir, true)?;
        git_dir.clone()
    };
    let built = (|| {
        if registered {
            write_whole(&building.join("commondir"), b"../..\n")?;
            write_whole(
                &building.join("gitdir"),
                format!("{}\n", shared.mount.join(name).join(".git").display()).as_bytes(),
            )?;
            // Git removes the record of a worktree it cannot find, which is how this one looks while unmounted.
            write_whole(&building.join("locked"), format!("{LOCK_REASON}\n").as_bytes())?;
        }
        if let Some(head) = &head {
            write_whole(&building.join("HEAD"), head.as_bytes())?;
        }
        let entries = shared.write_index(&building, &root, &HashMap::new())?;
        if registered {
            fs::rename(&building, &git_dir)?;
        }
        Ok((
            Arc::new(Workspace::create(
                dir.clone(),
                slot,
                name,
                base,
                root,
                git_dir.clone(),
                registered,
                &shared.paths,
            )?),
            entries,
        ))
    })();
    if built.is_err() && registered {
        let _ = fs::remove_dir_all(&building);
        let _ = fs::remove_dir_all(&git_dir);
    }
    built
}

/// What the lock of a worktree record says when this daemon made it.
const LOCK_REASON: &str = "served by wsfs";

/// Where worktree records are written before they are moved below worktrees/, and moved to before they are
/// deleted: a directory of the repository, so the move is a rename.
fn staging(shared: &Shared) -> io::Result<PathBuf> {
    let staging = shared.store.common_dir().join("wsfs-staging");
    make_dir(&staging, true)?;
    Ok(staging)
}

/// Takes a worktree record out of Git's sight at once and deletes it.
fn discard(shared: &Shared, git_dir: &Path, name: &str) -> io::Result<()> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let aside = staging(shared)?.join(format!("{name}.gone.{stamp}"));
    fs::rename(git_dir, &aside)?;
    if let Err(error) = fs::remove_dir_all(&aside) {
        log::warn!("{} is left behind: {error}", aside.display());
    }
    Ok(())
}

fn set_base(shared: &Arc<Shared>, request: &Value) -> io::Result<Value> {
    let started = Instant::now();
    let workspace = workspace(shared, request)?;
    let to = commit(request, "base")?;
    let mode = match request.get("mode").and_then(Value::as_str) {
        Some(name) => Mode::named(name).ok_or_else(|| bad("mode is reset or keep"))?,
        None => Mode::Reset,
    };
    let outcome = setbase::set_base(shared, &workspace, to, mode, flag(request, "head"), false)?;
    retain(shared);
    Ok(match outcome {
        Outcome::Done(report) => json!({
            "dropped": report.dropped,
            "kept": report.kept,
            "deleted": report.deleted,
            "told": report.told,
            "held_ms": (report.held.as_micros() as f64) / 1000.0,
            "ms": milliseconds(started),
        }),
        Outcome::Conflicts(paths) => {
            json!({ "ok": false, "error": "changed both in the workspace and between the commits", "conflicts": paths })
        }
        Outcome::Unfinished(reason) => {
            json!({ "ok": false, "error": format!("the move is not finished: {reason}"), "unfinished": true })
        }
    })
}

fn remove(shared: &Arc<Shared>, request: &Value) -> io::Result<Value> {
    let started = Instant::now();
    let workspace = workspace(shared, request)?;
    {
        let _gate = workspace.gate.write().unwrap();
        if workspace.gone.swap(true, Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "the workspace is being removed",
            ));
        }
        let mut table = shared.table.write().unwrap();
        table.by_name.remove(&workspace.name);
        table.by_slot.remove(&workspace.slot);
    }
    shared.files.close_slot(workspace.slot);
    if let Some(notifier) = shared.notifier.get() {
        let _ = notifier.inval_entry(INodeNo::ROOT, OsStr::new(&workspace.name));
    }
    shared.changed_list();
    // Out of the way at once, and deleted behind: a workspace's files can be many.
    let trash = shared.state.join("trash");
    make_dir(&trash, true)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let aside = trash.join(format!("{}.{stamp}", workspace.name));
    fs::rename(&workspace.dir, &aside)?;
    std::thread::spawn(move || {
        if let Err(error) = fs::remove_dir_all(&aside) {
            log::warn!("{} is left behind: {error}", aside.display());
        }
    });
    if workspace.registered {
        discard(shared, &workspace.git_dir, &workspace.name)?;
    }
    retain(shared);
    Ok(json!({ "ms": milliseconds(started) }))
}

fn list(shared: &Shared) -> Value {
    let workspaces: Vec<Arc<Workspace>> = shared.table.read().unwrap().by_slot.values().cloned().collect();
    let mut listed: Vec<Value> = workspaces
        .iter()
        .map(|workspace| {
            let view = workspace.view.read().unwrap();
            let (files, dirs, deleted) = view.counts();
            json!({
                "name": workspace.name,
                "base": view.base.to_string(),
                "generation": view.generation,
                "path": shared.mount.join(&workspace.name),
                "git_dir": workspace.git_dir,
                "files": files,
                "dirs": dirs,
                "deleted": deleted,
                "nodes": workspace.nodes.lock().unwrap().len(),
            })
        })
        .collect();
    listed.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    json!({ "workspaces": listed, "version": env!("CARGO_PKG_VERSION") })
}

fn resident() -> u64 {
    let pages = fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|statm| statm.split_whitespace().nth(1)?.parse::<u64>().ok())
        .unwrap_or(0);
    pages * 4096
}

fn stat(shared: &Shared) -> Value {
    let (trees, sizes, content) = shared.store.held();
    let workspaces: Vec<Arc<Workspace>> = shared.table.read().unwrap().by_slot.values().cloned().collect();
    let nodes: usize = workspaces
        .iter()
        .map(|workspace| workspace.nodes.lock().unwrap().len())
        .sum();
    let requests: serde_json::Map<String, Value> = ["lookup", "attr", "list", "read", "write", "change"]
        .iter()
        .zip(&shared.requests)
        .map(|(name, count)| (name.to_string(), json!(count.load(Ordering::Relaxed))))
        .collect();
    json!({
        "workspaces": workspaces.len(),
        "nodes": nodes,
        "trees": trees,
        "sizes": sizes,
        "content_bytes": content,
        "paths": shared.paths.len(),
        "open_files": shared.files.len(),
        "requests": requests,
        "resident_bytes": resident(),
    })
}

/// Walks a workspace so the kernel holds every name and its attributes before the first `git status`.
fn warm(shared: &Shared, name: &str) -> Value {
    static ONE: Mutex<()> = Mutex::new(());
    let _one = ONE.lock().unwrap();
    let started = Instant::now();
    let entries = walk(&shared.mount.join(name), shared.threads.min(8));
    log::info!("warmed {name}: {entries} entries, {:.1} ms", milliseconds(started));
    json!({ "entries": entries, "ms": milliseconds(started) })
}

/// Lists every directory below `root`, `threads` at a time. Answers the number of entries seen.
pub fn walk(root: &Path, threads: usize) -> u64 {
    let queue = (Mutex::new((vec![root.to_path_buf()], 0usize)), Condvar::new());
    let seen = AtomicU64::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            scope.spawn(|| loop {
                let dir = {
                    let mut state = queue.0.lock().unwrap();
                    loop {
                        if let Some(dir) = state.0.pop() {
                            state.1 += 1;
                            break dir;
                        }
                        // Done when nothing is queued and nobody is listing a directory that could queue more.
                        if state.1 == 0 {
                            queue.1.notify_all();
                            return;
                        }
                        state = queue.1.wait(state).unwrap();
                    }
                };
                let mut below = Vec::new();
                if let Ok(entries) = fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        seen.fetch_add(1, Ordering::Relaxed);
                        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                            below.push(entry.path());
                        }
                    }
                }
                // Listing a directory makes the kernel ask for its attributes once more, and Git looks for
                // this file in every directory: both are asked now and not by the first `git status`.
                let _ = fs::symlink_metadata(&dir);
                let _ = fs::symlink_metadata(dir.join(".gitignore"));
                let mut state = queue.0.lock().unwrap();
                state.0.append(&mut below);
                state.1 -= 1;
                queue.1.notify_all();
            });
        }
    });
    seen.load(Ordering::Relaxed)
}

fn handle(shared: &Arc<Shared>, request: &Value) -> io::Result<Value> {
    match text(request, "op")? {
        "create" => create(shared, request),
        "set_base" => set_base(shared, request),
        "remove" => remove(shared, request),
        "list" => Ok(list(shared)),
        "stat" => Ok(stat(shared)),
        "warm" => {
            let name = workspace(shared, request)?.name.clone();
            Ok(warm(shared, &name))
        }
        // The caller stops the daemon once the answer is sent.
        "shutdown" => Ok(json!({})),
        other => Err(bad(format!("no operation {other}"))),
    }
}

fn converse(shared: &Arc<Shared>, stream: UnixStream, stop: &(dyn Fn() + Send + Sync)) -> io::Result<()> {
    let mut writer = stream.try_clone()?;
    for line in BufReader::new(stream).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let started = Instant::now();
        let request = serde_json::from_str::<Value>(&line).map_err(|error| bad(error.to_string()));
        let last = request.as_ref().is_ok_and(|request| request["op"] == "shutdown");
        let answer = match request.and_then(|request| handle(shared, &request)) {
            Ok(Value::Object(mut fields)) => {
                fields.entry("ok").or_insert(Value::Bool(true));
                Value::Object(fields)
            }
            Ok(other) => json!({ "ok": true, "value": other }),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        };
        // Whoever looks after the daemon asks for the list every few seconds.
        let level = match answer["ok"] == true && (line.contains("\"list\"") || line.contains("\"stat\"")) {
            true => log::Level::Debug,
            false => log::Level::Info,
        };
        log::log!(
            level,
            "{line} -> {} in {:.1} ms",
            if answer["ok"] == true { "done" } else { "failed" },
            milliseconds(started)
        );
        shared.trim();
        writer.write_all(format!("{answer}\n").as_bytes())?;
        if last {
            // Unmounting ends the process, so the answer went out first.
            stop();
            break;
        }
    }
    Ok(())
}

/// Serves the control socket until the process ends.
pub fn serve(shared: Arc<Shared>, listener: UnixListener, stop: Arc<dyn Fn() + Send + Sync>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let (shared, stop) = (shared.clone(), stop.clone());
        std::thread::spawn(move || {
            if let Err(error) = converse(&shared, stream, &*stop) {
                log::debug!("a control connection ended: {error}");
            }
        });
    }
}

/// Sends one request to the daemon listening at `socket` and answers its reply.
pub fn call(socket: &Path, request: &Value) -> io::Result<Value> {
    let mut stream = UnixStream::connect(socket)?;
    stream.write_all(format!("{request}\n").as_bytes())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    serde_json::from_str(&line).map_err(|error| bad(format!("the daemon answered {line:?}: {error}")))
}

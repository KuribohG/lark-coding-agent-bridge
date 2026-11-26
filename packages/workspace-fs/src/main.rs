//! `wsfs`: Git workspaces served from the object database.
//!
//! One daemon mounts one directory for one repository. Every workspace is a directory there showing a
//! commit, read from the repository's objects as it is asked for, with the workspace's own changes over it.
//! Making a workspace writes its index and nothing else; see `README.md`.

mod control;
mod fs;
mod index;
mod setbase;
mod store;
mod workspace;

use fuser::{Config, MountOption, Session};
use serde_json::{json, Value};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;
use std::{env, io};

const USAGE: &str = "\
usage: wsfs mount --repo <dir> --state <dir> --control <socket> [--threads <n>] <mountpoint>
       wsfs ctl --control <socket> <operation> [<key>=<value> ...]

operations:
  create   name=<name> base=<commit> [git_dir=<dir>] [head=<ref or commit>] [prewarm=true]
  set_base name=<name> base=<commit> [mode=reset|keep] [head=true]
  remove   name=<name>
  warm     name=<name>
  list
  stat
  shutdown

A commit is given by its full id.";

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        // The library warns of every request this filesystem leaves to the kernel.
        metadata.level()
            <= if metadata.target().starts_with("fuser") {
                log::Level::Error
            } else {
                log::Level::Info
            }
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        // The library answers the kernel's notice that a caller was interrupted, which the kernel refuses:
        // once a second while Git shows progress.
        if record.target().starts_with("fuser")
            && record
                .args()
                .to_string()
                .starts_with("Failed to send FUSE reply: No such file")
        {
            return;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let seconds = now.as_secs() as libc::time_t;
        // SAFETY: both structures are the ones the calls fill and read, and the buffer is as long as said.
        let stamp = unsafe {
            let mut parts: libc::tm = std::mem::zeroed();
            libc::localtime_r(&seconds, &mut parts);
            let mut buffer = [0u8; 32];
            let length = libc::strftime(
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                c"%Y-%m-%d %H:%M:%S".as_ptr(),
                &parts,
            );
            String::from_utf8_lossy(&buffer[..length]).into_owned()
        };
        eprintln!(
            "{stamp}.{:03} {:5} {}",
            now.subsec_millis(),
            record.level(),
            record.args()
        );
    }

    fn flush(&self) {}
}

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("wsfs: {message}");
    exit(1)
}

/// The named options and the other arguments of a command line.
fn arguments(args: &[String], named: &[&str]) -> (Vec<Option<String>>, Vec<String>) {
    let (mut values, mut others, mut at) = (vec![None; named.len()], Vec::new(), 0);
    while at < args.len() {
        match named.iter().position(|name| *name == args[at]) {
            Some(which) => {
                values[which] = Some(
                    args.get(at + 1)
                        .cloned()
                        .unwrap_or_else(|| fail(format!("{} needs a value\n{USAGE}", args[at]))),
                );
                at += 2;
            }
            None => {
                others.push(args[at].clone());
                at += 1;
            }
        }
    }
    (values, others)
}

/// Unmounts what is left of a mount whose daemon is gone, or cannot be unmounted while in use.
fn detach(mountpoint: &Path) {
    for helper in ["fusermount3", "fusermount"] {
        if Command::new(helper)
            .arg("-u")
            .arg("-z")
            .arg(mountpoint)
            .status()
            .is_ok_and(|status| status.success())
        {
            return;
        }
    }
}

/// Whether a FUSE filesystem is mounted at `mountpoint`.
fn mounted(mountpoint: &Path) -> bool {
    let Ok(mounts) = std::fs::read_to_string("/proc/self/mountinfo") else {
        return false;
    };
    // Each line: ids, device, root, mount point, options, optional fields, "-", type, source, options. A
    // space in a path is written as \040.
    let wanted = mountpoint.to_string_lossy().replace(' ', "\\040");
    mounts.lines().any(|line| {
        let (before, after) = line.split_once(" - ").unwrap_or((line, ""));
        before.split(' ').nth(4) == Some(wanted.as_str()) && after.starts_with("fuse")
    })
}

/// Whether the daemon behind the mount at `mountpoint` answers. The kernel asks it for the free space every
/// time, while a file's attributes may be answered from what the kernel kept of a daemon that is gone.
fn served(mountpoint: &Path) -> bool {
    let Ok(path) = std::ffi::CString::new(mountpoint.as_os_str().as_bytes()) else {
        return false;
    };
    let mut space = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: the path ends with a NUL and the result is only written to.
    unsafe { libc::statfs(path.as_ptr(), space.as_mut_ptr()) == 0 }
}

fn mount(args: &[String]) -> io::Result<()> {
    let (values, others) = arguments(args, &["--repo", "--state", "--control", "--threads"]);
    let [repo, state, control, threads] = &values[..] else {
        unreachable!()
    };
    let (Some(repo), Some(state), Some(control), [mountpoint]) = (repo, state, control, &others[..]) else {
        fail(USAGE)
    };
    let threads = match threads {
        Some(threads) => threads.parse().unwrap_or_else(|_| fail("--threads is a number")),
        None => std::thread::available_parallelism()
            .map_or(8, |cores| cores.get())
            .clamp(4, 32),
    };

    // Before any thread starts: the signals that end the daemon are taken by one thread that waits for them.
    // SAFETY: the set is initialised by the first call before the others read it.
    let signals = unsafe {
        let mut signals: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut signals);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut signals, signal);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &signals, std::ptr::null_mut());
        // Files are made with the mode the kernel asks for. What the daemon makes for itself is masked as
        // the caller asked.
        workspace::MASK.store(libc::umask(0), Ordering::Relaxed);
        signals
    };
    log::set_logger(&Logger).map_err(|error| io::Error::other(error.to_string()))?;
    log::set_max_level(log::LevelFilter::Info);

    let control = PathBuf::from(control);
    if std::os::unix::net::UnixStream::connect(&control).is_ok() {
        fail(format!("a daemon already listens at {}", control.display()));
    }
    // A daemon that was killed leaves its mount behind, answering nothing. The kernel may still answer from
    // what it kept, so the mount is looked for in the table of mounts and not by asking it.
    let mountpoint = PathBuf::from(mountpoint);
    let mountpoint = match (mountpoint.parent(), mountpoint.file_name()) {
        (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => parent.canonicalize()?.join(name),
        _ => mountpoint,
    };
    for attempt in 0..50 {
        if !mounted(&mountpoint) {
            break;
        }
        if attempt == 0 {
            // Members may be working below a mount that is served: it is never taken from under them.
            if served(&mountpoint) {
                fail(format!(
                    "{} is served by a daemon whose socket is not {}",
                    mountpoint.display(),
                    control.display()
                ));
            }
            log::info!(
                "{} is left from a daemon that is gone: unmounting it",
                mountpoint.display()
            );
        }
        detach(&mountpoint);
        std::thread::sleep(Duration::from_millis(100));
    }
    workspace::make_dir(Path::new(state), true)?;
    let shared = Arc::new(fs::Shared {
        store: store::Store::open(Path::new(repo))?,
        state: Path::new(state).canonicalize()?,
        mount: mountpoint.clone(),
        // SAFETY: the calls only answer.
        uid: unsafe { libc::getuid() },
        gid: unsafe { libc::getgid() },
        threads,
        table: RwLock::default(),
        notifier: OnceLock::new(),
        files: fs::Files::default(),
        paths: Arc::default(),
        index: Mutex::new(None),
        listed: AtomicU64::new(0),
        requests: Default::default(),
    });
    shared.listed.store(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_secs()),
        Ordering::Relaxed,
    );
    control::open_all(&shared)?;

    let mut config = Config::default();
    config.mount_options = vec![
        MountOption::DefaultPermissions,
        MountOption::FSName(format!("wsfs:{repo}")),
        MountOption::Subtype("wsfs".into()),
    ];
    config.n_threads = Some(threads);
    config.clone_fd = true;
    let mut session = Session::new(fs::Mount(shared.clone()), &mountpoint, &config)?;
    let _ = shared.notifier.set(session.notifier());
    // The socket appears once the mount is there: a caller that can connect can use the workspaces.
    let _ = std::fs::remove_file(&control);
    // Whoever can connect can remove every workspace: the socket is its owner's alone. No request is served
    // yet, so the mask can be set for the moment the socket is made.
    // SAFETY: the calls only set a number of the process.
    unsafe { libc::umask(0o177) };
    let listener = UnixListener::bind(&control);
    unsafe { libc::umask(0) };
    let listener = listener?;
    let unmounter = Mutex::new(session.unmount_callable());
    let stop: Arc<dyn Fn() + Send + Sync> = {
        let (mountpoint, control) = (mountpoint.clone(), control.clone());
        Arc::new(move || {
            log::info!("unmounting {}", mountpoint.display());
            if let Err(error) = unmounter.lock().unwrap().unmount() {
                log::warn!("{} is in use ({error}): detaching it", mountpoint.display());
                detach(&mountpoint);
            }
            // A mount detached while in use is served until its last user leaves. The daemon does not wait.
            let control = control.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                let _ = std::fs::remove_file(&control);
                exit(0)
            });
        })
    };
    {
        let (shared, stop) = (shared.clone(), stop.clone());
        std::thread::spawn(move || control::serve(shared, listener, stop));
    }
    std::thread::spawn(move || {
        let mut signal = 0;
        // SAFETY: the set was filled above and the number is written before the call returns.
        unsafe { libc::sigwait(&signals, &mut signal) };
        log::info!("signal {signal}");
        stop();
    });
    log::info!(
        "serving {repo} at {} with {threads} threads, {} workspaces",
        mountpoint.display(),
        shared.table.read().unwrap().by_slot.len()
    );
    let served = session.run();
    let _ = std::fs::remove_file(&control);
    log::info!("stopped");
    served
}

fn ctl(args: &[String]) -> io::Result<()> {
    let (values, others) = arguments(args, &["--control"]);
    let Some(control) = values[0].clone().or_else(|| env::var("WSFS_CONTROL").ok()) else {
        fail(USAGE)
    };
    let Some((operation, fields)) = others.split_first() else {
        fail(USAGE)
    };
    let mut request = serde_json::Map::new();
    request.insert("op".into(), json!(operation));
    for field in fields {
        let Some((key, value)) = field.split_once('=') else {
            fail(format!("{field} is not <key>=<value>\n{USAGE}"))
        };
        request.insert(key.into(), json!(value));
    }
    let reply = control::call(Path::new(&control), &Value::Object(request))?;
    println!("{reply}");
    exit(if reply["ok"] == true { 0 } else { 1 })
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let done = match args.first().map(String::as_str) {
        Some("mount") => mount(&args[1..]),
        Some("ctl") => ctl(&args[1..]),
        _ => fail(USAGE),
    };
    if let Err(error) = done {
        fail(error);
    }
}

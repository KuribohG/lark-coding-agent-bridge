# Signal isolation

Workers of a workflow run as the same user on the same machine, so the kernel
lets any of them signal any other's processes. A member that tidies up with
`pkill -f cargo`, `killall node` or `kill $(lsof -ti:8080)` takes down the
builds, test runs and servers of every other member, and of the bridge itself.

Signal isolation puts each worker in a **cell**: its processes can signal each
other, and nothing else on the machine. It needs no root, no container runtime,
no user namespaces and no writable cgroups, so it works inside an unprivileged
container. It is on by default for workflow workers on Linux.

It guards against accidents, not against a process that sets out to get around
it (see [Limits](#limits)).

## What a worker sees

| A worker does | Result |
| --- | --- |
| `kill`, `pkill`, `killall`, `timeout`, a test runner stopping its children — aimed at processes the worker started | Works as before. |
| The same aimed at a process of another worker, the main agent, the bridge, or anything else | `Operation not permitted` (EPERM). `pkill -f pattern` still stops the worker's own matches. |
| `kill -9 -1` | EPERM. |
| `kill -0 <pid>` to ask whether a process exists | Always answered. |
| Stopping a job that an **earlier turn** of the same worker left running (`setsid nohup … &`) | Works: the turns of one worker session share a cell. |
| `ps`, `pgrep`, reading `/proc` | Unchanged: other workers' processes are visible, only not signalable. |
| `sudo`, `fusermount3` and other setuid programs | No longer gain privileges (see [Limits](#limits)). |

The main agent of a conversation is not in a cell and can still stop a worker's
processes. What the bridge itself starts for a workflow, such as landing checks,
is outside every cell, so no member can kill it.

Each signal that was refused is listed in `signal-cell.log` in the profile's
state directory, beside `workflows.sqlite`:

```text
2026-11-28T03:12:45Z cell=workflow:9f0c…:3b1e… denied pid=41822 (pkill) kill target=40117 (cargo) signal=15
```

One run lists at most 200 refusals, so a process retrying in a loop cannot fill
the disk.

## Turning it off

```toml
[workflow]
signal_isolation = false
```

The table is bridge-wide. The edit is picked up on reload and applies to worker
processes started after it; running ones keep what they started with. Turn it
off for a workflow whose workers must run setuid programs, for example to mount
a FUSE filesystem themselves.

`pnpm build` (and therefore `prepare` on install) compiles `bin/signal-cell`
from `native/signal-cell.c`. Without a C compiler or on another platform there
is no launcher, and workers are started as they were before. On a kernel older
than Linux 5.5 the launcher starts the worker unconfined and says so in
`signal-cell.log`. `bin/signal-cell --check` prints `ok`, `nested` or
`unsupported` for the machine it runs on.

## How it works

A worker's process is started as
`signal-cell --cell <session> -- <watchdog> <agent> …`, which makes three
processes:

```text
run host
└─ front         what the bridge holds: passes signals on, exits as the command did
   └─ supervisor a child subreaper holding the seccomp listener
      └─ command the deadline watchdog and, under it, the agent and all it starts
```

- The command runs under a **seccomp filter** that hands the six syscalls which
  send a signal (`kill`, `tkill`, `tgkill`, `rt_sigqueueinfo`,
  `rt_tgsigqueueinfo`, `pidfd_send_signal`, on the 64-bit, x32 and 32-bit entry
  points) to the supervisor. Every other syscall is allowed inside the kernel
  and costs nothing measurable. Signal 0 and `SIGURG` are allowed there too: the
  first only asks whether a process exists, the second is ignored unless a
  process asks for it, and Go programs send it to their own threads constantly.
- The **supervisor** lets a signal through when the target descends from a
  supervisor of the same cell ID, and answers EPERM otherwise. A process group
  is judged by one member: the command leads a session of its own and a process
  can only join a group of its session, so a group holds processes of the cell
  or none.
- The supervisor is a **child subreaper**, which is what keeps that test exact.
  An orphaned `setsid nohup` job would otherwise be adopted by init and lose
  its ancestry; here the supervisor adopts it. The supervisor therefore stays
  for as long as anything started in the cell is alive, and exits with the last
  of it.
- The cell ID is the worker's session, the same key as its
  [scratch directory](workflows.md#scratch-directories). A later turn starts a new
  supervisor with the same ID, and the two recognise each other by name and
  command line, so the later turn can stop what the earlier one left.
- The **front** is the process the run host started. It forwards `SIGTERM`,
  `SIGINT`, `SIGHUP`, `SIGQUIT`, `SIGUSR1` and `SIGUSR2` to the command's
  process group and exits with the command's exit code or signal, so stopping a
  run, its deadline, and how its end is reported all behave as they do without
  a cell. When the process that started the run is gone, the front sends the
  command `SIGTERM`, since nobody is left to stop it. If the front itself is
  killed outright, the supervisor ends the command: `SIGTERM`, then `SIGKILL`
  five seconds later.

The deadline watchdog is inside the cell on purpose. When a run ends it kills
what is still attached to the agent, as before, and those kills are the cell's
own. A job the agent had already detached is no descendant of the agent any
more, so the watchdog leaves it, also as before.

Measured on Linux 6.8: a syscall that is not one of the six costs the same in
and out of a cell within noise, and a signal that goes to the supervisor takes
about 13 µs instead of under 1 µs.

## Limits

- **`no_new_privs` is set**, as an unprivileged seccomp filter requires. Setuid
  and file-capability programs run without their privileges inside a worker:
  `sudo`, `su`, `mount`, and `fusermount3`, so a worker cannot mount a FUSE
  filesystem. [wsfs workspaces](workflow-worktrees.md) are mounted by a daemon
  of the bridge and are not affected.
- **Only signals are confined.** Other workers' processes stay visible, and
  ports, files under `/tmp`, CPU and memory are shared as before. The
  [exec sandbox](exec-sandbox.md) limits writes and composes with a cell; the
  [scratch directory](workflows.md#scratch-directories) separates temporary files.
- **Not a security boundary.** `ptrace`, `/proc/<pid>/mem` and
  `process_vm_writev` are not mediated. Between the supervisor's decision and
  the kernel acting on it the target's PID could in principle be reused; with
  PIDs handed out in sequence that needs the whole PID range to wrap within
  microseconds.
- **Shared daemons belong to whoever started them.** A build server, a compiler
  cache daemon or a database that one worker starts cannot be stopped or
  restarted by another. Start such a thing from the main agent when several
  workers are to manage it.
- **One listener per process.** A program that installs a seccomp user
  notification listener of its own fails with `EBUSY` inside a cell. A cell
  started inside a cell (a worker running this repository's tests) adds no
  listener and falls under the outer cell's rules.
- **A supervisor that is killed takes its cell's rules with it.** Processes it
  leaves behind are adopted by init, later turns no longer recognise them as
  the worker's own, and their own signal syscalls fail with `ENOSYS`. Nothing
  inside a cell can signal a supervisor; only an outside `kill -9` does this.
- **What is not covered.** Ordinary conversation turns are not put in cells.
  Neither are agents that do not run as a process of their own on this machine:
  Pi with `transport = "sdk"` (one host serves every session), a
  [workcell or remote host](configuration.md), and Codex in daemon mode, where
  the run's process is only a proxy to the shared `codex app-server`.
- **Architectures.** x86_64, including its 32-bit and x32 entry points, and
  aarch64, where a 32-bit ARM program is not confined.

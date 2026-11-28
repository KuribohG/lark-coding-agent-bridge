# Exec sandbox (Landlock)

The exec sandbox puts every agent run under a Linux
[Landlock](https://docs.kernel.org/userspace-api/landlock.html) domain, so the
agent, the tools it runs, and every process they spawn inherit one kernel-level
write allowlist. It exists to bound the blast radius of a wrong-path delete, a
bad `rsync --delete`, or an instruction injected into the model — not to stop a
determined attacker (see [Limits](#limits)).

It is off by default.

## Enabling it

```toml
[profiles.codex.exec_sandbox]
enabled = true
# Optional: refuse to start a run when the launcher or Landlock is missing
# instead of falling back to an unsandboxed run.
require_landlock = true
# Optional: deny every TCP bind/connect (default true). Unix sockets are not
# affected either way.
allow_tcp = true
# Optional extra writable roots, on top of the defaults below. `~/...` is expanded.
read_write = ["/data/artifacts"]
# Optional extra read-only roots; `/` is already readable.
read_only = []
```

The table is per profile, next to `permissions`. `pnpm build` (and therefore
`prepare` on install) compiles `bin/landlock-exec` from
`native/landlock-exec.c`; on non-Linux hosts the build is skipped and runs stay
unsandboxed.

## What a run can write

Defaults, all of which may be missing on a given host (missing paths are
skipped):

| Path | Why |
| --- | --- |
| the run's `cwd` | the conversation workspace |
| `os.tmpdir()` | prompt/system-prompt files and general temp files |
| `/dev` | `/dev/null`, `/dev/tty`, `/dev/pts`, `/dev/shm` |
| `~/.cache`, `~/.config`, `~/.local/share`, `~/.local/state` | tool caches and config |
| `~/.npm`, `~/.pnpm-store`, `~/.cargo`, `~/.rustup`, `~/.ccache` | package managers and compilers |
| harness state: `CLAUDE_CONFIG_DIR` or `~/.claude` + `~/.claude.json`; `CODEX_HOME` or `~/.codex`; `PI_CODING_AGENT_DIR` or `~/.pi` | session transcripts and harness state |
| `LARKSUITE_CLI_CONFIG_DIR` | `lark-cli` reads and refreshes its own config |
| `exec_sandbox.read_write` | per-profile extras |

Everything else is readable but not writable. In particular `~/.ssh`,
`~/.gitconfig`, `~/.lark-channel` (the bridge config and secrets), and every
repository or worktree outside the run's `cwd` are read-only. That is deliberate:
the bridge config is hot-reloaded, so an agent that could rewrite it could also
widen its own sandbox.

Reads are not restricted at all — `/` is granted read and execute. Secrets are
still readable by any agent that can read them today; the sandbox only stops
writes.

## Workflow workers

A profile's table confines every run of the profile: the conversations of the
main agent and every workflow worker alike, each to its own `cwd`. To confine
the workers and leave the main agent free, give the workers a table of their
own in the bridge-wide `[workflow]` table instead:

```toml
[workflow.worker_sandbox]
enabled = true
require_landlock = true
# What the members of your workflows must write outside their worktrees.
read_write = ["/shared/pool"]
```

It has the keys of a profile's table and takes its place for the workers that
are not leads; edits apply to worker processes started after them. A member
that leads, the lead of a swarm or of queues of one, is run as the main agent
is: with the profile's table, which may be none, and outside the
[signal cells](signal-isolation.md).

A confined worker can write

- its working directory: the worktree, clone or wsfs workspace it was given,
  or the directory of the workflow when it has none;
- its [scratch directory](workflows.md#scratch-directories), which is its
  `TMPDIR`; the machine's shared `/tmp` is closed to it;
- the tool caches and harness state of the [defaults](#what-a-run-can-write);
- what a commit in its working directory writes outside it: the checkout's own
  Git directory (`<repository>/.git/worktrees/<name>`, which holds its index and
  `HEAD`) and the repository's object store. The bridge adds these for each
  worker;
- `read_write`.

So a member can build, test and commit in its worktree, and
`submit_work` lands what it committed, because the bridge does the landing. It
cannot write the main checkout, another member's worktree, or the repository's
shared `config`, `HEAD` and refs: `git switch -c`, `git branch` and `git tag`
fail with `Permission denied`, and a member works on the detached `HEAD` its
worktree starts with. A `"clone"` workspace keeps its own refs and config
inside the working directory, so branches work there. The object store is
shared and writable, as it has to be for a commit: this guards against a wrong
path, not against a member that sets out to damage the repository.

For a script this means: members must keep what they produce inside their
worktree or name it in `read_write`; a script or tool that writes `/tmp/...`
by name fails, and should use `$TMPDIR`; whatever members share outside the
repository (a container pool's lease files, a shared build cache) must be
listed. Workers are told in their instructions that a refused write is the
sandbox. What the bridge runs itself, the landing `checks` among it, is not
confined.

## Shared runtimes: pi with `transport = "sdk"`

`pi.transport = "sdk"` serves every session of a profile from one long-lived
host process, and a Landlock domain cannot be widened or lifted once applied, so
there is no per-run domain to apply. Instead the bridge puts **the host itself**
under one static, profile-scoped domain when it starts:

- writable roots are the defaults above (without a run's `cwd`), plus the
  profile's bridge workspaces (`workspace_root`, by default
  `<config dir>-workspaces`), the agent home root (`<config dir>/agents`), the
  Pi `agentDir`, and `exec_sandbox.read_write`;
- every session of that profile shares it, so one run's domain can never be
  narrowed for the next;
- `require_landlock = true` makes a missing launcher or kernel support a host
  start failure instead of an unsandboxed fallback.

A host that runs on another machine (`pi.remote`) cannot take this domain at
all — the launcher is a binary on the bridge machine — and the configuration
rejects the pair; isolation there is whatever the remote node enforces.

The consequence to plan for: **a run's `cwd` is not added automatically**. If a
conversation or worker works in a repository outside the workspace roots, add
that path to `read_write`, or its writes fail with `EACCES` (the bridge logs
`pi-sdk-sandbox-cwd-read-only` once per such cwd). The sandbox also cannot
separate two workspaces from each other — it is one domain for the profile.

## How a run is wrapped

`src/platform/exec-sandbox.ts` turns the profile settings into a launcher
command line, and the agent layer applies it in two places:

- `spawnWithDeadline` (`src/agent/deadline.ts`) wraps the command before the
  deadline watchdog, so the watchdog and the agent share one domain. This covers
  Claude, Codex (per-run app-server), pi and agy.
- `spawnAgentProcess` (`src/agent/run-host.ts`) bakes the same command line into
  the run host's `spec.json`, so a detached run is sandboxed when the host
  starts the agent.

MCP servers, `lark-cli`, `workflow-cli` and shell tools all inherit the domain
because they are descendants of the agent process.

## Diagnostics

```bash
node native/build.mjs                  # build the launcher
./bin/landlock-exec --print-abi        # 0 means the kernel has no Landlock
./bin/landlock-exec --help
```

Exit code `125` means the launcher refused to run (used with `--require`).
`126`/`127` are exec failures.

When a run starts, the `run started` log line carries `execSandbox`, and the
spawn log carries the agent pid as usual.

## Limits

- **Reads are unrestricted.** The allowlist is write-only by design; tightening
  reads means enumerating every toolchain and would break more than it protects.
- **Unix sockets are not mediated.** Landlock (ABI 4) does not restrict
  `connect(2)` on filesystem sockets, so a process can still talk to
  `docker.sock`, the session bus, or `systemd --user`. Keep those reachable only
  by accounts you trust with root-equivalent access.
- **`allow_tcp = false` is coarse.** Rules are per port, not per destination, and
  UDP/DNS are unaffected.
- **Kernel support varies.** ABI 4 (Linux 6.7) is needed for TCP rules; ABI 3
  (6.2) for `TRUNCATE`; older kernels simply grant fewer rights. On kernels
  without Landlock the launcher falls back to an unsandboxed exec unless
  `require_landlock` is set.
- **Codex daemon mode is not covered.** The shared `codex app-server` daemon is
  started outside the per-run sandbox; use `appServerMode = "per-run"` (the
  default) or Claude/pi/agy when the sandbox has to hold.
- **`no_new_privs` is set**, so setuid helpers (including `sudo`) stop working
  inside a run.
- **The run host process itself stays outside the domain**; only the agent it
  starts is sandboxed.
- **Signals are not mediated.** Landlock before ABI 6 (Linux 6.12) cannot scope
  them; workflow workers get that from [signal isolation](signal-isolation.md),
  which composes with this sandbox.

## Working with git

A repository inside the run's `cwd` is writable, so `git add`/`commit` work
there. Anything else — including a linked worktree's *common* git directory —
is not. A linked worktree keeps its index at
`<main-repo>/.git/worktrees/<name>/index`, so committing from one needs both
the worktree and that directory in `read_write`:

```toml
read_write = [
  "/data/worktrees/bridge-feature-x",
  "/data/repos/lark-coding-agent-bridge/.git/worktrees/bridge-feature-x",
]
```

Git reports the missing grant as `fatal: Unable to create '.../index.lock':
Permission denied`. [Workflow workers](#workflow-workers) confined by
`[workflow.worker_sandbox]` are given both for their own worktree.

## Iterating on a profile

Start with `enabled = true` and no `require_landlock`, run the workflows you care
about, and add the paths that report `Permission denied` to `read_write`. A
denial surfaces as an ordinary `EACCES` in tool output or the run's stderr —
Landlock does not log denials, so the tool's own error is the signal.

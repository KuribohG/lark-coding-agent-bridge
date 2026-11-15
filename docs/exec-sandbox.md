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
Permission denied`.

## Iterating on a profile

Start with `enabled = true` and no `require_landlock`, run the workflows you care
about, and add the paths that report `Permission denied` to `read_write`. A
denial surfaces as an ordinary `EACCES` in tool output or the run's stderr —
Landlock does not log denials, so the tool's own error is the signal.

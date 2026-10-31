# Windows standalone Web validation

Validated on 2026-10-22 against `dev` at `4f701a8`, with the accompanying changes.
Scope: native Windows standalone Web chat using Codex and an existing custom
Responses provider. No WSL, Docker, Lark account or credentials are needed for
this mode. This is not validation of every integration in the repository.

## Fixes

- Resolve execution defaults even when `web` receives no TOML file, so Codex and
  Pi have default executable paths and retain their existing permission limits.
- Match the Codex adapter factory's default home inheritance to the configuration
  normalizer. Only explicit `inheritCodexHome = false` selects an isolated home.
- Wait for the Codex test process to exit before removing its working directory,
  preventing Windows `EBUSY` cleanup races.
- Provide optional Windows start/stop scripts with a separate Codex home for
  custom Responses providers. Sharing the desktop app's home produced an
  `already has an active writer` error during restart testing; isolated state
  avoids the conflict without altering the user's global configuration.
- Keep bearer tokens and literal HTTP header values in child-process environment
  variables, not generated configuration, command arguments or repository files.

See [channels.md](channels.md) for the normal CLI and optional Windows launcher.

## Successful checks

- Node.js 24.14.1, pnpm 10.33.0, Codex CLI 0.163.0-alpha.10.2.
- Frozen install and `npm run build`, backend/frontend typechecks, and
  `git diff --check`.
- 25 relevant test files, 208 tests: agent unit tests, Web CLI defaults, config
  resolution, Web channel integration, Codex app-server process contracts,
  Windows runtime/process cleanup, and launcher credential-isolation tests.
- Real browser/provider reply and a read-only shell command returning
  `win32 v24.14.1`.
- After restarting the isolated deployment, the same conversation recalled its
  previous test marker and command output.
- HTTP: page 200, unauthenticated API 401, authenticated API 200, foreign origin 403.
- Packaged PowerShell launcher starts a hidden server and stops only its verified
  process tree; the existing primary Web server remains unaffected.

Use the package's pinned pnpm version. This machine's global pnpm 11 ignored the
older `pnpm.onlyBuiltDependencies` setting and rejected install-script handling;
`npx --yes pnpm@10.33.0 install --frozen-lockfile` completed without changing the
lockfile.

## Remaining findings outside this Web deployment

The full suite is **not** green. Before adding the four launcher configuration
tests, the full rerun had 1756 passing, 36 failing and 8 skipped tests. Failures
were in these nine files:

- `tests/process/pi-adapter.test.ts`
- `tests/integration/cli/start-codex-legacy-config.test.ts`
- `tests/integration/runtime/supervisor.test.ts`
- `tests/unit/runtime/agent-resolver.test.ts`
- `tests/unit/daemon/launchd-autostart.test.ts`
- `tests/unit/inbox/claude-manager.test.ts`
- `tests/unit/inbox/gui.test.ts`
- `tests/unit/inbox/manager.test.ts`
- `tests/unit/storage-monitor/service.test.ts`

These include other process-cleanup races, Unix-shell test fixtures, macOS service
assertions and Inbox/storage-monitor failures. They are not hidden or skipped by
this patch, and Lark/Claude/Pi were not validated against real accounts.

`npm run lint:dead` also reports three existing unused exports:
`parseModelJson` in `src/inbox/values.ts`, and `analysisFailureReason` /
`backgroundAnalysisError` in `src/inbox/analysis-error.ts`.

The tested Codex CLI occasionally takes longer than the bridge's two-second
post-completion grace period. The existing cleanup logs
`post-done-exit-timeout` and terminates that run's process. Real replies and
isolated restart/resume passed; this patch does not hide the warning, expand
permissions or relax the timeout.

## Daemon compatibility follow-up (2026-10-31)

The later default of `appServerMode = "daemon"` requires a different Windows
transport from the per-run validation above. Node's Windows pipe connection
cannot reach Codex's AF_UNIX socket. The WebSocket bridge now uses the configured
CLI's `app-server proxy --sock` command as its byte transport on Windows; Codex
continues to own the persistent daemon. Stopping a proxy also cleans up its
Windows command launcher and native child.

New optional Web launcher installations use a short home under
`%USERPROFILE%\.lark-web`; existing `.web-local` state and explicit `-StateDir`
values are retained. The launcher recognizes npm's `codex.cmd` entry point and
accepts an explicit `-CodexBinary`. See [channels.md](channels.md) for package
requirements and moving an existing home when its socket path is too long.

This follow-up was checked on Linux: process tests cover WebSocket framing,
Unicode paths, errors, reconnection, daemon reuse, and state-directory selection.
A real Codex CLI 0.165.0 app-server completed `initialize` through its native byte
proxy. This is not a native Windows AF_UNIX or PowerShell end-to-end result;
the daemon process fixtures also run on Windows using a named-pipe test server.

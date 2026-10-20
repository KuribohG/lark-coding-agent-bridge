# Windows deployment validation

The bridge has native Windows launchers and a Task Scheduler backend. Changes
in this patch have been checked on Linux; native Windows acceptance is still
required before treating a deployment as supported end to end.

Use Node 20.19+ or 22.12+ within the versions allowed by `package.json`. Install
the bridge globally before registering a service, so its recorded CLI path
does not point into a temporary `npx` cache. Install and authenticate the chosen
agent on the same Windows account that will run the bridge. The bundled
`@larksuite/cli` is optional: a successful npm install alone does not prove that
its downloaded executable or the agent is usable; run the bridge preflight.

For an initial deployment, run `run-lark-cc fg` in a terminal and complete setup
in the local console. `run-lark-cc` starts a background process but does not
register login autostart. `lark-channel-bridge start --web-ui` registers the
Task Scheduler service. Its task uses the current interactive user; logout,
sleep and power loss are outside the continuous-running guarantee. Do not run
it as SYSTEM to work around installation errors: that changes the user home,
credentials and agent configuration.

The Windows service explicitly disables the default 72-hour execution limit
and the start/stop restrictions on battery power. Re-run service installation
to update an existing task; a plain restart does not rewrite its definition.
Status checks use Task Scheduler's numeric state through Windows PowerShell
and COM, so they do not depend on the OS display language. PowerShell and COM
access must be available to the service-management account.

Generated batch files use UTF-8, disable delayed expansion and quote static
arguments. Profiles cannot use Windows device names (`CON`, `NUL`, `COM1`,
etc.) or end with a dot. When moving from Linux, recreate machine credentials
and rewrite workspace/executable paths: copying the config directory is not a
credential migration. The bridge keystore derives its key using the machine
hostname and username.

Stopping a child on Windows uses `taskkill /T /F` while its root is alive.
Codex first attempts the protocol interrupt. Forced termination is not a
graceful POSIX signal and cannot guarantee application-level flushing. This
does not provide Windows Job Object containment: unexpected bridge death,
already-orphaned descendants and task-manager termination still need live
testing. Native deadline tests cover a live agent tree; Linux-only tests of
detached descendants and parent death do not establish the same Windows
guarantee.

Before deployment, exercise these cases on the target Windows installation:

- Foreground setup, app binding, user OAuth and a real Claude/Codex round trip.
- Non-ASCII paths and profiles, spaces, and any shell metacharacters used by
  the actual installation path, including the outer npm and scheduled-task
  launchers.
- Agent tool execution, stop, deadline expiry and absence of leftover agent,
  shell and tool processes; also force-close the bridge separately.
- Non-admin Task Scheduler installation, start/stop/restart, login autostart,
  localized status output, sleep/resume and battery transitions. Confirm
  `ExecutionTimeLimit=PT0S` and both battery restrictions are false in the task.
- The native tests in `tests/process/windows-runtime.test.ts`. Linux skips
  these tests. The CI OS matrix by itself is not evidence that they passed.

Microsoft references:
[execution limit](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit),
[start on battery](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-disallowstartifonbatteries),
[stop on battery](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-stopifgoingonbatteries).

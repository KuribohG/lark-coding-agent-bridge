# Advanced runtime reference

[Quick start](../README.md) · [Configuration](configuration.md) · [中文参考](user-guide/runtime-reference.md)

This page keeps the detailed Lark/CLI contracts out of the quick start. For standalone browser chat, use the [Web channel guide](channels.md); Lark slash commands are not browser controls. Commands below assume a stable global installation; from a source checkout, replace `lark-channel-bridge` with `node bin/lark-channel-bridge.mjs`. JSON snippets illustrate individual fields, not a loadable configuration file. Runtime configuration is TOML.

## In-flight Codex input

Bridge uses Codex `app-server` for native bidirectional input, verified with Codex 0.162.1. The `exec` backend has been removed. Existing configurations must remove `transport = "exec"` or change it to `"app-server"` under `[agents.codex.launch]` or `[profiles.<name>.launch]`. App-server loads normal user configuration and execpolicy `.rules`; `ignoreUserConfig` and `ignoreRules` default to `false` and must not be `true`. Launch changes require a bridge restart.

Codex launch defaults to `appServerMode = "daemon"`. Bridge ensures the official local app-server daemon is running and uses one short-lived stdio-to-Unix-WebSocket connection per run, so daemon-owned memory work survives after the Bridge run ends. `appServerMode = "per-run"` keeps the server process scoped to the run and forces `memories.generate_memories = false`; existing memory reads and Codex's native startup path remain available. `per-run` is an explicit fallback for environments where a persistent daemon is unsuitable.

Native async questions (`request_user_input_async`, delivered as `agentMessage.questions`) appear in separate “需要你回复” cards, mentioning the initiating user in the original group topic. Choice buttons and a free-text form send answers into the running task and display a receipt. No option is submitted automatically. After normal completion, answers can queue into the original session if it remains valid. Stopping, changing sessions, expiry, or restarting invalidates old cards. Only the intended user can answer. A failed card send falls back to a text reminder, independently of the progress display mode. This does not add synchronous question or permission approval support; notification sounds depend on the Lark client settings.

Send additional text normally: `turn/steer` appends it to the same process, thread, and turn. The acknowledgement means Codex accepted the input, not that the model has acted on it. Quoted context is included; attachments and agent-created card callbacks still use the queue. Input explicitly rejected because the turn ended falls back to the next turn. Ambiguous delivery failures are reported without automatic replay.

`/stop` cancels queued messages and input preparation before interrupting the active run, and sends a receipt. It does not undo completed actions. Existing topic isolation, access checks, and mention requirements still apply. Text can steer timed runs without changing their deadline; other timed-run input remains rejected rather than queued.

## In-flight Claude input

Bidirectional input is verified with Claude Code 2.1.302. Upgrade the `claude` executable used by the bridge and load this bridge version; no extra profile setting is required. The adapter keeps `--input-format stream-json` open so additional text reaches the same process and session. Claude incorporates it when it can process new input, or continues in the same process if the current generation has already finished.

The bridge acknowledges delivery only after a receipt containing the input ID. It finishes only when results cover every submitted input, so an earlier result cannot discard a new message. Acceptance does not mean execution and does not forcibly interrupt a running tool. Quoted context, attachment queueing, access checks, timed deadlines, and `/stop` follow the rules above. Missing receipts or disconnections are reported as unknown delivery without replay; errors with unaccounted supplemental input are not automatically retried.

Older CLIs can complete a single prompt, but supplemental input requires result correlation IDs. Missing fields produce an explicit failure instead of a false completion.

## Pi Coding Agent backend

Create a Pi profile with `lark-channel-bridge profile create pi --agent pi`, or use `--agent pi` during first-run setup. The adapter invokes `pi --mode json`, translates Pi's JSONL events, persists the returned session ID, and resumes later turns with `--session`. `LARK_CHANNEL_PI_BIN` overrides the `pi` executable used during profile creation.

Pi JSON mode is request/response rather than a duplex transport, so messages sent while a Pi turn is running queue for the next turn instead of steering the active one. Read-only profiles expose only `read`, `grep`, `find`, and `ls` and disable extensions. Full profiles inherit Pi's normal tools. Pi has no portable workspace-only filesystem sandbox, so the bridge rejects the `workspace` access mode rather than silently treating it as isolated.

The current `@earendil-works/pi-coding-agent` package requires Node.js 22.19 or newer. The adapter also accepts the `@mariozechner/pi-coding-agent` 0.73 JSON protocol on supported Node versions.

## Automatic rate-limit retries

For ordinary tasks, after the agent exhausts its own API rate-limit retries (for example, `exceeded retry limit, last status: 429 Too Many Requests`), the bridge retries up to 100 consecutive times without progress, waiting 30 seconds, then 60 seconds, then 120 seconds for each remaining retry. New non-whitespace text, thinking content, or tool activity resets the retry count and backoff, so the next rate limit starts at attempt 1 with a 30-second wait. Session metadata, usage statistics, and blank output do not reset retries. Process messages and streaming replies show retry progress. If a process-message update fails, the bridge drops that best-effort batch and keeps the existing COT available for later progress while execution and retries continue. Stop commands, session switches, and task deadlines cancel retries. After partial progress, the bridge resumes the session reported by this run and asks the agent to check completed operations before continuing. Quota/budget exhaustion, authentication failures, and follow-up input with unknown delivery status are not retried. Temporary forked tasks and runs that produced output without reporting a session ID are also excluded.

## Background service

Use `run` for first-run setup and foreground debugging. After the bot can send and receive messages, stop the foreground process with `Ctrl-C`, then use an OS-managed service for background operation:

```bash
lark-channel-bridge start
lark-channel-bridge status
lark-channel-bridge stop
```

Install globally before using service commands. The daemon's launchd plist / systemd unit / Windows task records the bridge CLI path; if that path comes from an npm temp cache through `npx`, the daemon can break when the cache is cleaned. `run` is fine through `npx` as a one-shot foreground process.

Service commands install a per-profile service:

```bash
lark-channel-bridge start [--profile <name>]
lark-channel-bridge stop [--profile <name>]
lark-channel-bridge restart [--profile <name>]
lark-channel-bridge status [--profile <name>]
lark-channel-bridge unregister [--profile <name>]
lark-channel-bridge logs [--profile <name>|--web-ui] [--follow] [--lines <count>]
```

Scripts and non-interactive callers must provide `--profile <name>` or `--web-ui` explicitly. Lifecycle commands print the resolved service and profile before acting.

`status --json` is the machine-readable deployment snapshot and does not require
an explicit service target. It reports the executing package version, embedded
build commit/time, entry file and release directory, OS service state, every
registered profile/agent/PID/bot, startup and current config revisions, and
whether each process matches the invoking build. A config hash difference means
the file changed after that process registered; it does not by itself prove that
`/config reload` was not applied. `status --json` does not resolve secrets or
contact agents/providers.

`start --web-ui` starts the persisted `bridge.autostart_profiles` set. Existing configurations without that field keep the legacy active-profile fallback. The active profile is now only the CLI default and does not implicitly define the supervisor boot set:

```bash
lark-channel-bridge profile autostart work on
lark-channel-bridge profile autostart work off
lark-channel-bridge profile autostart work
```

`start --web-ui --profile work` pins `work` into the installed supervisor service so later active-profile changes cannot redirect a service restart.

Platform mapping:
- **macOS**: launchd user agent `ai.lark-channel-bridge.bot.<profile>`
- **Linux**: systemd user unit `lark-channel-bridge.bot.<profile>.service`
- **Windows**: current-user `ONLOGON` Task Scheduler task `LarkChannelBridge.Bot.<profile>`, launched through a `.cmd` wrapper

Daemon logs are under `~/.lark-channel/profiles/<profile>/logs/daemon/`.

### Multiple profiles: Claude and Codex

`profile use <name>` changes the CLI default only; it does not change the supervisor boot set. Each profile keeps its own app credentials, sessions, working directories, and logs. Create multiple profiles only when you need to connect multiple PersonalAgent apps, or run Claude and Codex as separate bots:

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile codex --agent codex
```

For example, to restart only the Codex bot:

```bash
lark-channel-bridge restart --profile codex
lark-channel-bridge status --profile codex
```

## Commands

### Host CLI

```text
lark-channel-bridge run [--profile <name>] [--agent claude|codex|pi] [--workspace <path>] [-c <config>]
lark-channel-bridge config check
lark-channel-bridge config show --profile <name> --sources
lark-channel-bridge status --json
lark-channel-bridge ps
lark-channel-bridge kill <id|#>
lark-channel-bridge --help
```

`profile use <name>` changes the profile used by later default starts. Use these profile management commands when running separate Claude / Codex / Pi bots, connecting multiple PersonalAgent apps, or doing scripted deployment:

```bash
lark-channel-bridge profile create claude --agent claude
lark-channel-bridge profile create codex --agent codex
lark-channel-bridge profile create pi --agent pi
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
lark-channel-bridge profile export <name> [--output ./profile.toml] [--force]
lark-channel-bridge profile export <name> --include-secrets --yes
```

`profile remove` archives local state by default, including the active profile. If other profiles remain, the bridge switches to the next one; if it was the last profile, the root config is cleared so the same name can be created again. `--purge --yes` permanently deletes local state. `profile export` redacts app secrets by default; `--include-secrets --yes` includes sensitive config.

If a profile was created with the wrong agent kind, stop or unregister any matching background service first, then run `profile remove <name>` and recreate it with the intended `--agent`.

### Slash commands inside Feishu / Lark

| Command | Effect |
|---|---|
| `/new`, `/reset` | Clear the current session |
| `/btw <question>` | Answer a side question in this topic/chat, remembering previous side Q&A |
| `/cd <path>` | Switch working directory and reset the session |
| `/ws list` | List named workspaces |
| `/ws save <name>` | Save the current working directory as a named workspace |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Delete a named workspace |
| `/resume` | Resume compatible history for the same agent, working directory, and permission mode |
| `/recent [N]` | List recently completed sessions with links to the originating message (default 5, maximum 20); owners/admins see the whole profile, other users see the current chat/topic |
| `/status` | Show profile, agent, working directory, session, context occupancy, lark-cli identity, and run state |
| `/config` | Inspect configuration and open separate execution, Lark display or access forms |
| `/model [model-id\|default]` | View or change the current topic/chat model; accepts custom IDs |
| `/effort [level\|default]` | View or change the current topic/chat reasoning effort |
| `/run [defaults\|status\|stop]` | Create a one-shot task, configure its defaults, or inspect/cancel it |
| `/invite user @name` | Allow a user to use the bot in DMs |
| `/invite admin @name` | Add an access-control admin |
| `/invite group` | Allow the current group to use the bot |
| `/invite all group` | Allow all groups the bot has joined |
| `/remove user @name`, `/remove admin @name`, `/remove group` | Remove access entries |
| `/stop` | Stop the current run, including the card stop button |
| `/timeout [N\|off\|default]` | Set or clear the current session idle watchdog |
| `/ps` | List local bridge processes |
| `/exit <id\|#>` | Stop a bridge process |
| `/reconnect` | Force a WebSocket reconnect |
| `/doctor [description]` | Run low-sensitive diagnostics |
| `/help` | Help card |

DMs do not require an @ mention. Groups and topic groups require `@bot` by default; `@all` is ignored. Cloud-doc comments in supported document types run when the bot is mentioned.

### Conversation context

Codex receives the stable bridge instructions through app-server `developerInstructions`; per-turn user text contains only the current Lark context and request. Topic groups seed a new native session from the newest upstream messages (normally at most 40 messages / 30,000 characters). A resumed topic imports only messages after the last complete context import, because unmentioned group chatter is not present in the native session. Imports stop at the triggering batch's newest timestamp, exclude the bot's own app messages, and track initial/steered input message IDs so already-delivered input is not replayed. A failed, partial, or truncated import does not advance the cursor; the agent is told that the historical context is incomplete.

When Codex reports context occupancy, `/status` shows the percentage of the model context window used. Automatic Codex compaction is logged and shown as a progress status; completed turns retain the latest measured occupancy in the session catalog.

## Side questions

`/btw <question>` returns one reply labeled “旁问 /btw” in the current topic (or current chat for regular groups and DMs). Only `/btw` is registered, with no aliases. Claude and Codex share this behavior; a main session must already exist in this scope.

A “Typing” reaction acknowledges the question while it is queued or running, and is removed when it finishes or is cancelled. If the question is withdrawn before the answer is sent, the bridge retries against the original topic root when available, or sends to the same chat for non-thread questions.

Incoming-message batches are persisted per profile under `pending-queue.json` and restored only after the channel reconnects. Queues are bounded to 100 messages / 200,000 text characters per scope and flush after at most five seconds even under continuous debounce refresh. `/stop`, `/new`, `/cd`, workspace switches, and `/resume` cancel both queued input and a batch still in preparation before changing run state.

Each question forks the main session's currently saved context and includes earlier successful side Q&A. Side questions have a separate per-scope queue, are never batched, and do not change the main session binding. The main task continues; side work can run concurrently when a process slot is available. The side agent is instructed to answer from existing context without continuing the main task.

History is private to the bot profile and topic/chat, shared by users in that scope, and survives bridge restarts. Replay is limited to the latest 20 exchanges and about 60000 characters; oversized individual history entries are truncated. `/new`, workspace switches, and successful `/resume` clear side history for the scope. `/stop` cancels both the main task and active/queued side questions. Automatic topic-history imports exclude side Q&A; explicitly quoting a side reply can still bring it into the main conversation.

## Model and Reasoning Effort

```text
/model provider/custom-model
/effort high
/model default
/effort default
```

Without arguments, `/model` and `/effort` open a form showing the settings' source and scope. Type a model ID directly or choose a suggestion; the list is not an allowlist. Codex uses the profile's local CLI model catalog when available. Custom provider IDs need no bridge code changes; availability is determined by the provider.

Each field inherits independently: **topic/chat override → bot profile default → CLI default**. Topic settings affect only that topic; ordinary groups and DMs each use their chat scope. Users in the same topic/group share its settings. `default` removes the corresponding override. Preferences survive `/new`, `/cd`, and bridge restarts.

Owner/admin users can edit bot defaults in `/config` or the web console, or send:

```text
/model provider/custom-model --scope profile
/effort high --scope profile
```

Profile defaults affect conversations without an override for that field, plus meeting and document-comment tasks. Other profiles and independent terminal sessions are unaffected. Editing an offline profile in the web console takes effect when that profile next starts.

Changes apply when the next task is submitted. Running or already-submitted tasks retain their parameters; messages waiting to be batched remain queued and use the settings at submission. Switching preserves context and the native session ID and requires no bridge restart. `/status` shows both active and next-task settings. Cross-model resume remains subject to CLI/provider compatibility.

Known models validate reasoning levels against the local catalog, rejecting explicitly submitted unsupported combinations. If a model switch makes an inherited bridge effort incompatible, a catalog-provided model default is used for that run and noted in the settings summary. Unknown models are validated by the CLI/provider. Inherited CLI defaults are passed through by omitting the corresponding flags; global and project CLI config files are never rewritten.

Bot defaults live in `config.toml` under `profiles.<profile>.run`. Chat overrides live separately from transcripts in `profiles/<profile>/scope-preferences.json`.

## One-shot tasks with a deadline

Send `/run` to open a form for the task, deadline, timezone, safety margin, and temporary model/effort. Model IDs can be typed manually. Submitting the form creates a preview; **nothing starts until the creator confirms the concrete date and stop time**. The equivalent command is:

```text
/run --until 01:00 --tz Asia/Shanghai --margin 5 --effort ultra -- Review the project and save findings
```

Save reusable defaults once (owner/admin only), then supply just the task:

```text
/run defaults --until 01:00 --tz Asia/Shanghai --margin 5 --effort ultra
/run Review the project and save findings
```

Plain `/run <task>` uses the saved defaults; everything in the task body, including later `--` or `--effort` text, stays literal. `/run -- <task>` remains supported. When supplying leading run options, separate them from the task with `--`, for example `/run --effort high -- Review the project`. If the task itself starts with `--` or a reserved subcommand (`status`, `start`, `stop`, `defaults`), use `/run -- <task>` to treat it as task text. `/run` alone opens the form, and management subcommands keep their existing meaning.

`/run defaults` opens the defaults form; `/run defaults reset` restores the built-in two-hour window, five-minute margin, local timezone, and inherited conversation model/effort. Defaults belong to this bot profile and are stored separately in `profiles/<profile>/run-defaults.json`; ordinary chat settings and other profiles are unaffected. The task form is pre-filled from these defaults. Explicit flags override only the new task; `--model default` / `--effort default` inherit the conversation values for that task. Default deadlines accept recurring clock inputs or durations, never fixed dates. Each new preview computes a fresh absolute deadline, while existing previews/runs keep their original values. If the next clock occurrence is already inside its safety margin, the task is rejected rather than moved to the following day. The shorthand still requires confirmation and never schedules daily execution.

`01:00` means the next occurrence in the selected IANA timezone. You can also enter `2h`, `90m`, or an explicit date such as `2026-09-22T01:00+08:00`, up to seven days ahead. The margin is in minutes (default 5). For a 01:00 deadline and five-minute margin, the prompt asks the agent to wind down at 00:50 and the independent process guard terminates work at 00:55. Wind-down is agent guidance, not a guaranteed final summary; existing files and conversation history remain available. The normal idle watchdog still applies independently.

`--effort ultra` is the strongest tier on both agents, mapped per backend: Codex receives `model_reasoning_effort="ultra"`; Claude enables Claude Code ultracode through `--settings` (xhigh plus standing multi-agent workflow orchestration; strongest and most credit-hungry), so the commands above work unchanged on a Claude bot. Claude's `ultra` is offered only to timed tasks; ordinary `/effort` stays at `low` through `max`. Claude timed tasks also disable session scheduling tools such as `CronCreate` and `ScheduleWakeup` so nothing fires after the deadline; workflow subagents run inside the same CLI process tree and are terminated by the guard as well.

The task uses the current topic/chat context. Its model/effort snapshot applies only to this task and does not change `/model`, `/effort`, or bot defaults. Other topics/chats are unaffected. Supply a concrete goal or task list: completion ends the task early; this is not a loop to spend all available credit.

The fixed stop time covers time waiting for a process slot and the supervised CLI process tree. Expired tasks cannot start. Explicit recognized exhausted-credit errors (including LiteLLM-style gateway `budget_exceeded`) stop work; ordinary rate limits are not treated as exhausted credit. Stop with `/run stop`, `/stop`, or the task card; `/run status` shows the latest/active task. Only the creator may start a task; the creator or an administrator may use its stop button. Normal `/stop` permissions are unchanged. A busy topic must be stopped or finish first. While a timed task is active, Codex app-server can accept text into its existing turn and Claude streaming input into its active session, without extending the deadline; other input and agent card callbacks are declined with a notice, not queued for an unbounded follow-up.

Tasks are persisted in `profiles/<profile>/timed-runs.json`. A started task cannot be started twice; stopped, expired, failed, or restart-interrupted tasks never resume automatically. Create a new task to continue. This first version has no recurring scheduler or provider balance integration. Linux and Windows process-tree cleanup have process-test coverage; this is not full cross-platform Lark timed-task acceptance. See [Windows validation](windows-web-validation.md) for the tested scope. Client-side termination cannot guarantee how a provider bills an already accepted request across a quota reset; a strict billing guarantee requires a provider-side limit.

## Reply Display and COT

`/config lark` controls Lark presentation independently of `channels.web`:

- **Message reply mode**: `message card` streams the final reply; `plain text` sends once after the run finishes.
- **Tool-call display**: controls whether tool blocks appear in the final card / markdown reply.
- **COT process message**: `brief` is the default and uses the native Feishu/Lark COT control for agent progress text and tool summaries without manual setup; `detailed` also includes tool args and truncated output; `off` uses ordinary progress display. Explicit preferences are preserved; older profiles without this setting also use `brief`.

If the initial COT creation fails, the bridge sends one notice that the run has fallen back to ordinary progress display. Update failures after successful creation drop that best-effort batch and keep using the existing COT without sending an extra fallback card. The final answer is still sent separately.

When COT is enabled, the bridge splits the process view and final answer into two messages. The COT message is for tracing what the agent did; the final answer is still generated from the agent's raw text, without heuristic bridge-side filtering. If an agent emits final-answer text as ordinary stream text, that text can also appear in the COT process message.

## lark-cli identity policy

Each profile uses a profile-local lark-cli directory at `~/.lark-channel/profiles/<profile>/lark-cli`. The agent process receives `LARKSUITE_CLI_CONFIG_DIR` for that directory, so personal authorization in one profile is not shared with another profile.

The default policy is `bot-only`: lark-cli uses the app/bot identity and does not access personal resources. When a user authorizes personal resources such as calendar, mail, or drive, the current profile can switch to `user-default`, which keeps app identity available and also allows the authorized user identity. Owner/admin users can inspect or change this policy in `/config`; `/status` shows the current summary as `lark-cli: app` or `lark-cli: user-ready`.

## Working directories

Each profile may define a default working directory through `workspaces.default`. New profiles may be created with `--workspace <path>`; if omitted, the bridge creates a profile-managed default working directory.

This is a profile-field snippet. Do not replace the whole `config.toml` with it; edit the matching profile's `workspaces` field.

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/claude/default"
  }
}
```

The bridge checks that a selected directory exists, is a directory, and is not an overly broad location such as `/`, the home root, a system directory, or a temp root. The working directory is only the current directory for an agent run. It is not a filesystem sandbox; actual file access still depends on the local agent process and its permission mode.

## Permission modes

The recommended user-facing profile config is `permissions.defaultAccess` and `permissions.maxAccess`. New profiles default to `full` for both values so the bridge can keep local tools, authorization flows, file writes, and other agent features fully usable. To tighten a profile, set one or both values to `workspace` or `read-only`; stricter modes can limit local tool execution, login/authorization flows, file writes, and similar capabilities.

This is a profile-field snippet. Do not replace the whole `config.toml` with it; edit the matching profile's `permissions` field.

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

Mode mapping:

| Bridge access | Claude permission mode | Codex mode |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |

The legacy `sandbox` field is still readable for old configs. After the bridge saves the profile, it migrates that setting to canonical `permissions`.

Pi supports `read-only` (built-in read/search tools only) and `full`. It has no portable workspace-only sandbox, so `workspace` engine selection is rejected.

## Data directories

| Path | Content |
|---|---|
| `~/.lark-channel/config.toml` | Root config with profiles and active profile |
| `~/.lark-channel/active-profile` | Last selected profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | Session state |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | Agent-aware session catalog |
| `~/.lark-channel/profiles/<profile>/scope-execution.json` | Per-chat/topic execution-engine overrides |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | Current and named workspace bindings |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | Profile-local encrypted secrets |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | Profile-local lark-cli directory |
| `~/.lark-channel/profiles/<profile>/media/` | Attachment cache |
| `~/.lark-channel/profiles/<profile>/logs/` | Structured run logs |
| `~/.lark-channel/web/default/scope-execution.json` | Per-conversation standalone Web engine overrides |
| `~/.lark-channel/web/default/sessions.catalog.json` | Agent-aware standalone Web session catalog |
| `~/.lark-channel/registry/processes.json` | Local process registry |
| `~/.lark-channel/registry/locks/` | Profile and app locks |

Set `LARK_CHANNEL_HOME=/path/to/state` to move Lark and management-console state. Standalone Web uses its own `--state-dir` and does not inherit that location. `LARK_CHANNEL_LOG_DAYS` overrides log retention.

Profile secrets are encrypted with a stable local key derived from the
persisted profile salt and username. Containers should inject
`LARK_CHANNEL_KEYSTORE_MASTER_KEY` from their secret manager so the key does
not depend on the hostname. Existing v1 entries are migrated when the profile
next reads or writes a secret.

## Access control

**Chat access is private by default: out of the box, only *you* can use the bot in DMs and groups.** "You" = whoever created / owns the Feishu app (the person who scanned the QR to set it up). The bot figures out who the app owner is automatically from Feishu, so **solo chat use needs zero configuration** — you can DM it and `@`-mention it in any group, and everyone else's chat messages are silently ignored (no "permission denied" reply, which would only confirm the bot exists). Cloud-doc comments are document-scoped; see below.

To let other people or groups in, add them to one of three lists:

| List | Controls | Add | Remove |
|------|----------|-----|--------|
| **Allowed users** | who can DM the bot | `/invite user @them` | `/remove user @them` |
| **Allowed chats** | which groups the bot answers in (for **everyone** in them) | `/invite group` (current group) / `/invite all group` (every group the bot is in) | `/remove group` (current group) |
| **Admins** | who can change settings, and use the bot in any group | `/invite admin @them` | `/remove admin @them` |

> `/invite` and `/remove` can only be run by **you (the creator) and admins**. The `@` in the command points at the *target person* (not the bot) — the bot resolves the mention to their identity, so you never deal with raw IDs.

### Two identities that bypass everything

- **You (the creator)**: subject to no list at all — DMs, any group, every command. You **can never lock yourself out**: even if the lists get messed up, DM the bot and send `/config` to get back in. Transfer the app's ownership in the Feishu console and the bot follows the new owner automatically.
- **Admins**: can DM, run management commands like `/config`, and **bypass the allowed-chats list** — the bot answers them in any group, listed or not. Good for teammates who co-maintain the bot.

### Common setups

- **Just me** → nothing to do; this is the default.
- **Let a teammate DM the bot** → `/invite user @them`
- **Open a work group to everyone in it** → send `/invite group` inside that group
- **First-time setup, onboard every group the bot is already in** → `/invite all group` pulls them all into the list at once; trim with `/remove group` afterwards
- **Add a co-admin** → `/invite admin @them`

### Worth knowing

- Changes take effect on the **next message** — no restart needed.
- **In groups you must `@` the bot first** (DMs don't need it). That's a separate toggle (`/config` → "require @ in groups"), independent of the lists above.
- Strangers get pure silence — no reply at all. The one exception: if someone `@`-mentions the bot in a group that hasn't been opened up, the bot posts a friendly one-liner telling them an admin can run `/invite group` to enable it.
- Cloud-doc comments are document-scoped: anyone who can comment in a supported document and mention the bot can trigger a reply.

### Advanced: editing the config file directly

If you'd rather not do it inside Feishu, `/invite` and `/config` write the matching profile's `access` field in `~/.lark-channel/config.toml`. Empty lists mean nobody from that list, not open access. This is a profile-field snippet; do not replace the whole `config.toml` with it:

```toml
[profiles.claude.access]
allowedUsers = ["ou_xxxxxxxxxxxxx"]
allowedChats = ["oc_xxxxxxxxxxxxx"]
admins = ["ou_xxxxxxxxxxxxx"]
requireMentionInGroup = true
```

`allowedUsers` / `admins` take user `open_id`s; `allowedChats` takes group `chat_id`s. The easiest way to find an ID by hand: have the person message the bot (or `@` it in the group), then check the active profile's log:

```bash
grep '"event":"enter"' ~/.lark-channel/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

Each line carries `chatId` (group / DM id) and `senderId` (user `open_id`). After a manual edit, **restart the bridge** or send `/reconnect` from an allowed admin context to apply it. For day-to-day tweaks `/invite` / `/config` are easier; direct edits are mainly for deployment scripts that pre-seed access.

## Cloud-doc comments

Cloud-doc comments do not need a separate workspace binding or document allowlist. In supported document comments, mention the bot and the bridge replies in the same thread. Comment runs reuse the document session key and fall back to the user home directory when no document cwd was previously recorded.

## Optional telemetry

By default the bridge reports **nothing**: no metrics, no logs leave your machine, and it pulls in zero telemetry dependencies. The hook below is inert unless you opt in.

To wire up your own monitoring, point an environment variable at a module that default-exports (or exports `createAdapter`) an `AdapterFactory`:

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package lark-channel-bridge start
```

That module receives every `log.*` event plus error/metric hooks and forwards them wherever you like. The interface is exported from the package root:

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from 'lark-channel-bridge';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* ship event */},
  recordError(err, ctx) {/* ship exception */},
  recordMetric(name, value, tags) {/* ship metric */},
  flush(timeoutMs) {/* drain buffered events */},
});
export default createAdapter;
```

A missing module, a bad factory, or a throwing adapter all degrade to noop — telemetry can never stop the bridge from starting or break logging.

### Browser links for local files

Set `profiles.<name>.preferences.fileLinks` in the bridge configuration to turn
local POSIX paths in IM replies into browser links. Each mapping has an explicit
local directory and two HTTPS base URLs:

```json
{
  "fileLinks": [{
    "localRoot": "/srv/reports",
    "fileBaseUrl": "https://jupyter.example/user/alice/files/reports/",
    "browseBaseUrl": "https://jupyter.example/user/alice/lab/tree/reports/",
    "markdownPreviewUrl": "https://jupyter.example/user/alice/custom/reader/index.html"
  }]
}
```

The destination service must already serve that directory (for Jupyter, for
example, create a `reports` symlink under its file root). The bridge only rewrites
links; it does not upload files or grant browser access. Keep login tokens out of
these URLs. Restart the bridge after editing the configuration file.

`markdownPreviewUrl` is optional. When set, `.md` and `.markdown` files open that
endpoint with the absolute filesystem path in the URL-encoded `path` query
parameter, instead of opening the file browser. The endpoint must implement its
own authenticated file loading and Markdown rendering. Without it, Markdown keeps
using `browseBaseUrl`. The preview URL must be HTTPS without credentials, query,
or fragment; the bridge adds the query parameter.

Claude and Codex share the same conversion for text, streamed Markdown, full
cards, final replies, fallbacks and `/btw`. Existing Markdown link labels are kept;
bare paths and path-only inline code become links. Images, HTML, text/logs, PDF,
CSV/JSON and common archives use `fileBaseUrl`; other files and directories use
`browseBaseUrl`. Each path segment is URL-encoded. Line suffixes such as `:42` are
removed from the destination (no automatic line jump). Unmapped paths, existing
web links, fenced/indented code and tool records remain unchanged. Bare filenames
containing spaces should use inline code or an angle-bracket Markdown destination.
Reference-style links are preserved. A streaming bare path is linked after its
boundary or end of reply arrives.

Configuration is per profile and disabled when omitted. External `lark-cli`
sends, COT records, meeting replies and document comments have separate output
paths and are not rewritten by this feature. No agent skill or memory is needed.

GitLab CI failure monitoring and automatic Flash investigations: [configuration and behavior](gitlab-ci-watch.md).

For adapter development, see the [agent execution contract](agent-execution.md).

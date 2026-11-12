# Configuration

[Documentation index](README.md) · [Step-by-step tutorial (中文)](user-guide/configuration.md) · [Runnable examples](user-guide/README.md#查表与示例)

This is the field and reload reference. For a first setup, choose the native Web, Responses Web or Lark recipe in the tutorial instead of copying the complete example blindly.

Lark and the management console normally use `~/.lark-channel/config.toml` (`version = 3`). The runtime does not read old JSON configuration. `--config` selects another TOML file. Lark state and the monitor file are resolved relative to the selected root file's directory. Standalone Web reads Bridge TOML only when `--config` is supplied; its state uses `--state-dir` or `~/.lark-channel/web/default`, not `LARK_CHANNEL_HOME`.

Execution and presentation have separate ownership:

| Setting | Location | Resolution |
| --- | --- | --- |
| Execution defaults | `defaults.run`, `agents.<kind>.run`, `profiles.<name>.run` | Built-in defaults, then global, agent, profile, conversation overrides, explicit task parameters |
| Agent launch | `agents.<kind>.launch`, `profiles.<name>.launch` | Agent defaults, then profile overrides |
| Agent state (homes, default workspaces, memory, shared instructions/skills) | root `state` | Bridge-wide; an engine resolves the same way under every profile. See [Agent state](#agent-state) |
| Model providers | root `model_services` | Named API services; independent from executable and local state |
| Feishu/Lark display | `channels.lark`, `channels.lark.profiles.<name>` | Lark defaults, then settings for that bot |
| Feishu/Lark network | `channels.lark.network`, `channels.lark.profiles.<name>.network` | Common settings, then individual profile fields; reconnect required |
| Browser display | `channels.web`, `channels.web.profiles.<name>` | Web defaults, then the selected profile |
| Slack display | `channels.slack`, `channels.slack.profiles.<name>` | Slack defaults, then the selected profile |
| Accounts, access, permissions, meetings | `profiles.<name>` | Explicit bot settings; not inherited from another bot or a conversation |
| Workspace override | `profiles.<name>.workspaces.default` | Optional; applies only to the profile's own `agent`, otherwise the `state` layout decides |
| Monitoring | `bridge.monitors_file` | Existing `monitors.toml`, with its own validation and application rules |

Presentation is never inherited through an agent. The shared runtime produces complete events; the Lark, Slack, and Web output plugins independently select what to display. Hiding reasoning/progress is a display choice and does not change model effort or generation.

See [config.example.toml](config.example.toml) for a full layered example. `agent` is a type (`codex`, `claude`, `pi` or `agy`); a profile name identifies a particular bot. Multiple profiles can use the same agent defaults. Existing domain objects (`accounts`, `access`, `permissions`, `attachments`, `meeting`, `larkCli`, launch metadata and model service definitions) retain their established field names. New execution and channel keys use snake_case.

## Execution fields

- `model`: model identifier, or `{ source = "native" }` to stop inheritance and let the CLI decide.
- `effort`: agent-supported reasoning effort, or `{ source = "native" }`.
- `max_concurrent_runs`: integer 1–512, a per-profile concurrency limit shared by conversation turns and workflow workers; global defaults do not impose a host-wide aggregate limit.
- `idle_timeout_minutes`: integer 0–120; 0 disables the no-output watchdog.
- `workflow_timeout_minutes`: integer 1–10080 (7 days), default 480. Sets the default and maximum total duration for a new workflow; its `timeoutMs` may request a shorter duration. Reload affects new workflows only. Existing workflows and their descendants retain the saved budget and deadline, including across replay/restart.
- `stop_grace_ms`: integer 100–30000 between graceful and forced termination.

Omitting a key inherits its parent. Removing a profile override restores inheritance. Arrays replace their parent's entire value; an empty array explicitly clears the list. False and zero are retained. Native model/effort delegation omits the corresponding CLI override so native project/managed configuration remains authoritative. The bridge does not rewrite native Codex/Claude settings.

`launch` is the single ownership boundary for the executable and agent-local
configuration/authentication state. It accepts `binaryPath` and an optional
`env` table for all three agents, plus:

- Claude: `configDir`, exposed to the child as `CLAUDE_CONFIG_DIR`, and
  `mcpConfig`, a file passed as `--mcp-config`. Claude Code honours a server's
  `alwaysLoad` only for servers given this way (not from `~/.claude.json`): they
  connect before the first request and their tools are not deferred behind tool search.
- Codex: `codexHome`, exposed as `CODEX_HOME`, plus `transport`,
  `appServerMode`, `provider`, `inheritCodexHome`, `ignoreUserConfig` and `ignoreRules`.
- pi: `agentDir`, exposed as `PI_CODING_AGENT_DIR`.

`env` adds environment variables to the selected agent process and its tool
subprocesses. `$NAME` and `${NAME}` references are resolved from the Bridge
process environment; `$$` escapes a literal dollar sign. A missing referenced
variable is an error rather than a silently empty value. For example:

```toml
[agents.codex.launch.env]
HTTPS_PROXY = "$HTTPS_PROXY"
HTTP_PROXY = "$HTTP_PROXY"
NO_PROXY = "localhost,127.0.0.1,.internal"
```

Per-profile `profiles.<name>.launch.env` entries overlay the matching agent's
global `env` entries. Launch environment changes apply on reload: the engine
adapter is rebuilt for new runs while active runs keep their process. A Codex
daemon whose launch environment changed restarts only once no runs are attached
to it (see [Hot reload](#hot-reload)).
For Lark runs, `LARK_CHANNEL`, `LARK_CHANNEL_PROFILE`, `LARK_CHANNEL_HOME`,
`LARK_CHANNEL_CONFIG` and `LARKSUITE_CLI_CONFIG_DIR` remain bound to the receiving
frontend; these host bindings take precedence over shared launch settings.
Bridge does not invoke a shell to apply this table. If startup needs arbitrary
shell initialization, point `binaryPath` at a reviewed wrapper script that
ends with `exec <real-agent> "$@"`.

Global `agents.<kind>.launch` settings apply whenever that backend is selected,
including per-chat engine switches. `profiles.<name>.launch` overrides only the
profile's configured `agent`. Model Provider selection never changes which
executable or local state directory is used.

Configuration validates launch and agent combinations before use. Unknown
agent-specific fields are rejected, so a `codexHome` cannot silently be applied
to pi or a `configDir` to Codex.

Codex uses `app-server`, enabling input during an active turn. The `exec` backend has been removed: remove an old `transport = "exec"` setting or change it to `"app-server"`. Both ignore flags default to `false`; explicitly setting either to `true` is rejected because app-server loads normal user configuration and execpolicy rules. Launch changes take effect after restarting the profile.

`appServerMode` defaults to `daemon`. Bridge ensures Codex's official app-server daemon is running and attaches each run through a short-lived stdio-to-Unix-WebSocket bridge; the daemon stays alive after a run so native background memory extraction and consolidation can finish. On Windows, the bridge uses `codex app-server proxy --sock` as the native AF_UNIX byte transport underneath WebSocket, since Node's pipe API cannot connect to those sockets. `appServerMode = "per-run"` keeps the app-server scoped to one Bridge run and forces `memories.generate_memories = false`; existing memory reads and Codex's native memory startup path remain available, while the thread is not added as a source for new memory generation.

Codex defaults to the bridge-wide private home `<agent_home_root>/codex` (see [Agent state](#agent-state)); `codexHome` can select another private directory. `inheritCodexHome = true` is an explicit legacy opt-in. Bridge-managed model services require a private home and never rewrite the personal `~/.codex/config.toml`.

`launch.provider` selects a service from `model_services` at startup. If omitted, Bridge uses the service named by the default model, or the sole compatible service. Multiple services require an explicit selection. Bridge merges the selected provider, default model and environment-backed authentication into the private `config.toml`, preserving native options such as MCP servers, features and verbosity. This file remains the place to configure Codex features that Bridge does not expose; Bridge-owned fields are regenerated from Bridge TOML. Provider IDs are the configured service names, without generated aliases. Changed provider credentials/configuration restart only this private home's daemon during activation.

The provider stays fixed for the lifetime of an engine adapter. Editing `model_services` or `launch.provider` rebuilds the adapter on reload; while runs are still attached to the Codex daemon, the swap is deferred and completes automatically when they finish. Model commands reject attempts to save another provider, and stale conversation overrides continue on the active provider's default model with an explanatory notice. No new provider credentials are loaded for those rejected selections. Model changes within the active provider remain available. A legacy thread bound to another provider is forked with its history into the active provider; the source is retained.

## Agent state

Each engine keeps native state in its home directory (Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`, pi `PI_CODING_AGENT_DIR`), and its memory follows that home (Codex, pi) or the run's working directory (Claude stores auto-memory under `projects/<encoded cwd>/memory`). The root `[state]` table places all of these once for the whole bridge, so a per-chat engine switch, a second bot, or a scheduled job reaches the same state as the engine's own profile:

```toml
[state]
# workspace_root = "~/.lark-channel-workspaces" # default: <config dir>-workspaces
# agent_home_root = "~/.lark-channel/agents"    # default: <config dir>/agents
memory = "agent"                                # or "workspace"

[state.shared]
instructions = "~/.claude/CLAUDE.md" # linked as CLAUDE.md / AGENTS.md in each engine home
skills = "~/.claude/skills"          # each skill directory is linked into <home>/skills
```

Resolution for an engine `<kind>`:

- Default workspace: `/cd` for the conversation, then `profiles.<name>.workspaces.default` when `<name>` is configured with this `agent`, then `<workspace_root>/<kind>/default`. The derived directory is created on demand and is not written back to the profile. A profile's own workspace never leaks to another engine switched into that bot's chats.
- Home: `agents.<kind>.launch` state field (`configDir`, `codexHome`, `agentDir`) when set. Otherwise Claude and pi use their native home, and Codex uses `<agent_home_root>/codex` because Bridge-managed model services need a private `config.toml`. Hosts without a bridge root (standalone Web or Slack) use `<state dir>/codex-home`.
- Memory: `memory = "agent"` (default) pins Claude auto-memory to the project directory of `<workspace_root>/claude/default` through `autoMemoryDirectory`, so `/cd` into a repository keeps one Claude memory. `"workspace"` keeps Claude's per-cwd behaviour. Codex and pi memories are always one per home.
- Shared assets: links are created when an engine adapter starts, only where nothing exists. Existing files or foreign links are reported in the bridge log and never replaced. Without `[state.shared]` nothing is linked.

`/doctor` prints the resolved workspace, home (with its source) and memory location for the conversation's engine. `[state]` changes rebuild the engine adapter on reload; sessions already bound to a workspace keep it.

## Frontend fields

Lark owns `reply_mode` (`markdown`, `text`, `card`), `show_tools`, `progress` (`off`, `brief`, `detailed`), `message_debounce_ms` (0–5000) and `file_links`. The debounce is a per-profile quiet window: adjacent messages are merged into one agent prompt until it expires; `0` starts immediately. Web owns `show_tools` and `show_reasoning`. Slack owns `show_tools` and `show_progress`. Web and Slack have no Lark COT bubble, card type or identity setting. `defaults.output`, `agents.codex.output` and frontend fields inside `run` are rejected.

For a standalone browser host:

```sh
lark-channel-bridge web --agent codex --workspace /path/to/repo --config /path/to/config.toml
```

The active TOML profile supplies the initial execution engine and `channels.web` settings; `--profile <name>` selects another profile, and `--agent <kind>` remains an optional one-run initial override. Without `--config`, Web starts with Claude Code and its own local defaults. The browser page can switch the current conversation among all three backends. Standalone Web reads execution and presentation settings only: it does not bootstrap a Lark account, resolve App Secrets, or establish a Lark connection.

For a standalone Slack Socket Mode host:

```sh
lark-channel-bridge slack --workspace /path/to/repo --config /path/to/config.toml \
  --allowed-users U01234567 --allowed-channels C01234567
```

The Slack channel reads the same execution layers and `channels.slack` display
settings. Tokens come from `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`, or from the
profile keystore entries `slack-bot-token` / `slack-app-token`. See
[channels.md](channels.md) for Slack app scopes and events.

## Feishu/Lark network

```toml
[channels.lark.network]
proxy = "env"
# no_proxy = "localhost,127.0.0.1,::1,.internal,10.0.0.0/8"

[channels.lark.profiles.work.network]
proxy = "http://proxy.example:3128"
# no_proxy = "" # Clear inherited and environment bypass rules.
```

`proxy` defaults to `"env"`: HTTP uses `HTTP_PROXY`, HTTPS uses `HTTPS_PROXY` with HTTP fallback, and `ALL_PROXY` is a fallback. Nonempty lowercase variables take precedence over uppercase variants. WebSocket `ws`/`wss` follows HTTP/HTTPS respectively. Set `"direct"` to ignore proxy environment variables, or use an explicit HTTP(S) proxy URL. SOCKS and PAC URLs are not supported. For authenticated proxies, keep the credentials in the process environment and use `"env"`; credential-bearing URLs are rejected in TOML.

`no_proxy` overrides `NO_PROXY`/`no_proxy`. Omission inherits the common field or the environment; an empty string clears exclusions. Rules support comma/space-separated exact hosts, optional ports, `.domain`/`*.domain` suffixes, IPv4/IPv6 addresses and CIDR subnets, or `*` for all hosts. IPv6 addresses with ports must use brackets. Fields merge independently across the common and profile tables.

Bridge SDK REST and WebSocket connections, native COT create/update/complete, tenant token requests, credential checks, H5 authentication and keepalive probes use the same policy. Each profile has its own HTTP clients; this does not change the global Node dispatcher, other channels, model-provider traffic, `lark-cli`, or agent subprocesses. No `NODE_OPTIONS` proxy shim is needed. The native request layer reports error codes such as `UND_ERR_CONNECT_TIMEOUT` without including request bodies or proxy credentials.

Network settings are captured when the profile's transport starts. They are reconnect-class: reload keeps the active network settings and lists `channels.lark.network` as pending until `/reconnect` (or a profile restart). Automatic keepalive reconnects reuse the running settings and never apply pending edits. `config show --sources` displays the source of each network field. A failed COT create is still not blindly retried, because an uncertain response can mean the server already created the bubble.

## Inspecting and editing

```sh
lark-channel-bridge config check
lark-channel-bridge config show --profile codex --sources
lark-channel-bridge config set agents.codex.run.effort high
lark-channel-bridge config set channels.lark.progress brief
lark-channel-bridge config unset profiles.codex.run.model
```

`check` validates configuration and monitor references without retrieving secrets or contacting providers. `show` prints execution and frontend settings with their sources; it does not dump credentials or provider definitions. It describes the file, not a running process's loaded settings (use `/config show` in Lark for the running state). `set`/`unset` print how the edited field will take effect; `describe` lists the class of every setting and `reload` asks running bridges to apply the file now.

In Lark, `/config` shows a summary. `/config run`, `/config lark` and `/config access` open separate short forms. All `/config` forms edit the current bot profile globally: its DMs, groups and topics share the same defaults. `/config run` and the Web profile form both change the default execution engine, model and effort. Engine changes apply to future runs without disconnecting Lark or stopping active runs. `/config show web` inspects browser display defaults.

Existing `/model`, `/effort` and `/timeout` overrides remain local; `default` removes a field override and restores inheritance. `/model` and `/effort` reject `--scope profile`; edit global defaults with `/config run`. These commands do not change other bot profiles or installation-wide agent settings.

`/agent <engine>` selects the engine of the current chat/topic and stores it in `scope-agents.json`; `/agent default` returns to the bot default. Each engine keeps its own session per chat/topic, and nothing is carried over between engines. Lark no longer loads the earlier `scope-execution.json`, so old per-chat engine settings cannot override the bot default. Standalone Web retains its own explicit conversation engine choices.

The local console separates execution from Lark presentation; editing it does not set browser presentation. Changes use the same persistence service. Forms carry a document revision, reject stale submissions, and store only changed overrides. Use `inherit` in the model/concurrency/timeout form fields, or the inheritance options/buttons, to remove profile overrides. Explicit native delegation is configured in TOML. Programmatic TOML edits preserve unrelated text/comments and use atomic replacement under the configuration lock. External editors do not participate in this lock; detected conflicts are rejected, but it is not a transaction with arbitrary editors.

## Hot reload

Every setting declares how it takes effect in a running bridge (`src/config/settings.ts`, listed by `lark-channel-bridge config describe`). Like 3FS `CONFIG_HOT_UPDATED_ITEM` and PostgreSQL `pg_settings.context`, the class is part of the setting's definition, not of the code that happens to read it:

| Class | Settings (examples) | How it applies |
| --- | --- | --- |
| `live` | `run.*` (model, effort, concurrency, timeouts), `access.*`, Lark display (`reply_mode`, `progress`, `show_tools`, `file_links`, `message_debounce_ms`), `attachments.*`, `workspaces.*`, `meeting.*` except `enabled` | Next message / run. Raising concurrency releases queued runs immediately; lowering it never cancels running tasks. Meeting fields apply to new meetings. |
| `execution` | `agent`, `agents.*.launch` / `profiles.*.launch` (binary, env, homes, provider), `permissions`, `[state]`, `model_services` | The default engine adapter is rebuilt and availability-checked before it replaces the old one; active runs keep their adapter. A failed check keeps the old adapter. A busy Codex daemon defers the swap until its runs finish. |
| `meeting` | `meeting.enabled` | The meeting manager attaches to or leaves the live connection. |
| `lark-cli` | `mode`, `larkCli.identityPreset` | The lark-cli identity policy is re-applied; on failure the previous mode/identity stays in effect. |
| `monitoring` | `bridge.monitors_file`, monitor sources, `concurrency` | Picked up by the next monitor reconcile (immediately on a detected change, at most 15 s otherwise). |
| `reconnect` | `accounts.*`, `secrets`, `channels.lark.network` | Needs a new Lark connection: `/reconnect` applies them (it stops active runs). |
| `restart` | `bridge.autostart_profiles`, `bridge.active_profile`, adding/removing profiles, `channels.web` / `channels.slack` (standalone hosts) | Read once by the process; restart it. Profiles can still be started or stopped from the local console while it runs. |

Settings without a declaration are treated as `restart`, so a new field is never silently assumed to be hot; a test enforces that every resolved field is declared.

**Triggers.** The running bridge watches `config.toml` and the selected monitors file (inotify plus a 3 s stat poll for network filesystems). `SIGHUP` (service/detached processes; a bridge attached to a terminal keeps the default hang-up behaviour), `lark-channel-bridge config reload` (signals only processes that advertise SIGHUP reload in the registry and reports whether each accepted the revision), `/config reload` and every in-process writer (forms, `/access`, console) use the same path. Applying is idempotent; `/config reload` forces a re-apply, e.g. to retry a failed component.

**Validation.** An edit is validated as a whole before anything is applied (validate-then-swap). An invalid file is reported once per revision (`config.reload-rejected` in the log, `/config show`, `/config reload`) and the process keeps running on the last good configuration; running readers never see a half-valid file. Startup stays strict: an invalid file refuses to start a profile.

**Partial application.** A valid edit applies every hot field even when it also changes reconnect/restart fields; those are listed as pending with their running and file values (credential-like values are never echoed). `/config show` prints the running state, the last reload and the pending list; `status --json` reports `appliedConfigRevision`, `configFileChangedSinceApply` and `configPendingCount` per process.

Running output uses its existing display snapshot. Reload never starts or restarts a stopped profile; startup has no JSON fallback.

Monitor reload still follows [its own contract](monitor-config.md). The default TOML path does not change the per-profile JSON projection required by lark-cli. `LARK_CHANNEL_CONFIG` points to that generated JSON, not the human-maintained TOML. Native agent files, sessions, cursors, work items and encrypted credential stores retain their existing formats.

Standalone Web and Slack hosts do not participate in hot reload. Restart that server after editing its TOML, and reopen the newly printed token URL. The optional Windows isolated launcher reads the native Codex provider at startup and does not accept Bridge `--config`; use the normal Web CLI for file-based Bridge settings.

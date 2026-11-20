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
| Accounts, access, permissions | `profiles.<name>` | Explicit bot settings; not inherited from another bot or a conversation |
| Workspace override | `profiles.<name>.workspaces.default` | Optional; applies only to the profile's own `agent`, otherwise the `state` layout decides |
| Monitoring | `bridge.monitors_file` | Existing `monitors.toml`, with its own validation and application rules |

Presentation is never inherited through an agent. The shared runtime produces complete events; the Lark, Slack, and Web output plugins independently select what to display. Hiding reasoning/progress is a display choice and does not change model effort or generation.

See [config.example.toml](config.example.toml) for a full layered example. `agent` is a type (`codex`, `claude`, `pi` or `agy`); a profile name identifies a particular bot. Multiple profiles can use the same agent defaults. Existing domain objects (`accounts`, `access`, `permissions`, `attachments`, `larkCli`, launch metadata and model service definitions) retain their established field names. New execution and channel keys use snake_case.

## Execution fields

- `model`: model identifier, or `{ source = "native" }` to stop inheritance and let the CLI decide.
- `effort`: agent-supported reasoning effort, or `{ source = "native" }`.
- `max_concurrent_runs`: integer 1–512, a per-profile concurrency limit shared by conversation turns and workflow workers; global defaults do not impose a host-wide aggregate limit.
- `idle_timeout_minutes`: integer 0–120; 0 disables the no-output watchdog.
- `workflow_timeout_minutes`: integer 1–10080 (7 days), default 480. Sets the default and maximum total duration for a new workflow; its `timeoutMs` may request a shorter duration. Reload affects new workflows only. Existing workflows and their descendants retain the saved budget and deadline, including across replay/restart.
- `stop_grace_ms`: integer 100–30000 between graceful and forced termination.
- `cache_keepalive_interval_minutes`: integer 0–1440, default 0 (off). While a Claude conversation is idle waiting on its workflow, the bridge re-reads the session's cached prompt this often from a throwaway fork, so the next wake does not pay to write the whole context to the cache again. Set it a few minutes under the cache lifetime in use (for example 50 with a 1-hour cache); a request more than 5 minutes overdue is skipped, because the cache has probably expired already.
- `cache_keepalive_max_pings`: integer 1–100, default 6. Keep-alive requests per idle period; after that the cache is left to expire. Each request costs one cache read of the full context, a rebuild costs a cache write of it.
- `cache_keepalive_min_context_tokens`: integer 0–10000000, default 100000. A session whose prompt is smaller than this gets one request and no more.

Keep-alive applies only while the scope's workflow is active and its conversation has no turn running. It starts a new count after every turn, and stops for the rest of an idle period as soon as a request reads less than 90% of its prompt from the cache. Each request is logged as `cache-keepalive ping` with its prompt and cached token counts.

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
- pi: `agentDir`, exposed as `PI_CODING_AGENT_DIR`, plus `transport`, `sdkPath`,
  `nodePath`, `hostScript`, `idleTtlMs`, `maxSessions`, `sessionPersistence`,
  `bashDefaultTimeoutSeconds` and `bashMaxTimeoutSeconds`.

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

Pi's shell tool has no time limit of its own: a call without `timeout` waits until the command ends, so a `find` or `grep -r` over a network mount can hold a run for hours. Bridge therefore stops a call without `timeout` after `bashDefaultTimeoutSeconds` (default 600) and caps an explicit `timeout` at `bashMaxTimeoutSeconds` (default 14400, four hours). The model is told both numbers; a call stopped this way returns its output so far with a note on how to ask for longer, and the turn continues. Commands the model expects to be slow keep the time it names for them, up to the cap, and work longer than the cap belongs in a detached process. Set either key to `0` to switch that limit off. Both transports apply the limits; a workflow worker whose call is still out two minutes past its limit is stopped and retried (see [workflows](workflows.md)).

pi runs through the `pi` CLI by default. `transport = "sdk"` embeds the Pi SDK in a long-lived host process instead: one host serves every session of the profile, text streams through the same translator, and follow-up input can steer the active turn. A run of the CLI goes on across a bridge restart under its run host (see [runtime reference](runtime-reference.md)); a run of the SDK transport does not, and is replayed or retried. The host needs Node >= 22.19, normally Pi's own bundled runtime; Bridge derives `nodePath` and `sdkPath` from the configured `pi` launcher, so only `binaryPath` is required. Set them explicitly when the launcher is not a wrapper (or on Windows). `remote = "user@host"` runs the host on another machine over ssh: the protocol is JSONL on stdin/stdout, so only the command line changes, and `nodePath`, `sdkPath`, `hostScript` and `agentDir` must resolve to the same paths there (a shared filesystem mount). The run environment travels in a private file next to the profile state that the remote shell deletes after sourcing it, workflow credentials included: the bridge publishes its local-only workflow endpoint on the remote loopback through an `ssh -R` tunnel for the life of the profile. A remote host cannot take the local exec sandbox (the launcher is a local binary and the configuration rejects the pair), and a bridge restart starts a new host instead of reattaching. `agentDir` defaults to `$PI_CODING_AGENT_DIR` or `~/.pi/agent`; SDK session files are ordinary Pi JSONL and can be reopened with `pi --session <id>`. `sessionPersistence = "memory"` keeps worker sessions off disk, and `idleTtlMs`/`maxSessions` bound the host's memory. With `exec_sandbox` enabled, the shared host itself runs under one profile-scoped Landlock domain (bridge workspaces, agent homes, the Pi `agentDir` and `exec_sandbox.read_write` are writable; a run's own `cwd` is not added automatically), see [exec sandbox](exec-sandbox.md#shared-runtimes-pi-with-transport--sdk). Per-run `env` bindings (workflow credentials, for example) reach the shell tools of the run that owns them and never the host's `process.env`, so concurrent sessions keep their own bindings, and model-provider credentials are passed to the provider as literals for the same reason.

The protocol a rented unit speaks to the bridge is not agent-specific: `bin/cell-host.mjs` starts one agent CLI inside the unit and relays its stdio plus the workflow calls its tools make, so any adapter that drives a process over stdio can run there. The Pi SDK host is the first user of that idea; wiring another backend means giving it a pushed runtime and translating its command line to the cell-local paths.

`provider` selects the builtin that fulfils the protocol: `ssh://[user@]host[:port]/base` rents a directory on a machine reachable over ssh (runtime and workspace pushed in, host started there, its port reached through `ssh -L`, the unit deleted on release), and any other value is treated as a provider executable speaking the JSONL protocol — that is how a container platform is plugged in without the bridge knowing its name. The ssh provider is placement, not isolation: the unit is a directory plus the processes started in it, so untrusted work belongs in a container provider, and a host that already shares the bridge's filesystem should use `pi.remote` instead.

A profile can also rent an isolated unit per workflow member instead of running the host at all locally or on a fixed machine: `[agents.pi.workcell]` names a **provider** (builtin `ssh://…`, or an executable) and the sizing it wants (`image`, `cpu`, `memoryGb`, `ttlSeconds`, `network`, `parallelism`, `layer`). `layer` points at a prebuilt runtime layer (an EROFS under `/artifacts/<user>/…`, built once with `private/tools/workcell-runtime/build.py`). Units then start with the Pi runtime already mounted, so a unit only receives its workspace, `bin/` and agent files — the per-unit runtime upload disappears and provisioning drops to ~1 s. The build packs to that same path, and packing replaces the previous layer in place, so old runtimes cannot accumulate; the script verifies the layer in a fresh unit before reporting success and stops every temporary container it created.

Only a workflow member rents a unit: a run enters a cell when it carries the member's host key, so ordinary turns and members that own a git workspace stay on the bridge machine (a cell copies the tree without `.git`, so it cannot commit). `maxCells` (default 32) bounds the units alive at once — a new member evicts the least recently used idle unit, and when every unit is busy the request fails rather than killing a member's host. A provider that dies is replaced on the next request, and units it owned are forgotten with it. A unit is kept between turns of its member and released after `idleReleaseSeconds` of inactivity (default: half of `ttlSeconds`, or 30 minutes); its sessions are pulled out before the unit goes away, so the unit rented by the member's next turn resumes the conversation.

`parallelism` (default 8) bounds how many units are prepared at once: transfers scale with the number of streams — measured ~13 MiB/s per stream, with aggregate throughput still growing at 16 — so a batch of workers provisions in parallel while a runaway batch stays bounded. Within one unit the small pushes, the agent files and the port request travel alongside the runtime upload. The bridge starts that provider once, then drives it with newline-delimited JSON (`create`, `push`, `exec`, `forward`, `ttl`, `stop`); the repository defines only the protocol, so which infrastructure fulfils it stays outside the bridge. The bridge pushes the runtime (the whole `node_modules` tree around the launcher, because the SDK also imports packages kept beside it) plus the files in `<agentDir>`, starts the host inside the unit, and reaches it over the forwarded port — the same host protocol as stdio. A workcell is its own boundary: `exec_sandbox` and `remote` cannot be combined with it, and `transport = "sdk"` is required. The unit starts empty, so a run works in a copy of its workspace pushed to `/opt/lark-workcell/work` (build outputs, `.git` and `node_modules` are excluded), and its native session lives inside the unit: as long as the member keeps its unit, turns resume cheaply; a replaced unit starts a fresh session. Paths the prompt mentions that only exist on the bridge machine are not visible there, and pulling changes back is not wired yet. Workflow calls work from inside the unit: the host runs a loopback endpoint that the run's `AGENT_WORKFLOW_ENDPOINT` points at, and each call travels over the host channel so the bridge executes it with the worker's own token; the bundled workflow CLI is pushed with the runtime, so `node "$AGENT_WORKFLOW_CLI"` resolves there. Sessions are pulled out of the unit on release and pushed back into the next unit for the same member, so a replaced unit still resumes its native session.

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

## Model gate

```toml
[gate]
enabled = true
fail_open = true
lease_seconds = 600

[gate.defaults]
rpm = 1000
concurrency = 100

[gate.providers.deepseek]
concurrency = 100
```

A bridge-wide limit on model requests, one bucket per model provider. The key of
`[gate.providers.<name>]` is the provider's name: the `[model_services.<name>]`
key, or the provider's name in Pi's own catalog for a model Pi resolves itself;
all models of a provider share its bucket. `rpm` and
`concurrency` apply together: a request needs a rate token and a free slot.
`burst`, the number of requests that may start back to back after an idle
period, is the bucket's `rpm` unless set lower.
`concurrency = 0` turns the slot limit off for a provider that has none of its
own; the rate bucket still applies. The gate is shared by every profile in the
process; a Pi run holds a permit only while the provider answers, so tools never
occupy a slot.

Only Pi CLI runs are gated in this phase. `[gate]` is bridge-wide: it is not a
profile field and does not resolve through `defaults.run` / `agents.*.run`.
Edits are picked up on reload; in-flight permits keep their old limits. See
[Model gate](model-gate.md) for the permit lifecycle, failure behaviour and the
`/status` endpoint.

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

In Lark groups, slash commands may follow a leading structured mention of the receiving bot, including in rich-text messages. For example, `@bot /model custom/fast check this issue` changes the model and immediately submits the task. The effort is optional: a recognized effort such as `high` is consumed before the task; otherwise the remaining text is the task, preserving its internal spacing and line breaks. Known effort levels unsupported by the chosen engine or model are still rejected. `/provider` and the model arguments of `/agent` follow the same rule. Ordinary text and mentions of other users or bots are not stripped to expose commands.

`/agent <engine>` selects the engine of the current chat/topic and stores it in `scope-agents.json`; `/agent default` returns to the bot default. Each engine keeps its own session per chat/topic, and nothing is carried over between engines. Standalone Web and Slack keep their conversation engine choices in a `scope-agents.json` of their own state directory.

The local console separates execution from Lark presentation; editing it does not set browser presentation. Changes use the same persistence service. Forms carry a document revision, reject stale submissions, and store only changed overrides. Use `inherit` in the model/concurrency/timeout form fields, or the inheritance options/buttons, to remove profile overrides. Explicit native delegation is configured in TOML. Programmatic TOML edits preserve unrelated text/comments and use atomic replacement under the configuration lock. External editors do not participate in this lock; detected conflicts are rejected, but it is not a transaction with arbitrary editors.

## Hot reload

Every setting declares how it takes effect in a running bridge (`src/config/settings.ts`, listed by `lark-channel-bridge config describe`). Like 3FS `CONFIG_HOT_UPDATED_ITEM` and PostgreSQL `pg_settings.context`, the class is part of the setting's definition, not of the code that happens to read it:

| Class | Settings (examples) | How it applies |
| --- | --- | --- |
| `live` | `run.*` (model, effort, concurrency, timeouts), `access.*`, Lark display (`reply_mode`, `progress`, `show_tools`, `file_links`, `message_debounce_ms`), `attachments.*`, `workspaces.*` | Next message / run. Raising concurrency releases queued runs immediately; lowering it never cancels running tasks. Meeting fields apply to new meetings. |
| `execution` | `agent`, `agents.*.launch` / `profiles.*.launch` (binary, env, homes, provider), `permissions`, `[state]`, `model_services` | The default engine adapter is rebuilt and availability-checked before it replaces the old one; active runs keep their adapter. A failed check keeps the old adapter. A busy Codex daemon defers the swap until its runs finish. |
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

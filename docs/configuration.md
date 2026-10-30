# Configuration

[Documentation index](README.md) · [Step-by-step tutorial (中文)](user-guide/configuration.md) · [Runnable examples](user-guide/README.md#查表与示例)

This is the field and reload reference. For a first setup, choose the native Web, Responses Web or Lark recipe in the tutorial instead of copying the complete example blindly.

Lark and the management console normally use `~/.lark-channel/config.toml` (`version = 3`). The runtime does not read or upgrade old JSON configuration. `--config` selects another TOML file. Lark state and the monitor file are resolved relative to the selected root file's directory. Standalone Web reads Bridge TOML only when `--config` is supplied; its state uses `--state-dir` or `~/.lark-channel/web/default`, not `LARK_CHANNEL_HOME`.

Execution and presentation have separate ownership:

| Setting | Location | Resolution |
| --- | --- | --- |
| Execution defaults | `defaults.run`, `agents.<kind>.run`, `profiles.<name>.run` | Built-in defaults, then global, agent, profile, conversation overrides, explicit task parameters |
| Agent launch | `agents.<kind>.launch`, `profiles.<name>.launch` | Agent defaults, then profile overrides |
| Model providers | root `model_services` | Named API services; independent from executable and local state |
| Feishu/Lark display | `channels.lark`, `channels.lark.profiles.<name>` | Lark defaults, then settings for that bot |
| Feishu/Lark network | `channels.lark.network`, `channels.lark.profiles.<name>.network` | Common settings, then individual profile fields; reconnect required |
| Browser display | `channels.web`, `channels.web.profiles.<name>` | Web defaults, then the selected profile |
| Slack display | `channels.slack`, `channels.slack.profiles.<name>` | Slack defaults, then the selected profile |
| Accounts, access, permissions, workspace, meetings | `profiles.<name>` | Explicit bot settings; not inherited from another bot or a conversation |
| Monitoring | `bridge.monitors_file` | Existing `monitors.toml`, with its own validation and application rules |

Presentation is never inherited through an agent. The shared runtime produces complete events; the Lark, Slack, and Web output plugins independently select what to display. Hiding reasoning/progress is a display choice and does not change model effort or generation.

See [config.example.toml](config.example.toml) for a full layered example. `agent` is a type (`codex`, `claude`, `pi` or `agy`); a profile name identifies a particular bot. Multiple profiles can use the same agent defaults. Existing domain objects (`accounts`, `access`, `permissions`, `attachments`, `meeting`, `larkCli`, launch metadata and model service definitions) retain their established field names. New execution and channel keys use snake_case.

## Execution fields

- `model`: model identifier, or `{ source = "native" }` to stop inheritance and let the CLI decide.
- `effort`: agent-supported reasoning effort, or `{ source = "native" }`.
- `max_concurrent_runs`: integer 1–50, a per-profile concurrency limit; global defaults do not impose a host-wide aggregate limit.
- `idle_timeout_minutes`: integer 0–120; 0 disables the no-output watchdog.
- `stop_grace_ms`: integer 100–30000 between graceful and forced termination.

Omitting a key inherits its parent. Removing a profile override restores inheritance. Arrays replace their parent's entire value; an empty array explicitly clears the list. False and zero are retained. Native model/effort delegation omits the corresponding CLI override so native project/managed configuration remains authoritative. The bridge does not rewrite native Codex/Claude settings.

`launch` is the single ownership boundary for the executable and agent-local
configuration/authentication state. It accepts `binaryPath` and an optional
`env` table for all three agents, plus:

- Claude: `configDir`, exposed to the child as `CLAUDE_CONFIG_DIR`.
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
global `env` entries. Launch environment changes require a Bridge restart.
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

`appServerMode` defaults to `daemon`. Bridge ensures Codex's official app-server daemon is running and attaches each run through a short-lived stdio-to-Unix-WebSocket bridge; the daemon stays alive after a run so native background memory extraction and consolidation can finish. `appServerMode = "per-run"` keeps the app-server scoped to one Bridge run and forces `memories.generate_memories = false`; existing memory reads and Codex's native memory startup path remain available, while the thread is not added as a source for new memory generation.

Codex defaults to an independent `<profile-state-dir>/codex-home`; `codexHome` can select another private directory. `inheritCodexHome = true` is an explicit legacy opt-in. Bridge-managed model services require a private home and never rewrite the personal `~/.codex/config.toml`.

`launch.provider` selects a service from `model_services` at startup. If omitted, Bridge uses the service named by the default model, or the sole compatible service. Multiple services require an explicit selection. Bridge merges the selected provider, default model and environment-backed authentication into the private `config.toml`, preserving native options such as MCP servers, features and verbosity. This file remains the place to configure Codex features that Bridge does not expose; Bridge-owned fields are regenerated from Bridge TOML. Provider IDs are the configured service names, without generated aliases. Changed provider credentials/configuration restart only this private home's daemon during activation.

The running provider stays fixed until restart. Model commands reject attempts to save another provider, and stale conversation overrides continue on the active provider's default model with an explanatory notice. No new provider credentials are loaded for those rejected selections. Model changes within the active provider remain available. A legacy thread bound to another provider is forked with its history into the active provider; the source is retained.

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

Network and environment settings are captured when the profile's transport starts. Use `/reconnect` or restart that profile after changing them. Configuration reload applies display/run/access changes but reports `channels.lark.network` as requiring reconnect and retains the active network settings. `config show --sources` displays the source of each network field. A failed COT create is still not blindly retried, because an uncertain response can mean the server already created the bubble.

## Inspecting and editing

```sh
lark-channel-bridge config check
lark-channel-bridge config show --profile codex --sources
lark-channel-bridge config set agents.codex.run.effort high
lark-channel-bridge config set channels.lark.progress brief
lark-channel-bridge config unset profiles.codex.run.model
```

`check` validates configuration and monitor references without retrieving secrets or contacting providers. `show` prints execution and frontend settings with their sources; it does not dump credentials or provider definitions. It describes the file, not a running process's loaded settings.

In Lark, `/config` shows a summary. `/config run`, `/config lark` and `/config access` open separate short forms. The execution engine saved by `/config run` is scoped to the current chat or topic; the Web profile form changes the profile default. `/config show web` inspects browser display defaults. `/model`, `/effort` and `/timeout` retain their conversation-specific controls. Profile administrators cannot write global/agent settings through the chat endpoint.

The local console separates execution from Lark presentation; editing it does not set browser presentation. Changes use the same persistence service. Forms carry a document revision, reject stale submissions, and store only changed overrides. Use `inherit` in the model/concurrency/timeout form fields, or the inheritance options/buttons, to remove profile overrides. Explicit native delegation is configured in TOML. Programmatic TOML edits preserve unrelated text/comments and use atomic replacement under the configuration lock. External editors do not participate in this lock; detected conflicts are rejected, but it is not a transaction with arbitrary editors.

After editing a file, use `/config reload` in each affected bot. Execution/display changes apply to subsequent runs; running output uses its existing display snapshot. Access updates affect new messages. Lowering concurrency does not cancel current tasks. Reload reports remaining changes requiring restart (agent launch, account/identity, permissions, workspace or service reconstruction). Changing agent type requires restart before any new execution/display settings are loaded. Reload never starts or restarts a stopped profile. A malformed file leaves already-loaded settings intact and fails explicitly; startup has no JSON fallback.

Monitor reload still follows [its own contract](monitor-config.md). The default TOML path does not change the per-profile JSON projection required by lark-cli. `LARK_CHANNEL_CONFIG` points to that generated JSON, not the human-maintained TOML. Native agent files, sessions, cursors, work items and encrypted credential stores retain their existing formats.

Standalone Web has no `/config reload` endpoint or file watcher. Restart that server after editing its TOML, and reopen the newly printed token URL. The optional Windows isolated launcher reads the native Codex provider at startup and does not accept Bridge `--config`; use the normal Web CLI for file-based Bridge settings.

## One-time conversion of this installation

An offline converter can preserve an existing version-2 profile installation:

```sh
lark-channel-bridge config migrate --config ~/.lark-channel/config.json --dry-run
lark-channel-bridge config migrate --config ~/.lark-channel/config.json --output ~/.lark-channel/config.toml
```

The output must be a new file in the same directory, so relative monitor references and profile state stay valid. The converter checks the execution, display, account, access and service settings before writing. Unknown legacy root/profile/preference fields stop conversion for review. It does not print resolved credentials, overwrite its input/output, merge defaults across profiles, rebind lark-cli or restart a process. The old file is an offline backup, never a second runtime source. Older versions that cannot load TOML must be upgraded or stopped before switching the shared configuration. Version-1 automatic migrations and their process-stop prompts have been removed.

# Configuration

This version uses `~/.lark-channel/config.toml` (`version = 3`). The runtime does not read or upgrade old JSON configuration. `--config` selects another TOML file. State directories and the monitor file are resolved relative to the selected root file's directory.

Execution and presentation have separate ownership:

| Setting | Location | Resolution |
| --- | --- | --- |
| Execution defaults | `defaults.run`, `agents.<kind>.run`, `profiles.<name>.run` | Built-in defaults, then global, agent, profile, conversation overrides, explicit task parameters |
| Agent launch | `agents.<kind>.launch`, `profiles.<name>.launch` | Agent defaults, then profile overrides |
| Feishu/Lark display | `channels.lark`, `channels.lark.profiles.<name>` | Lark defaults, then settings for that bot |
| Browser display | `channels.web`, `channels.web.profiles.<name>` | Web defaults, then host-selected profile settings |
| Accounts, access, permissions, workspace, meetings | `profiles.<name>` | Explicit bot settings; not inherited from another bot or a conversation |
| Monitoring | `bridge.monitors_file` | Existing `monitors.toml`, with its own validation and application rules |

Presentation is never inherited through an agent. The shared runtime produces complete events; the Lark and Web output plugins independently select what to display. Hiding reasoning/progress is a display choice and does not change model effort or generation.

See [config.example.toml](config.example.toml) for a complete example. `agent` is a type (`codex` or `claude`); a profile name identifies a particular bot. Multiple profiles can use the same agent defaults. Existing domain objects (`accounts`, `access`, `permissions`, `attachments`, `meeting`, `larkCli`, launch metadata and model service definitions) retain their established field names. New execution and channel keys use snake_case.

## Execution fields

- `model`: model identifier, or `{ source = "native" }` to stop inheritance and let the CLI decide.
- `effort`: agent-supported reasoning effort, or `{ source = "native" }`.
- `max_concurrent_runs`: integer 1–50, a per-profile concurrency limit; global defaults do not impose a host-wide aggregate limit.
- `idle_timeout_minutes`: integer 0–120; 0 disables the no-output watchdog.
- `stop_grace_ms`: integer 100–30000 between graceful and forced termination.

Omitting a key inherits its parent. Removing a profile override restores inheritance. Arrays replace their parent's entire value; an empty array explicitly clears the list. False and zero are retained. Native model/effort delegation omits the corresponding CLI override so native project/managed configuration remains authoritative. The bridge does not rewrite native Codex/Claude settings.

`launch` accepts `binaryPath` for both agents. Codex also accepts `transport`, `codexHome`, `inheritCodexHome`, `ignoreUserConfig` and `ignoreRules`. Configuration validates launch and agent combinations before use.

Codex uses `app-server`, enabling input during an active turn. The `exec` backend has been removed: remove an old `transport = "exec"` setting or change it to `"app-server"`. Both ignore flags default to `false`; explicitly setting either to `true` is rejected because app-server loads normal user configuration and execpolicy rules. Launch changes take effect after restarting the profile.

## Frontend fields

Lark owns `reply_mode` (`markdown`, `text`, `card`), `show_tools`, `progress` (`off`, `brief`, `detailed`) and `file_links`. Web owns `show_tools` and `show_reasoning`. Web has no Lark COT bubble, card type or identity setting. `defaults.output`, `agents.codex.output` and frontend fields inside `run` are rejected.

For a standalone browser host:

```sh
lark-channel-bridge web --agent codex --workspace /path/to/repo --config /path/to/config.toml
```

It uses global/agent execution defaults and `channels.web`, without bootstrapping a Lark account. Standalone Web does not select a bot profile. Profile-scoped channel options are available to hosts that explicitly select that profile.

## Inspecting and editing

```sh
lark-channel-bridge config check
lark-channel-bridge config show --profile codex --sources
lark-channel-bridge config set agents.codex.run.effort high
lark-channel-bridge config set channels.lark.progress brief
lark-channel-bridge config unset profiles.codex.run.model
```

`check` validates configuration and monitor references without retrieving secrets or contacting providers. `show` prints execution and frontend settings with their sources; it does not dump credentials or provider definitions. It describes the file, not a running process's loaded settings.

In Lark, `/config` shows a summary. `/config run`, `/config lark` and `/config access` open separate short forms. `/config show web` inspects browser display defaults. `/model`, `/effort` and `/timeout` retain their conversation-specific controls. Profile administrators cannot write global/agent settings through the chat endpoint.

The local console separates execution from Lark presentation; editing it does not set browser presentation. Changes use the same persistence service. Forms carry a document revision, reject stale submissions, and store only changed overrides. Use `inherit` in the model/concurrency/timeout form fields, or the inheritance options/buttons, to remove profile overrides. Explicit native delegation is configured in TOML. Programmatic TOML edits preserve unrelated text/comments and use atomic replacement under the configuration lock. External editors do not participate in this lock; detected conflicts are rejected, but it is not a transaction with arbitrary editors.

After editing a file, use `/config reload` in each affected bot. Execution/display changes apply to subsequent runs; running output uses its existing display snapshot. Access updates affect new messages. Lowering concurrency does not cancel current tasks. Reload reports remaining changes requiring restart (agent launch, account/identity, permissions, workspace or service reconstruction). Changing agent type requires restart before any new execution/display settings are loaded. Reload never starts or restarts a stopped profile. A malformed file leaves already-loaded settings intact and fails explicitly; startup has no JSON fallback.

Monitor reload still follows [its own contract](monitor-config.md). The default TOML path does not change the per-profile JSON projection required by lark-cli. `LARK_CHANNEL_CONFIG` points to that generated JSON, not the human-maintained TOML. Native agent files, sessions, cursors, work items and encrypted credential stores retain their existing formats.

## One-time conversion of this installation

An offline converter can preserve an existing version-2 profile installation:

```sh
lark-channel-bridge config migrate --config ~/.lark-channel/config.json --dry-run
lark-channel-bridge config migrate --config ~/.lark-channel/config.json --output ~/.lark-channel/config.toml
```

The output must be a new file in the same directory, so relative monitor references and profile state stay valid. The converter checks the execution, display, account, access and service settings before writing. Unknown legacy root/profile/preference fields stop conversion for review. It does not print resolved credentials, overwrite its input/output, merge defaults across profiles, rebind lark-cli or restart a process. The old file is an offline backup, never a second runtime source. Older versions that cannot load TOML must be upgraded or stopped before switching the shared configuration. Version-1 automatic migrations and their process-stop prompts have been removed.

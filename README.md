# lark-channel-bridge

Talk to local **Codex CLI, Claude Code, or Pi Coding Agent** from your browser or Feishu / Lark. The agent runs on your machine and works in the project directory you choose.

[中文](README.zh.md) · [Documentation](docs/README.md) · [Configuration reference](docs/configuration.md)

> This README describes this repository's **`dev` branch**. The npm package with the same name may not contain these changes. Start from source using the steps below.

## 1. Choose what you want to run

| Goal | Entry point | What opens | Lark account? |
| --- | --- | --- | --- |
| Chat with an agent in a browser | `web --agent codex` | **Bridge Chat**, normally on port 8787 | No |
| Set up a Lark bot, profiles or the inbox | `node bin/run-lark-cc.mjs` | **Management console**, at the printed address | Yes, to connect a bot |
| Run an already configured Lark bot without a console | `run --profile <name>` | Terminal logs | Yes |
| Connect a Slack bot | `slack --workspace /absolute/project/path --allowed-users U... --allowed-channels C...` | Slack threads via Socket Mode; see [setup](docs/channels.md#run-the-bundled-slack-channel) | No |

**Browser chat and the management console are different applications.** `run-lark-cc` and `run --web-ui` do not open standalone chat. For a first local test, choose browser chat.

## 2. Install once

You need **Git**, **Node.js 22.12+** (or Node 20.19+ within Node 20), and at least one installed, authenticated agent. Check the agent in the same terminal/account that will run Bridge:

```sh
node --version
codex --version
```

Use `claude --version` or `pi --version` if that is your chosen engine. A version check proves the binary exists, not that model authentication works; complete one direct agent conversation first.

```sh
git clone --branch dev https://github.com/KuribohG/lark-coding-agent-bridge.git
cd lark-coding-agent-bridge
npx --yes pnpm@10.33.0 install --frozen-lockfile
```

Run subsequent commands **from this repository directory**. Installation builds the bundled frontend and CLI. No separate Vite server, database, Docker, WSL or global `npm link` is needed for the commands below. Use the pinned pnpm version to avoid install-script policy differences.

## 3A. Start browser chat — no Lark setup

```sh
node bin/lark-channel-bridge.mjs web --agent codex --workspace . --state-dir .web-local/chat --port 8787
```

- Replace `.` after `--workspace` with your project path; quote paths containing spaces.
- Replace `codex` with `claude` or `pi` only if that agent is installed and configured. Omitting `--agent` without a config defaults to Claude, not Codex.
- Open the **complete URL printed by the command**, including `#token=...`. The server listens only on this machine's `127.0.0.1`.
- Send “Explain this project without changing files.” Use **Send**, **Stop**, **New conversation**, and the engine selector. Ctrl/⌘+Enter sends a message.
- Keep the terminal open. **Ctrl+C** stops this foreground server.

**After a restart, use the newly printed URL.** The token changes on each server start. A stale bookmark or bare `http://127.0.0.1:8787/` in a new browser session can show the page but fail authentication. If you replace only the URL fragment in an already open tab, reload it as well.

### Windows: optional background launcher for a custom Responses provider

If your native Codex config already uses a custom Responses provider, run these in PowerShell:

```powershell
.\bin\windows\start-web.ps1 -Workspace "C:\projects\my-app" -OpenBrowser
.\bin\windows\stop-web.ps1
```

This starts a hidden process with an isolated Codex home under `.web-local`, reusing your current provider/model without writing its key to disk or modifying global Codex settings. It avoids sharing desktop-app sessions and plugins. It is **not an OAuth-only launcher** and does not accept a Bridge `--config`; use the foreground command for those cases. Neither launcher enables login autostart.

Full instructions: [Web chat](docs/user-guide/web-chat.md) · [Windows](docs/user-guide/windows.md) · [Channel reference](docs/channels.md).

## 3B. Connect Feishu / Lark instead

```sh
node bin/run-lark-cc.mjs
```

1. Open the **management console** address printed by the launcher.
2. Complete the QR-code setup, choose an agent and a project, then start the profile.
3. DM the bot `/status`, then send a small task. In a group, add the bot and use a real @mention.

```sh
node bin/run-lark-cc.mjs ui --print
node bin/run-lark-cc.mjs status
node bin/run-lark-cc.mjs stop
```

These commands manage the **console**, not the Web chat process. The inbox and monitoring are optional and initially off; ordinary chat does not require them. See [first Lark setup](docs/user-guide/getting-started.md) and [deployment](docs/self-contained.md). Registering an OS service is a separate step requiring a stable installed CLI path.

## 4. Configure only what you need

| What you want to change | Where to change it |
| --- | --- |
| Agent login / native model provider | The chosen agent's own configuration; ordinary Bridge chat can reuse it |
| Web project and port | `web --workspace ... --port ...` |
| Web model/effort/display defaults | A TOML file passed explicitly with `web --config ...` |
| Lark app, profiles, permissions and default project | Console, or `~/.lark-channel/config.toml` |
| Independent Responses API used by Codex/Pi or screening | `model_services.<name>` in Bridge TOML; secrets are env/file references |
| Assistant and monitoring | Configure them after basic chat works; [assistant](docs/user-guide/assistant.md), [monitoring](docs/user-guide/monitoring.md) |

**Standalone `web` does not automatically load `~/.lark-channel/config.toml`.** Pass `--config` when you want it to use a file. Bridge loads TOML (`version = 3`), not old JSON configuration.

Start with the [native Web example](docs/user-guide/examples/web-native.toml), or the [custom Responses example](docs/user-guide/examples/web-responses.toml):

```sh
node bin/lark-channel-bridge.mjs config check --config docs/user-guide/examples/web-native.toml
node bin/lark-channel-bridge.mjs web --agent codex --workspace . --state-dir .web-local/chat --config docs/user-guide/examples/web-native.toml
```

Edit a **private copy**, not the shipped example, for real settings. A successful `config check` validates structure; it does not contact the model or prove credentials work. Restart standalone Web after changing its file. Read the [configuration tutorial](docs/user-guide/configuration.md) for complete recipes and the [reference](docs/configuration.md) for precedence and reload behavior.

## 5. Common problems

| Symptom | First check |
| --- | --- |
| Page opens, but messages fail with `unauthorized` | Reopen the latest full token URL, then reload |
| Connection refused | Server is still running, correct port, same machine; remote hosts need SSH forwarding |
| Command / `dist/cli.js` not found | Run the pinned install from the repository; do not start only the frontend |
| Codex missing or provider authentication fails | Check the CLI in the same user account; use `--binary` for an explicit path |
| `already has an active writer` | Avoid sharing a native Codex home with another app; use the optional isolated launcher when applicable |
| Editing config appears ineffective | Correct process, explicit Web `--config`, and a restart after saving |

More: [Web troubleshooting](docs/user-guide/web-chat.md#故障排查) · [operations](docs/user-guide/operations.md).

## Safety and project status

These are **local operator interfaces, not public multi-user services**. Do not share token URLs or expose their ports. Agent commands can change files: standalone Codex/Claude default to workspace access, Pi to full access; Lark profiles have their own permission settings. Review permissions before sending tasks. Stop does not undo completed changes.

Native Windows Web/Codex was tested with real replies, tool execution and restart/resume. The full repository test suite is **not yet green**; [validation and remaining findings](docs/windows-web-validation.md) distinguish verified paths from unverified integrations. Existing Lark/advanced CLI behavior is documented in the [runtime reference](docs/runtime-reference.md).

For development, use the pinned pnpm version above, then `pnpm test`, `pnpm typecheck`, `pnpm typecheck:web` and `pnpm build`. Architecture: [channels](docs/channels.md) · [agent execution](docs/agent-execution.md). License: [MIT](LICENSE).

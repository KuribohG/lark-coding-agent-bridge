# lark-channel-bridge

Talk to a local **Claude Code, Codex CLI, Pi Coding Agent or Antigravity CLI** from Feishu / Lark. The agent runs on your machine and works in the project directory you choose.

[中文](README.zh.md) · [Documentation](docs/README.md)

This page is the Linux setup. Browser chat without Lark, Windows, the web console and Slack are in the [full quick start](docs/quick-start.md).

## Install

You need Git, Node.js 22.12+ (or 20.19+ within Node 20) and one agent CLI that already works for the user who will run the bridge.

```sh
git clone --branch dev https://github.com/KuribohG/lark-coding-agent-bridge.git
cd lark-coding-agent-bridge
npx --yes pnpm@10.33.0 install --frozen-lockfile
```

Install from this `dev` branch; the npm package with the same name may not contain the same code. Run the commands below from the repository directory.

## Set up a bot

```sh
node bin/lark-channel-bridge.mjs guide
```

The guide asks, in Chinese, for the agent executable, permissions, who may use the bot, the project directory, model credentials, the network proxy and the Lark app, which you can create by scanning a QR code in the terminal. It writes `~/.lark-channel/config.toml` after the last answer; Ctrl+C before that leaves nothing behind.

## Run

```sh
node bin/lark-channel-bridge.mjs run --profile <name>     # foreground, Ctrl+C to stop
node bin/lark-channel-bridge.mjs start --profile <name>   # register as a systemd service
node bin/lark-channel-bridge.mjs up                       # background without systemd; `down` stops it
```

Then DM the bot `/status` and send a small task. In a group, add the bot and @mention it.

The agent can change files and run commands with the permissions you picked in the guide. Check them before opening the bot to other people.

## More

- [Deploying with `up`](docs/deploy.md): build a branch, upgrade, roll back
- [Configuration reference](docs/configuration.md) and [runtime reference](docs/runtime-reference.md)
- [Workflows](docs/workflows.md)
- Development: `pnpm test`, `pnpm typecheck`, `pnpm build`

License: [MIT](LICENSE)

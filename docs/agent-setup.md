# Setup guide for coding agents

[Linux quick start](../README.md) · [Documentation index](README.md) · [Configuration reference](configuration.md)

This page is written for a coding agent (Claude Code, Codex and similar) that a person has asked to install and configure the bridge on a Linux machine. A person setting it up by hand should run `node bin/lark-channel-bridge.mjs guide` instead.

`guide` asks its questions on a terminal. Without one it only prints a checklist, so you configure the bridge with the non-interactive commands below. They write the same `~/.lark-channel/config.toml` the guide writes.

## What only the person can do

- Create or approve the Lark app. Creating one means opening a link in Lark; you cannot do it for them.
- Decide what the agent may do on the machine and who may use the bot.
- Log the agent CLI in to its model account, if it is not logged in yet.
- Send the first message to the bot. That is the only real end-to-end test.

## 1. Ask before you change anything

Get these answers first. Do not pick the access level or the audience yourself.

| Question | Options |
| --- | --- |
| Which agent runs behind the bot? | `claude`, `codex`, `pi`, `agy` |
| Which project directory does it work in? | An absolute path |
| What may it do on this machine? | `full` (any file, any command), `workspace` (writes only inside the project), `read-only`. Not every agent supports all three; `config check` rejects an unsupported one. |
| Who may use the bot? | Only the app owner (default), people and chats the owner later invites, or anyone in the tenant |
| New Lark app or an existing one? | New: the person opens a link. Existing: you need its App ID and App Secret. |
| How does the agent reach its model? | Its own login, or a third-party gateway address and token |
| Does this machine need a proxy to reach Lark or the model? | Proxy URL and the hosts that bypass it |

If the person wants the bot open to the whole tenant with `full` access, tell them that anyone who can find the bot can then run commands as their account, and ask them to confirm.

## 2. Install

Requires Git and Node.js 22.12+ (or 20.19+ within Node 20).

```sh
git clone --branch dev https://github.com/KuribohG/lark-coding-agent-bridge.git
cd lark-coding-agent-bridge
npx --yes pnpm@10.33.0 install --frozen-lockfile
```

Run every command below from this directory, as the user who will run the bridge. `B` stands for `node bin/lark-channel-bridge.mjs`.

## 3. Find the agent executable

```sh
command -v claude codex pi agy
ls ~/.local/bin ~/.npm-global/bin ~/.nvm/versions/node/*/bin 2>/dev/null | grep -E '^(claude|codex|pi|agy)$'
/absolute/path/to/agent --version
```

A version number shows that the executable runs. It does not show that the model account works. Ask the person whether they have completed one conversation with this CLI under this user; if not, they need to log in first.

## 4. Create the profile

One profile is one bot. `profile create` checks the app credentials with Lark and writes the config only when they are valid.

**New app.** The command prints a QR code and a line starting with `也可以直接在浏览器打开：` followed by a URL, then waits until the app is created. The link expires after a few minutes.

```sh
B profile create <name> --agent <kind> --workspace /absolute/project/path
```

Start it in the background or with a timeout of at least ten minutes, read the URL from its output, and give the URL to the person. Whoever opens the link becomes the owner of the bot, so send it only to the person you are working for, never to a group chat. Keep the command running until it prints `已创建 profile`.

**Existing app.** Pass the secret on standard input so it does not appear in the process list:

```sh
printf '%s\n' "$APP_SECRET" | B profile create <name> --agent <kind> --workspace /absolute/project/path --app-id cli_xxx --tenant feishu
```

Use `--tenant lark` for the international version. An existing app also needs the scopes, event subscriptions and a published version listed by `B guide --print` (section 6 of its output). Relay that list to the person; they apply it in the Lark developer console.

Chat is open only to the app owner by default. If the person did not create the existing app, they cannot use the bot until the owner sends `/invite user @them` in Lark.

## 5. Apply the answers

The config file must exist before `config set` works, so run these after step 4. Skip the ones that do not apply.

```sh
# Agent executable, when it is not on the PATH of the bridge process
B config set agents.<kind>.launch.binaryPath /absolute/path/to/agent

# Access level: set both
B config set profiles.<name>.permissions.defaultAccess <full|workspace|read-only>
B config set profiles.<name>.permissions.maxAccess <full|workspace|read-only>

# Open to anyone in the tenant (the default is personal)
B config set profiles.<name>.mode team

# Proxy for the Lark connection: HTTP(S) only, no credentials in the URL
B config set channels.lark.profiles.<name>.network.proxy http://proxy.example.com:3128
B config set channels.lark.profiles.<name>.network.no_proxy localhost,127.0.0.1

# Proxy for the agent process and the commands it runs
B config set profiles.<name>.launch.env.https_proxy http://proxy.example.com:3128
B config set profiles.<name>.launch.env.http_proxy http://proxy.example.com:3128
B config set profiles.<name>.launch.env.no_proxy localhost,127.0.0.1
```

Write proxy settings into the config even when the current shell already exports them: a bridge started as a service does not inherit the shell's variables. Put the host of an internal model gateway into `no_proxy`.

**Claude Code through a third-party gateway:**

```sh
B config set profiles.<name>.launch.env.ANTHROPIC_BASE_URL https://gateway.example.com
B config set profiles.<name>.launch.env.ANTHROPIC_AUTH_TOKEN '${ANTHROPIC_AUTH_TOKEN}'
```

The quoted `${ANTHROPIC_AUTH_TOKEN}` is stored as a reference, so the token stays out of the file and must be in the environment of the bridge process at every start. To store the token itself, pass its value instead and double every `$` in it. Ask the person which they prefer.

**Codex or Pi through a third-party Responses gateway:** save the token in a file only this user can read, then register a model service that points to it.

```sh
mkdir -p -m 700 ~/.lark-channel/model-keys
(umask 077; printf '%s\n' "$MODEL_TOKEN" > ~/.lark-channel/model-keys/gateway.key)
B model-service configure gateway service.json
```

`service.json`:

```json
{"protocol": "responses", "baseUrl": "https://gateway.example.com/v1", "model": "<model id>", "apiKey": {"source": "file", "id": "/home/<user>/.lark-channel/model-keys/gateway.key"}}
```

See [model services](model-services.md) for selecting between several services, and [Antigravity](antigravity.md) for `agy`.

Then validate:

```sh
B config check
B config show --profile <name>
```

`config check` validates structure only. It does not read credentials or contact the model.

## 6. Start

```sh
B up                         # background, no systemd needed; run again after an upgrade, `B down` stops it
B start --profile <name>     # or: register a systemd service
```

Do not use `B run --profile <name>` for a bridge that should keep running: it stays in the foreground and ends with your session.

Check that it came up:

```sh
B ps
B logs --profile <name> --lines 50
```

If a bridge process already holds the profile, the non-interactive start refuses to replace it. Report this to the person; stop the old process with `B kill <id>` only when they agree.

## 7. Hand over

Tell the person:

1. DM the bot `/status`, then send a small task such as "explain this project without changing files". A reply is the proof that the setup works.
2. In a group, add the bot and mention it with the @ picker. Typing "@name" as plain text does not reach it.
3. To let others in, the owner sends `/invite user @colleague` or `/invite group` in Lark.

Then report what you configured: the profile name, agent path, project directory, access level, audience, how the bridge was started, and any environment variable it needs at start.

## Rules

- Never print, log or commit an App Secret or model token. Do not paste `config.toml` into a chat.
- Do not edit `config.toml` by hand while a bridge is running; use `config set`, which locks the file and tells you whether a reload or reconnect is needed.
- Do not widen access or the audience beyond what the person chose.
- If a log line contains `99991672`, the app is missing a scope. The error names the scope and gives an application link; pass both to the person.
- If a command fails, report its output. Do not delete `~/.lark-channel` or an existing profile to get past an error.

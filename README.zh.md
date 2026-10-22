# lark-channel-bridge

通过**浏览器或飞书 / Lark**使用本机的 **Codex CLI、Claude Code、Pi Coding Agent**。Agent 在你的机器上运行，处理你指定的项目目录。

[English](README.md) · [中文用户手册](docs/user-guide/README.md) · [配置教程](docs/user-guide/configuration.md)

> 本文对应本仓库 **`dev` 分支**。npm 上的同名包不一定包含这些功能，第一次使用请按下方步骤从源码安装。

## 1. 先选入口

| 你想做什么 | 启动入口 | 打开的是什么 | 需要飞书吗 |
| --- | --- | --- | --- |
| 在浏览器里和 Agent 聊天 | `web --agent codex` | **Bridge Chat 聊天页**，默认 8787 端口 | 不需要 |
| 配飞书机器人、profile、会话助理 | `node bin/run-lark-cc.mjs` | **管理控制台**，地址以终端输出为准 | 接机器人时需要 |
| 已有飞书配置，只想无界面运行 | `run --profile <名称>` | 终端日志 | 需要 |
| 接入 Slack Bot | `slack --workspace /absolute/project/path --allowed-users U... --allowed-channels C...` | Socket Mode，每个 thread 独立会话；见[接入说明](docs/channels.md#run-the-bundled-slack-channel) | 否 |

**聊天页和管理控制台不是同一个页面。** `run-lark-cc`、`run --web-ui` 都不是独立聊天入口。只想先跑起来体验，选 Web 聊天即可。

## 2. 安装一次

准备 **Git**、**Node.js 22.12 或更新版本**（也支持 Node 20 中的 20.19 及更新版本），以及至少一个安装并完成登录 / provider 配置的 Agent。在准备运行 Bridge 的同一终端、同一用户下检查：

```sh
node --version
codex --version
```

如果使用 Claude 或 Pi，改为检查 `claude --version` 或 `pi --version`。版本命令只证明程序存在；先直接用 Agent 完成一次简单对话，确认模型账号可用。

```sh
git clone --branch dev https://github.com/KuribohG/lark-coding-agent-bridge.git
cd lark-coding-agent-bridge
npx --yes pnpm@10.33.0 install --frozen-lockfile
```

**后续命令都在仓库目录执行。** 安装会构建网页和 CLI，无需另起 Vite、数据库、Docker 或 WSL，也不要求全局 `npm link`。固定 pnpm 版本是为了避免不同版本的依赖构建策略导致安装失败。

## 3A. 启动 Web 聊天：不配飞书

```sh
node bin/lark-channel-bridge.mjs web --agent codex --workspace . --state-dir .web-local/chat --port 8787
```

- `--workspace .` 表示当前仓库；换成你的项目路径即可，路径有空格时加引号。
- 用 Claude 或 Pi 时，把 `codex` 换为已安装、已配置的 `claude` 或 `pi`。无配置文件时省略 `--agent` 默认选 Claude，**不会自动选 Codex**。
- 打开终端打印的**完整地址，包括 `#token=...`**。服务只监听本机 `127.0.0.1`。
- 发送“请解释这个项目，先不要修改文件”。页面提供发送、停止、新对话、切换引擎；Ctrl/⌘+Enter 发送消息。
- 这是前台运行，终端要保持打开；按 **Ctrl+C** 停止服务。

**重启后必须使用新打印的地址。** 每次启动的 token 都不同。旧书签、旧 token，或者在新浏览器会话中只打开 `http://127.0.0.1:8787/`，可能出现页面能开但无法发消息。已有标签页只替换了 `#token` 时，还需刷新页面。

### Windows：已有自定义 Responses provider，可选后台启动

如果本机 Codex 已配置自定义 Responses provider，可在 PowerShell 执行：

```powershell
.\bin\windows\start-web.ps1 -Workspace "C:\projects\my-app" -OpenBrowser
.\bin\windows\stop-web.ps1
```

脚本隐藏运行后台服务，在 `.web-local` 中隔离 Codex 状态；复用当前模型/provider，不把密钥写入生成配置，也不改全局 Codex 设置，避免与桌面端争用会话或加载其插件。此脚本**不适用于只有官方 OAuth 登录的配置，也不接受 Bridge 的 `--config`**；这些场景使用前台命令。两种启动方式都不会自动注册开机自启。

完整说明：[Web 聊天怎么用](docs/user-guide/web-chat.md) · [Windows 启动与维护](docs/user-guide/windows.md)。

## 3B. 如果你想接飞书 / Lark

```sh
node bin/run-lark-cc.mjs
```

1. 打开启动器打印的**管理控制台**地址。
2. 按网页向导扫码连接应用，选择 Agent 和项目，然后启动 profile。
3. 私聊机器人发送 `/status`，再发一个简单任务；群聊需先拉机器人入群并真正 @机器人。

```sh
node bin/run-lark-cc.mjs ui --print
node bin/run-lark-cc.mjs status
node bin/run-lark-cc.mjs stop
```

这组命令管理的是**控制台**，不是 3A 的聊天进程。会话助理和监控是后续可选功能，默认关闭，普通对话不依赖它们。详见[首次飞书接入](docs/user-guide/getting-started.md)；系统服务是另一步，需要稳定的已安装 CLI 路径。

## 4. 配置到底改哪里

| 想改什么 | 改哪里 |
| --- | --- |
| Agent 登录、原生 provider | Agent 自己的配置；普通 Bridge 对话可以沿用 |
| Web 使用的项目和端口 | `web --workspace ... --port ...` |
| Web 模型、思考强度、展示默认值 | 一个 TOML 文件，通过 `web --config ...` **显式传入** |
| 飞书应用、profile、权限、默认项目 | 管理控制台，或 `~/.lark-channel/config.toml` |
| 独立模型 API，供 Codex/Pi 或助理筛选使用 | Bridge TOML 中的 `model_services.<名称>`；密钥使用环境变量 / 文件引用 |
| 会话助理、GitLab CI 等来源 | 基础对话跑通后再配：[会话助理](docs/user-guide/assistant.md)、[监控](docs/user-guide/monitoring.md) |

**独立 `web` 不会自动读取 `~/.lark-channel/config.toml`。** 需要配置文件就加 `--config`。Bridge 使用 `version = 3` 的 TOML，不能直接加载旧 JSON 配置。

最少配置可以从[沿用原生 Codex 的示例](docs/user-guide/examples/web-native.toml)开始；需要在 Bridge 指定 API 时，用[自定义 Responses 示例](docs/user-guide/examples/web-responses.toml)：

```sh
node bin/lark-channel-bridge.mjs config check --config docs/user-guide/examples/web-native.toml
node bin/lark-channel-bridge.mjs web --agent codex --workspace . --state-dir .web-local/chat --config docs/user-guide/examples/web-native.toml
```

真实配置请复制到**私有文件**再修改，不要直接往仓库示例中写密钥。`config check` 通过只代表结构合法，不代表模型调用成功。独立 Web 改完配置后重启；[配置教程](docs/user-guide/configuration.md)按场景说明完整步骤，[字段参考](docs/configuration.md)解释优先级和生效规则。

## 5. 常见卡点

| 现象 | 先检查 |
| --- | --- |
| 页面能开，发消息报 `unauthorized` | 使用最近一次启动的完整 token 地址，然后刷新 |
| 浏览器提示连接被拒绝 | 服务是否仍在运行、端口是否正确、是否同一台机器；远程服务器需端口转发 |
| 找不到命令或 `dist/cli.js` | 在仓库根目录执行固定版本的安装命令，不要只启动前端 |
| 找不到 Codex / 模型鉴权失败 | 同一用户下 CLI 能否正常对话；程序不在 PATH 时用 `--binary` |
| `already has an active writer` | 避免与桌面端共享 Codex 会话目录；满足条件时用隔离启动脚本 |
| 改了配置没生效 | 是否改对文件、Web 是否传入 `--config`、保存后是否重启正确的服务 |

继续排查：[Web 故障排查](docs/user-guide/web-chat.md#故障排查) · [运行维护](docs/user-guide/operations.md)。

## 安全与验证范围

这是**本机操作界面，不是公网多用户服务**。不要分享 token 链接或开放端口。Agent 可以修改文件：独立 Web 的 Codex/Claude 默认是 workspace 权限，Pi 默认 full；飞书 profile 有单独的权限配置。发任务前确认范围，停止不会撤销已完成的修改。

原生 Windows Web/Codex 已验证真实对话、工具调用和重启续接，**不代表整个仓库测试全通过**；已知失败与未验收功能见[验证记录](docs/windows-web-validation.md)。高级命令、权限、旁问、限时任务等已移至[运行行为详细参考](docs/user-guide/runtime-reference.md)。

开发验证：使用上方固定版本 pnpm 安装后运行 `pnpm test`、`pnpm typecheck`、`pnpm typecheck:web`、`pnpm build`。架构：[渠道](docs/channels.md) · [Agent 执行](docs/agent-execution.md)。许可证：[MIT](LICENSE)。

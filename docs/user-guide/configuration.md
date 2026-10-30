# 配置教程：先选场景，再改文件

[手册首页](README.md) · [Web 聊天](web-chat.md) · [字段与优先级参考](../configuration.md)

先跑通一种基础对话，再配置模型、助理或监控。**Bridge 配置、Agent 自己的配置、运行状态不是一回事。** 不要把网上的整段配置覆盖到已有文件，也不要把真实密钥提交到 Git。

## 1. 找到真正生效的文件

| 运行方式 | 读取什么 |
| --- | --- |
| `web --agent codex`，没有 `--config` | Web 内置默认值 + 原生 Codex 账号/provider；不自动读 Bridge TOML |
| `web --config <文件>` | 指定的 Bridge TOML 中的执行和 Web 展示设置；不连接飞书 |
| `bin/windows/start-web.ps1` | 原生 Codex 自定义 Responses provider；生成独立 home 的配置，不接受 Bridge `--config` |
| 飞书管理控制台 / 默认 `run` | `~/.lark-channel/config.toml`，或 `LARK_CHANNEL_HOME` 下的 `config.toml` |
| 飞书 `run --config <文件>` | 指定的根 TOML；关联状态归属该配置根目录 |

`~` 表示当前运行用户的主目录；Windows PowerShell 对应 `$HOME`。Agent 的配置位置遵循 Agent 自身规则，例如 Codex 使用 `CODEX_HOME` 或默认 `~/.codex`。从其他用户、服务账号或终端启动时，不一定读到你当前登录的账号。

最容易混淆的三种凭据：

| 凭据 | 用来做什么 | 不应该填在哪里 |
| --- | --- | --- |
| Web URL 中的 token | 访问本机网页 API，每次服务启动变化 | 不是模型 API key |
| 模型 API key / Agent 登录态 | 请求模型服务 | 不要放进聊天消息或公开配置 |
| 飞书 App Secret / 用户授权 | 连接机器人 / 读取飞书数据 | 不是 Codex 或模型服务凭据 |

## 2. 场景 A：Web 沿用已有 Codex 模型

**完全不需要额外文件也能运行：**

```sh
node bin/lark-channel-bridge.mjs web --agent codex --workspace . --state-dir .web-local/chat
```

如果想调整展示或明确继承模型，复制 [web-native.toml](examples/web-native.toml)。以下示例在仓库根目录的 PowerShell 中运行；目标存在时不要覆盖已有配置：

```powershell
New-Item -ItemType Directory -Force .web-local | Out-Null
Copy-Item docs/user-guide/examples/web-native.toml .web-local/web.toml -Confirm
node bin/lark-channel-bridge.mjs config check --config .web-local/web.toml
node bin/lark-channel-bridge.mjs web --agent codex --workspace . --state-dir .web-local/chat --config .web-local/web.toml
```

其中两个重要设置：

```toml
[agents.codex.run]
model = { source = "native" }
effort = { source = "native" }
```

它们明确让原生 CLI 决定模型和思考强度；不是名为 `native` 的模型。只想指定这次启动的模型，也可以在 `web` 命令加 `--model <模型ID>`。模型必须是你当前 provider 真正支持的 ID，Bridge 不保证任何示例模型有权限或额度。

## 3. 场景 B：Web 使用 Bridge 管理的 Responses API

这与场景 A 的“复用原生 provider”是两条不同路径。使用 [web-responses.toml](examples/web-responses.toml)，复制到 `.web-local/web.toml` 后修改：

| 字段 | 填什么 |
| --- | --- |
| `model_services.gateway.baseUrl` | 你的 HTTPS API 根地址，通常以 `/v1` 结尾；**不要附加 `/responses`** |
| `model_services.gateway.model` | 服务支持的真实模型 ID |
| `agents.codex.run.model` | `gateway/<上面模型ID>`；`gateway` 是服务名，不是网址 |
| `model_services.gateway.apiKey.id` | 环境变量名称，示例为 `BRIDGE_MODEL_API_KEY`；不是 key 本身 |

在**将要启动 Bridge 的同一 PowerShell 窗口**读取密钥并启动：

```powershell
$env:BRIDGE_MODEL_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host '模型 API key' -AsSecureString)).Password
node bin/lark-channel-bridge.mjs config check --config .web-local/web.toml
node bin/lark-channel-bridge.mjs web --agent codex --workspace . --state-dir .web-local/chat --config .web-local/web.toml
```

输入不会显示；密钥仍会存在进程环境中，应保护本机账号。不要在另一个终端设置变量后期待已启动的服务自动获得它。Bridge 不会自动读取 `.env`。

也可以将 `apiKey` 改为私有 UTF-8 文件引用，例如：

```toml
apiKey = { source = "file", id = 'C:\private\model-api-key.txt' }
```

这个片段替换同一个服务里的 `apiKey` 字段，不是独立完整配置。密钥文件需要自行保护访问权限，不要放在仓库中。Windows 路径可用 TOML 单引号字符串，避免反斜杠转义。

Responses 模型服务可供 Codex / Pi 使用，不能把它直接当成 Claude 的 Anthropic Messages 服务。独立服务不复用 Agent 的工具、会话或 OAuth。更多头部、服务命名和检查命令见[模型 API 服务](../model-services.md)。

## 4. 场景 C：飞书机器人

第一次推荐[网页扫码向导](getting-started.md)，不要一开始手写 App Secret。向导保存后，检查生成的 `~/.lark-channel/config.toml`，再修改需要的字段。

已有应用、需要部署配置时，可参考 [lark-codex.toml](examples/lark-codex.toml)：

1. 复制到专用私有目录，不要覆盖现有根配置。
2. 把 `cli_REPLACE_ME` 换成真实 App ID；国际版按需将 `tenant` 改为 `lark`。
3. 在启动环境设置 `FEISHU_APP_SECRET`，不要把实际密钥写入例子。
4. 用 `config check --config <文件>` 检查，再执行 `run --config <文件> --profile codex --workspace <项目路径>`。
5. 完成必要的飞书权限与授权，发送 `/status` 和一个实际任务验证。

配置中的 **profile 名称**和 **agent 类型**不同：`profiles.work` 可以使用 `agent = "codex"`；`--profile work` 选择这套机器人，`--agent codex` 选择引擎。只有管理多套机器人或应用时才需要多个 profile。

本示例选择 workspace 权限；新建的普通飞书 profile 可能使用更宽的 full 权限，检查向导结果后再发任务。`allowedUsers` / `allowedChats` 是谁能与机器人聊天，`permissions` 是 Agent 能对本机做什么，不要混用。

## 5. 常用配置对照

以下均是局部字段说明，需要放进相应完整配置文件：

| 想改的行为 | 字段 | 生效范围 |
| --- | --- | --- |
| 所有执行器的默认并发 | `[defaults.run] max_concurrent_runs = 4` | 各 profile 默认值，不是全机器总并发上限 |
| Codex 默认模型 | `[agents.codex.run] model = "模型ID"` | 使用该引擎、未覆盖模型的运行 |
| 某个 bot 单独指定模型 | `[profiles.work.run] model = "模型ID"` | 名为 work 的 profile |
| 禁用无输出超时 | `[defaults.run] idle_timeout_minutes = 0` | 新运行；0 表示不启用该 watchdog |
| Web 是否显示工具 | `[channels.web] show_tools = true` | 独立聊天页 |
| Web 是否显示推理 | `[channels.web] show_reasoning = false` | 仅改变展示，不改变模型思考强度 |
| 飞书过程显示 | `[channels.lark] progress = "brief"` | 飞书；可选 off / brief / detailed |
| 飞书消息合并窗口 | `[channels.lark.profiles.work] message_debounce_ms = 250` | 该 profile；0–5000ms，0 表示不等待 |
| 飞书代理 | `[channels.lark.network] proxy = "env"` | 默认读取 HTTP(S)_PROXY；也可填 `direct` 或 HTTP(S) 代理地址，修改后重新连接 |
| 飞书代理绕过 | `[channels.lark.profiles.work.network] no_proxy = "localhost,.internal"` | 按 profile 覆盖 NO_PROXY；空字符串清空绕过规则 |
| Codex 程序位置 | `[agents.codex.launch] binaryPath = 'C:\tools\codex.exe'` | Agent 进程启动 |
| 某个飞书 profile 默认目录 | `[profiles.work.workspaces] default = 'C:\projects\my-app'` | 该 bot 的默认项目；独立 Web 使用 `--workspace` |
| 权限限制 | `[profiles.work.permissions] defaultAccess = "workspace"` 与 `maxAccess = "workspace"` | 明确 profile 的默认及最高权限 |

执行字段优先级从低到高为：**内置 → defaults → agent → profile → 会话 → 显式任务参数**。删除某层字段表示继承；`model = { source = "native" }` 则明确停止上层模型继承，交给原生 CLI。展示设置有自己的全局/每 profile 层，不跟随 Agent 模型配置继承。

Web 选择 profile 时可使用 `--profile`；未指定时参考 `bridge.active_profile` 等默认选择。独立 Web 不连接这个 profile 的飞书应用，也不通过浏览器请求更换工作目录或权限。

## 6. 检查与应用

```sh
node bin/lark-channel-bridge.mjs config check --config /path/to/config.toml
node bin/lark-channel-bridge.mjs config show --config /path/to/config.toml --profile work --sources
```

把路径与 profile 换成实际值；`show --profile` 用于文件中确实存在的 profile。**检查不读取密钥、不请求模型、不修改已运行进程**。最后仍需发一个真实小任务验收。

| 修改对象 | 怎么应用 |
| --- | --- |
| 独立 Web 的 TOML 或启动参数 | 停止并按新参数重启，打开新 token URL |
| Windows 隔离启动器读取的原生模型/provider | 停止脚本实例再启动；每次启动重新生成隔离配置 |
| 飞书执行/展示设置 | 对每个受影响的在线 bot 执行 `/config reload`，作用于后续任务 |
| Agent 启动、账号、权限、工作目录等构造设置 | 按 reload 提示重启对应 profile / 服务 |
| 助理与监控来源 | 遵循[监控配置](../monitor-config.md)的独立应用规则 |

修改环境变量不会改变已有进程；从哪里启动，就需要在哪个环境提供变量。不要为了“清缓存”删除会话或凭据目录。

## 7. 之后再配置的功能

- 模型选择、飞书访问和用户授权：[模型与账号](models-and-accounts.md)。
- 筛选消息、结果话题、草稿工作台：[会话助理](assistant.md)。
- CI 或存储来源：[监控](monitoring.md)、[完整字段示例](../config.example.toml)。
- 旧 JSON 迁移、字段命名、重载边界：[配置参考](../configuration.md)。本版本不会直接加载旧 JSON。

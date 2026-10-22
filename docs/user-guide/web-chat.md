# Web 聊天：启动、使用与排错

[手册首页](README.md) · [配置教程](configuration.md) · [Windows](windows.md)

这篇只讲 **Bridge Chat 独立聊天页**。它不需要飞书，不包含机器人管理、会话助理或模型服务编辑表单。`run-lark-cc` 打开的是另一套[飞书管理控制台](getting-started.md)。

## 第一次启动

先按[快速开始](../../README.zh.md#2-安装一次)完成安装，并确认本机 Agent 能直接对话。以下命令在仓库根目录执行：

```sh
node bin/lark-channel-bridge.mjs web --agent codex --workspace . --state-dir .web-local/chat --port 8787
```

把工作目录改成实际项目。例如 Windows：

```powershell
node bin/lark-channel-bridge.mjs web --agent codex --workspace "C:\projects\my-app" --state-dir .web-local/chat --port 8787
```

macOS / Linux 使用相应绝对路径；其余参数相同。Codex / Claude 默认使用 workspace 权限，Pi 不支持 workspace 沙箱，独立 Pi Web 的默认权限为 full。不要在不了解权限范围时切换引擎。

### 打开哪个地址

终端输出形如：

```text
Bridge Chat: http://127.0.0.1:8787/#token=<本次启动生成的令牌> (engine: codex)
```

打开**你自己的实际完整链接**；上面的占位符不能直接使用。第一次加载后，页面把令牌保存到当前浏览器会话，并清除地址栏里的 `#token`，这是正常现象。

- 每次重启服务都会换令牌，旧链接会失效。
- 新浏览器、无痕窗口或新的浏览器会话需要重新打开完整链接。
- 在已有标签页只替换 `#token` 不一定重新加载脚本；粘贴新链接后再刷新。
- `127.0.0.1` 指打开浏览器的那台机器；手机上的这个地址不是你的电脑。
- 不要把带令牌的地址公开。它是操作本机 Agent 的凭据。

## 页面怎么用

| 控件 / 动作 | 行为 |
| --- | --- |
| 消息框 + 发送 | 新任务；Ctrl/⌘+Enter 同样发送 |
| 运行中发送补充 | 支持的引擎会接收追加文字；“已接收”不代表已完成，送达未知时不要盲目重发 |
| 停止 | 取消当前运行，不撤销已写文件或已完成操作 |
| 新对话 | 创建新的对话上下文；不是清空项目目录 |
| 引擎选择 | 仅在空闲时切换；目标 Agent 必须已安装，并满足当前权限要求 |
| 工具进度 | 查看命令 / 工具执行过程；可由 `channels.web.show_tools` 隐藏 |

建议第一条消息是：“只说明你能看到的项目，不修改文件。”确认模型回复后，再给出真正任务。

**不要把飞书 `/cd`、`/config`、`/model` 等斜杠命令当成 Web 控件。** Web 页面只发送普通文本，不提供这些管理命令的解析。项目、模型和权限应在启动参数或配置中设置。

## 工作目录、模型和配置

| 参数 | 用途 |
| --- | --- |
| `--workspace <路径>` | 必填；已有目录，固定为此服务的项目 |
| `--agent codex\|claude\|pi` | 初始引擎；无配置、无参数时默认 Claude |
| `--binary <路径>` | 初始引擎的可执行文件；程序不在 PATH 时使用 |
| `--model <id>` | 初始引擎本次服务的新任务模型覆盖 |
| `--config <文件>` | 显式读取 Bridge TOML；不自动读取管理控制台的配置 |
| `--profile <名称>` | 需要 `--config`；选择其中的 profile，而非默认 active profile |
| `--state-dir <目录>` | 会话状态存储；不传时为 `~/.lark-channel/web/default` |
| `--port <端口>` | 默认 8787；传 0 时自动分配空闲端口，以输出地址为准 |

`LARK_CHANNEL_HOME` 不会替代独立 `web` 的 `--state-dir`。希望状态落在固定目录时显式传入它。

不用 Bridge 配置也能沿用 Agent 已有账号和模型。要配置模型服务、展示或执行默认值，参见[配置教程](configuration.md)。独立 Web 不监听配置文件变化，保存后需重启。

### Windows 后台与独立 Codex home

已有自定义 Responses provider 时，可以改用：

```powershell
.\bin\windows\start-web.ps1 -Workspace "C:\projects\my-app" -OpenBrowser
.\bin\windows\stop-web.ps1
```

该脚本读取原生 Codex 配置里的 `model_provider`、对应的 Responses 服务和默认模型，在 `.web-local/codex-home` 建立独立状态。密钥只注入子进程环境，不复制登录文件、桌面插件或通知命令。仅 OAuth 登录、不支持的鉴权或缺少凭据时会明确拒绝，**不会自动借用其他账号**。

脚本接受 `-Workspace`、`-StateDir`、`-Port`、`-OpenBrowser`，不接受 Bridge `--config`。需要 Bridge TOML 时使用上面的标准 CLI。详细数据位置和停止方式见 [Windows 指南](windows.md)。

## 停止、重启和续接

1. 先让任务结束，或点击“停止”。
2. 前台模式按 Ctrl+C；脚本模式执行对应的 `stop-web.ps1`。`run-lark-cc stop` 不会停止独立聊天页。
3. 使用相同项目、状态目录和端口重新启动。
4. 打开新的完整 token URL，刷新页面后继续提问。

服务端保存原生 session ID，浏览器本地保存当前对话 ID 和可见历史；不是多设备同步聊天记录。换浏览器、清理站点数据、点“新对话”，或者改变工作目录 / 权限，可能不再使用原上下文。运行中刷新或关闭网页会取消当前请求，不会离线继续工作，也没有断流重放。

Windows 脚本强停后，状态锁最多约 30 秒过期，重启脚本会等待，不应手动删除状态目录或锁。

## 在远程服务器运行

服务仍只监听服务器的回环地址。在你的电脑建立 SSH 转发：

```sh
ssh -N -L 8787:127.0.0.1:8787 user@your-server
```

然后使用 `http://127.0.0.1:8787/#token=<服务器打印的令牌>`。如果换了本地转发端口，浏览器 origin 也会改变，可见历史不一定沿用。不要为省去转发而直接向公网开放此服务。

## 故障排查

| 错误 / 现象 | 处理顺序 |
| --- | --- |
| `unauthorized` / 提示从启动链接打开 | 获取最近一次启动的完整链接；已有标签页重新加载 |
| 连接被拒绝 | 检查进程还在、端口正确、浏览器与服务是否同机；先看启动终端 |
| `EADDRINUSE` | 端口被占用；确认是不是已有实例，不要盲目终止别的进程；换端口或停止自己的实例 |
| 状态目录已被使用 | 同一个 `--state-dir` 只运行一个实例；停止旧实例后等待锁过期 |
| 找不到 Agent | 同一用户下执行 `codex --version` 等检查；必要时显式传 `--binary` |
| `CODEX_HOME ... does not exist` | 检查显式 home 路径；不要随意设置 `inheritCodexHome = false`，隔离 home 必须自行初始化 |
| `already has an active writer` | 原生 Codex home 可能被其他应用使用；自定义 Responses 场景可使用隔离启动器 |
| 模型 401 / 403 / 额度错误 | 直接检查 Agent/provider；Web token 与模型 API key 是两种不同凭据 |
| 模型服务配置没生效 | 标准 CLI 有没有传正确 `--config`、是否重启；后台隔离脚本使用的是原生 provider 配置 |
| 模型已答复，但日志有 `post-done-exit-timeout` | CLI 未在退出宽限期内结束，Bridge 会尝试清理；核对结果和子进程，不要扩大权限来消除日志 |

启动错误看终端；`--state-dir` 下的 `logs` 保存运行日志。Windows 脚本另有 `web.stdout.log`、`web.stderr.log`；只提供必要的脱敏错误，不公开 token、密钥和完整个人配置。

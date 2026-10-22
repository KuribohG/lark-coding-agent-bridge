# Windows：启动、停止与状态目录

[手册首页](README.md) · [Web 聊天](web-chat.md) · [首次飞书接入](getting-started.md) · [实际验证记录](../windows-web-validation.md)

Windows 可以原生运行，不需要 WSL。先安装 Git、符合 `package.json` 要求的 Node.js，以及选用的 Agent；使用同一 Windows 用户完成登录和运行。不要为了避开权限错误改用 SYSTEM，这会改变主目录、凭据与配置。

## 1. 安装源码

在 PowerShell 执行：

```powershell
git clone --branch dev https://github.com/KuribohG/lark-coding-agent-bridge.git
cd lark-coding-agent-bridge
npx --yes pnpm@10.33.0 install --frozen-lockfile
codex --version
```

如果使用 Claude/Pi，检查其实际命令。模型能否调用还要直接对话验证。固定 pnpm 版本可避免系统 pnpm 11 对旧版构建脚本配置不兼容。

## 2. 只要聊天页，先前台跑通

```powershell
node bin/lark-channel-bridge.mjs web --agent codex --workspace "C:\projects\my-app" --state-dir .web-local/chat --port 8787
```

项目目录必须存在。打开打印的完整 `#token=...` 地址；保持终端开启，Ctrl+C 停止。只有官方 OAuth 登录、需要 Bridge TOML、使用 Claude/Pi，都可以从标准 `web` 命令入手；按引擎与配置调整参数。

找不到程序时可用 `--binary "C:\实际路径\codex.exe"`，不要把别人机器的 Codex 安装路径照抄过来。Windows TOML 路径可用单引号，例如 `'C:\projects\my-app'`。

## 3. 自定义 Responses provider 的可选后台脚本

仅在原生 Codex 配置中已经有可用的**自定义 Responses provider**时使用：

```powershell
.\bin\windows\start-web.ps1 -Workspace "C:\projects\my-app" -OpenBrowser
.\bin\windows\stop-web.ps1
```

脚本支持：

| 参数 | 默认 / 用途 |
| --- | --- |
| `-Workspace` | 仓库根目录；改为实际项目 |
| `-Port` | 8787；换端口时使用新输出链接 |
| `-StateDir` | 仓库下 `.web-local`；指定后，停止时也要传同一个目录 |
| `-OpenBrowser` | 启动后打开默认浏览器；不传仍会打印完整 URL |

例如让状态固定到单独的目录：

```powershell
.\bin\windows\start-web.ps1 -Workspace "C:\projects\my-app" -StateDir "C:\bridge-data\chat" -Port 8787 -OpenBrowser
.\bin\windows\stop-web.ps1 -StateDir "C:\bridge-data\chat"
```

脚本不会注册登录自启，也不接受 Bridge `--config`。它只复用原生模型/provider：生成的配置使用环境变量引用，密钥和 HTTP 头部值只存在于子进程环境，不改全局 Codex 文件。

PowerShell 若按组织策略阻止 `.ps1`，先检查本地文件来源并按组织允许的方式运行；不要为启动聊天页修改全局安全策略。标准 `node ... web` 前台方式不依赖 PowerShell 脚本。

## 4. 不要混用停止命令

| 启动方式 | 停止方式 |
| --- | --- |
| `node ... web ...` 前台聊天 | 该终端 Ctrl+C；页面“停止”只停当前任务 |
| `start-web.ps1` 后台聊天 | `stop-web.ps1`，同一 `-StateDir` |
| `node bin/run-lark-cc.mjs` 后台管理控制台 | `node bin/run-lark-cc.mjs stop` |
| `node bin/run-lark-cc.mjs fg` 前台控制台 | Ctrl+C |
| `lark-channel-bridge start --web-ui` 系统服务 | `lark-channel-bridge stop --web-ui` |

脚本停止前核对 PID、启动时间与入口路径，只终止记录的进程树。Windows 强停使用 `taskkill /T /F`，不是 POSIX 的优雅信号，不保证所有应用层内容已刷盘。重启前最好等待任务结束。状态锁可能需要约 30 秒过期；启动器会等待，不应手动删除状态目录。

## 5. 配置、日志与备份

| 模式 | 位置 |
| --- | --- |
| 标准 Web | `--state-dir`；不传则 `~/.lark-channel/web/default`，不随 `LARK_CHANNEL_HOME` 改变 |
| 后台脚本 | `-StateDir`，默认 `.web-local` |
| 后台脚本的原生 Codex 状态 | `<StateDir>/codex-home` |
| 后台脚本的 Web 会话 / 日志 | `<StateDir>/web-state`、`web-state/logs` |
| 后台脚本的启动输出 | `<StateDir>/web.stdout.log`、`web.stderr.log` |
| 后台脚本的进程记录 | `<StateDir>/web-process.json` |
| 飞书管理控制台 | `LARK_CHANNEL_HOME` 或默认 `~/.lark-channel` |

`.web-local` 已被 Git 忽略。不要提交生成配置、会话、令牌日志和凭据。备份前停止相关实例；换机器时重新配置账号和可执行文件/项目路径，复制数据目录不等于凭据迁移。

## 6. 飞书的系统服务是另一条路径

先按[首次飞书接入](getting-started.md)完成真实机器人对话，确认后再考虑系统服务。需要稳定的全局 CLI 路径，例如源码安装后 `npm link`：

```powershell
lark-channel-bridge start --web-ui
lark-channel-bridge status --web-ui
lark-channel-bridge logs --web-ui --follow
lark-channel-bridge stop --web-ui
```

这是当前用户登录后运行的 Task Scheduler `ONLOGON` 任务，不是后台 Web 聊天脚本。单 profile 服务改用 `--profile <名称>`。不要用临时 npx 路径注册服务，不要同时运行服务与便携控制台连接相同应用。

supervisor 使用 `bridge.autostart_profiles`，不等同于 active profile；`profile autostart <名称> on|off` 设置集合。显式 `start --web-ui --profile <名称>` 会在服务定义中固定该 profile。

服务实现关闭默认 72 小时运行上限和电池电源限制，更新已有任务需重新安装定义而非仅 restart。状态查询依赖 PowerShell/COM 和 Task Scheduler 数值状态，不以界面语言字符串判断。注销、睡眠、断电不是持续运行保证。

## 7. 验证范围与排错

独立 Web/Codex 已在 Windows 验证真实回复、只读工具调用与隔离状态的重启续接；原生进程测试覆盖停止和 deadline。**不代表完整飞书账号流程、计划任务、睡眠恢复、所有引擎或整个测试集都已通过。** 未通过项目见[验证记录](../windows-web-validation.md)。

Task Scheduler 部署仍需在目标机器验收非管理员安装、登录自启、电池切换、强行结束父进程后的后代清理等。当前没有 Windows Job Object 级的退出后收容保证。

网页 token/端口问题先查 [Web 故障排查](web-chat.md#故障排查)。不要通过更换账号、放宽沙箱或删除状态来隐藏错误。

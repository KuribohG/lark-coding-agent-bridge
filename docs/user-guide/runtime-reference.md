# 运行行为详细参考

[手册首页](README.md) · [快速开始](../../README.zh.md) · [配置教程](configuration.md) · [English reference](../runtime-reference.md)

本页保留飞书与高级 CLI 的完整行为约定，首次使用不必通读。仅用浏览器聊天时，请先看 [Web 聊天指南](web-chat.md)；飞书斜杠命令不是 Web 页面的控制指令。下文命令按已全局安装书写；源码安装可把 `lark-channel-bridge` 换为 `node bin/lark-channel-bridge.mjs`。JSON 片段仅用于说明局部字段，不能直接替换完整配置文件；实际配置使用 TOML。

## Codex 中途补充

Bridge 的 Codex 统一使用 `app-server` 全双工模式，原生双向接口已在 Codex 0.162.1 验证，`exec` 后端已移除。已有配置需删除 `[agents.codex.launch]` 或 `[profiles.<name>.launch]` 下的 `transport = "exec"`，或改为 `"app-server"`。app-server 加载正常的用户配置和 execpolicy `.rules`；`ignoreUserConfig`、`ignoreRules` 默认均为 `false`，显式为 `true` 时会提示迁移。修改启动配置后需重启 bridge。

Codex 启动默认使用 `appServerMode = "daemon"`。Bridge 会确保官方本地 app-server daemon 运行，每次任务只连接一个短生命周期的 stdio 到 Unix WebSocket 桥，因此 daemon 负责的 memory 抽取和整合不会随着单次任务退出。显式配置 `appServerMode = "per-run"` 时，app-server 只存活于当前任务，并强制设置 `memories.generate_memories = false`；已有 memory 的读取和 Codex 原生 memory startup 路径保留，但当前 thread 不会作为新的 memory 生成输入。

运行期间直接发送补充文字即可：bridge 调用 `turn/steer`，保留同一进程、会话和回合，不停止后续跑，也不新增 slash 命令。收到成功确认后回复“已送入当前任务，等待模型处理”；这表示接口已接受，不表示模型已经落实要求。引用上下文会一同传入，图片、文件和 agent 自行发送的卡片回调仍走队列。

Codex 的原生异步提问（`request_user_input_async`，app-server 的 `agentMessage.questions`）会单独发送“需要你回复”卡片，在群聊原话题 @ 发起任务的用户，不依赖过程消息或回复显示模式。点击选项或填写答案即可提交到当前任务，卡片显示接收结果；没有点击不会自动提交默认选项。任务自然结束后，若原会话仍有效，答案会排队续接。停止任务、切换会话、过期或重启后的旧卡片不能继续操作；按钮仅供提问对象使用。卡片发送失败时会尝试发送普通文字提醒。此功能不包含同步提问/权限审批请求；通知声音仍由飞书客户端设置决定。

包含回调超时修复的版本会在卡片操作耗时较长时先响应“正在处理，请稍候”，随后更新卡片或发送处理结果。这只表示正在处理点击，不表示答案已经被接收，也不会因提前响应而重新执行操作；最终状态以卡片或后续消息为准。

任务已结束时，明确拒绝的补充进入下一轮；连接中断等导致送达状态未知时，会提示未确认且不自动重发，避免重复执行。`/stop` 先取消排队消息和准备中的输入，再停止当前任务并回执；它不撤销已经完成的操作。话题隔离、访问权限和群聊 @ 规则保持生效。限时任务内的文字补充不改变截止时间，其余输入仍不自动续跑。

## Claude 中途补充

Claude Code 2.1.302 已验证支持双向输入。升级 bridge 实际调用的 `claude` 后，加载此版本 bridge 即可使用，无需额外配置。运行期间直接发送补充文字，bridge 通过 `--input-format stream-json` 保持输入通道打开，沿用同一进程和会话；Claude 会在能处理新输入时纳入补充，若当前生成已结束，则在同一进程内继续处理。

bridge 收到带输入 ID 的接收回执后才回复“已送入当前任务，等待模型处理”。结果必须涵盖所有已发送的输入才结束任务，避免旧结果先到时丢失补充。接收确认不代表要求已执行，也不会强行中断正在运行的工具。引用、附件排队、权限检查、限时任务截止时间和 `/stop` 规则与上文一致。回执超时或断连时提示送达未知，不自动重发；失败时仍有补充未被结果确认，也不自动续跑。

较旧 CLI 的单次输入仍可使用，但中途补充需要结果中的输入 ID；缺少这些字段时 bridge 会报告无法确认，而不会把任务误判为完成。

## Pi Coding Agent 后端

使用 `lark-channel-bridge profile create pi --agent pi` 创建 Pi profile，也可在首次初始化时传 `--agent pi`。适配器通过 `pi --mode json` 读取 JSONL 事件，保存 Pi 返回的 session ID，后续轮次使用 `--session` 续聊。创建 profile 时可用 `LARK_CHANNEL_PI_BIN` 指定 `pi` 可执行文件。

Pi JSON 模式是单轮请求/响应，不是全双工输入通道，因此运行中的补充消息会排队到下一轮，不会 steer 当前回合。只读 profile 仅开放 `read`、`grep`、`find`、`ls` 并禁用扩展；完整权限 profile 继承 Pi 的常规工具。Pi 没有可移植的“仅工作区可写”文件系统沙箱，所以 bridge 会明确拒绝 `workspace` 权限模式，不会把它静默当成隔离环境。

当前 `@earendil-works/pi-coding-agent` 要求 Node.js 22.19 或更新版本；适配器也兼容支持范围内的 `@mariozechner/pi-coding-agent` 0.73 JSON 协议。

## 限流自动重试

普通任务遇到 API 限流（如 `exceeded retry limit, last status: 429 Too Many Requests`）时，bridge 会在 agent 自身重试结束后，再等待 30、60、120 秒各重试一次。次数按连续无进展计算：收到新的非空白正文、思考内容或工具调用/结果后，重试次数和等待时间重置；之后再次限流会从第 1 次、等待 30 秒开始。仅收到会话元信息、用量统计或空白输出不会重置。过程消息和流式回复会显示重试进度；过程消息更新失败时只丢弃该批过程更新，现有 COT 继续接收后续进度，任务与重试继续执行；`/stop`、切换会话和任务截止时间会取消重试。已有进度时会续接本轮报告的会话，并提示 agent 检查已完成的操作后继续。额度或预算耗尽、鉴权错误、送达状态未知的补充消息不自动重试；临时分叉任务，以及已有输出但未获得本轮会话 ID 的任务也不自动重试。

## 后台运行

`run` 适合首次配置和前台调试。确认 bot 能正常收发消息后，先用 `Ctrl-C` 停掉前台进程，再用系统服务常驻后台：

```bash
lark-channel-bridge start
lark-channel-bridge status
lark-channel-bridge stop
```

服务层命令必须先全局安装，不能直接用 `npx`。daemon 的 launchd plist / systemd unit / Windows 任务会记录 bridge CLI 的路径；如果这个路径来自 npm 临时缓存，缓存清掉后 daemon 就起不来。`run` 用 `npx` 单次启动没问题。

服务层命令按 profile 注册，每个 profile 有独立服务：

```bash
lark-channel-bridge start [--profile <name>]
lark-channel-bridge stop [--profile <name>]
lark-channel-bridge restart [--profile <name>]
lark-channel-bridge status [--profile <name>]
lark-channel-bridge unregister [--profile <name>]
lark-channel-bridge logs [--profile <name>|--web-ui] [--follow] [--lines <count>]
```

脚本和非交互环境必须显式指定 `--profile <name>` 或 `--web-ui`。服务命令会先打印实际目标和 profile，避免受 active profile 隐式变化影响。

`start --web-ui` 使用持久化的 `bridge.autostart_profiles` 作为 supervisor 的自动启动集合；旧配置没有该字段时仍回退到 active profile。active profile 只决定 CLI 默认目标，不再隐式定义整套服务的启动集合：

```bash
lark-channel-bridge profile autostart work on
lark-channel-bridge profile autostart work off
lark-channel-bridge profile autostart work
```

显式执行 `start --web-ui --profile work` 会把 `--profile work` 固化进 supervisor 服务，避免服务重启后跟随 active profile 漂移。

平台映射：
- **macOS**：launchd 用户代理 `ai.lark-channel-bridge.bot.<profile>`
- **Linux**：systemd 用户单元 `lark-channel-bridge.bot.<profile>.service`
- **Windows**：当前用户登录后启动的 Task Scheduler `ONLOGON` 任务 `LarkChannelBridge.Bot.<profile>`，launcher 是 `.cmd`

daemon 日志在 `~/.lark-channel/profiles/<profile>/logs/daemon/`。

### 多 profile：分别运行 Claude 和 Codex

`profile use <name>` 只切换 CLI 默认 profile，不修改 supervisor 的自动启动集合。每个 profile 会维护独立的应用凭据、会话、工作目录和日志。只有在需要同时连接多个 PersonalAgent 应用，或分别运行 Claude 和 Codex 时，才需要创建多个 profile：

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile codex --agent codex
```

例如只重启 Codex bot：

```bash
lark-channel-bridge restart --profile codex
lark-channel-bridge status --profile codex
```

## 命令速查

### 宿主 CLI

```text
lark-channel-bridge run [--profile <name>] [--agent claude|codex|pi] [--workspace <path>] [-c <config>]
lark-channel-bridge config check
lark-channel-bridge config show --profile <name> --sources
lark-channel-bridge ps
lark-channel-bridge kill <id|#>
lark-channel-bridge --help
```

`profile use <name>` 会切换后续默认启动使用的 profile。需要同时跑 Claude / Codex / Pi 等多个 bot、连接多套 PersonalAgent 应用，或做脚本化部署时，再使用这些 profile 管理命令：

```bash
lark-channel-bridge profile create claude --agent claude
lark-channel-bridge profile create codex --agent codex
lark-channel-bridge profile create pi --agent pi
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
lark-channel-bridge profile export <name> [--output ./profile.toml] [--force]
lark-channel-bridge profile export <name> --include-secrets --yes
```

`profile remove` 默认归档本地状态，也可以删除当前激活的 profile。若还剩其他 profile，会自动切到下一个；若这是最后一个 profile，会清空 root config，之后可以用同名重新创建。只有加 `--purge --yes` 才会永久删除。`profile export` 默认脱敏 app secret；只有加 `--include-secrets --yes` 才会导出敏感配置。

如果某个 profile 被建成了错误的 agent 类型，先 `stop` 或 `unregister --profile <name>` 清理对应后台服务，再 `profile remove <name>`，然后用正确的 `--agent` 重新创建。

### 飞书内斜杠命令

| 命令 | 作用 |
|---|---|
| `/new`, `/reset` | 清空当前会话 |
| `/btw <问题>` | 在当前话题/聊天回答旁问，并记住之前的旁问问答 |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/ws list` | 列出命名工作空间 |
| `/ws save <name>` | 把当前工作目录保存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/resume` | 恢复同 agent、工作目录、权限模式兼容的历史会话 |
| `/recent [N]` | 列出最近完成的 session（默认 5 条、最多 20 条），标题可跳到原消息或对应话题；owner/admin 看整个 profile，其他用户只看当前话题/聊天 |
| `/status` | 查看 profile、agent、工作目录、会话、上下文占用、lark-cli 身份和运行状态 |
| `/config` | 查看配置摘要，分别进入执行、飞书展示和访问设置 |
| `/model [模型名\|default]` | 查看或修改当前话题/聊天的模型，支持手填 |
| `/effort [强度\|default]` | 查看或修改当前话题/聊天的思考强度 |
| `/run [defaults\|status\|stop]` | 创建一次性限时任务、设置默认值，或查看/取消任务 |
| `/invite user @某人` | 允许用户私聊使用 bot |
| `/invite admin @某人` | 添加访问控制管理员 |
| `/invite group` | 允许当前群使用 bot |
| `/invite all group` | 允许 bot 所在的所有群使用 |
| `/remove user @某人`, `/remove admin @某人`, `/remove group` | 移除访问控制条目 |
| `/stop` | 停止当前 run 并取消排队消息，也可点卡片停止按钮 |
| `/timeout [N\|off\|default]` | 设置或清除当前会话的 idle watchdog |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id\|#>` | 停止指定 bridge 进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [描述]` | 执行低敏诊断 |
| `/help` | 帮助卡片 |

私聊不需要 @。群和话题群默认必须 `@bot`；`@all` 会被忽略。支持的云文档评论里 @bot 就会触发回复。

### 会话上下文

Codex 的稳定 Bridge 规则通过 app-server 的 `developerInstructions` 注入，每轮 user message 只携带当前飞书上下文和请求。新话题会话会导入最新的上游消息，通常最多 40 条、30000 字符；已有原生会话从上次完整导入的游标开始，只导入之后的新消息。导入截止到当前触发批次的最新时间，过滤 Bot 自身消息，并记录初始消息和已接受 steer 消息的 ID，避免重复注入。抓取失败、部分失败或内容截断时不会推进游标，同时会告知 Agent 历史上下文不完整。

Codex 报告上下文用量后，`/status` 会显示模型上下文窗口占用比例。Codex 自动压缩上下文时会写入日志并在过程状态中显示；成功完成的任务会保存最近一次上下文占用。

## 模型与思考强度

```text
/model provider/custom-model
/effort high
/model default
/effort default
```

不带参数的 `/model` 或 `/effort` 打开设置卡片，显示设置来源和作用范围。模型名可以直接输入，也可从建议列表选择；列表不是白名单。Codex 优先读取当前 profile 对应 CLI 的本地模型目录。自定义 provider 的模型无需在 bridge 代码中注册；模型是否可用仍由该 provider 决定。

两个字段分别按 **当前话题/聊天覆盖 → bot profile 默认 → CLI 默认** 继承。话题内设置只影响这个话题，普通群和私聊各自按聊天保存；同一话题/群中的用户共用设置。`default` 清除相应字段的覆盖。`/new`、`/cd` 和 bridge 重启保留模型偏好。

owner/admin 可以在 `/config` 或网页控制台填写默认模型和思考强度，也可发送：

```text
/model provider/custom-model --scope profile
/effort high --scope profile
```

bot 默认值影响该 profile 下未单独覆盖对应字段的对话，也用于会议和文档评论任务。其他 profile 和独立终端会话不受影响。网页控制台修改离线 profile 时，下次启动该 profile 才生效。

设置从下一次提交新任务开始生效，正在执行或已提交等待执行的任务保留原参数；等待合并的消息会保留，并在提交时使用新设置。切换不会清空上下文或更换原生会话 ID，无需重启 bridge。`/status` 可同时查看当前任务和下一轮设置。跨模型恢复仍受底层 CLI/provider 的兼容性限制。

已知模型会根据本地目录校验思考档位，显式提交不支持的组合会被拒绝。切换模型后，若继承的 bridge 思考设置不兼容且目录提供了模型默认值，则本次使用模型默认，并在设置摘要中说明。未知模型交由 CLI/provider 校验。当字段跟随 CLI 默认时，不传对应参数，也不改写 CLI 的全局或项目配置。

bot 默认值存于 `config.toml` 的 `profiles.<profile>.run`；聊天覆盖单独存于 `profiles/<profile>/scope-preferences.json`，不和对话历史混用。

## 旁问

`/btw 问题` 在当前话题内（普通群或私聊则在当前聊天）返回一个标有“旁问 /btw”的答复。仅提供 `/btw`，没有别名。Claude 和 Codex 使用相同的交互方式；需要当前话题/聊天已建立主会话。

收到问题后会添加“正在输入”表情反馈，排队和执行期间保留，完成或取消后移除。如果问题在答复发出前被撤回，会尝试回复原话题根消息（需要有效的根消息 ID）；非话题消息则直接发到原聊天。

飞书消息批次会持久化到 profile 目录下的 `pending-queue.json`，只在频道重新连接后恢复。每个话题/聊天最多排队 100 条、200000 个正文字符；连续刷新合并窗口时最多等待五秒。`/stop`、`/new`、`/cd`、切换工作区和 `/resume` 会在切换状态前同时取消排队消息以及仍在准备阶段的任务。

每次旁问从主会话当前已保存的上下文创建独立分叉，并带上此前成功的旁问问答。旁问按话题独立排队，不合并，不切换主会话；主任务继续运行，有可用进程槽位时可同时回答。旁问被要求仅根据已有上下文回答，不继续主任务。

记录按 bot profile 和话题/聊天隔离，同一话题内的用户共用；bridge 重启后保留。最多回放最近 20 组问答，总计约 60000 字符；过长的单条历史会截断。`/new`、切换工作区和成功 `/resume` 会清空该范围的旁问历史，`/stop` 同时取消主任务及运行中/排队中的旁问。旁问问答不会通过自动话题历史导入主会话，显式引用旁问答复仍可将它带入主会话。

## 一次性限时任务

发送 `/run` 打开表单，填写任务、截止时间、时区、安全余量和本次模型/思考强度，模型名支持手填。提交后先显示预览，**创建者核对具体日期和强制停止时间、点击确认后才会运行**。也可用命令生成预览：

```text
/run --until 01:00 --tz Asia/Shanghai --margin 5 --effort ultra -- 审查项目并保存发现的问题
```

可先保存一套默认值（仅 owner/管理员），以后只写任务：

```text
/run defaults --until 01:00 --tz Asia/Shanghai --margin 5 --effort ultra
/run 审查项目并保存发现的问题
```

普通 `/run 任务内容` 直接使用默认值，正文中的 `--`、`--effort` 等内容原样保留；原来的 `/run -- 任务内容` 仍然支持。显式填写运行参数时继续用 `--` 分隔，例如 `/run --effort high -- 审查项目`。如果正文恰好以 `--` 或保留子命令 `status`、`start`、`stop`、`defaults` 开头，用 `/run -- 正文` 表示它是任务内容。单独 `/run` 仍打开表单，管理子命令含义保持不变。

`/run defaults` 打开默认值表单，`/run defaults reset` 恢复内置的两小时时限、五分钟余量、本机时区及沿用对话的模型/强度。默认值属于当前 bot profile，单独存于 `profiles/<profile>/run-defaults.json`，不影响普通聊天设置或其他 bot。任务表单会自动填入默认值；命令显式参数只覆盖本次任务，`--model default`、`--effort default` 表示本次沿用对话设置。默认截止时间只保存钟点或时长，不保存固定日期；每次生成新预览重新计算绝对截止时间，已有预览和运行中的任务不变。若下一次钟点已落入安全余量内，本次拒绝启动，不会顺延一天。简写仍需确认，也不会每天自动执行。

`01:00` 表示指定 IANA 时区的下一次凌晨一点；也支持 `2h`、`90m` 或带时区的完整日期，如 `2026-09-22T01:00+08:00`，最长未来七天。安全余量单位为分钟，默认 5。例如截止 01:00、余量 5 分钟时，提示词要求 agent 在 00:50 开始收尾，独立守护进程在 00:55 强制终止。提前收尾依赖 agent 执行，不保证强停前一定产生总结；已有文件和对话记录保留。原有 idle watchdog 仍独立生效。

`--effort ultra` 在两种 agent 上都表示最强档，只是映射不同：Codex 直接传 `model_reasoning_effort="ultra"`；Claude 通过 `--settings` 开启 Claude Code ultracode（xhigh 加常驻多 agent workflow 编排，最强也最耗额度），因此上面的命令对 Claude bot 原样可用。Claude 的 `ultra` 只用于限时任务，普通 `/effort` 仍为 `low`～`max`。Claude 限时任务还会禁用 `CronCreate`、`ScheduleWakeup` 等会话内定时工具，避免截止后再触发；workflow 子 agent 运行在同一 CLI 进程树内，同样由守护进程到点终止。

任务使用当前话题/聊天的上下文，本次模型/强度保存为任务快照，不修改 `/model`、`/effort` 或 bot 默认值；其他话题/聊天不受影响。应提供具体目标或任务列表，完成后提前结束，不会为了耗尽额度无限循环。

固定停止时间覆盖进程槽位排队和受监管的 CLI 进程树，过期任务不能启动。可识别的明确额度耗尽错误（含 LiteLLM 类网关的 `budget_exceeded`）会终止任务，普通限流不会误判为额度耗尽。可用 `/run stop`、`/stop` 或任务卡停止，`/run status` 查看最新/正在运行的任务。仅创建者可启动；创建者或管理员可用任务卡停止，普通 `/stop` 权限保持原样。当前话题已有任务时需先等它结束或停止；限时任务内，Codex app-server 可将文字追加到当前回合，Claude 双向输入可追加到当前会话，均不延长截止时间。其他输入和 agent 卡片回调会明确提示未排队，避免截止后触发无限时续跑。

任务持久化到 `profiles/<profile>/timed-runs.json`。已启动任务不能重复启动；停止、到期、失败或 bridge 重启后都不会自动继续，续做需新建任务。第一版没有每日自动调度或服务商余额查询。Linux 和 Windows 的进程树清理由进程测试覆盖，不等于所有平台的完整飞书限时任务已验收；详见 [Windows 验证记录](../windows-web-validation.md)。本地终止不能保证服务商对已接收请求的跨额度周期计费方式，严格的费用限制仍需服务端支持。

## 回复展示与 COT

`/config lark` 管理飞书展示；Web 使用独立的 `channels.web` 配置：

- **消息回复方式**：`消息卡片` 流式更新最终回复；`纯文本` 在 run 完成后一次性发送。
- **工具调用显示**：控制最终回复卡片 / markdown 中是否展示工具块。
- **COT 过程消息**：默认 `简略`，用飞书原生 COT 控件展示 agent 的过程文本和工具摘要，无需手动开启；`详细` 还会展示工具参数和截断后的输出；`关闭` 使用普通进度显示。已有的显式选择会保留，未配置此项的旧 profile 也使用 `简略`。

首次创建 COT 失败时，本轮会提示一次“已异常回退为普通进度显示”；创建成功后的更新失败只丢弃该批尽力而为的过程更新并继续使用现有 COT，不额外发送回退卡片。最终答复仍会单独发送。

开启 COT 后，bridge 会把过程消息和最终答案拆成两条消息。过程消息用于追踪 agent 做了什么；最终答案仍由 agent 原始文本生成，bridge 不做启发式过滤。若 agent 把最终答案也作为普通流式文本输出，COT 过程消息中可能会出现对应片段。

## lark-cli 身份策略

每个 profile 都使用当前 profile 的 lark-cli 目录：`~/.lark-channel/profiles/<profile>/lark-cli`。agent 子进程会收到指向这个目录的 `LARKSUITE_CLI_CONFIG_DIR`，所以一个 profile 里的个人授权不会共享给另一个 profile。

默认策略是 `bot-only`：lark-cli 使用应用 / bot 身份，不访问个人资源。当用户为了日历、邮箱、云盘等个人资源完成授权后，当前 profile 可以切到 `user-default`，保留应用身份，同时允许已授权的用户身份。owner/admin 可以在 `/config` 查看或切换这个策略；`/status` 会用 `lark-cli: app` 或 `lark-cli: user-ready` 展示当前摘要。

## 工作目录

每个 profile 都可以有一个默认工作目录：`workspaces.default`。新建 profile 时可以传 `--workspace <path>` 作为初始目录；没传时 bridge 会创建一个 profile 托管的默认工作目录。

下面只是 profile 里的字段片段，不要整段覆盖 `config.toml`；请改对应 profile 下的 `workspaces` 字段。

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/claude/default"
  }
}
```

bridge 会检查所选目录存在、是目录，并且不是 `/`、Home 根、系统目录或临时目录根这类范围过大的位置。工作目录只是 agent run 的当前目录，不是文件系统 sandbox；agent 实际能访问哪些文件仍取决于本机 agent 进程及其权限模式。

## 权限模式

推荐给用户配置的是 `permissions.defaultAccess` 和 `permissions.maxAccess`。新 profile 默认两项都是 `full`，以保持 bridge 的本地工具、授权流程、文件写入等能力完整可用。如需收紧权限，可以改成 `workspace` 或 `read-only`；收紧后本地工具执行、登录 / 授权流程、文件写入等能力可能受限。

下面只是 profile 里的字段片段，不要整段覆盖 `config.toml`；请改对应 profile 下的 `permissions` 字段。

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

模式映射：

| Bridge access | Claude permission mode | Codex mode |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |

旧版 `sandbox` 字段仍可读取。bridge 保存 profile 后，会把该设置迁移为 canonical `permissions`。

Pi 支持 `read-only`（只开放读取/搜索工具）和 `full`。Pi 没有可移植的 workspace-only 沙箱，因此会在选择 `workspace` 引擎时明确拒绝。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.toml` | root config，包含 profiles 和 active profile |
| `~/.lark-channel/active-profile` | 最近选择的 profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | 会话状态 |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | agent-aware 会话索引 |
| `~/.lark-channel/profiles/<profile>/scope-execution.json` | 各聊天 / 话题的执行引擎覆盖 |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | 当前和命名工作空间绑定 |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | profile 本地加密 secret |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | 当前 profile 的 lark-cli 目录 |
| `~/.lark-channel/profiles/<profile>/media/` | 附件缓存 |
| `~/.lark-channel/profiles/<profile>/logs/` | 结构化运行日志 |
| `~/.lark-channel/web/default/scope-execution.json` | 独立 Web 各 conversation 的执行引擎覆盖 |
| `~/.lark-channel/web/default/sessions.catalog.json` | 独立 Web 的 agent-aware 会话索引 |
| `~/.lark-channel/registry/processes.json` | 本机进程注册表 |
| `~/.lark-channel/registry/locks/` | profile lock 和 app lock |

设置 `LARK_CHANNEL_HOME=/path/to/state` 可以改变飞书和管理控制台的状态根目录。独立 Web 使用自己的 `--state-dir`，不继承该变量指定的位置。`LARK_CHANNEL_LOG_DAYS` 可以调整日志保留天数。

profile secret 使用持久 salt 和用户名派生稳定本地密钥。容器部署建议通过
secret manager 注入 `LARK_CHANNEL_KEYSTORE_MASTER_KEY`，避免密钥依赖主机名；
已有的 v1 secret 会在该 profile 下一次读取或写入时自动迁移。

## 访问控制

**聊天访问默认是私有的：开箱即用时，只有"你"能在私聊和群聊里用这个 bot。** 这里的"你" = 创建 / 拥有这个飞书应用的人（也就是扫码把 bot 建起来的那位）。bot 会自动从飞书查出谁是应用 owner，所以**一个人用聊天入口完全不用配置**——你私聊它、在任意群里 @它都正常工作，其他人的聊天消息会被静默忽略（bot 不会回"你没权限"，免得暴露自己的存在）。云文档评论按文档权限生效，见下文。

想让别的同事或某些群也能用，就把他们加进下面三类名单：

| 名单 | 控制谁 | 加入 | 移除 |
|------|--------|------|------|
| **允许私聊的用户** | 谁可以私聊 bot | `/invite user @某人` | `/remove user @某人` |
| **响应的群** | bot 在哪些群里对**群内所有人**响应 | `/invite group`（当前群）/ `/invite all group`（bot 所在的全部群） | `/remove group`（当前群） |
| **管理员** | 谁能改设置、并能在任意群用 bot | `/invite admin @某人` | `/remove admin @某人` |

> `/invite`、`/remove` 这些命令只有**你（创建者）和管理员**能发。命令里 @ 的是**对方**（不是 @ bot），bot 会自动把 @ 解析成对应的人，你不用手动去找 ID。

### 两种"畅通无阻"的身份

- **你（创建者）**：不受任何名单限制——私聊、任意群、所有命令都能用，而且**永远锁不死自己**：哪怕名单配乱了，回到 bot 私聊发 `/config` 总能进来。在飞书后台把应用 owner 转给别人后，bot 也会自动跟着切换。
- **管理员**：能私聊、能用 `/config` 等管理命令，而且**不受"响应的群"名单限制**——无论群在不在名单里，bot 都会回他们。适合给一起维护 bot 的同事。

### 几种常见配置

- **只给自己用** → 什么都不用做，默认就是。
- **让某个同事能私聊 bot** → `/invite user @他`
- **让某个工作群里所有人都能用** → 在那个群里发 `/invite group`
- **第一次配，想把 bot 已经在的群一次性全开放** → 发 `/invite all group` 一键拉取 bot 所在的全部群加入名单，之后再用 `/remove group` 删掉不想要的
- **再拉个人一起当管理员** → `/invite admin @他`

### 还需要知道的

- 改完**下一条消息**就生效，不用重启。
- **群里默认要先 @bot 才会回**（私聊不用 @）。这是另一个独立开关（`/config` →"群里需要 @ bot"），和上面的名单是两回事。
- 陌生人发消息一律静默丢弃，不会有任何回复。唯一的例外：有人在一个还没开放的群里 @bot，bot 会回一句友好提示，告诉他可以让管理员发 `/invite group` 开放这个群。
- 云文档评论按文档权限生效：能在支持的文档里评论并 @bot 的人可以触发回复。

### 高级：直接改配置文件

不想在飞书里点的话，`/invite`、`/config` 背后写的是 `~/.lark-channel/config.toml` 中对应 profile 的 `access` 字段。空白名单表示这个名单没人，不表示所有人都能用。下面只是 profile 里的字段片段，不要整段覆盖 `config.toml`：

```toml
[profiles.claude.access]
allowedUsers = ["ou_xxxxxxxxxxxxx"]
allowedChats = ["oc_xxxxxxxxxxxxx"]
admins = ["ou_xxxxxxxxxxxxx"]
requireMentionInGroup = true
```

`allowedUsers` / `admins` 填用户 `open_id`，`allowedChats` 填群 `chat_id`。手动找 ID 最简单的办法：让对方给 bot 发条消息（群里就 @ 它一下），然后看当前 profile 的日志：

```bash
grep '"event":"enter"' ~/.lark-channel/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

每行都带 `chatId`（群 / 私聊 ID）和 `senderId`（用户 `open_id`）。手改完后**重启 bridge**，或在允许的 admin 上下文里发 `/reconnect` 让它生效。日常调整还是 `/invite` / `/config` 更省事，直接改文件主要用于部署脚本预填。

## 云文档评论

云文档评论不再需要单独绑定工作目录或维护文档白名单。支持的文档评论里 @bot 后，bridge 会在同一个评论线程里回复。评论运行复用文档级 session key；没有记录过文档 cwd 时回退到用户 home 目录。

## 可选：遥测（Telemetry）

默认情况下 bridge **不上报任何数据**：没有指标、没有日志离开你的机器，也不引入任何遥测依赖。下面这个钩子在你主动开启前完全是空操作。

想接自己的监控时，用环境变量指向一个 default export（或导出 `createAdapter`）`AdapterFactory` 的模块：

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package lark-channel-bridge start
```

该模块会收到每一条 `log.*` 事件，以及错误 / 指标钩子，转发到任何你想要的地方。接口从包根导出：

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from 'lark-channel-bridge';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* 上报事件 */},
  recordError(err, ctx) {/* 上报异常 */},
  recordMetric(name, value, tags) {/* 上报指标 */},
  flush(timeoutMs) {/* 冲刷缓冲事件 */},
});
export default createAdapter;
```

模块不存在、工厂函数不合法、或者 adapter 抛错，都会降级为空操作——遥测永远不会阻止 bridge 启动，也不会打断日志。

### 本地文件的浏览器链接

在 bridge 配置的 `profiles.<name>.preferences.fileLinks` 中配置本地 POSIX
目录与网页入口，即可把 IM 回复中的文件路径自动转成可点击链接：

```json
{
  "fileLinks": [{
    "localRoot": "/srv/reports",
    "fileBaseUrl": "https://jupyter.example/user/alice/files/reports/",
    "browseBaseUrl": "https://jupyter.example/user/alice/lab/tree/reports/",
    "markdownPreviewUrl": "https://jupyter.example/user/alice/custom/reader/index.html"
  }]
}
```

网页服务需要事先能访问该目录，例如在 Jupyter 文件根目录下建立 `reports`
符号链接。bridge 仅转换链接，不上传文件或授予访问权限；URL 不应包含登录 token。
直接编辑配置文件后重启 bridge 生效。

可选的 `markdownPreviewUrl` 用于轻量阅读页。配置后，`.md` 和 `.markdown` 文件
改为打开该入口，bridge 把绝对文件路径编码后放入 `path` 查询参数。阅读页自行负责
文件鉴权和 Markdown 渲染；未配置时仍走 `browseBaseUrl`。此 URL 必须是 HTTPS，
不含账号、查询参数或片段，查询参数由 bridge 添加。

Claude/Codex 共用转换逻辑，覆盖文本、流式 Markdown、完整卡片、最终回复、发送回退和
`/btw`。Markdown 文件链接保留标题；正文路径和仅含路径的行内代码转为链接。
图片、HTML、文本/日志、PDF、CSV/JSON 及常见压缩包走 `fileBaseUrl`，其他文件和目录
走 `browseBaseUrl`。路径逐段编码，`:42` 等行号后缀不作为文件名（暂不自动跳行）。
未映射路径、已有网页链接、围栏/缩进代码块、工具记录保持原样。带空格的路径请用行内
代码或 Markdown 的尖括号目标表示；引用式链接保持原样。流式裸路径会等到边界或回复
结束后再转换。

配置按 profile 生效，未配置时关闭。外部 `lark-cli` 直接发消息、COT 记录、会议回复和
云文档评论走独立链路，不在此次转换范围内。无需配置 agent skill 或 memory。

GitLab CI 失败监控与 Flash 自动分析：[配置与行为说明](../gitlab-ci-watch.md)。

Agent 适配器开发：[执行契约与分层说明](../agent-execution.md)。

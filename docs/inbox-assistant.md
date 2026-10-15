# 会话助理

助理随 Bridge supervisor 启动，复用个人 Codex profile 的用户授权。托管工作台连接在助理关闭时仍保持心跳，可查看历史、编辑草稿和标记处理。

## 工作流

- **关闭**：停止采集、筛选和深入分析，取消排队及正在执行的模型任务。
- **开启**：按接收范围采集消息，合并连续消息后用 `deepseek-flash` 判断是否需要本人关注。没有倒计时自动深入分析。
- **深入分析**：仅 `process` 或 `manual` 显式操作可入队，执行时再次检查 `analysisRequested`。读取当前默认模型（profile preference 优先，其次 Codex config.model），复用当前第三方 Responses provider。仅分析聊天上下文，工具列表为空，不声称已查询代码或修复系统。

筛选每批最多 8 项，每项最多 6 条、每条 500 字符，关注背景最多 3000 字符；输入聊天不能作为系统指令。模型输出必须完整覆盖每个事项且 ID 唯一。筛选和深入分析串行调用，批次额度在调用前持久化。`dailyTriageLimit` 默认每天 100 批；失败、缺失结果或额度不足显示为“待核对”，不通知群。额度不限制用户明确发起的深入分析。

模型综合具体请求、相关性和待采取动作判断。`attentionProfile` 是用户授权后从历史整理的背景；仅有领域关键词、@ 或普通通知不能推定本人必须处理。通用规则覆盖直接请求、决策、故障风险和阻塞；闲聊、无需动作的 FYI、已解决事项静默。

工作台默认“需要关注”展示未处理且 `attention.state=needed` 的事项；草稿生成并不等于已处理。“待核对”包含 pending/uncertain；quiet 可在全部事项查看。标记已处理/忽略独立于分析状态。

## 通知节制

托管工作台模式下，普通 pending、进度、失败和深入分析结果不自动逐条发群。旧原生卡片入口仅在显式分析后投递一次符合关注条件的结果。只把 needed、未处理、此前未通知的事项汇总为一条摘要，最多 20 项，至少间隔 10 分钟，每天最多 12 条；上限只影响群通知，不影响工作台。已通知事项更新后静默，同一事项不会反复推送。主动选会话不再额外通知自己。

发信前保存 outbox 和幂等键。最多 3 次重试，重试窗口 4 分钟；重试前重新核对消息版本、处理状态、归属和接收范围。结果不确定时保留工作台事项并停止重复投递。发送只用机器人身份到已验证的配置目标，不发送原会话，不生成结构化 @。

## 设置

根配置的 `inbox` 包含：

```json
{
  "enabled": false,
  "executorProfile": "codex",
  "ownerOpenId": "ou_OWNER",
  "destination": { "chatId": "oc_RESULT", "threadId": "omt_TOPIC", "replyTo": "om_ANCHOR" },
  "deliveryMode": "thread",
  "intakeScope": "private_mentions",
  "attentionProfile": "用户授权整理的具体工作背景",
  "dailyTriageLimit": 100,
  "pollSeconds": 60,
  "contextMinutes": 15,
  "maxContextChars": 24000,
  "gui": { "publicUrl": "https://your-app.example/app/app_ID", "apiKeyFile": "/absolute/private/key" }
}
```

接收范围：`private` 私聊；`private_mentions` 私聊和直接 @ 本人的群消息（含相关回复）；`all` 所有可读取的私聊和群消息。与开关独立，关闭时可保存；范围变更从新消息开始，不补入旧会话，保留已有事项。本人回复、结构化报警恢复、结束语、结果群消息仍按既有规则处理。

旧 `autoAnalyze/waitMinutes/dailyAutoLimit` 字段只为快照兼容保留，`autoAnalyze` 始终归一为 false，旧 countdown 和自动队列不执行。旧 mode=manual/auto 命令拒绝。新 UI 在 `attentionControl=true` 后才允许开启，避免版本混布启动旧自动逻辑。

所需用户读取能力包含 `search:message`、`im:chat:read`、`im:message.p2p_msg:get_as_user`、`im:message.group_msg:get_as_user`。CLI 保持 profile 的 bridge-bound 身份，身份失效暂停，不换账号。仅群授权时不启动 OAuth，授权须在私聊完成。

## 保存与批量操作

本地权威状态为配置目录下 `inbox/state.json`，权限 0600，原子写入；包含消息、筛选结果、草稿、版本、已处理状态、额度和通知 outbox。妙搭 PostgreSQL 保存工作台快照和 owner-scoped 指令；浏览器不是持久化来源。当前在采集周期清理 7 天前已处理事项，并限制无需动作的旧记录，不提供永久归档。

`review` 支持草稿保存和处理状态；`batch` 支持最多 500 项已处理或忽略。批量传 `{items:[{id,revision}],handlingState:"handled"|"ignored"}`，所有归属与版本均匹配后一次保存，任何冲突都不修改，落盘失败恢复内存状态；命令 ID 支持重试去重。关闭时可操作，不调用模型。运行中分析被取消，晚到结果不能覆盖人工操作。

工作台最多同步 500 项，优先需要关注和待核对；详情按 700 KB 快照预算预同步，其余按需读取。`@Type(() => Object)` 保留 jobs 为对象，兼容平台隐式转换。控制连接不依赖飞书聊天查询。

## 验证

针对性测试覆盖模型路由、筛选失败和预算、关闭/范围/新消息竞争、无自动深入分析、幂等摘要、权限和目标验证、批量版本冲突及落盘失败。浏览器验证使用模拟数据；不能代替真实飞书消息上的筛选质量验收。

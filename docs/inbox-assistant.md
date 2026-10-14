# 会话助理

会话助理在现有 Bridge supervisor 中运行，默认关闭。选择一个会话后，读取近期聊天、判断需求并准备回复草稿。自动模式则轮询本人私聊和直接 @ 本人的消息，合并后提醒；提醒成功送达后默认等待 30 分钟再分析。结果、提醒和进度都由机器人回复到配置的同一个群话题，带来源名称、会话 ID、消息时间范围和原消息入口。

## 运行要求

- 个人模式的 Codex profile，以及该 profile 中已有的本人用户授权。所需读取能力包含 `search:message`、`im:chat:read`、`im:message.p2p_msg:get_as_user`、`im:message.group_msg:get_as_user`。机器人还须能读取并回复结果话题。
- 已验证命令格式：lark-cli 1.0.77。CLI 始终在该 profile 的 bridge-bound 环境中运行；身份失效时暂停，不切换到其他账号。
- Codex 配置中的 Responses 模型接口与 API 凭证。支持 provider 的 `env_key`、`experimental_bearer_token`、配置请求头，或 API-key 类型的 `auth.json`。只有 ChatGPT/钥匙串登录态而无可用 API 凭证时，会明确报未就绪，不启动任务。
- 默认使用飞书消息卡片和现有长连接，不需要公网 HTTPS 地址、端口代理或网页应用。飞书应用需通过长连接订阅卡片回传交互 `card.action.trigger`。

## 配置与入口

Bridge 管理页面的 profile 列表下面新增「会话助理 · 全局设置」。配置唯一执行 profile、本人 Open ID、结果群 ID、话题 ID 和话题内的回复消息 ID。每次投递都会验证该消息确实属于配置的群和话题。改变目标后，旧任务不会自动改投；在新目标的话题中主动重新处理时才采用新目标。

根配置文件的 `inbox` 字段示例（请替换占位值）：

```json
{
  "enabled": false,
  "executorProfile": "codex",
  "ownerOpenId": "ou_OWNER",
  "destination": { "chatId": "oc_RESULT_GROUP", "threadId": "omt_RESULT_TOPIC", "replyTo": "om_REPLY_ANCHOR" },
  "watchPrivate": true,
  "watchMentions": true,
  "autoAnalyze": true,
  "waitMinutes": 30,
  "pollSeconds": 60,
  "contextMinutes": 15,
  "maxContextChars": 24000,
  "dailyAutoLimit": 20,
  "h5": { "publicUrl": "", "port": 19182 }
}
```

设置 `watchPrivate=false`、`watchMentions=false` 可只使用手动选择入口。总开关关闭会取消正在执行的任务、停止读取与新的自动启动；待办仍保留。管理页保存即时生效，直接编辑文件需要重启对应 Bridge 进程。

## 默认入口：飞书原生卡片（无需 HTTPS）

1. 更新并重启 Bridge，启用上述配置。
2. 在配置的结果群任意话题中发送 `/inbox`（该群要求 @ 时需同时 @ 机器人），收到「处理会话」卡片。可将此入口置顶，之后直接点击。
3. 点击「最近私聊」或「最近群聊」，按最近活跃时间浏览，每页最多八个会话，支持下一页；每项显示名称和会话 ID。
4. 点击所需会话的「分析此会话」，自动读取近期消息并提交。默认最近十五分钟没有消息时扩展到最近一天。
5. 自动提醒卡片直接提供「立即处理 / 我来处理 / 忽略」，也可从入口点击「查看待办」。分析结果继续回复到指定话题。

浏览、翻页、接手和忽略不调用模型。入口只接受配置的本人在指定 profile 和群中操作；菜单跟随命令/卡片所在话题，分析结果与自动提醒仍固定投递到配置的结果话题。其他成员点击、卡片转发到其他群或无法确认话题时，不读取个人会话。提交和待办操作的签名绑定动作、来源、本人、结果话题和配置；重复点击被拒绝。选项有效期三十分钟，提醒操作七天，失效后重新打开入口获取新卡片。未使用的待办操作及已用 nonce 跨重启保留。

这些是 Bridge 内建卡片命令，通过现有长连接处理，不进入 agent 对话，也不需要机器人网页菜单。无需添加 `__bridge_cb` 或 agent 回调 token；agent 自行发卡时仍必须遵守原有 CLI 签名约定。

## 可选：HTTPS 网页入口

仅需要原生网页会话选择器时，才配置 `h5.publicUrl` 并部署网页。留空不会启动 HTTP 监听器。以下 Nginx 示例应加入已有 HTTPS 虚拟主机中。代理须保留原始 `Origin` 头；不允许将管理控制台 `/api` 暴露出来。

```nginx
location /assistant/ {
    proxy_pass http://127.0.0.1:19182/;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_read_timeout 120s;
    client_max_body_size 256k;
}
```

此时 `publicUrl` 应填 `https://该域名/assistant/`（末尾保留 `/`）。仅部署静态 HTML 不够，页面还需要登录校验、读取会话和提交任务的后端。没有对应路由的 Jupyter `/proxy/端口/` 地址不会自动生效。

## 可选网页入口的飞书后台配置

1. 打开同一个机器人应用，添加「网页应用」能力，桌面端和移动端主页填写上述 HTTPS 地址。
2. 在「安全设置 → H5 可信域名」加入该页面的域名；网页需在飞书内打开。
3. 在「机器人 → 机器人自定义菜单」开启菜单，添加「处理会话」，响应动作选「跳转至指定链接」，填写上述页面地址。菜单目前仅支持机器人单聊；结果依然发到配置的群话题。
4. 创建应用版本并发布，应用可用范围至少包含本人。官方说明菜单更新可能延迟约 5 分钟。
5. 本人在飞书打开菜单，完成应用登录，点击「选择会话，交给 AI 处理」。页面弹出 `chooseChat`，不用输入名字或转发消息。待办里的「立即处理 / 我来处理 / 忽略」也在此页面操作。

网页登录仅请求本人身份，不替换 lark-cli 的持久用户授权。后端验证真实 Open ID 后签发短期会话；即使其他人打开相同链接，也不能读取、提交或操作本人的待办。

从聊天「＋」菜单传入 `triggerCode` 的启动入口已预留 `getTriggerContext` 支持；该扩展需另行配置并在目标客户端验收。不要把消息快捷操作的 `__trigger_id__` 当成该参数使用。

## 处理规则和边界

- 默认一次只分析一项任务；自动任务每日最多 20 项（按 UTC 日计数）。手动选择的任务立即排队，不等待超时，不自动把这个会话加入长期监听。
- 轮询、去重、简单过滤不调用模型。模型输入默认最多 100 条、约 24,000 字符；输出上限 4,000 tokens；完成后记录实际输入和输出 token。中断或失败的调用可能已产生用量，不将它们虚报为零开销。
- 识别「收到/谢谢」等简单消息、私聊中的机器人和自己发出的结果；只处理直接 @，不把 @所有人当成直接 @。群话题按线程分组，普通会话按五分钟内的连续消息分组。复杂的同一事项语义合并仍需模型判断。
- 报警和机器人群消息默认只提醒。相同 `alert_id` 或 `fingerprint` 的结构化 JSON 报警按发送者、会话和事件 ID 合并；明确的 `status=resolved/recovered` 取消对应待办。普通报警文案不自动判断误报或恢复。
- 会检查待办来源中的新回复。私聊中本人在请求之后的回复会暂停自动任务；群聊需匹配同一话题或引用消息，群里的无关发言不会取消任务。分钟精度时间戳使用消息位置辅助排序。
- 状态原子写入根配置目录旁的 `inbox/state.json`，文件权限 600。等待中的任务跨重启恢复；中断的模型任务转为失败，须本人重试。消息去重保留两天，已结束任务保留七天。跨 profile 的服务锁防止重复启动。
- 初次启用从近期消息开始；搜索每轮最多 40 页，分页不完整时保留游标并显示错误，不把部分结果当成已全部处理。活跃来源每轮补读最多十个，按上次读取时间轮转。
- 提醒投递失败不启动倒计时。投递使用任务、尝试次数和阶段构成的幂等键；长时间中断仍受飞书服务端幂等窗口限制，不承诺无限时间内严格只投递一次。

第一版直接调用所选 Codex 配置的 Responses 模型进行文本分析，`tools=[]`、`tool_choice=none`。它不启动拥有本机工具的 Codex CLI 会话，不执行代码修复、系统排查或其他外部操作；模型即使返回工具调用也会被拒绝。需要排查系统的问题，会在分析中列出待确认信息，后续由本人发起普通 Bridge 任务。

## 验证

`tests/unit/inbox` 覆盖提醒计时、点击与超时竞争、恢复、去重、关闭竞争、本人身份与固定话题、分页、网页登录和模型工具隔离。原生卡片新增本人/话题限制、来源签名、跨重启重放、分页和无 HTTPS 启动测试。上线后仍需实际飞书客户端完成点击与结果回传验收；选用网页方案时才需验证网页登录、网页选择器及菜单。离线测试不能替代客户端验证。

官方文档：

- [会话选择器](https://open.feishu.cn/document/client-docs/gadget/-web-app-api/open-ability/chat/choosechat.md)
- [网页登录](https://open.feishu.cn/document/web-app/gadget-api/open-ability/login/requestaccess.md)
- [JSAPI 鉴权](https://open.feishu.cn/document/web-app/gadget-api/open-ability/authentication/h5sdkconfig.md)
- [机器人菜单](https://open.feishu.cn/document/client-docs/bot-v3/bot-customized-menu.md)

# 模型与账号配置

[手册首页](README.md) · [配置教程](configuration.md) · [会话助理](assistant.md)

如果只是想知道“改哪个文件、API key 填哪、改完怎么生效”，先看[配置教程](configuration.md)。本篇解释模型选择、账号和飞书授权的边界。独立 Web 没有下述管理表单或飞书斜杠命令，使用方法见 [Web 聊天](web-chat.md)。

## 先区分三种配置

| 配置 | 决定什么 | 在哪里设置 |
| --- | --- | --- |
| Agent 执行器 | Claude / Codex、工具、工作目录、CLI 模型账号 | profile 和本机 CLI |
| 模型 API 服务 | 直接 API 请求的地址、默认模型及凭据 | 控制台“模型 API 服务” |
| 飞书身份 | 机器人发消息、用户读取个人可访问资料 | profile 的飞书应用与用户授权 |

模型 API 的密钥不能替代飞书授权；Claude/Codex 登录也不等于拥有可用于直接 Responses API 调用的密钥。

## 普通对话的模型

```text
/model your-model
/effort high
/model default
/effort default
/provider
```

模型和思考强度分别按“当前话题 / 聊天 → profile 默认 → CLI 默认”继承。`default` 清除当前覆盖，`/new` 不会清除模型偏好。owner / 管理员可在 `/config` 或控制台设置 profile 默认值。

设置从下一次提交的任务生效；正在执行或已经提交排队的任务保留原参数。同一话题里的用户共用设置。可手填模型名，建议列表不是白名单；最终可用性由 CLI 和模型服务决定。

模型名可使用 `<provider>/<model>` 明确选择服务：

- `screening/model-name`：复用“模型 API 服务”中名为 `screening` 的 Responses endpoint 和凭据。

同一话题可随时切换 Provider，不需要重启 Bridge。这里只列出根配置
`model_services` 中实际配置的 API Key 服务。OpenAI 官方账号属于 Agent 自身的
登录态，不作为 Bridge Provider 展示；Codex 使用原生模型 ID，pi 使用自身的
`openai-codex/...` 模型选择。

发送 `/provider` 会打开与 `/model` 共用的飞书卡片。Provider 下拉项由 Bridge 的
共享 registry 和当前 Agent 的能力生成，选择后填写模型 ID 即可保存到当前话题。
切换只影响下一条新任务，不中断正在运行的任务。

## 配置独立模型 API 服务

当前独立服务支持 **Responses API**。它供会话助理轻量筛选使用，不启动 Agent，也不继承其 MCP、skills 或本地工具。

在控制台“模型 API 服务”中新增一个服务，例如 `screening`。填写 API 根地址、默认模型，以及密钥的环境变量名或文件路径。下面是可以保存为 `service.json` 的完整单服务示例：

```json
{
  "protocol": "responses",
  "baseUrl": "https://api.example.com/v1",
  "model": "your-screening-model",
  "apiKey": { "source": "env", "id": "SCREENING_API_KEY" }
}
```

密钥也可以来自本机私有文本文件：

```json
{
  "source": "file",
  "id": "/absolute/private/model-api-key"
}
```

第二段只用于替换 `apiKey` 对象。密钥文件内容是原始密钥，去除首尾空白；网页和配置中填写引用，不填写密钥正文。环境变量必须在启动 Bridge 前设置，已经运行的进程不会读取后来在另一个终端设置的变量。

`baseUrl` 不要带 `/responses`，请求时会自动添加。这里不读取 `.env`、不运行凭据命令，也不自动借用 Codex 的密钥。

CLI 管理方式：

```bash
lark-channel-bridge model-service configure screening /absolute/path/service.json
lark-channel-bridge model-service list
lark-channel-bridge model-service check screening
```

`check` 只检查本地结构和凭据可读性，不请求模型。之后在会话助理中选择 `screening`，筛选模型覆盖留空即可使用该服务的默认模型。

显式选择的服务不存在、密钥无效或模型调用失败时会报错，不会悄悄切换其他服务。正在被助理引用的服务不能删除；先修改助理的筛选服务，再执行 `model-service remove <name>`。

## 后台分析用哪个模型

| 任务 | 模型来源 |
| --- | --- |
| 飞书消息轻量筛选 | 选中的模型 API 服务；筛选模型覆盖非空时使用覆盖值 |
| 会话待办深入分析 | `inbox.analysisModel`；显式留空跟随执行 profile / CLI |
| GitLab CI 分析 | `gitlabCi.model`；显式留空跟随 CI 执行 profile / CLI |

旧 Codex 配置省略深入分析模型时仍保留 Flash 默认，避免升级改变成本。Claude 省略或留空时使用其默认模型。切换执行器时应检查旧的显式模型覆盖是否仍可用。

没有选择独立筛选服务的旧配置仍兼容原来的 Codex profile 路由；升级不会自动复制或迁移凭据。新配置推荐独立服务。完整字段说明见[模型 API 服务参考](../model-services.md)。

## 访问控制与飞书授权

默认只有应用 owner 可以使用聊天入口。可在飞书里发送：

```text
/invite user @同事
/invite group
/invite admin @同事
```

分别开放同事私聊、当前群全体成员、管理员权限。请用飞书结构化 @选择账号。`/remove` 对应移除；这些管理操作由 owner 或管理员执行。

普通机器人对话使用应用身份。会话助理读取你的消息、日历等个人资源时需要当前 profile 的用户授权，且只能读取该用户实际有权访问的内容。在自己的本地控制台完成授权；从聊天发起授权时请私聊机器人，不在群里发 OAuth 登录链接。

每个 profile 的用户授权独立。Bridge 子进程会自动使用当前 profile 的 lark-cli 环境；出现“context detected … not bound”时，先重启或执行诊断，不要切到另一个账号配置绕过。

新 profile 默认使用完整本机权限。工作目录不是文件沙箱；收紧到 `workspace` 或 `read-only` 会影响工具和文件操作。后台分析的“只读”或“准备草稿”约束属于 Agent 任务指令，实际权限仍来自执行 profile。

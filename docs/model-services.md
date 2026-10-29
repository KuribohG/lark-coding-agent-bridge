# 独立模型 API 服务

首次配置可先阅读[用户手册：模型与账号](user-guide/models-and-accounts.md)。

加载本功能的 Bridge 可在根配置 `model_services` 中保存模型服务，供筛选、分类等直接 API 调用，也可作为 Pi/Codex 的 Responses provider 或 Antigravity 的 Gemini provider。Provider 列表只展示这里实际配置的服务。配置不依赖 Claude/Codex profile，不启动 Agent，也不继承其工具或会话。支持 Responses 和 Gemini 原生 API；直接筛选调用仍要求 Responses 入口。

## 配置

在 `config.toml` 中添加服务：

```toml
[model_services.screening]
protocol = "responses"
baseUrl = "https://api.example.com/v1"
model = "your-screening-model"
apiKey = { source = "env", id = "SCREENING_API_KEY" }
```

在已选中的 `monitors.toml` 配置对应来源：

```toml
[sources.lark]
executorProfile = "claude"
analysisModel = ""
triageService = "screening"
triageModel = ""
```

尚未拆分监控文件时，对应根配置节是 `[monitoring.lark]`。

示例只展示相关字段；保留实际的 profile、授权、目标话题和启用配置。`baseUrl` 是 HTTPS API 根地址，请求时添加 `/responses`，不要填写完整 `/responses` 路径。地址不能包含用户名、密码、查询参数或片段。默认模型必填，服务名称为 1–64 位字母、数字、下划线或横线，并以字母或数字开头。

同一服务可同时供直接 API 和 Agent 使用。Agent 选择带 provider 前缀的模型：

```text
/model screening/your-screening-model
```

在飞书中发送 `/provider` 可直接打开切换卡片；下拉选项来自 Bridge 的 Provider
registry，并按当前 Agent 的 `supports()` 能力过滤，不需要在卡片代码里维护品牌分支。

如果只有一个支持当前 Agent 的服务声明了该默认模型，也可以继续使用裸模型名，
Bridge 会唯一解析到该服务；多个服务声明相同模型时会明确报歧义，要求改用
`<provider>/<model>`。

Pi 会在每次运行时通过临时 extension 注册该 provider；Codex 会通过 app-server
的 `model_providers` 配置注入 endpoint 和 `env_key`。两者都只把凭据放进子进程
环境，不写进命令行参数或生成的 provider 文件。Responses 服务当前支持 Pi 和
Codex，不兼容 Claude Code 的 Anthropic Messages 协议。

OpenAI 官方账号使用 Agent 自身的 OAuth，不进入 Bridge 的 API Key Provider 列表：

```text
/model gpt-6.1-sol
```

Codex 使用原生 OpenAI provider。Pi 应使用其自身的
`openai-codex/gpt-6.1-sol` 模型选择。两者分别复用各自的官方账号登录态；未登录时
会在 Agent 启动阶段报授权错误，Bridge 不会改用其他 provider 或借用第三方密钥。

`apiKey` 只接受引用，不能填写明文密钥：

- `{"source":"env","id":"SCREENING_API_KEY"}`：读取 Bridge 进程环境中的变量。
- `{"source":"file","id":"/absolute/private/model-api-key"}`：读取 UTF-8 普通文本文件，去除首尾空白。文件不超过 64 KiB，值不能包含控制字符。

环境变量需要在启动 Bridge 前设置。凭据在加载服务时读取，会话助理在每次筛选启动时重读；可更新文件完成轮换；网页、配置和 `list` 只展示引用，不返回密钥内容。这里不自动回退到 `OPENAI_API_KEY`、Codex home 或其他服务的凭据，也不加载 `.env` 或执行凭据命令。

可选 `headers` 用于服务商要求的额外请求头，每个值同样使用环境变量/文件引用：

```json
{
  "headers": {
    "X-Tenant": { "source": "env", "id": "MODEL_TENANT" }
  }
}
```

`Authorization`、`Content-Type` 和连接/长度相关头由客户端管理，不能在这里覆盖。配置校验拒绝重复头名、非法头名和未知字段。模型请求沿用原有超时、取消、流式响应和禁止重定向的行为。

## 一个 provider 的多协议入口

`protocol` 和 `baseUrl` 定义默认入口；`endpoints` 可为其他协议指定独立地址和默认模型，复用同一个凭据引用。
例如同一服务的 Responses 地址是 `https://gateway.example/v1`，Gemini 入口是 `https://gateway.example`。
Antigravity 的 SDK 会在 Gemini 地址后添加 `/v1beta/models/...`，并要求配置对应模型的 `contextWindow`。
完整配置与 high-five 接入方式见 [Antigravity 后端](antigravity.md)。不会根据品牌名或 Responses URL 猜测原生入口。

模型选择器按后端支持的协议过滤 provider。打开选择器时可以发现远端模型；运行中的任务只使用缓存，不因元数据刷新而改变已选模型。
Gemini-only 服务不会出现在筛选服务列表中；额外配置 Responses 入口后即可用于筛选。

## 管理入口

本地工作台新增“模型 API 服务”，可添加、编辑、检查和删除服务，再在会话助理中选择“筛选模型服务”。API Key 输入框填写变量名或文件路径。正在被会话助理引用的服务不能删除，即使助理当前关闭；先更改筛选服务即可删除引用，删除操作不会删除凭据文件。

也可用 CLI 管理。`service.json` 的内容是上面 `screening` 内的单个服务对象：

```sh
lark-channel-bridge model-service configure screening /absolute/path/service.json
lark-channel-bridge model-service list
lark-channel-bridge model-service check screening
lark-channel-bridge model-service remove screening
```

每个子命令支持 `--config /absolute/path/bridge/config.toml`。保存仅校验配置结构；`check` 还检查凭据是否可读取。两者均不请求模型，因此不代表远端模型或授权已经验收。服务配置通过配置锁合并保存，不会覆盖其他服务或 profile。运行新版 supervisor 时，所选服务配置变化会使助理重载，正在进行的旧任务沿用助理现有的取消处理；CLI 写入在下一次配置检查时生效。单 profile 进程的服务配置遵循其原有启动和后台模块行为。

## 模型选择和旧配置迁移

| 配置 | 筛选行为 |
| --- | --- |
| 设置 `triageService` | 只使用该独立服务；不存在或凭据无效就报错，不回退。 |
| 独立服务且 `triageModel` 省略或为空 | 使用服务的 `model`，与 `analysisModel` 无关。 |
| `triageModel` 非空 | 只覆盖筛选模型，endpoint 和凭据仍来自所选服务。 |
| 没有 `triageService` | 保留旧 `triageProfile` / 执行 profile 的 Codex Responses 配置解析，以及旧模型/成本策略。 |

旧配置不会在升级时自动迁移，也不会复制 Codex 的凭据。迁移步骤：

1. 配置独立服务，填写原 endpoint、所需默认模型和凭据引用；需要时在私有文件中准备密钥。
2. 运行本地检查。
3. 在会话助理中选择新服务并保存；确认 `triageModel` 是否应使用服务默认值或保留原覆盖值。界面切换到独立服务会清空旧筛选 profile 和模型覆盖，便于明确采用新默认值。

`analysisModel` 和 GitLab CI 的执行模型仍属于原生 Agent 任务设置，不读取 `model_services`。飞书授权和通知身份始终属于执行 profile。只安装和配置 Claude 的用户现在也可设置独立筛选服务，无需创建 Codex profile。

服务配置位于 version 3 TOML 的 `model_services`。旧 Bridge 无法加载主 TOML；切换前需完成各实例升级。推送或打包不会自动切换正在运行的 Bridge。

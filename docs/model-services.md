# 独立模型 API 服务

首次配置可先阅读[用户手册：模型与账号](user-guide/models-and-accounts.md)。

加载本功能的 Bridge 可在根配置 `modelServices` 中保存模型服务，供筛选、分类等直接 API 调用使用。配置不依赖 Claude/Codex profile，不启动 Agent，也不继承其工具或会话。当前接入协议为 Responses API；Claude Code/Codex 带工具任务继续使用各自的 CLI 配置。

## 配置

```json
{
  "modelServices": {
    "screening": {
      "protocol": "responses",
      "baseUrl": "https://api.example.com/v1",
      "model": "your-screening-model",
      "apiKey": { "source": "env", "id": "SCREENING_API_KEY" }
    }
  },
  "inbox": {
    "executorProfile": "claude",
    "analysisModel": "",
    "triageService": "screening",
    "triageModel": ""
  }
}
```

示例只展示相关字段；保留实际的 profile、授权、目标话题和启用配置。`baseUrl` 是 HTTPS API 根地址，请求时添加 `/responses`，不要填写完整 `/responses` 路径。地址不能包含用户名、密码、查询参数或片段。默认模型必填，服务名称为 1–64 位字母、数字、下划线或横线，并以字母或数字开头。

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

## 管理入口

本地工作台新增“模型 API 服务”，可添加、编辑、检查和删除服务，再在会话助理中选择“筛选模型服务”。API Key 输入框填写变量名或文件路径。正在被会话助理引用的服务不能删除，即使助理当前关闭；先更改筛选服务即可删除引用，删除操作不会删除凭据文件。

也可用 CLI 管理。`service.json` 的内容是上面 `screening` 内的单个服务对象：

```sh
lark-channel-bridge model-service configure screening /absolute/path/service.json
lark-channel-bridge model-service list
lark-channel-bridge model-service check screening
lark-channel-bridge model-service remove screening
```

每个子命令支持 `--config /absolute/path/bridge/config.json`。保存仅校验配置结构；`check` 还检查凭据是否可读取。两者均不请求模型，因此不代表远端模型或授权已经验收。服务配置通过配置锁合并保存，不会覆盖其他服务或 profile。运行新版 supervisor 时，所选服务配置变化会使助理重载，正在进行的旧任务沿用助理现有的取消处理；CLI 写入在下一次配置检查时生效。单 profile 进程的服务配置遵循其原有启动和后台模块行为。

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

`analysisModel` 和 GitLab CI 的执行模型仍属于原生 Agent 任务设置，不读取 `modelServices`。飞书授权和通知身份始终属于执行 profile。只安装和配置 Claude 的用户现在也可设置独立筛选服务，无需创建 Codex profile。

服务配置位于 schema 2 根配置的新字段。旧 Bridge 不识别它，并可能在写回根配置时丢弃新字段；完成升级后再配置，避免由旧实例同时改写同一配置。推送或打包不会自动切换正在运行的 Bridge。

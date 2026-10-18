# 盯盘与任务来源

[手册首页](README.md) · [会话助理](assistant.md)

## 与会话助理的关系

当前 Git 仓库盯盘专门监控 **GitLab CI 失败**。它直接向会话助理提交事项，在同一个本地工作台中查看和处理：

加载统一事项接口的版本后，群聊/私聊检查和 CI 盯盘共用事项引擎，分别保留消息筛选和 CI 失败规则。已有草稿、话题、停止标记和投递状态会保留。新增来源的开发契约见[统一事项接口](../work-item-sources.md)；此重构不会自动启用 3FS 或萤火监控。

```text
GitLab 仓库轮询 → 发现新的失败 → 助理待办 → 复查并采集证据 → 共用分析队列 → 草稿、工作台、可选飞书通知
飞书消息采集   → 个人关注筛选 → 助理待办 ────────────────────────────┘
```

| 共用 | 按来源保留 |
| --- | --- |
| 待办状态、分析队列、结果校验 | GitLab 轮询、pipeline / job 去重、执行前复查 |
| 草稿编辑、已处理 / 忽略、手动重试 | 飞书消息的个人关注筛选 |
| 通知的持久化与重试机制 | 来源开关、执行 profile、模型和通知目标 |
| 本地工作台 | 按来源、所属用户和 profile 隔离的持久化分区 |

新增一种盯盘时，接入方只需提供事件标识和证据准备逻辑，由助理接管处理。当前实际接入的是 GitLab CI；本手册不表示已经支持任意 URL、GitHub、commit 或 MR 动态监控。

## 配置 GitLab CI

先让个人 Claude / Codex profile 上线，准备能够读取目标 GitLab 项目、pipeline、job 和 trace 的凭据。无需为 CI 单独配置 Responses 筛选服务，也无需开启飞书消息采集。

保存下面的完整 CI 配置为 `ci-watch.json`，替换地址、profile、仓库和绝对路径：

```json
{
  "enabled": true,
  "executorProfile": "codex",
  "url": "https://gitlab.example.com",
  "tokenEnv": "GITLAB_TOKEN",
  "pollSeconds": 1,
  "model": "",
  "outputDir": "/absolute/private/gitlab-ci-analysis",
  "repositories": [
    {
      "project": "team/project",
      "refs": ["dev"],
      "sourceDir": "/absolute/path/project"
    }
  ]
}
```

```bash
lark-channel-bridge ci-watch configure /absolute/path/ci-watch.json
lark-channel-bridge ci-watch status
```

- `project` 可以是项目数字 ID 或 `namespace/project`；`refs` 是精确 ref 名，空数组表示所有 ref。
- 加载支持 CI 每秒轮询的版本后，`pollSeconds` 可设为 1–3600，默认仍为 60。旧版下限为 30 秒，需先升级。查询串行执行，慢请求会延后下一次完成检查的时间。
- `sourceDir` 是可选的本地源码参考位置，盯盘不会自动 checkout 或修改这个目录。
- `model: ""` 跟随执行 profile / CLI。省略时保留旧 Codex 的 Flash 策略，Claude 使用自身默认值。
- `tokenEnv` 指启动 Bridge 时已有的环境变量。也可以填写 `credentialsFile`，使用私有文件中的字面量 `GITLAB_TOKEN` / `GITLAB_URL` 赋值；文件不会被当作 shell 执行。
- CLI 导入的是整个 CI 配置对象。修改时保留其他设置，仅调整需要的字段。

正在运行的新版 Bridge 通常在 15 秒内重载配置。`ci-watch status` 返回持久状态和 `inboxJobId`，不能单凭 `enabled: true` 判断执行器在线。

## 哪些失败会触发

第一次启用仓库时记录当前时间，不追溯更早的失败。启用时仍在运行的 pipeline 随后失败，可以被发现。

只处理总体状态为 `failed` 的 pipeline，排除 allowed-to-fail job。`manual`、`canceled`、`skipped`、`running`、`success` 不触发。下游 bridge 失败也会作为调查线索保留。

同一 pipeline 和相同失败 job / bridge ID 集合只提交一次；重试产生新的失败 job ID，可以产生新事项。开始分析前重新查询当前状态，失败已过期时给出跳过说明，不再调用模型。

自动分析连续失败最多尝试三次，之后在工作台手动重试。Agent 内部可恢复的 429 退避也受该次分析时限约束。重新分析不会替你重试 GitLab job。

## 查看结果和飞书通知

不配置 `notification` 时，**工作台和本机文件仍有结果**，不会发飞书消息。工作台选择“GitLab CI”，打开 pipeline 来源链接、分析和草稿即可查看。

需要飞书通知时，在同一 CI 配置对象中加入：

```json
{
  "notification": {
    "ownerOpenId": "ou_OWNER",
    "deliveryMode": "new_topic",
    "destination": {
      "chatId": "oc_RESULT",
      "threadId": "omt_SETUP_TOPIC",
      "replyTo": "om_SETUP_MESSAGE"
    }
  }
}
```

这段是附加字段，不是替换整个文件。`new_topic` 为每项建立独立话题，`thread` 回复到指定话题。机器人必须能访问并发送到该位置；可沿用已设置的会话助理结果话题 ID。配置通知就会发送开始和结果消息，请填写自己明确选择的目标。

每次调查的证据保存在 `outputDir/<run-id>/`，包括 `evidence.json`、`job-<id>.log` 和成功分析后的 `result.json`。日志截断或缺失会在证据中标明。只读复查发现已过期时，工作台保存跳过说明，不要求产生模型结果文件。

## 停止及升级

把原 CI 配置的 `enabled` 改为 `false`，重新运行 `ci-watch configure`，即可停止轮询并取消 CI 在途分析；已有事项和草稿保留。停止其执行 profile 也会停止来源。聊天 `/stop` 和飞书消息采集开关不负责关闭 CI。

加载新版本并启动盯盘时，旧 `gitlab-ci/state.json` 中的记录会幂等导入助理。已完成结果直接导入，已投递结果不会重发；旧投递曾尝试但未确认时保留结果供核对，不自动重复发送。旧分析中断或结果文件丢失时标记失败，等待手动重试。

GitLab 的轮询游标仍保存在 `gitlab-ci/state.json`；事项、草稿和处理状态进入 `inbox/sources/gitlab-ci/`。更换所属用户或执行 profile 使用独立分区，旧数据保留在原分区，不自动转交给新身份。没有飞书通知的任务使用本机 profile 分区。

CI Agent 的任务要求是只读调查：读取源码、下载日志、提出建议；不自动改仓库、重试 CI、push、合并或部署。这些任务约束仍使用执行 profile 的权限环境。

协议和字段细节见 [GitLab CI 参考](../gitlab-ci-watch.md)。

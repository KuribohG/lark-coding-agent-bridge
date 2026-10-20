# 3FS 集群与 UID 任务监控

支持此功能的 Bridge 可以在 `monitors.toml` 的 `[sources.storage]` 配置两类订阅：重点集群，以及萤火平台的数字 UID。UID 对应平台数据库 `user.user_id`，通过用户表解析用户名。用户无需填写 Chain ID；内部用真实 `chain_id` 追踪每次运行，保留最近 20 个运行 ID。

先参考 [完整示例](monitors.example.toml) 填写集群目录、平台 datasource UID、UID 订阅、凭据文件与输出目录。`monitors check` 只做本地配置校验；部署支持版本后才可以启用。默认不启用任何新监控。

```toml
[[sources.storage.watches]]
id = "important-cluster"
kind = "cluster"
cluster = "prod"

[[sources.storage.watches]]
id = "user-42"
kind = "user"
platform = "platform"
uid = 42
clusters = ["prod"]
```

集群目录定义可查询的 ClickHouse 数据源及数据库，并不自动订阅其中所有集群。`clusters` 是 UID 订阅声明的预期依赖；同时查询目录内其他集群的客户端指标，发现实际访问。一个任务可以访问多个集群，已观察到的依赖会保留；重启后某依赖不再有可映射指标时显示未知。未配置的集群无法自动观测；没有声明完整依赖时，界面显示覆盖未知。无需改动飞书消息监控的会话范围或通知目的地。

## 判定与关联

- 显式 I/O 失败：对 `storage_client.num_failed_ops_per_user` 的窗口值求和，首次发现即创建事项。配置了 `minConnectedNodes` 时，连接节点数低于下限也触发事项。
- 延迟：可选 `latencyMs`，默认 0（关闭）。对 `storage_client.overall_latency` 按 count 加权计算毫秒均值；有已处理 chunks 且连续超过 `sustainSeconds` 才触发。它不是全局 p99。
- 心跳：使用新鲜的 `MgmtdService.NodeStatusCount / HEARTBEAT_CONNECTED`，按角色取最新 gauge。未配置下限时仅检查数据新鲜度，不把历史闲置节点当成故障。
- 任务映射：通过平台 `task_ng`、`unfinished_task_ng` 和 `pod_ng` 取得真实 Chain、运行和 pod，按完整 pod 标签对应 I/O。平台的当前任务以及两次成功扫描之间新创建、已结束的任务一起发现。首次查询包括过去一天；查询窗口保留一小时重叠。最近结束的 Chain 保留七天以跟踪重启。
- 同集群同窗口内的错误归入一个事项，列出有相应指标证据的已订阅任务。只有 UID 订阅时，仅已订阅任务的 I/O 触发告警。共享窗口不代表已证明共同根因，调查必须补充因果证据。
- 零吞吐、没有 pod、平台排队/抢占、查询失败、指标过期、超出 `maxTasks`、已跟踪 Chain 突然不可见，都不能当作存储恢复。未知覆盖不妨碍报告已经观察到的明确错误。

当前信号覆盖客户端 I/O 失败、可选延迟和连接节点下限；不承诺覆盖所有磁盘、容量、路由或训练停顿故障。目录外依赖、不同格式的 pod 标签和没有 I/O 的任务会显示覆盖缺口。Grafana 采集与导出延迟决定实际发现时延，轮询频率不等于端到端告警时延。

## 调查、通知与恢复

健康轮询不调用模型。异常默认启动 `deepseek-flash`，分析前重新读取集群指标，证据与结果保存在 `outputDir`。调查提示要求只读，输出影响、依据、原因候选、证据缺口和建议。采用现有 profile 的凭据和执行权限；具体可用的日志工具取决于该 profile。

加载逐事项筛选版本后，存储分析与飞书/CI 分析共用 `[concurrency].analysis` 个执行名额（默认 5），名额占满时排队等待；筛选有独立的 `triage` 名额（默认 50），告警通知和采集不占分析名额。旧版本使用独立的存储分析名额。默认每天最多 24 次自动尝试（UTC 日界，重试也计入），单次事件最多 3 次尝试。超额继续采集、保留告警和排队事项，次日继续；人工处理可以主动重试。正常持续异常不重复调用模型；任务运行或异常类型发生变化时，在 `reanalyzeSeconds` 间隔后补查。已有调查运行时合并变化，待它结束后再补查，避免不断取消长调查。

配置 `notification` 后，首报在模型队列之外投递，分析结果与恢复通知沿用确认过的话题。首次投递失败不阻止调查。通知最多尝试 3 次、4 分钟内重试，以固定发送标识去重；超过后保留工作台状态，不承诺网络错误下的严格 exactly-once。模型不可用时也保留异常事项。

明确失败和软异常均消失、数据新鲜且满足 `recoverySeconds` 连续窗口后，来源才发送恢复事件。相同源时间戳的重复查询不推进窗口。客户端错误恢复需要有新的正常 I/O，不能仅凭失败计数消失判断。模型完成和人工忽略都不等于集群恢复。

`enabled = false` 暂停来源；单个 watch 的 `enabled = false` 移除该订阅的采集范围；`muted = true` 静默消息但继续采集与分析；工作台停止分析保留草稿且需人工重新处理才恢复分析。服务重启后恢复采集，自动续接未超重试预算的中断调查；人工停止、人工草稿和已处理状态始终保留。改变集群目录、UID 订阅身份或规则会建立新的采集状态分区，旧事项保留，旧分区不再自动分析。

在包含独立后台执行器的版本中，采集开关与 Lark profile 上下线独立；执行器暂不可用时继续保存观测、分析排队，人工暂停保持有效。关闭来源请设置 `enabled = false`。旧版本仍依赖执行 profile 上线，需部署新版本后才具备此语义。

## 凭据、状态和边界

通过 Grafana `/api/ds/query` 访问 ClickHouse 和只读 PostgreSQL datasource，不直接保存数据库密码。读取 `grafana.credentialsFile` 的 `GRAFANA_URL`、`GRAFANA_TOKEN`、`GRAFANA_USER`/`GRAFANA_PASSWORD` 或 `GRAFANA_COOKIE`；同名环境变量优先。文件只解析赋值，不执行 shell。不要把原始 token 写进 TOML。PostgreSQL datasource 须有上述表的只读权限和跨用户可见性；验证失败显示未知。

`monitors status` 显示配置和上次持久化快照；快照时间不能替代实时在线证明。工作台的“采集覆盖”显示集群、UID、Chain 的状态、上次成功时间和缺口。状态文件位于配置根目录的 `storage-monitor/<scope>.json`；共享事项、人工草稿与通知回执仍在 `inbox/sources/storage-monitor/`。同一状态根目录由进程锁保护，观测先落盘再提交，可在提交中断后重复投递同一版本。

每个配置最多 16 个集群、16 个平台和 32 个订阅；每个 UID 最多 `maxTasks` 条 Chain（默认 1000，上限 10000），每集群最多 20000 个 pod 指标聚合。超限不截断后假装覆盖完整。新功能默认关闭，配置热更新约每 15 秒检查一次；采集请求和正在关闭的调查可能延迟切换。

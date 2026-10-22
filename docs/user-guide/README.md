# Bridge 中文用户手册

[快速开始](../../README.zh.md) · [English documentation](../README.md)

Bridge 把本机 Codex、Claude Code、Pi 接到浏览器或飞书。先完成一种基础对话，再选择是否使用会话助理、监控和系统服务。本文档跟随本仓库 `dev` 分支；npm 同名包不一定包含相同代码。

## 按顺序阅读

| 阶段 | 你要做什么 | 读哪篇 |
| --- | --- | --- |
| 1. 启动 | 不配飞书，先在浏览器聊天 | [Web 聊天](web-chat.md) |
| 1. 启动 | 连接飞书应用并完成第一条机器人回复 | [首次飞书接入](getting-started.md) |
| 1. 启动 | Windows 前台、后台、登录自启怎么选 | [Windows 指南](windows.md) |
| 2. 使用 | Web 的新对话、停止、引擎和会话续接 | [Web 聊天](web-chat.md) |
| 2. 使用 | 飞书切项目、恢复历史、旁问、限时任务 | [日常对话与任务](chat-and-tasks.md) |
| 3. 配置 | 文件放哪里、模型/密钥怎么填、何时重启 | [配置教程](configuration.md) |
| 3. 配置 | 模型与 Agent 账号、飞书权限和用户授权 | [模型与账号](models-and-accounts.md) |
| 4. 扩展 | 消息筛选、待办、草稿和结果话题 | [会话助理](assistant.md) |
| 4. 扩展 | GitLab CI 等自动任务来源 | [盯盘与任务来源](monitoring.md) |
| 5. 维护 | 升级、备份、服务管理、常见问题 | [运行维护](operations.md) |

## 三个容易混淆的入口

- **Bridge Chat**：`web` 命令；直接和 Agent 对话，没有飞书管理表单。
- **管理控制台**：`run-lark-cc` / `run --web-ui`；管理 profile、模型服务和助理，不是独立聊天页。
- **系统服务**：`start --profile ...` / `start --web-ui`；由操作系统维持进程，不等于便携后台启动。

停止时使用与启动方式配套的命令，见 [Windows](windows.md) 和[运行维护](operations.md)。

## 四个概念

| 名称 | 含义 |
| --- | --- |
| Agent | 本机执行引擎；`codex`、`claude` 或 `pi` |
| profile | 一套默认执行/权限与机器人配置；名称可以是 work，不必叫 codex；独立 Web 可以没有 profile |
| 会话 | 当前聊天/话题/浏览器对话的上下文；不是配置文件，也不是项目目录 |
| 模型服务 | Bridge 中独立配置的 Responses API；与 Agent 原生登录、飞书授权分开 |

管理配置默认在 `~/.lark-channel/config.toml`；独立 Web 必须显式 `--config` 才读取 Bridge TOML。状态目录规则不同，参见[配置教程](configuration.md)。

## 查表与示例

- 可复制配置：[原生 Codex Web](examples/web-native.toml)、[Responses Web](examples/web-responses.toml)、[Lark Codex](examples/lark-codex.toml)。
- [命令速查](commands.md)、[完整运行行为参考](runtime-reference.md)、[字段与优先级](../configuration.md)。
- [实际验证与已知失败](../windows-web-validation.md)：哪些路径已验收，哪些仍未通过；不把测试矩阵当成实机成功证明。

会话助理和监控默认关闭。普通 Web/飞书对话不自动成为助理待办；飞书 `/run` 也不是每天定时执行。GitLab CI 来源发现的失败进入同一个助理工作台，但与飞书消息来源的开关和配置独立。

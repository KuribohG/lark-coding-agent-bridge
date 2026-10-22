# 命令速查

[手册首页](README.md)

## 在飞书里发送

群或话题群按当前设置真正 @机器人；命令中的路径指 Bridge 运行机器。

| 命令 | 用途 |
| --- | --- |
| `/help` | 帮助卡片 |
| `/status` | 当前 profile、Agent、目录、会话和状态 |
| `/config` | 配置摘要和来源；`run`、`lark`、`access` 分别编辑执行、飞书展示、访问设置 |
| `/config reload` | 校验并重载，报告仍需重启的设置 |
| `/new`、`/reset` | 重置当前会话 |
| `/cd <绝对路径>` | 切换项目并重置会话 |
| `/ws list` | 列出命名工作目录 |
| `/ws save <名称>`、`/ws use <名称>` | 保存当前目录、切换目录 |
| `/ws remove <名称>` | 删除命名绑定，保留文件 |
| `/resume` | 恢复兼容的历史会话 |
| `/model [模型名或 default]` | 当前话题 / 聊天的模型 |
| `/effort [强度或 default]` | 当前话题 / 聊天的思考强度 |
| `/btw <问题>` | 基于主会话的旁问 |
| `/stop` | 停止当前聊天任务、队列和旁问 |
| `/run` | 创建一次性限时任务，需确认预览 |
| `/run status`、`/run stop` | 查看或停止限时任务 |
| `/run defaults` | 配置以后创建限时任务时使用的默认值 |
| `/timeout [N 或 off 或 default]` | 当前会话的空闲超时 watchdog |
| `/inbox setup` | 在目标结果话题中登记会话助理的投递位置 |
| `/inbox` | 会话助理入口；完整本地工作台用启动器打开 |
| `/invite user @某人`、`/remove user @某人` | 管理私聊访问 |
| `/invite admin @某人`、`/remove admin @某人` | 管理管理员 |
| `/invite group`、`/remove group` | 开放或关闭当前群 |
| `/invite all group` | 开放机器人所在的全部群 |
| `/doctor [描述]` | 低敏诊断 |
| `/reconnect` | 强制重连飞书连接 |

访问管理等操作需要 owner / 管理员权限。`/stop`、`/run`、暂停消息采集、关闭 CI 来源分别控制不同任务，见[日常任务](chat-and-tasks.md)和[盯盘](monitoring.md)。

## 在本机终端执行

| 命令 | 用途 |
| --- | --- |
| `run-lark-cc` | 启动控制台 |
| `run-lark-cc fg` | 前台运行控制台 |
| `run-lark-cc ui --print` | 获取本地网页地址 |
| `run-lark-cc status`、`run-lark-cc log` | 查看运行状态和启动日志 |
| `run-lark-cc stop` | 停止整个便携控制台 |
| `lark-channel-bridge profile list` | 列出 profile |
| `lark-channel-bridge profile create <名称> --agent claude` | 创建 Claude profile；Codex/Pi 分别使用 `--agent codex` / `--agent pi` |
| `lark-channel-bridge profile use <名称>` | 切换默认选择 |
| `lark-channel-bridge profile autostart <名称> on\|off` | 设置 supervisor 登录后自动启动集合，不影响 active profile |
| `lark-channel-bridge model-service list` | 列出独立模型 API 服务 |
| `lark-channel-bridge model-service configure <名称> <文件>` | 保存单个服务对象 |
| `lark-channel-bridge model-service check <名称>` | 本地校验配置和凭据 |
| `lark-channel-bridge model-service remove <名称>` | 删除未被引用的服务 |
| `lark-channel-bridge ci-watch configure <文件>` | 保存整个 CI 来源配置 |
| `lark-channel-bridge ci-watch status` | 查看 CI 持久状态 |
| `lark-channel-bridge logs --profile <名称> --follow` | 跨平台查看并跟随 profile 服务日志 |
| `lark-channel-bridge logs --web-ui --follow` | 查看 supervisor 服务日志 |
| `lark-channel-bridge --version`、`--help` | 版本与命令帮助 |

`model-service` 和 `ci-watch` 子命令支持 `--config /absolute/path/config.toml`。在 Bridge 会话里运行 lark-cli 时，保持已注入的 profile 环境。系统服务命令见[运行维护](operations.md)。

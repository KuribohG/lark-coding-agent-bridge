# 运行维护与常见问题

[手册首页](README.md) · [命令速查](commands.md)

## 查看和停止

```bash
run-lark-cc status
run-lark-cc log
run-lark-cc stop
```

`status` 核对本地控制台和在线 profile，`log` 查看启动日志，`stop` 关闭该配置目录的整个控制台进程及其 profile。只停一个机器人时，在控制台操作对应 profile。

## 常驻服务和前台模式

| 运行方式 | 启动 | 停止 |
| --- | --- | --- |
| 便携后台控制台 | `run-lark-cc` | `run-lark-cc stop` |
| 前台控制台 | `run-lark-cc fg` | Ctrl-C |
| 系统服务控制台 | `lark-channel-bridge start --web-ui` | `lark-channel-bridge stop --web-ui` |
| 无网页单 profile | `lark-channel-bridge run --profile codex` | Ctrl-C |

单 profile 模式也使用 supervisor 管理该 profile；其配置的后台来源需要相应执行 profile 在线。统一网页管理推荐使用控制台模式。

系统服务需要稳定的全局安装路径，不要从临时 npx 路径注册。通过对应的服务命令停止服务，避免服务管理器重新拉起；不要混用服务和便携启动器连接同一个应用。

## 升级

确认当前任务可以中断后，在源码安装目录执行：

```bash
git pull --ff-only origin dev
npm install
run-lark-cc stop
run-lark-cc
```

这组命令适用于 `npm link` 加便携启动器的安装。系统服务用户使用服务命令重启；自定义发布目录的用户需更新实际发布指针。构建成功、推送 dev、安装包更新和运行中的进程加载新代码是不同状态。

保留配置目录和私有凭据。旧实例可能在保存配置时丢弃不认识的新字段，因此先完成升级和进程切换，再配置新的模型 API 服务。不要同时运行新旧实例写同一个配置。

## 数据和备份

| 位置，均相对配置目录 | 内容 |
| --- | --- |
| `config.toml` | 执行默认值、前端展示、profile 和模型 API 配置 |
| `monitors.toml` | 由主配置引用的监控来源配置 |
| `profiles/<profile>/` | 会话、命名工作目录、授权相关文件及日志 |
| `inbox/state.json` | 飞书来源事项、草稿和处理状态 |
| `inbox/sources/` | 盯盘事项，按来源与所属身份分区 |
| `gitlab-ci/state.json` | CI 轮询游标、失败去重和助理任务 ID |
| `logs/launcher.log` | 启动器日志 |

CI 原始日志和结果在配置的 `sources.gitlab_ci.outputDir`，模型密钥文件则位于自己指定的私有路径。需要完整恢复时，这些位置也应纳入自己的备份方案。备份状态前停止相关进程，避免复制到互不一致的队列和回执。

配置和授权文件包含个人身份信息，不应作为问题附件公开。日志定位时提供必要时间、profile、任务 ID 和脱敏错误即可。不要通过删除状态目录来“清缓存”，这会同时丢失会话、去重或草稿。

## 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 私聊 / 群里没回复 | profile 是否在线；应用可用范围；群里是否真正 @；用户或群是否有访问权限 |
| 控制台已打开，但机器人离线 | profile 列表中的连接错误，以及本机 Agent 能否登录运行 |
| 服务器的网页在电脑上打不开 | 使用 SSH 端口转发，并保留正确的本地管理 token |
| 中途补充被排队 | Codex 是否仍使用 exec；附件是否走普通队列；当前 CLI 是否支持双向输入 |
| 过程消息停止更新 | 查看是否已切换进度显示；任务可能继续，先查 `/status` 和最终回复 |
| 独立模型本地检查通过，筛选仍失败 | 检查实际 API 地址、模型可用性和额度；本地检查不会发送模型请求 |
| 找不到环境变量密钥 | 变量是否设置在启动 Bridge 的环境；已有进程不会获得其他终端的新变量 |
| 助理一直显示筛选重试 | 用户授权、scope、身份是否匹配；模型错误和工作台显示的下一次重试时间 |
| CI 开启后没有历史失败事项 | 首次启用不回溯；确认后来确实产生总体 failed 的 pipeline，ref 精确匹配 |
| CI 配置 enabled，但没有新结果 | 执行 profile 是否在线；最后轮询时间 / 错误；GitLab 凭据、来源状态和分析队列 |
| 飞书消息暂停后 CI 仍在分析 | 两个来源开关独立；关闭 CI 配置或整个 Bridge |
| 草稿保存提示已更新 | 保留编辑文本，刷新并核对新结果后重新保存，避免覆盖他人的更新 |
| lark-cli 提示 bridge context 未绑定 | 用原 profile 重启或做 doctor / preflight，不切换其他账号绕过 |

飞书 `/doctor` 提供低敏诊断，`/status` 显示会话状态。本机 `lark-channel-bridge --help` 和 `run-lark-cc --help` 可核对实际安装版本支持的命令。

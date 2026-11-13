# lark-channel-bridge

在飞书 / Lark 里使用本机的 **Claude Code、Codex CLI、Pi Coding Agent 或 Antigravity CLI**。Agent 在你的机器上运行，处理你指定的项目目录。

[English](README.md) · [中文用户手册](docs/user-guide/README.md)

本页只讲 Linux 上的接入。不接飞书的浏览器聊天、Windows、网页控制台和 Slack 见[完整快速开始](docs/user-guide/quick-start.md)。

## 安装

需要 Git、Node.js 22.12 或更新版本（Node 20 需 20.19 及以上），以及一个已经能正常对话的 Agent CLI，且由准备运行 Bridge 的同一用户安装。

```sh
git clone --branch dev https://github.com/KuribohG/lark-coding-agent-bridge.git
cd lark-coding-agent-bridge
npx --yes pnpm@10.33.0 install --frozen-lockfile
```

请从本仓库 `dev` 分支安装，npm 上的同名包不一定是同一份代码。后续命令都在仓库目录执行。

## 配置机器人

```sh
node bin/lark-channel-bridge.mjs guide
```

向导依次询问 Agent 可执行文件、权限、谁能用、项目目录、模型凭据、网络代理和飞书应用，飞书应用可以在终端里扫码创建。全部答完才写入 `~/.lark-channel/config.toml`，中途 Ctrl+C 不留改动。

## 运行

```sh
node bin/lark-channel-bridge.mjs run --profile <名称>     # 前台运行，Ctrl+C 停止
node bin/lark-channel-bridge.mjs start --profile <名称>   # 注册为 systemd 服务
node bin/lark-channel-bridge.mjs up                       # 没有 systemd 时后台运行，down 停止
```

然后私聊机器人发送 `/status`，再发一个简单任务。群聊需先拉机器人入群并 @ 它。

Agent 会按向导里选定的权限修改文件、执行命令。把机器人开放给其他人之前先确认权限范围。

## 更多

- [用 `up` 部署](docs/deploy.md)：构建指定分支、升级、回滚
- [配置教程](docs/user-guide/configuration.md)和[运行行为参考](docs/user-guide/runtime-reference.md)
- [工作流](docs/workflows.md)
- 开发验证：`pnpm test`、`pnpm typecheck`、`pnpm build`

许可证：[MIT](LICENSE)

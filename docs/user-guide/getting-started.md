# 安装与首次使用

[手册首页](README.md) · 下一篇：[日常对话与任务](chat-and-tasks.md)

## 准备环境

准备 Node.js **22.12 或更新版本**（也支持 20.19 系列及更新的 Node 20）、Git，以及已安装、已登录的 Claude Code 或 Codex CLI。先确认 `claude` 或 `codex` 能在准备运行 Bridge 的终端里正常使用。

Bridge 调用本机 Agent；模型账号、订阅和 CLI 登录需要单独准备。只使用一个 Agent 也可以安装和使用 Bridge。

## 安装当前 dev 分支

```bash
git clone --branch dev https://github.com/KuribohG/lark-coding-agent-bridge.git
cd lark-coding-agent-bridge
npm install
npm link
run-lark-cc
```

`npm install` 会构建网页和 CLI；`npm link` 注册本机命令。网页已经打包到 Bridge，不需要单独启动前端、数据库或妙搭。已有 pnpm 环境的开发者也可以按仓库锁文件安装。

如果收到维护者提供的 tgz 包，可以安装该包，再运行 `run-lark-cc`：

```bash
npm install -g ./lark-channel-bridge-0.7.1.tgz
run-lark-cc
```

包名以实际收到的文件为准。直接从 npm 安装同名包前，应确认它包含需要的分支功能。

## 建立机器人并验证第一次对话

1. 打开启动器打印的本地网页地址，在向导中扫码创建或连接自己的飞书应用。
2. 选择 Claude 或 Codex，以及一个具体的项目目录；也可以先用自动创建的默认目录。
3. 按飞书租户要求完成应用可用范围、权限和事件订阅配置，然后在 profile 列表中启动机器人。
4. 私聊机器人发送 `/status`，确认 Agent、工作目录和运行状态。
5. 发一个简单任务，例如“列出当前项目的主要文件，并说明项目用途”。收到答复后，普通对话链路就已跑通。
6. 要在群里使用，先把机器人加入群，再用飞书真正的 @选择机器人发送消息。不要只键入文本“@机器人名字”。

聊天访问默认只对应用 owner 开放。想让同事或整个群使用，可按[访问与授权](models-and-accounts.md)中的说明配置。

普通对话不要求开启会话助理，也不要求创建独立模型 API 服务。准备自动整理消息时，再阅读[会话助理](assistant.md)。

## 常用启动方式

| 命令 | 用途 |
| --- | --- |
| `run-lark-cc` | 后台启动本地控制台；已有可验证的实例时打开它 |
| `run-lark-cc codex` | 启动时选择 codex profile |
| `run-lark-cc --profile work` | 选择名为 work 的 profile |
| `run-lark-cc fg codex` | 前台运行，适合容器；Ctrl-C 退出 |
| `run-lark-cc ui` | 打开已有控制台 |
| `run-lark-cc ui --print` | 只打印控制台地址 |
| `run-lark-cc status` | 查看控制台及 profile 状态 |

`run-lark-cc` 的后台模式不提供开机自启或崩溃重启。系统服务和无界面运行方式见[运行维护](operations.md)。不要让两个独立进程同时连接同一个飞书应用。

## Bridge 在远程服务器上

网页只监听服务器的 `127.0.0.1`。在服务器执行 `run-lark-cc ui --print` 获取端口和地址，再在自己的电脑执行：

```bash
ssh -N -L 19180:127.0.0.1:<网页端口> <你的服务器>
```

在电脑浏览器打开 `http://127.0.0.1:19180/?token=<打印地址中的 token>`。这是本地管理凭据，留在自己的终端和浏览器中；不要发到群里。管理页不提供公网多用户登录。

## lark-cli 没安装成功

Bridge 通常会安装兼容的 lark-cli。其原生二进制下载失败时，普通聊天可能仍可用，但会话助理的飞书读取需要先修复依赖：

```bash
npm install -g @larksuite/cli@1.0.77
```

安装后重启相关 profile，再进行授权检查。更多部署细节见[自包含部署指南](../self-contained.md)。

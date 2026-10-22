# 首次飞书接入

[手册首页](README.md) · [只用浏览器聊天？看这里](web-chat.md) · 下一篇：[日常对话](chat-and-tasks.md)

本篇打开的是**飞书管理控制台**，不是 Bridge Chat。要用机器人，需要飞书 / Lark 账号和应用；只用 Web 聊天不需要它们。

## 1. 安装并检查 Agent

按[快速开始](../../README.zh.md#2-安装一次)安装 `dev` 分支，使用项目指定的 pnpm 10.33.0。安装会构建网页和 CLI，不需要单独运行前端或数据库。

只需安装一个你实际使用的 Agent，并在运行 Bridge 的同一账号下完成登录/provider 配置和一次直接对话。版本检查不能证明模型可用。

## 2. 打开控制台

在仓库根目录运行：

```sh
node bin/run-lark-cc.mjs
```

默认后台启动。打开打印的完整控制台 URL；端口以实际输出为准，不要套用 Web Chat 的 8787。若想前台观察首次启动日志：

```sh
node bin/run-lark-cc.mjs fg
```

只选择一种方式，不要同时启动两个进程连接同一个飞书应用。

## 3. 完成绑定并验收

1. 按网页向导扫码创建或连接 PersonalAgent 应用。
2. 选择已配置的 Agent、profile 名称和项目目录；也可以先用自动创建的默认目录。
3. 按租户要求完成应用可用范围、权限、事件订阅和审批。
4. 在 profile 列表中启动机器人；查看是否有连接错误。
5. 私聊机器人发送 `/status`，确认引擎、项目和运行状态。
6. 发送“说明当前项目，先不要修改文件”，收到回复后才算基础链路验收通过。
7. 群聊使用时先加入机器人，再通过飞书的 @选择器真正提及它；纯文本“@机器人”不等同于真实 mention。

聊天默认只向应用 owner 开放。让同事或群使用的配置见[模型与账号](models-and-accounts.md)。普通聊天不依赖会话助理，也不要求先创建独立模型 API 服务。

## 4. 以后怎么打开、停止和看日志

以下均在同一仓库、同一配置环境执行：

```sh
node bin/run-lark-cc.mjs ui
node bin/run-lark-cc.mjs ui --print
node bin/run-lark-cc.mjs status
node bin/run-lark-cc.mjs log
node bin/run-lark-cc.mjs stop
```

这些命令只管理此配置根目录下可验证的 GUI supervisor。前台 `fg` 用 Ctrl+C 停止。便携后台模式不提供登录自启或崩溃重启，系统服务见[运行维护](operations.md)。

## 5. 配置保存在哪里

默认是 `~/.lark-channel/config.toml`（Windows 中 `~` 为 `$HOME`）。profile 的会话、授权和日志在其 `profiles/<名称>` 目录。`LARK_CHANNEL_HOME` 可为管理控制台指定独立配置根目录，之后的启动、查看和停止必须使用同一设置。

模型原生登录仍由 Agent 管理；飞书 App Secret 与模型 API key 不同。配置字段、密钥引用和何时重启见[配置教程](configuration.md)。修改文件前备份，不要把授权目录公开。

## 6. 已有配置，只想无界面运行

```sh
node bin/lark-channel-bridge.mjs run --profile codex
```

把 `codex` 换成实际 profile 名称。配置不在默认位置时，加 `--config /path/to/config.toml`；项目可用 `--workspace` 指定。App Secret 应使用配置中的 env/file/exec 引用或已有 keystore，不要每次启动都把密钥写入公开脚本。首次手动配置可参考 [lark-codex.toml](examples/lark-codex.toml)。

要使用简短的全局命令，源码安装后可选 `npm link`。注册系统服务前必须确保 CLI 位于稳定路径，不要注册指向临时 npx 缓存的服务。已收到维护者 tgz 包时，可用 `npm install -g ./实际包名.tgz`；不要假设 npm 同名版本必然包含本分支代码。

## 远程主机与依赖失败

管理页仅监听运行机器的 `127.0.0.1`。在服务器执行 `node bin/run-lark-cc.mjs ui --print`，用 SSH 转发实际端口，保留打印地址中的管理 token。不要把 token 发到飞书群。具体示例见[自包含部署](../self-contained.md)。

`@larksuite/cli` 是可选依赖；二进制下载失败时，安装成功不等于用户授权或消息读取可用。独立 Web 不依赖它；飞书相关能力需要修复并重启 profile，详见[自包含部署](../self-contained.md)及控制台诊断。

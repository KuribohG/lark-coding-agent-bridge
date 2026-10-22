# 自包含部署

按使用流程阅读请从[用户手册](user-guide/README.md)开始。

本篇是飞书管理控制台/助理的部署参考。仅运行浏览器聊天请看 [Web 聊天指南](user-guide/web-chat.md)，无需完成下方飞书绑定与授权。

本仓库包含 Bridge、`run-lark-cc` 启动器、网页初始化向导、配置页和会话助理工作台。网页构建成单个 HTML 并嵌入 CLI；待办和草稿保存在本地。使用本地工作台不需要单独的前端进程、数据库、妙搭账户或公网入口。

## 新用户

1. 安装 Node.js 22.12+（也支持 20.19+）和 Git。
2. 安装并登录 Claude Code 或 Codex CLI；命令需在 PATH 中可用。
3. 从本仓库安装：

   ```bash
   git clone --branch dev https://github.com/KuribohG/lark-coding-agent-bridge.git
   cd lark-coding-agent-bridge
   npx --yes pnpm@10.33.0 install --frozen-lockfile
   npm link
   run-lark-cc
   ```

   固定版本的 pnpm 按锁文件安装并构建网页和 CLI，无需预先全局安装 pnpm。此部署参考使用 `npm link` 注册稳定的短命令；只做源码前台/便携运行时，可跳过 link 并使用 `node bin/run-lark-cc.mjs`。兼容版本的 `@larksuite/cli` 作为可选依赖安装并自动加入 Bridge 的工具路径；原生二进制下载失败时需修复依赖并重启 profile，不能以 npm 安装成功代替飞书能力验收。
4. 在打印的本地地址中扫码创建飞书应用，选择 agent 和工作目录。创建后在 profile 列表中启动机器人；页面会显示连接错误。
5. 按飞书应用的可用范围、权限和事件订阅要求完成配置，将机器人加入需要的群。

不要从别人的机器复制配置、应用密钥或用户授权。每位用户使用自己的应用/授权；不同账户应使用独立的 `LARK_CHANNEL_HOME`。

## 启动入口

| 命令 | 行为 |
| --- | --- |
| `run-lark-cc` | 后台启动 GUI supervisor 并沿用当前 active profile 的默认执行引擎 |
| `run-lark-cc fg` | 前台运行，适合容器，Ctrl-C 退出 |
| `run-lark-cc --profile work` | 选择其他名称的 profile |
| `run-lark-cc ui --print` | 只打印当前网页地址 |
| `run-lark-cc status` | 查询经过 token 验证的本地监听器和在线 profile |
| `run-lark-cc stop` | 通过本地 API 关闭整个 GUI supervisor，包含其中所有 profile |
| `run-lark-cc log` | 输出启动日志末尾，路径为配置目录的 `logs/launcher.log` |

后台启动不依赖 systemd，也不提供崩溃重启或开机自启。需要系统服务时使用 `lark-channel-bridge start --web-ui`，并通过 `lark-channel-bridge stop --web-ui` 停止服务，避免服务管理器自动拉起。原来的 `lark-channel-bridge run --profile codex` 仍是无 GUI 的单 profile 模式。

supervisor 的自动启动集合保存在 `bridge.autostart_profiles`，与 CLI 的 active profile 分离。首次迁移不写该字段，继续沿用 active profile；在 Profile 详情页启用“登录后自启”或执行 `lark-channel-bridge profile autostart <name> on|off` 后会写入显式集合。

启动器只管理它能验证身份的 GUI supervisor，不会用进程名称匹配去杀别的用户或其他配置目录的进程。原来的个人版脚本使用无界面模式时，先用旧脚本停止，再使用新版入口启动；不要同时连接同一个飞书应用。

`LARK_CHANNEL_HOME` 控制配置目录。启动器继承当前 shell 的环境，不主动 source `.bashrc`，不带固定代理、个人模型服务地址、密钥或发布路径。需要代理时在启动前配置标准代理环境变量；特殊 Node 代理兼容层可自行通过 `NODE_OPTIONS` 注入。

## 会话助理

默认关闭，普通飞书对话不依赖此功能。网页内“配置与首次使用检查”按顺序完成：

1. 创建并启动个人 Claude 或 Codex profile 作为执行器。
2. 点击“授权飞书消息读取”，在浏览器授权后点击“完成授权”。应用侧也需要开通对应权限：`search:message`、`im:chat:read`、`im:message.p2p_msg:get_as_user`、`im:message.group_msg:get_as_user`。若飞书租户要求审批，先完成应用审批。
3. 将机器人加入结果话题群，在目标话题发送 `/inbox setup`（群要求 @ 时需 @ 机器人）。回到网页点击“重新读取设置”，即可填入本人、结果群、话题和回复锚点 ID。
4. 在“模型 API 服务”中添加服务，填写 HTTPS API 根地址、默认模型和 API Key 的环境变量/文件引用，然后在助理中选择该筛选服务。密钥内容保留在本机，不填在网页中。只使用 Claude 时也无需 Codex profile。旧配置仍可选“沿用旧版 profile 配置”。详见[模型服务配置](model-services.md)；飞书读取始终使用执行 profile 的用户授权。
5. 深入分析模型留空时沿用执行 profile / CLI 的默认模型；也可填写执行器支持的模型 ID。旧 Codex 配置未包含 `analysisModel` 时继续使用 `deepseek-flash`；在网页保存为空即可切换到继承模式。独立筛选服务使用自己的默认模型，筛选模型覆盖留空或省略时均继承该默认值；只有旧版 profile 路由保留原来同源跟随深入分析模型、跨 profile 使用 Flash 的省略规则。配置示例见[会话助理文档](inbox-assistant.md)。
6. 填写本人职责、选择接收范围，运行“检查配置”，勾选开启并保存。

检查只验证本地配置、已授予的 scope 和凭据是否存在，不发送模型请求，也不保证模型服务/飞书实际调用成功。实际错误会显示在工作台。

工作台支持待处理、筛选与待核对、历史列表、最近会话选择、分析与重试、详情、草稿编辑和复制、已处理/忽略/恢复及批量标记。草稿保存带版本校验，旧标签页不能覆盖新结果。复制后由用户到原会话核对发送。暂停接收后仍可查看和修改已有草稿；执行 profile 必须在线。

分析进度和结果继续发到指定飞书话题。没有远程工作台时，飞书 `/inbox` 使用卡片入口，本地完整网页用 `run-lark-cc ui` 打开。无需把带管理 token 的本地地址发到飞书。

## 远程机器

网页仅监听 `127.0.0.1`，地址包含每次启动生成的管理 token。用 `run-lark-cc ui --print` 得到端口和地址，然后在自己的电脑上建立转发：

```bash
ssh -N -L 19180:127.0.0.1:<网页端口> <你的服务器>
```

在本机浏览器访问 `http://127.0.0.1:19180/?token=<打印地址里的 token>`。不要把管理 token 分享出去。该管理页不提供公网多用户登录；要从手机直接访问，可继续接入独立妙搭工作台，或自行部署已有的 owner-authenticated H5 入口。这两种远程部署不是本地 GUI 的前置依赖。

## 升级和分发

保留配置目录，更新代码并构建后，在方便时手动重启：

```bash
git pull --ff-only origin dev
npx --yes pnpm@10.33.0 install --frozen-lockfile
run-lark-cc stop
run-lark-cc
```

在源码目录 `npm link` 安装的命令指向该目录，下一次启动使用新构建。自定义发布目录的用户需更新自己的发布指针，不能仅凭 git pull 判断已部署。运行中的进程继续使用已加载代码。

维护者可以 `npm pack` 生成包含已构建 GUI、两个入口和文档的 tgz；接收方 `npm install -g ./lark-channel-bridge-<version>.tgz` 即可安装。此仓库没有内置任何人的飞书应用、API key、SSH 代理配置或个人发布目录。

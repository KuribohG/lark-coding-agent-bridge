# Windows 安装包

`LarkChannelBridge-Setup-<version>-g<sha>.exe` 是一个**单文件、免管理员**的 Windows 安装包：自带
Node 运行时和全部生产依赖，双击即可安装或升级。安装目录默认
`%LOCALAPPDATA%\LarkChannelBridge`，配置目录 `%USERPROFILE%\.lark-channel` 不受影响。

安装后会得到一个托盘程序 `LarkChannelBridgeTray.exe`（开始菜单和桌面都有快捷方式）：

- **双击**快捷方式 → 后台启动 Bridge 和本地控制台，**任务栏托盘出现图标**，不弹控制台窗口；
- **双击托盘图标** → 用浏览器打开管理控制台；
- **右键托盘图标** → 打开控制台 / 重启 Bridge / 定位配置文件 / **退出**（退出会先停掉
  Bridge 再结束托盘进程）。「定位配置文件」会在资源管理器中选中
  `%USERPROFILE%\.lark-channel\config.toml`；文件还不存在时退回打开配置目录。

## 升级时自动做什么

1. 停止并注销所有 `LarkChannelBridge.Bot.*` 计划任务，记录每个服务的 profile / `--web-ui`
   模式和升级前状态（Running / Disabled / Ready）；
2. 结束仍在运行的旧 bridge 进程：npm 全局安装、`npm link`、源码 clone 目录、旧安装目录创建的进程
   都能识别（按 CLI 入口脚本和 launcher 里记录的入口路径匹配）；
3. 如果存在 `npm i -g lark-channel-bridge`，执行 `npm rm -g`（`npm link` 只会删链接，不会动源码目录）；
4. 删除旧的 `app\`、`runtime\`、`bin\` 后写入新版本；
5. 用新的 `node.exe` 和 CLI 绝对路径重新执行 `start`，重建计划任务和
   `~/.lark-channel/daemon/<id>/launcher.cmd`，然后恢复原来的运行状态；
6. 如果升级前是托盘启动的 GUI supervisor，用同一个 profile 重新拉起；
7. 如果托盘程序在运行：先结束旧进程（否则安装目录被占用），安装完成后以 `/quiet`
   模式重新启动托盘（不重复弹浏览器）；托盘会自己把 GUI supervisor 拉起来；
8. 把 `%LOCALAPPDATA%\LarkChannelBridge\bin` 插到**用户 PATH** 最前面，新的终端里
   `lark-channel-bridge` 直接指向新安装。

正在进行的 agent 会话、后台任务和工作流会被中断，升级后请重新发起。

## 安装与卸载

- 图形安装：双击 exe。未签名，SmartScreen 提示时选“更多信息 → 仍要运行”。
- 静默安装：`LarkChannelBridge-Setup-....exe /S`；自定义目录用 NSIS 的 `/D=C:\path`
  （必须是最后一个参数，且路径不加引号）。
- 卸载：设置 → 应用 → Lark Channel Bridge，或开始菜单里的 Uninstall。静默卸载
  `uninstall.exe /S`。
- 卸载默认**保留** `%USERPROFILE%\.lark-channel`（profile、密钥、会话、日志）；只有图形卸载里
  明确选“是”才会删除。安装目录和用户 PATH 条目会被删除。

安装器只写 HKCU、用户 PATH 和当前用户的计划任务，不请求管理员权限，也不安装系统服务；
Windows 上的“后台运行”本身就是登录时触发的计划任务。

## 构建

本地（Windows x64，需要 Node 22、Git；NSIS 优先使用 PATH 或默认安装目录，找不到时脚本
会自动下载官方便携版；托盘程序用系统自带的 .NET Framework 4.x `csc.exe` 编译，无需额外 SDK）：

```powershell
corepack pnpm install --frozen-lockfile
pwsh -File installer/build.ps1
```

产物在 `dist-installer\LarkChannelBridge-Setup-<baseVersion>-g<sha>.exe`，约 20–30 MB。
常用参数：

| 参数 | 作用 |
| --- | --- |
| `-SkipBuild` | 复用已有的 `dist/`（CI 里先单独构建时使用） |
| `-SkipInstall` | 跳过 `pnpm install` |
| `-KeepStage` | 保留 `.installer-stage/` 便于排查 |
| `-NodeVersion 22.18.0` | 固定内置的 Node 版本 |

构建脚本会：构建前端和 CLI → 生成最小化 `package.json` → 在 `win32-x64` 上下载
`better-sqlite3` 预编译产物 → 下载 `node.exe` 并按官方 `SHASUMS256.txt` 校验 →
写入 `bin\*.cmd` shims → 用 `csc.exe` 编译 `tray/LarkChannelBridgeTray.cs`（图标
`tray/app.ico` 由 `tray/make-icon.py` 生成，已提交）→ 调用 `makensis` 编译。**必须在
Windows 上构建**，否则拿不到 `better-sqlite3` 的 win32 原生模块。

## CI

`.github/workflows/windows-installer.yml`：

- **Actions → Windows installer → Run workflow**：手动选择分支（默认 `dev`），构建后从
  run 页面下载 `windows-installer` artifact（保留 3 天）。
- 推送 `v*` tag：自动创建 GitHub Release 并附上安装包，可长期下载。
- 每次构建后还有一个 `windows-latest` 上的 smoke job：静默安装 → 校验 CLI 和内嵌依赖 →
  覆盖安装 → 静默卸载，并检查配置目录和 PATH 的处理。

## GitHub 免费版的存储额度

- **公开仓库**：GitHub-hosted runner 的标准分钟数免费，本 workflow 不消耗付费分钟。
- **Actions artifact**：Free 版 500 MB 存储额度。安装包约 20–30 MB，workflow 里
  `retention-days: 3`，过期自动清理，不会长期占用。
- **Release 资产**：每个 release 最多 1000 个资产、单文件小于 2 GiB；release 资产不计入
  artifact 存储额度，也没有总下载流量限制。建议只保留最近几个 release，旧版本在
  Releases 页面删除即可。
- **私有 fork**：runner 改为按分钟计费（Free 每月包含额度有限，Windows 倍率更高）。如果只是
  自己用，把 fork 保持公开最省心；不想公开就把 workflow 改成手动触发，用完即删 artifact。

## 目录与文件

```
%LOCALAPPDATA%\LarkChannelBridge\
├─ app\        dist/、bin/、生产 node_modules（含 better-sqlite3）
├─ runtime\    node.exe（v22.18.0，构建时校验 SHA256）
├─ bin\        LarkChannelBridgeTray.exe、lark-channel-bridge.cmd、stop-gui.cmd 等
└─ uninstall.exe
%USERPROFILE%\.lark-channel\      配置、密钥、会话、日志（升级/卸载默认保留）
```

## 排查

安装日志写到 `%TEMP%\lark-channel-bridge-installer.log`，包含计划任务枚举、被杀进程、
服务记录和重建结果。需要手动重跑升级流程时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer\stop-existing.ps1 `
  -InstallDir "$env:LOCALAPPDATA\LarkChannelBridge" `
  -RecordPath "$env:TEMP\old-services.json"
powershell -NoProfile -ExecutionPolicy Bypass -File installer\post-install.ps1 `
  -InstallDir "$env:LOCALAPPDATA\LarkChannelBridge" `
  -RecordPath "$env:TEMP\old-services.json"
```

## 限制

- 仅 Windows x64；ARM64 需要另做 Node 和原生模块的构建。
- 安装包未做代码签名，首次运行会有 SmartScreen 提示。
- 只支持当前用户安装（不需要管理员）；如果机器策略禁止用户计划任务，服务模式不可用。
- 不迁移旧 npm 全局安装里的任何东西；配置本来就在 `~/.lark-channel`，与安装方式无关。

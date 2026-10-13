# CodexUsage

基于 Electron、Vite、React 和 TypeScript 的本地 Codex 额度与账号管理面板，支持 Windows、macOS 和 Linux。Electron 面板与普通浏览器共用同一套页面和本机 HTTP 接口。

API 模式账号可分别配置端点、密钥、模型、接口协议和推理强度。模型默认使用 `gpt-5.6-sol`，`wire_api` 默认使用 `responses`，`model_reasoning_effort` 默认使用 `high`，并支持 `max` 档。

## CPA 账号与优先级

在菜单的 CPA 设置中配置管理地址和管理密码后，选择“同步账号”。订阅账号写入 CPA OAuth 凭据列表，API 账号以端点、密钥及上游 `/models` 返回的模型列表注册到 CPA 的 OpenAI 兼容配置中。使用范围为“仅原生”的账号不参与 CPA 同步。

API 与订阅账号共用拖拽排序，越靠前优先级越高；CPA 模式下排序会立即同步，并回读校验 API 配置和优先级。原生模式下拖拽只保存列表顺序。API 排在第一项时也显示“优先使用”，不显示额度悬浮窗。

账号默认模型和 CPA 默认模型仅用于切换时写入 Codex 配置，不作为可用模型的限制条件。CPA 以每次请求携带的模型名和其注册列表进行调度。拖拽或编辑默认模型不会覆盖 CPA 已有的模型列表；手动“同步账号”会重新读取上游 `/models` 并补充新模型，保留已有别名和模型配置。读取失败会停止本次同步并提示错误。

## CPA 流量状态

额度刷新成功后，会自动检查已配置 CPA 的订阅凭证。若 CPA 仍处于账号级额度冷却，而最新上游查询确认额度可用，则清除该凭证的 CPA 本地冷却。手动、自动、启动和 Hook 触发的刷新均适用；仅原生账号、查询失败、额度耗尽、模型不可用或同时存在其他类型冷却时不会处理。修正结果写入程序日志，不刷新 OAuth 凭证、不消耗 OpenAI 额度重置次数，也不重启 CPA。

右上角菜单中的“显示流量图”控制整条流量栏的显示，默认开启。关闭后停止页面的流量自动查询，显示偏好保存在本机，桌面面板和浏览器同步生效。

CPA 列表中的每个账号显示累计成功/失败请求次数，以及最近 200 分钟的 20 格状态图（每格 10 分钟）。绿色表示全部成功，红色表示全部失败，混合请求按成功率显示红黄绿过渡色，灰色表示暂无请求。右侧成功率仅计算这 200 分钟，鼠标悬停方块可查看时段和次数。

订阅账号读取 CPA `/v0/management/auth-files` 的统计，API 账号结合 OpenAI 配置读取 `/v0/management/api-key-usage`，按 Provider、端点和密钥关联。管理密码和上游 API 密钥不会随统计返回页面。仅查看 CPA 列表时每 15 秒批量更新，多个页面共享短时缓存；失败保留上次数据并提示，错误写入日志。旧版 CPA 缺少统计字段或接口时会提示，不影响原生额度查询。

## Token 日统计

面板菜单的“Token 日统计”按本机自然日汇总 Codex 本地会话用量，支持原生/API/CPA 模式产生的日志。分叉开头继承的用量记录会与父会话及祖先会话核对后去重；分叉后新请求重新发送上下文产生的输入 Token 仍正常计入。

首次升级会在原缓存旁保留 `token_usage.v1.json.before-fork-fix.bak`，并校正仍有原始日志的历史统计。统计过的会话被删除后，缓存继续保留其记录；只有旧汇总、没有原始日志的会话保持原值并提示无法校验，不会直接丢弃。

Token 数采用三档显示：不足百万显示基础数值，百万起使用 `M` 并四舍五入取整，达到十亿才使用 `E`（单位仍为亿），固定保留两位小数。例如 `55650826 → 56M`、`100000000 → 100M`、`1000000000 → 10.00E`。鼠标悬停数值可查看完整数字，统计缓存仍保存精确整数。

## 环境要求

- Git
- Node.js 20 或更高版本
- npm 10 或更高版本
- 已安装 Codex；账号切换和“打开 Codex”功能需要本机存在 Codex 启动入口

仓库为公开仓库，可直接执行 `git clone`。

## 浏览器访问

CodexUsage 运行后，在系统托盘菜单或面板右上角菜单中选择“在浏览器中打开”。程序会使用默认浏览器打开本次运行对应的本机地址。

- HTTP 服务仅监听 `127.0.0.1`，不会向局域网或互联网开放。
- 默认使用端口 `64991`；如果被占用，则依次尝试 `64992、64993……`，不需要手动配置。
- 页面使用 `HttpOnly` 本机会话 Cookie，API 同时校验请求来源。
- Electron 面板、浏览器页面和悬浮窗共享账号数据与实时刷新状态。
- 浏览器页面依赖 CodexUsage 后台，退出 CodexUsage 后页面将无法继续操作。

## Windows

在 PowerShell 中从克隆到开发运行：

```powershell
git clone https://github.com/122006/CodexUsage.git
Set-Location CodexUsage
node --version
npm --version
npm ci
npm run dev
```

`npm run dev` 会打开程序并持续运行。按 `Ctrl+C` 停止开发进程。

构建 Windows 未安装版和安装程序：

```powershell
Set-Location CodexUsage
npm ci
npm run dist
Start-Process -FilePath ".\dist\win-unpacked\CodexUsage.exe"
```

运行最新的 Windows 安装程序：

```powershell
$installer = Get-ChildItem ".\dist\CodexUsage-*-Windows-Setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Start-Process -FilePath $installer.FullName
```

以后直接运行未安装版：

```powershell
Set-Location CodexUsage
Start-Process -FilePath ".\dist\win-unpacked\CodexUsage.exe"
```

## macOS

在“终端”中从克隆到开发运行：

```bash
git clone https://github.com/122006/CodexUsage.git
cd CodexUsage
node --version
npm --version
npm ci
npm run dev
```

`npm run dev` 会打开程序并持续运行。按 `Control+C` 停止开发进程。

自动识别 Apple Silicon 或 Intel 架构、构建并打开应用：

```bash
cd CodexUsage
bash build-and-run-macos.command
```

以后直接运行构建出的应用：

```bash
cd CodexUsage
APP="$(find dist -maxdepth 2 -type d -name 'CodexUsage.app' -print -quit)"
xattr -cr "$APP"
open "$APP"
```

如需手动构建指定架构：

```bash
npm ci
npm run dist:mac:arm64
# 或者：npm run dist:mac:x64
```

应用未进行 Apple 开发者签名或公证。如果首次打开被阻止，请进入“系统设置 > 隐私与安全性”，选择“仍要打开”。

## Linux

在终端中从克隆到开发运行：

```bash
git clone https://github.com/122006/CodexUsage.git
cd CodexUsage
node --version
npm --version
npm ci
npm run dev
```

`npm run dev` 会打开程序并持续运行。按 `Ctrl+C` 停止开发进程。

构建并运行 AppImage：

```bash
cd CodexUsage
npm ci
npm run dist
APPIMAGE="$(find dist -maxdepth 1 -type f -name 'CodexUsage-*-Linux-*.AppImage' -print -quit)"
chmod +x "$APPIMAGE"
"$APPIMAGE"
```

如果系统没有 FUSE，可使用 AppImage 的解压运行模式：

```bash
"$APPIMAGE" --appimage-extract-and-run
```

## 常用命令

```bash
npm ci          # 按 package-lock.json 安装依赖
npm run dev     # 开发模式运行
npm run build   # 编译生产文件
npm run package # 生成当前平台的未安装目录
npm run dist    # 生成当前平台的发行包
```

## Node.js 版本错误

如果启动时出现以下错误：

```text
SyntaxError: The requested module 'node:fs/promises' does not provide an export named 'constants'
```

说明当前终端实际使用的 Node.js 版本过旧。Windows PowerShell 先检查 Node.js 的版本和路径：

```powershell
where.exe node
node --version
npm --version
```

项目要求 Node.js 20+ 和 npm 10+。通过 WinGet 安装或升级 Node.js LTS：

```powershell
winget upgrade --id OpenJS.NodeJS.LTS -e
# 如果尚未安装：winget install --id OpenJS.NodeJS.LTS -e
```

安装完成后关闭所有 PowerShell 或命令提示符窗口，重新打开终端并再次检查：

```powershell
where.exe node
node --version
npm --version
```

如果 `where.exe node` 返回多个路径，需要从系统 `PATH` 中移除旧 Node.js 路径，确保第一项是新版本。然后在项目目录重新安装依赖并运行：

```powershell
Set-Location CodexUsage
if (Test-Path ".\node_modules") { Remove-Item -LiteralPath ".\node_modules" -Recurse -Force }
npm ci
npm run dev
```

macOS 或 Linux 使用以下命令确认实际 Node.js 路径，并在升级到 20+ 后重新安装依赖：

```bash
which -a node
node --version
npm --version
cd CodexUsage
rm -rf node_modules
npm ci
npm run dev
```

## 本地文件

账号数据和查询日志只保存在本机：

- Windows：`%APPDATA%\CodexUsagePanel\accounts.v2.json`
- macOS：`~/Library/Application Support/CodexUsagePanel/accounts.v2.json`
- Linux：`${XDG_CONFIG_HOME:-~/.config}/CodexUsagePanel/accounts.v2.json`
- 查询日志：账号数据同目录下的 `query_errors.log`
- Codex 授权和配置：`~/.codex/auth.json`、`~/.codex/config.toml`

账号密钥在系统支持时通过 Electron `safeStorage` 加密保存；导入和导出内容为明文。渲染页面没有 Node.js 文件权限，文件、密钥、托盘、浮窗、账号切换和 Codex 重启均由主进程执行。页面仅通过带本机会话验证的 `127.0.0.1` HTTP API 和 SSE 状态流访问这些能力。

账号或 Provider 切换快照存放于 `~/.codex/backups_state/provider-sync`，只包含上一账号的 `auth.json` 和 `config.toml`。程序不改写 `sessions`、`archived_sessions` 中的会话内容或 Provider，并只保留最近一份上一账号/Provider 的配置快照。Windows 切换时会在 Codex 完全退出后，幂等移除 `state_5.sqlite` 中 `rollout_path` 的 `\\?\` 前缀，避免非当前账号会话归档时被识别为重复路径。

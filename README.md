# CodexUsage

基于 Electron、Vite、React 和 TypeScript 的本地 Codex 额度与账号管理面板，支持 Windows、macOS 和 Linux。Electron 面板与普通浏览器共用同一套页面和本机 HTTP 接口。

API 模式账号可分别配置端点、密钥、模型、接口协议和推理强度。模型默认使用 `gpt-5.6-sol`，`wire_api` 默认使用 `responses`，`model_reasoning_effort` 默认使用 `high`，并支持 `max` 档。

## 环境要求

- Git
- Node.js 20 或更高版本
- npm 10 或更高版本
- 已安装 Codex；账号切换和“打开 Codex”功能需要本机存在 Codex 启动入口

仓库为公开仓库，可直接执行 `git clone`。

## 浏览器访问

CodexUsage 运行后，在系统托盘菜单或面板右上角菜单中选择“在浏览器中打开”。程序会使用默认浏览器打开本次运行对应的本机地址。

- HTTP 服务仅监听 `127.0.0.1`，不会向局域网或互联网开放。
- 端口由系统在每次启动时动态分配，不需要手动配置。
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

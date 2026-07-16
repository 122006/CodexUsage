# CodexUsage

基于 Electron、Vite、React 和 TypeScript 的本地 Codex 额度与账号管理面板，支持 Windows、macOS 和 Linux。

## 环境要求

- Git
- Node.js 20 或更高版本
- npm 10 或更高版本
- 已安装 Codex；账号切换和“打开 Codex”功能需要本机存在 Codex 启动入口

仓库为私有仓库，执行 `git clone` 时需要登录有访问权限的 GitHub 账号。

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

## 本地文件

账号数据和查询日志只保存在本机：

- Windows：`%APPDATA%\CodexUsagePanel\accounts.v2.json`
- macOS：`~/Library/Application Support/CodexUsagePanel/accounts.v2.json`
- Linux：`${XDG_CONFIG_HOME:-~/.config}/CodexUsagePanel/accounts.v2.json`
- 查询日志：账号数据同目录下的 `query_errors.log`
- Codex 授权和配置：`~/.codex/auth.json`、`~/.codex/config.toml`

账号密钥在系统支持时通过 Electron `safeStorage` 加密保存；导入和导出内容为明文。渲染页面没有 Node.js 文件权限，文件、网络、密钥、托盘、浮窗、账号切换和 Codex 重启均由主进程通过白名单 IPC 执行。

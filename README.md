# Codex 额度面板

基于 Electron、Vite、React 和 TypeScript 的本地单页桌面应用，支持 Windows、macOS 和 Linux。

## 开发

```powershell
npm install
npm run dev
```

## 构建

```powershell
npm run build
npm run dist
```

Windows 生成 `CodexUsage.exe` 和 NSIS 安装程序，macOS 生成 DMG，Linux 生成 AppImage。macOS 安装包需要在 macOS 上构建，Linux 安装包需要在 Linux 上构建。

macOS 也可以按当前处理器架构生成未签名 ZIP：

```bash
npm run dist:mac:arm64
npm run dist:mac:x64
```

将项目传到 Mac 后，可以直接执行 `bash build-and-run-macos.command` 自动识别架构、构建并打开应用。

## 本地数据

- 账号数据：系统应用数据目录下的 `CodexUsagePanel/accounts.v2.json`
- 查询日志：同目录下的 `query_errors.log`
- Codex 配置：`~/.codex/auth.json` 和 `~/.codex/config.toml`

首次启动会只读迁移旧 Python 面板的 `tokens.json`。Windows 旧 DPAPI 数据会迁移为 Electron `safeStorage`，原文件另存为 `tokens.json.python-backup`。导入和导出内容按照原需求保持明文。

渲染页面没有 Node 权限。文件、网络、密钥、托盘、浮窗、账号切换和 Codex 重启均通过 preload 白名单 IPC 在主进程执行。

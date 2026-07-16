# CodexUsage macOS 运行说明

支持 Apple Silicon（M 系列）和 Intel Mac。需要先安装 Git、Node.js 20+ 和 npm 10+。

## 从 GitHub 克隆并运行

```bash
git clone https://github.com/122006/CodexUsage.git
cd CodexUsage
node --version
npm --version
npm ci
npm run dev
```

程序打开后，终端中的开发进程需要保持运行。按 `Control+C` 退出。

## 构建并打开 macOS 应用

项目脚本会自动识别当前 Mac 是 Apple Silicon 还是 Intel：

```bash
cd CodexUsage
bash build-and-run-macos.command
```

脚本会执行以下操作：

1. 检查 Node.js 版本。
2. 通过 `npm ci` 安装锁定依赖。
3. 构建当前处理器架构的 `CodexUsage.app` 和 ZIP。
4. 清除本机构建应用的隔离属性并打开应用。

以后直接打开构建结果：

```bash
cd CodexUsage
APP="$(find dist -maxdepth 2 -type d -name 'CodexUsage.app' -print -quit)"
xattr -cr "$APP"
open "$APP"
```

## 手动选择架构

Apple Silicon：

```bash
cd CodexUsage
npm ci
npm run dist:mac:arm64
open dist/mac-arm64/CodexUsage.app
```

Intel Mac：

```bash
cd CodexUsage
npm ci
npm run dist:mac:x64
APP="$(find dist -maxdepth 2 -type d -name 'CodexUsage.app' -print -quit)"
open "$APP"
```

应用未进行 Apple 开发者签名或公证。如果首次打开被 macOS 阻止，请进入“系统设置 > 隐私与安全性”，选择“仍要打开”。

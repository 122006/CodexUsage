# macOS 运行说明

此压缩包同时支持 Apple Silicon（M 系列）和 Intel Mac，构建脚本会自动识别当前处理器架构。

## 首次运行

1. 安装 Node.js 20 或更高版本：https://nodejs.org/
2. 解压整个压缩包。
3. 打开“终端”，进入解压后的 `CodexUsage-macOS-source` 目录。
4. 执行：

```bash
bash build-and-run-macos.command
```

脚本会自动安装依赖、生成当前 Mac 架构的应用和 ZIP，然后打开 `CodexUsage.app`。首次构建需要联网下载 Electron 运行时。

生成位置：

- Apple Silicon：`dist/mac-arm64/CodexUsage.app`
- Intel：`dist/mac/CodexUsage.app`
- 可传输的应用 ZIP：`dist/CodexUsage-<版本>-macOS-<架构>.zip`

应用没有 Apple 开发者签名或公证。如果 macOS 阻止首次打开，请在“系统设置 > 隐私与安全性”中选择“仍要打开”。

## 后续运行

直接打开构建出的 `CodexUsage.app`，不需要再次执行构建脚本。

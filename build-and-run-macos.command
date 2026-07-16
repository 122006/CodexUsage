#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先安装 Node.js 20 或更高版本，然后重新运行。"
  echo "下载地址：https://nodejs.org/"
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 20 ]; then
  echo "当前 Node.js 版本过低：$(node --version)"
  echo "请安装 Node.js 20 或更高版本。"
  exit 1
fi

case "$(uname -m)" in
  arm64)
    build_script="dist:mac:arm64"
    app_dir="dist/mac-arm64/CodexUsage.app"
    ;;
  x86_64)
    build_script="dist:mac:x64"
    app_dir="dist/mac/CodexUsage.app"
    ;;
  *)
    echo "不支持的 Mac 处理器架构：$(uname -m)"
    exit 1
    ;;
esac

echo "正在安装项目依赖..."
npm ci

echo "正在构建 CodexUsage..."
npm run "$build_script"

if [ ! -d "$app_dir" ]; then
  app_dir="$(find dist -maxdepth 3 -type d -name 'CodexUsage.app' -print -quit)"
fi

if [ -z "$app_dir" ] || [ ! -d "$app_dir" ]; then
  echo "构建完成，但没有找到 CodexUsage.app。"
  exit 1
fi

xattr -cr "$app_dir" 2>/dev/null || true
echo "构建完成：$app_dir"
open "$app_dir"

const major = Number(process.versions.node.split('.')[0])

if (!Number.isFinite(major) || major < 20) {
  console.error(`\nCodexUsage 需要 Node.js 20 或更高版本，当前版本为 ${process.version}。`)
  console.error('请升级 Node.js，重新打开终端，然后删除 node_modules 并执行 npm ci。\n')
  process.exit(1)
}

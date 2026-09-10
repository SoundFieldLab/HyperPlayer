// 复测 scripts/dev-electron.mjs 的 isWaveForgeDevLeftover（正斜杠归一化版）
// 减配后：compensation_server.py / beat_analyzer.py / loudness_server.py 等 Python 分析
// 服务已移除，残留判定只保留 vite dev server / local-server / apple_bridge。
const projectRoot = process.cwd()
const isWaveForgeDevLeftover = (commandLine) => {
  if (!commandLine) return false
  const normalized = commandLine.replace(/[\\/]+/g, '/')
  const root = projectRoot.replace(/[\\/]+/g, '/')
  if (!normalized.includes(root)) return false
  return /vite\/bin\/vite|local-server\.mjs|apple_bridge\.py/.test(normalized)
}

const cases = [
  ['真实残留 vite (反斜杠)', '"node" "D:\\opencode\\WaveForge\\node_modules\\.bin\\..\\vite\\bin\\vite.js" --port=3000 --host=0.0.0.0', true],
  ['vite 正斜杠', 'node D:/opencode/WaveForge/node_modules/vite/bin/vite.js --port 3000', true],
  ['local-server', 'node D:\\opencode\\WaveForge\\local-server.mjs', true],
  ['apple bridge', 'python D:\\opencode\\WaveForge\\python-apple-bridge\\apple_bridge.py', true],
  ['ZCode 无关进程', 'C:\\Program Files\\node.exe C:\\Users\\Yoshino\\AppData\\Roaming\\ZCode\\index.js', false],
  ['electron 测试探针', 'D:\\opencode\\WaveForge\\node_modules\\electron\\dist\\electron.exe test/widget-x.cjs', false],
]
let allPass = true
for (const [name, cmd, expect] of cases) {
  const got = isWaveForgeDevLeftover(cmd)
  const ok = got === expect
  if (!ok) allPass = false
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + ' -> ' + got)
}
process.exit(allPass ? 0 : 1)

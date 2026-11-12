const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const runner = path.resolve(__dirname, '../scripts/benchmark-loading.cjs')

test('独立CLI可在未启动服务／浏览器时展示四模式、双平台及三次正常／慢网计划', () => {
  const result = spawnSync(process.execPath, [runner, '--plan'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.runs.length, 48)
  assert.deepEqual([...new Set(plan.runs.map(r => r.mode))], ['minimal', 'traditional', 'explore', 'desktop'])
  assert.deepEqual([...new Set(plan.runs.map(r => r.platform))], ['netease', 'qq'])
  assert.ok(plan.scenarios.includes('playlist-play-all'))
  assert.ok(plan.scenarios.includes('mv-toggle'))
  assert.equal(plan.source, 'controlled-sdk-fixtures')
  assert.equal(plan.idleMs, 4000)
})

test('端口被其他服务占用时CLI拒绝启动，原服务仍保持监听', async t => {
  const server = net.createServer(socket => socket.end())
  const listening = await new Promise(resolve => {
    server.once('error', error => resolve(error.code === 'EADDRINUSE' ? false : Promise.reject(error)))
    server.listen(3210, '127.0.0.1', () => resolve(true))
  })
  if (!listening) return t.skip('已有3210服务，不触碰它')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const child = spawn(process.execPath, [runner, '--run=port-guard-test'], { env: { ...process.env, HYPERPLAYER_BROWSER_TOOLS: '' }, windowsHide: true })
  let error = ''
  child.stderr.on('data', data => { error += data })
  const status = await new Promise(resolve => child.once('exit', resolve))
  assert.notEqual(status, 0)
  assert.match(error, /EPORTBUSY/)
  assert.equal(server.listening, true)
})

test('CLI拒绝不完整慢网参数和路径穿越，不启动应用', () => {
  for (const arg of ['--run=../private', '--repeats=0', '--modes=tv', '--networks=3g', '--unknown=1']) {
    const result = spawnSync(process.execPath, [runner, arg, '--plan'], { encoding: 'utf8' })
    assert.notEqual(result.status, 0, arg)
  }
})

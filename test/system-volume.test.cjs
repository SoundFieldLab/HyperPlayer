'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createSystemVolumeReader } = require('../desktop/system-volume.cjs')

test('desktop main initializes the system volume reader before its first use', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8')
  const readerImport = source.indexOf("const { createSystemVolumeReader } = require('./system-volume.cjs')")
  const readerInitialization = source.indexOf('const readSystemVolume = createSystemVolumeReader({ execFile })')

  assert.notEqual(readerImport, -1, 'desktop main must import the system volume reader')
  assert.notEqual(readerInitialization, -1, 'desktop main must construct the reader')
  assert.ok(readerImport < readerInitialization, 'the constructor must be imported before the call (avoids the startup ReferenceError)')
})

/** 假的 execFile：按脚本化结果回调，并记录调用次数。 */
function fakeExecFile(behaviour) {
  const calls = []
  const execFile = (cmd, args, options, callback) => {
    calls.push({ cmd, args, options })
    const result = typeof behaviour === 'function' ? behaviour(calls.length) : behaviour
    setImmediate(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''))
  }
  return { execFile, calls }
}

test('读到音量并按 0-100 夹取', async () => {
  const { execFile, calls } = fakeExecFile({ stdout: '72\r\n' })
  const read = createSystemVolumeReader({ execFile, platform: 'win32' })
  assert.deepEqual(await read(), { success: true, volume: 72 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'powershell.exe')
  assert.equal(calls[0].options.windowsHide, true)
})

test('缓存命中期间不再 spawn，过期后重新读', async () => {
  const { execFile, calls } = fakeExecFile({ stdout: '40' })
  let clock = 1_000
  const read = createSystemVolumeReader({ execFile, platform: 'win32', cacheTtlMs: 1000, now: () => clock })
  assert.equal((await read()).volume, 40)
  clock += 999
  assert.equal((await read()).volume, 40)
  assert.equal(calls.length, 1, '缓存有效期内不应重复 spawn')
  clock += 2
  await read()
  assert.equal(calls.length, 2, '缓存过期后必须重新读取')
})

test('并发调用合流为一次 spawn', async () => {
  const { execFile, calls } = fakeExecFile({ stdout: '55' })
  const read = createSystemVolumeReader({ execFile, platform: 'win32' })
  const results = await Promise.all([read(), read(), read()])
  assert.deepEqual(results.map(r => r.volume), [55, 55, 55])
  assert.equal(calls.length, 1)
})

test('读取失败如实报错且不写缓存（下次重试成功即恢复）', async () => {
  const { execFile, calls } = fakeExecFile(n => (n === 1
    ? { error: new Error('powershell exit 1'), stdout: '' }
    : { stdout: '66' }))
  const read = createSystemVolumeReader({ execFile, platform: 'win32' })
  const failed = await read()
  assert.equal(failed.success, false)
  assert.equal(failed.volume, -1)
  assert.match(failed.error, /exit 1/)
  const recovered = await read()
  assert.deepEqual(recovered, { success: true, volume: 66 })
  assert.equal(calls.length, 2, '失败结果绝不能被缓存')
})

test('输出不可解析时按失败处理，不返回 NaN', async () => {
  const { execFile } = fakeExecFile({ stdout: 'not-a-number' })
  const read = createSystemVolumeReader({ execFile, platform: 'win32' })
  const result = await read()
  assert.equal(result.success, false)
  assert.equal(result.volume, -1)
})

test('非 Windows 直接声明不支持，不 spawn', async () => {
  const { execFile, calls } = fakeExecFile({ stdout: '50' })
  const read = createSystemVolumeReader({ execFile, platform: 'linux' })
  assert.deepEqual(await read(), { success: true, volume: -1, supported: false })
  assert.equal(calls.length, 0)
})

test('缺注入 execFile 时立刻报错（防止把静默空实现带上线）', () => {
  assert.throws(() => createSystemVolumeReader({}), /execFile/)
})

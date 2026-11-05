'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createIpcRegistry, getIpcCapability, IpcRegistryError } = require('../desktop/ipc-registry.cjs')

function createFakeIpc() {
  const handlers = new Map()
  const events = []
  return {
    handlers,
    events,
    ipcMain: {
      handle: (channel, handler) => { handlers.set(channel, handler) },
      on: (...args) => { events.push(['on', ...args]) },
      removeHandler: (channel) => { handlers.delete(channel) },
      removeAllListeners: (channel) => { events.push(['removeAllListeners', channel]) },
    },
  }
}

test('capability 由 channel 前缀与白名单决定', () => {
  assert.equal(getIpcCapability('desktop-lyrics:get-settings'), 'desktopLyrics')
  assert.equal(getIpcCapability('desktop-player:get-state'), 'desktopPlayer')
  assert.equal(getIpcCapability('taskbar-widget:get-state'), 'taskbarWidget')
  assert.equal(getIpcCapability('update:get-pending'), 'update')
  assert.equal(getIpcCapability('hse-save-rendered-audio'), 'privileged')
  assert.equal(getIpcCapability('chroma:activate'), 'privileged')
  assert.equal(getIpcCapability('unknown:channel'), null)
})

test('注册时强制 capability 并交给 guard 包装', () => {
  const { ipcMain, handlers } = createFakeIpc()
  const capabilities = []
  const registry = createIpcRegistry({
    ipcMain,
    guard: (capability, handler) => {
      capabilities.push(capability)
      return handler
    },
  })
  const handler = () => 'ok'
  const wrapped = registry.handle('hse-save-rendered-audio', handler)

  assert.equal(capabilities[0], 'privileged')
  assert.equal(handlers.get('hse-save-rendered-audio'), wrapped)
  assert.equal(registry.getCapability('hse-save-rendered-audio'), 'privileged')
})

test('未知 channel 与重复注册在启动时失败', () => {
  const { ipcMain } = createFakeIpc()
  const registry = createIpcRegistry({ ipcMain, guard: (_capability, handler) => handler })

  assert.throws(
    () => registry.handle('unknown:channel', () => undefined),
    (error) => error instanceof IpcRegistryError && /未声明 capability/.test(error.message),
  )
  registry.handle('oobe:get-flag', () => undefined)
  assert.throws(
    () => registry.handle('oobe:get-flag', () => undefined),
    (error) => error instanceof IpcRegistryError && /重复注册/.test(error.message),
  )
})

test('removeHandler 后允许重新注册', () => {
  const { ipcMain } = createFakeIpc()
  const registry = createIpcRegistry({ ipcMain, guard: (_capability, handler) => handler })

  registry.handle('oobe:get-flag', () => undefined)
  registry.removeHandler('oobe:get-flag')
  assert.doesNotThrow(() => registry.handle('oobe:get-flag', () => undefined))
})

test('主进程、更新、Chroma、SignalRGB 的 handle channel 全部有 capability', () => {
  const names = new Set()
  for (const file of ['desktop/main.cjs', 'desktop/update-manager.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    for (const match of source.matchAll(/ipcMain\.handle\('([^']+)'/g)) names.add(match[1])
  }
  for (const file of ['desktop/chroma-ipc.cjs', 'desktop/signalrgb-ipc.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    const start = source.indexOf('const handlers = {')
    assert.ok(start >= 0, `${file} 中未找到 handlers 对象`)
    const end = source.indexOf('for (const [channel, handler]', start)
    assert.ok(end > start, `${file} 中未找到 handlers 注册循环`)
    const block = source.slice(start, end)
    for (const match of block.matchAll(/'((?:chroma|signalrgb):[^']+)'\s*:/g)) names.add(match[1])
  }

  const missing = [...names].filter((name) => !getIpcCapability(name))
  assert.deepEqual(missing, [])
})

test('main.cjs 不绕过 registry 直接注册 handle 或保留重复 guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8')
  assert.doesNotMatch(source, /electronIpcMain\.handle\s*\(/)
  assert.doesNotMatch(source, /guardTrustedIpc\('privileged'/)
  assert.ok(source.includes('handle: (channel, handler) =>'))
})

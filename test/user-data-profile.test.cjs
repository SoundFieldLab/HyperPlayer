'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { selectHyperPlayerUserData } = require('../desktop/user-data-profile.cjs')

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hyperplayer-profile-'))
}

// ── 隔离不变量：HyperPlayer 绝不与其他 Electron 应用（含 WaveForge）共用配置目录 ──

test('packaged builds always use the stable product profile and ignore overrides', () => {
  const root = fixture()
  const relativeOverride = 'relative/path'
  const junctionLike = path.join(root, 'Electron')
  assert.equal(selectHyperPlayerUserData({ appDataRoot: root, isPackaged: true }), path.join(root, 'HyperPlayer'))
  // 打包版不认 override（哪怕是绝对路径），杜绝被环境变量引到别的产品目录
  assert.equal(
    selectHyperPlayerUserData({ appDataRoot: root, isPackaged: true, overridePath: junctionLike }),
    path.join(root, 'HyperPlayer'),
  )
  assert.equal(
    selectHyperPlayerUserData({ appDataRoot: root, isPackaged: true, overridePath: relativeOverride }),
    path.join(root, 'HyperPlayer'),
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('development builds also use the product profile, never the shared Electron dir', () => {
  const root = fixture()
  const shared = path.join(root, 'Electron')
  // 即使公共目录里堆满了“像 HyperPlayer”的标记文件，也不再被认领
  fs.mkdirSync(path.join(shared, 'IndexedDB', 'http_127.0.0.1_3000.indexeddb.leveldb'), { recursive: true })
  fs.writeFileSync(path.join(shared, 'config.json'), '{}')
  fs.writeFileSync(path.join(shared, 'desktop-player-settings.json'), '{}')
  fs.writeFileSync(path.join(shared, 'apple-web-cookies.json'), '{}')

  const selected = selectHyperPlayerUserData({ appDataRoot: root, isPackaged: false })
  assert.equal(selected, path.join(root, 'HyperPlayer'))
  assert.notEqual(selected, shared)
  fs.rmSync(root, { recursive: true, force: true })
})

test('development builds accept an explicit absolute override (test profiles)', () => {
  const root = fixture()
  const custom = path.join(root, 'custom-profile')
  assert.equal(
    selectHyperPlayerUserData({ appDataRoot: root, isPackaged: false, overridePath: custom }),
    path.resolve(custom),
  )
  // 相对路径不算有效 override，回落到产品目录
  assert.equal(
    selectHyperPlayerUserData({ appDataRoot: root, isPackaged: false, overridePath: 'relative/path' }),
    path.join(root, 'HyperPlayer'),
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('resolved profile is always inside the app data root for the product', () => {
  const root = fixture()
  for (const isPackaged of [true, false]) {
    const selected = selectHyperPlayerUserData({ appDataRoot: root, isPackaged })
    assert.equal(path.dirname(selected), path.resolve(root))
    assert.equal(path.basename(selected), 'HyperPlayer')
  }
  fs.rmSync(root, { recursive: true, force: true })
})

// ── 主进程 / 启动器接线约定 ──

test('main process creates selected profile before setPath and launcher shares it with API services', () => {
  const root = path.resolve(__dirname, '..')
  const mainSource = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8')
  const launcherSource = fs.readFileSync(path.join(root, 'scripts/dev-electron.mjs'), 'utf8')
  const mkdirIndex = mainSource.indexOf("fs.mkdirSync(selectedUserDataPath, { recursive: true })")
  const setPathIndex = mainSource.indexOf("app.setPath('userData', selectedUserDataPath)")
  assert.ok(mkdirIndex >= 0 && setPathIndex > mkdirIndex)
  assert.match(launcherSource, /HYPERPLAYER_USERDATA:\s*userDataRoot/)
  assert.match(launcherSource, /\.\.\.localServiceEnv/)
})

test('no module reintroduces a fallback to the shared Electron profile directory', () => {
  const root = path.resolve(__dirname, '..')
  const profile = fs.readFileSync(path.join(root, 'desktop/user-data-profile.cjs'), 'utf8')
  // 该模块只应引用产品目录名；出现 'Electron' 字面量意味着又引入了公共目录回退
  assert.doesNotMatch(profile, /['"]Electron['"]/)
})

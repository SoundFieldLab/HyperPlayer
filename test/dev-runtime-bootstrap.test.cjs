'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

test('development launcher enforces production VMP even when invoked directly', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'dev-electron.mjs'), 'utf8')
  assert.match(source, /ensure-dev-vmp\.cjs/)
  assert.match(source, /spawnSync\(process\.execPath/)
  assert.match(source, /终止启动以避免静默退回非原生音源/)
})

test('all Python audio services pin their own directory before importing shared auth', () => {
  for (const file of ['beat_analyzer.py', 'loudness_server.py', 'compensation_server.py']) {
    const source = fs.readFileSync(path.join(root, 'python-beat-service', file), 'utf8')
    assert.match(source, /SCRIPT_DIR = Path\(__file__\)\.resolve\(\)\.parent/, file)
    assert.match(source, /sys\.path\.insert\(0, str\(SCRIPT_DIR\)\)/, file)
    assert.match(source, /from local_service_auth import/, file)
  }
})

test('WaveForge network entrypoints prefer IPv4 when resolving external services', () => {
  const launcher = fs.readFileSync(path.join(root, 'scripts', 'dev-electron.mjs'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8')
  const api = fs.readFileSync(path.join(root, 'local-server.mjs'), 'utf8')
  for (const source of [launcher, main, api]) {
    assert.match(source, /setDefaultResultOrder\(['"]ipv4first['"]\)/)
  }
})

test('development launcher stops before Electron when port 3001 belongs to another session', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'dev-electron.mjs'), 'utf8')
  assert.match(source, /isCompatibleLocalApiHealth\(body\)/)
  assert.match(source, /throw await createStaleLocalApiError\(\)/)
  assert.match(source, /const api = await startAPI\(\)/)
  assert.doesNotMatch(source, /freePortIfHijacked\(3001/)
  assert.match(source, /本次启动已停止/)
})

test('local API health response publishes a stable service contract', () => {
  const source = fs.readFileSync(path.join(root, 'local-server.mjs'), 'utf8')
  assert.match(source, /service: LOCAL_API_SERVICE/)
  assert.match(source, /protocolVersion: LOCAL_API_PROTOCOL_VERSION/)
})

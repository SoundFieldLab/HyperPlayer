const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { observeRendererNetwork, summarizeNetwork, summarizeRuns, networkWindow, upstreamWindow } = require('../scripts/lib/loading-metrics.cjs')

test('CDP 边界只保留类别，不记录查询、歌曲名、账号和 token；失败与未知字节不当成零', () => {
  const cdp = new EventEmitter()
  const stop = observeRendererNetwork(cdp)
  cdp.emit('Network.requestWillBeSent', { requestId: 'a', timestamp: 1, request: { url: 'http://127.0.0.1:3211/api/qq/search?keywords=PRIVATE&cookie=SECRET' }, type: 'Fetch' })
  cdp.emit('Network.responseReceived', { requestId: 'a', timestamp: 1.1, response: { status: 200, fromDiskCache: false, timing: { sendEnd: 2, receiveHeadersEnd: 102 } } })
  cdp.emit('Network.requestWillBeSent', { requestId: 'b', timestamp: 1.05, request: { url: 'https://private.example/user/name.jpg?token=SECRET' }, type: 'Image' })
  cdp.emit('Network.loadingFinished', { requestId: 'a', timestamp: 1.2, encodedDataLength: 240 })
  cdp.emit('Network.loadingFailed', { requestId: 'b', timestamp: 1.3, canceled: true, errorText: 'PRIVATE' })
  const result = summarizeNetwork(stop())
  assert.equal(result.requests, 2)
  assert.equal(result.peakConcurrency, 2)
  assert.equal(result.cancelled, 1)
  assert.equal(result.knownTransferredBytes, 240)
  assert.equal(result.unknownTransferredRequests, 1)
  assert.equal(result.transferredBytes, null)
  assert.equal(result.categories.api.requests, 1)
  assert.equal(result.categories.image.requests, 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|private\.example|keywords|cookie/)
  assert.equal(cdp.listenerCount('Network.requestWillBeSent'), 0)
})

test('观察窗口保留跨窗请求的并发与未完成状态，不伪称本窗发起或已知完整字节', () => {
  const entries = [
    { start: 1, end: 5, category: 'api', outcome: 'complete', transferredBytes: 100 },
    { start: 3, end: 3.5, category: 'image', outcome: 'complete', transferredBytes: 80 },
    { start: 5, end: 6, category: 'other', outcome: 'complete', transferredBytes: 10 },
  ]
  const result = networkWindow(entries, 2, 4)
  assert.equal(result.requests, 2)
  assert.equal(result.started, 1)
  assert.equal(result.carriedIn, 1)
  assert.equal(result.pending, 1)
  assert.equal(result.peakConcurrency, 2)
  assert.equal(result.transferredBytes, null)
  assert.equal(result.knownTransferredBytes, 80)
})

test('重复运行仅聚合相同条件下已测场景，失败与不同网络不能混入中位数', () => {
  const sample = n => ({ name: 'search', status: 'measured', network: { requests: n, knownTransferredBytes: 10, peakConcurrency: 1 }, frames: { p95: 16 }, usableMs: 100, taskMs: 50, heapMB: 20, durationMs: 1000 })
  const runs = [10, 20, 60].map(n => ({ conditions: { mode: 'minimal', platform: 'qq', network: 'normal' }, samples: [sample(n), { ...sample(999), status: 'failed' }] }))
  runs.push({ conditions: { mode: 'minimal', platform: 'qq', network: 'slow' }, samples: [sample(90)] })
  const summaries = summarizeRuns(runs)
  assert.equal(summaries.length, 2)
  assert.deepEqual(summaries[0].requests, { samples: 3, min: 10, median: 20, p95: 60, max: 60 })
  assert.equal(summaries[1].repeats, 1)
})

test('后端窗口把SDK逻辑调用和实际fetch分开，保留fixture未覆盖和传输未知', () => {
  const events = [
    { id: 'a', event: 'request-start', at: 1000, transport: 'sdk-fixture', category: 'api', fixtureMiss: false },
    { id: 'b', event: 'request-start', at: 1100, transport: 'fetch', category: 'api', fixtureMiss: false },
    { id: 'b', event: 'request-end', at: 1200, transport: 'fetch', outcome: 'complete', status: 200, transferredBytes: null },
    { id: 'a', event: 'request-end', at: 1300, transport: 'sdk-fixture', outcome: 'complete', status: 200, transferredBytes: null },
    { id: 'c', event: 'request-start', at: 1400, transport: 'fetch', fixture: true, category: 'api', fixtureMiss: true },
  ]
  const result = upstreamWindow(events, 900, 1500)
  assert.equal(result.logicalSdk.requests, 1)
  assert.equal(result.http.requests, 1)
  assert.equal(result.fixtureHttp.requests, 1)
  assert.equal(result.fixtureMisses, 1)
  assert.equal(result.http.transferredBytes, null)
})

test('毫秒时间戳内完成的上游调用不丢失其实际并发峰值', () => {
  const events = [
    { id: 'a', event: 'request-start', at: 1000, transport: 'sdk-fixture', category: 'api', active: 1 },
    { id: 'b', event: 'request-start', at: 1000, transport: 'sdk-fixture', category: 'api', active: 2 },
    { id: 'a', event: 'request-end', at: 1000, transport: 'sdk-fixture', status: 200, outcome: 'success' },
    { id: 'b', event: 'request-end', at: 1000, transport: 'sdk-fixture', status: 200, outcome: 'success' },
  ]
  assert.equal(upstreamWindow(events, 900, 1100).logicalSdk.peakConcurrency, 2)
})

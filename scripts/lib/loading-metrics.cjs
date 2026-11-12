'use strict'

// 仅独立诊断脚本引用；CDP 的原始 URL、header、响应正文永不进入报告。
function requestCategory(rawUrl, resourceType = '') {
  try {
    const url = new URL(rawUrl)
    if (/\/api\/(audio|bilibili\/(stream|audio))/.test(url.pathname) || resourceType === 'Media') return 'media'
    if (/\/api\/(cover|proxy-image)/.test(url.pathname) || resourceType === 'Image') return 'image'
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') return 'api'
    if (resourceType === 'Font') return 'font'
    if (['Script', 'Stylesheet', 'Document'].includes(resourceType)) return 'code'
  } catch { /* data/blob 等资源仅按类型归类。 */ }
  return 'other'
}

function observeRendererNetwork(cdp) {
  const requests = new Map()
  const completed = []
  const handlers = {
    'Network.requestWillBeSent': e => {
      const previous = requests.get(e.requestId)
      if (previous) completed.push({ ...previous, end: e.timestamp, outcome: 'redirect', transferredBytes: null })
      requests.set(e.requestId, { start: e.timestamp, category: requestCategory(e.request.url, e.type), transferredBytes: null, status: null, outcome: 'pending', ttfbMs: null })
    },
    'Network.responseReceived': e => {
      const entry = requests.get(e.requestId)
      if (!entry) return
      entry.status = e.response.status
      entry.cached = Boolean(e.response.fromDiskCache || e.response.fromServiceWorker)
      const timing = e.response.timing
      entry.ttfbMs = timing && timing.receiveHeadersEnd >= timing.sendEnd && timing.sendEnd >= 0 ? timing.receiveHeadersEnd - timing.sendEnd : null
    },
    'Network.loadingFinished': e => finish(e, 'complete'),
    'Network.loadingFailed': e => finish(e, e.canceled ? 'cancelled' : 'failed'),
  }
  function finish(e, outcome) {
    const entry = requests.get(e.requestId)
    if (!entry) return
    requests.delete(e.requestId)
    completed.push({ ...entry, end: e.timestamp, outcome, transferredBytes: outcome === 'complete' && Number.isFinite(e.encodedDataLength) ? e.encodedDataLength : null })
  }
  for (const [event, handler] of Object.entries(handlers)) cdp.on(event, handler)
  const snapshot = () => [...completed, ...requests.values()]
  const stop = () => {
    for (const [event, handler] of Object.entries(handlers)) cdp.off(event, handler)
    return snapshot()
  }
  stop.snapshot = snapshot
  return stop
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const at = q => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] : null
  return { samples: sorted.length, min: sorted[0] ?? null, median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null }
}

function summarizeNetwork(entries) {
  const summary = {
    requests: entries.length, peakConcurrency: 0, failed: 0, cancelled: 0, httpErrors: 0, pending: 0,
    knownTransferredBytes: 0, unknownTransferredRequests: 0, transferredBytes: null,
    durationMs: distribution(entries.filter(e => e.end != null).map(e => (e.end - e.start) * 1000)),
    ttfbMs: distribution(entries.map(e => e.ttfbMs)), categories: {},
  }
  const points = []
  for (const e of entries) {
    points.push([e.start, 1, e.startOrder ?? 1])
    if (e.end != null) points.push([e.end, -1, e.endOrder ?? 0])
    if (e.outcome === 'failed') summary.failed++
    if (e.outcome === 'cancelled') summary.cancelled++
    if (e.outcome === 'pending') summary.pending++
    if (e.status >= 400) summary.httpErrors++
    const category = summary.categories[e.category] ||= { requests: 0, knownTransferredBytes: 0, unknownTransferredRequests: 0 }
    category.requests++
    if (Number.isFinite(e.transferredBytes)) {
      summary.knownTransferredBytes += e.transferredBytes
      category.knownTransferredBytes += e.transferredBytes
    } else {
      summary.unknownTransferredRequests++
      category.unknownTransferredRequests++
    }
  }
  let active = 0
  for (const [, delta] of points.sort((a, b) => a[0] - b[0] || a[2] - b[2])) {
    active += delta
    summary.peakConcurrency = Math.max(summary.peakConcurrency, active)
  }
  if (!summary.unknownTransferredRequests) summary.transferredBytes = summary.knownTransferredBytes
  return summary
}

function summarizeRuns(runs) {
  const groups = new Map()
  for (const run of runs) {
    for (const sample of run.samples) {
      if (sample.status !== 'measured') continue
      const key = [run.conditions.mode, run.conditions.platform, run.conditions.network, sample.name].join('/')
      const items = groups.get(key) || []
      items.push(sample)
      groups.set(key, items)
    }
  }
  return [...groups].map(([scenario, samples]) => ({
    scenario, repeats: samples.length,
    requests: distribution(samples.map(s => s.network.requests)),
    knownTransferredBytes: distribution(samples.map(s => s.network.knownTransferredBytes)),
    peakConcurrency: distribution(samples.map(s => s.network.peakConcurrency)),
    usableMs: distribution(samples.map(s => s.usableMs)),
    firstPlayingMs: distribution(samples.map(s => s.firstPlayingMs)),
    frameP95Ms: distribution(samples.map(s => s.frames.p95)),
    taskMs: distribution(samples.map(s => s.taskMs)),
    heapMB: distribution(samples.map(s => s.heapMB)),
    durationMs: distribution(samples.map(s => s.durationMs)),
    cancelled: distribution(samples.map(s => s.network.cancelled)),
    unknownTransferredRequests: distribution(samples.map(s => s.network.unknownTransferredRequests)),
    upstreamLogicalRequests: distribution(samples.map(s => s.upstream?.logicalSdk.started)),
    upstreamFixtureHttpRequests: distribution(samples.map(s => s.upstream?.fixtureHttp.started)),
    upstreamRealHttpRequests: distribution(samples.map(s => s.upstream?.http.started)),
    reviewLineMs: Object.fromEntries(['usableMs', 'firstPlayingMs'].map(key => {
      const d = distribution(samples.map(s => s[key]))
      return [key, d.samples >= 3 ? d.max + Math.max(1, d.max - d.min) : null]
    })),
  }))
}

function networkWindow(entries, from, to) {
  const overlapping = entries.filter(e => e.start < to && (e.end == null || e.end > from))
  const clipped = overlapping.map(e => {
    const completeInWindow = e.start >= from && e.end != null && e.end <= to
    return { ...e, start: Math.max(e.start, from), end: e.end == null || e.end > to ? undefined : e.end,
      outcome: e.end == null || e.end > to ? 'pending' : e.outcome,
      transferredBytes: completeInWindow ? e.transferredBytes : null,
      ttfbMs: e.start >= from ? e.ttfbMs : null }
  })
  return { ...summarizeNetwork(clipped), started: overlapping.filter(e => e.start >= from).length, carriedIn: overlapping.filter(e => e.start < from).length }
}

function upstreamWindow(events, from, to) {
  const entries = new Map()
  // 同毫秒事件用源文件顺序破平局，避免epoch浮点精度丢失极短调用。
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const at = e.at / 1000
    if (e.event === 'request-start') entries.set(e.id, { start: at, startOrder: i, fixture: e.fixture === true || e.transport.endsWith('-fixture'), category: e.category || 'other', transport: e.transport, fixtureMiss: e.fixtureMiss, transferredBytes: null, outcome: 'pending' })
    else if (e.event === 'request-end' && entries.has(e.id)) Object.assign(entries.get(e.id), { end: at, endOrder: i, outcome: e.outcome, status: e.status, transferredBytes: e.transferredBytes ?? null })
  }
  const all = [...entries.values()]
  const window = filter => networkWindow(all.filter(filter), from / 1000, to / 1000)
  return {
    logicalSdk: window(e => e.transport === 'sdk-fixture'),
    fixtureHttp: window(e => e.transport !== 'sdk-fixture' && e.fixture),
    http: window(e => !e.fixture),
    fixtureMisses: all.filter(e => e.fixtureMiss && e.start * 1000 >= from && e.start * 1000 < to).length,
  }
}

module.exports = { requestCategory, observeRendererNetwork, summarizeNetwork, summarizeRuns, distribution, networkWindow, upstreamWindow }

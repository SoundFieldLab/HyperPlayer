'use strict'

const assert = require('assert')
const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs')
const test = require('node:test')
const { AudioDownloadService } = require('../desktop/audio-download.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-audio-policy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  return root
}

const { PassThrough } = require('stream')

function response(statusCode, headers, body = Buffer.from('ID3-test-audio')) {
  return { statusCode, headers, body, resume() {}, on() {}, destroy() {} }
}

function streamResponse(statusCode, headers, delay = 0) {
  const stream = new PassThrough()
  stream.statusCode = statusCode
  stream.headers = headers
  setTimeout(() => { stream.end(Buffer.from('ID3-audio')) }, delay)
  return stream
}

function fakeRequestFactory(calls, handler) {
  return ({ url, headers }, callback) => {
    calls.push({ url, headers })
    const request = {
      destroyed: false,
      on(event, listener) { if (event === 'error') request.errorListener = listener; return request },
      setTimeout() {},
      destroy() { request.destroyed = true },
    }
    setImmediate(() => handler({ url, headers }, callback, request))
    return request
  }
}

test('adds provider headers, follows relative redirects, and accepts 206', async t => {
  const root = fixture(t)
  const calls = []
  const service = new AudioDownloadService(root, {
    requestFactory: fakeRequestFactory(calls, ({ url }, callback) => {
      if (url.includes('/start')) return callback(response(302, { location: '/audio' }))
      callback(streamResponse(206, { 'content-type': 'audio/mpeg', 'content-length': '9' }))
    }),
  })
  const file = await service.downloadForAnalysis('https://example.qq.com/start?guid=secret', 'qq-track')
  assert.ok(fs.existsSync(file))
  assert.equal(calls.length, 2)
  assert.equal(calls[0].headers.Referer, 'https://y.qq.com/')
  assert.equal(calls[0].headers.Accept, 'audio/*,application/octet-stream;q=0.9,*/*;q=0.8')
  assert.ok(calls[0].headers['User-Agent'])
  service.clearLocalAuthorizations()
})

test('cooled 403 does not retry the same signed URL, but a new URL can try', async t => {
  const root = fixture(t)
  const calls = []
  let now = 1000
  const service = new AudioDownloadService(root, {
    now: () => now,
    requestFactory: fakeRequestFactory(calls, (_request, callback) => callback(response(403, {}))),
  })
  await assert.rejects(service.downloadForAnalysis('https://audio.example/song.mp3?sig=old', 'song'), /AUDIO_DOWNLOAD_HTTP_403/)
  await assert.rejects(service.downloadForAnalysis('https://audio.example/song.mp3?sig=old', 'song'), /AUDIO_DOWNLOAD_403_COOLDOWN/)
  assert.equal(calls.length, 1)
  await assert.rejects(service.downloadForAnalysis('https://audio.example/song.mp3?sig=new', 'song'), /AUDIO_DOWNLOAD_HTTP_403/)
  assert.equal(calls.length, 2)
  now += 31_000
  await assert.rejects(service.downloadForAnalysis('https://audio.example/song.mp3?sig=old', 'song'), /AUDIO_DOWNLOAD_HTTP_403/)
  assert.equal(calls.length, 3)
})

test('joins concurrent downloads only for the same track and signed URL', async t => {
  const root = fixture(t)
  const calls = []
  const service = new AudioDownloadService(root, {
    requestFactory: fakeRequestFactory(calls, (_request, callback) => {
      callback(streamResponse(200, { 'content-type': 'audio/mpeg' }))
    }),
  })
  const oldUrl = 'https://audio.example/song.mp3?sig=old'
  const newUrl = 'https://audio.example/song.mp3?sig=new'
  await Promise.all([
    service.downloadForAnalysis(oldUrl, 'song'),
    service.downloadForAnalysis(oldUrl, 'song'),
    service.downloadForAnalysis(newUrl, 'song'),
  ])
  assert.equal(calls.length, 2)
})

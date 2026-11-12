'use strict'

// 合成媒体用于真实 audio 元素解码／起播；不是实际歌曲或音质基准。
function audioFixture() {
  const rate = 8000, seconds = 12
  const pcm = Buffer.alloc(rate * seconds * 2)
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 600), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
const audio = audioFixture()
const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#315b70"/></svg>')
function rendererFixture(url) {
  const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
  if (['fixture.invalid', '203.0.113.10'].includes(url.hostname) && url.pathname === '/audio.wav') return { status: 200, contentType: 'audio/wav', headers, body: audio }
  if (['fixture.invalid', '203.0.113.10'].includes(url.hostname) && url.pathname === '/cover.svg') return { status: 200, contentType: 'image/svg+xml', headers, body: image }
  // 歌词第三方增强可正常回退；未知外部请求失败封闭，不访问互联网、不伪造业务成功。
  return { status: 503, contentType: 'application/json', headers, body: Buffer.from('{"fixtureUnsupported":true}') }
}
module.exports = { rendererFixture, audioFixture }

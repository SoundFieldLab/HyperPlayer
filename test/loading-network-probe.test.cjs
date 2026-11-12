'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtempSync, readFileSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const http = require('node:http')

const probe = path.resolve(__dirname, '../scripts/lib/loading-network-probe.cjs')

// 只启动独立测试 child；监听临时端口，不加载应用/用户配置。
async function child(source, env = {}, enabled = true) {
  const output = path.join(mkdtempSync(path.join(tmpdir(), 'hp-loading-')), 'events.ndjson')
  const childEnv = { ...process.env }
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('HYPERPLAYER_LOADING_')) delete childEnv[key]
  }
  if (enabled) childEnv.HYPERPLAYER_LOADING_PROBE_FILE = output
  Object.assign(childEnv, env)
  const proc = spawn(process.execPath, ['--require', probe, '-e', source], {
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = '', stderr = ''
  proc.stdout.on('data', chunk => { stdout += chunk })
  proc.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => proc.kill(), 12000)
  const code = await new Promise((resolve, reject) => {
    proc.once('error', reject)
    proc.once('exit', resolve)
  })
  clearTimeout(timer)
  assert.equal(code, 0, stderr || stdout)
  const raw = existsSync(output) ? readFileSync(output, 'utf8') : ''
  return { stdout, raw, events: raw.trim() ? raw.trim().split('\n').map(JSON.parse) : [] }
}

async function upstream(t, handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return `http://127.0.0.1:${server.address().port}`
}

function paired(events, count) {
  const starts = events.filter(event => event.event === 'request-start')
  const ends = events.filter(event => event.event === 'request-end')
  assert.equal(starts.length, count)
  assert.equal(ends.length, count)
  assert.equal(new Set(starts.map(event => event.id)).size, count)
  for (const start of starts) {
    const end = ends.find(event => event.id === start.id)
    assert.ok(end)
    assert.equal(end.startedAt, start.at)
    assert.ok(end.at >= start.at)
  }
  return ends
}

test('默认关闭：preload 不替换网络函数、不增加 timer，fixture 开关单独设置也不启用', async () => {
  const result = await child(`
    const assert = require('node:assert/strict');
    const snapshot = require(${JSON.stringify(probe)}).getSnapshot();
    assert.equal(snapshot.enabled, false);
    assert.equal(require('node:http').request.name, 'request');
    assert.equal(require('node:https').request.name, 'request');
    assert.equal(global.fetch.name, 'fetch');
    assert.equal(process.getActiveResourcesInfo().filter(x => x === 'Timeout').length, 0);
  `, { HYPERPLAYER_LOADING_FIXTURES: '1' }, false)
  assert.equal(result.events.length, 0)
})

test('真实 fetch 和 Node HTTP 保留 body/压缩响应/状态，记录配对时刻与峰值且不泄密', async t => {
  const { gzipSync } = require('node:zlib')
  const compressed = gzipSync(Buffer.from('压缩内容'))
  const origin = await upstream(t, (req, res) => {
    setTimeout(() => {
      if (req.url.startsWith('/gzip')) {
        res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(compressed)
      } else {
        res.writeHead(req.url.startsWith('/bad') ? 503 : 200)
        res.write('hello'); res.end(' world')
      }
    }, 35)
  })
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      const http = await import('node:http');
      const origin = ${JSON.stringify(origin)};
      const get = path => new Promise((resolve, reject) => {
        http.get(origin + path, { headers: { cookie: 'SECRET_COOKIE' } }, res => {
          const chunks = []; res.on('data', x => chunks.push(x));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
      const [text, bytes, bad] = await Promise.all([
        fetch(origin + '/private-id?token=SECRET_TOKEN').then(r => r.text()),
        get('/gzip/SECRET_ID'), fetch(origin + '/bad').then(r => r.text())
      ]);
      assert.equal(text, 'hello world');
      assert.equal(require('node:zlib').gunzipSync(bytes).toString(), '压缩内容');
      assert.equal(bad, 'hello world');
      const snapshot = require(${JSON.stringify(probe)}).getSnapshot();
      assert.equal(snapshot.active, 0); assert.equal(snapshot.started, 3);
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_TEST_UPSTREAM_ORIGIN: origin })
  const ends = paired(result.events, 3)
  assert.ok(ends.some(event => event.peakActive >= 2))
  assert.equal(ends.filter(event => event.outcome === 'http-error').length, 1)
  assert.equal(ends.find(event => event.transport === 'http').encodedBytes, compressed.length)
  assert.ok(ends.every(event => event.transferredBytes === null))
  assert.doesNotMatch(result.raw, /SECRET|private-id|127\.0\.0\.1|cookie|token|gzip/i)
})

test('默认所有 loopback 为内部链路，不把本地代理调用计为外部', async t => {
  const origin = await upstream(t, (_req, res) => res.end('local'))
  const result = await child(`
    (async () => {
      await (await fetch(${JSON.stringify(origin)})).text();
      await new Promise(resolve => require('node:http').get(${JSON.stringify(origin)}, r => { r.resume(); r.on('end', resolve) }));
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `)
  assert.equal(result.events.filter(event => event.event === 'request-start').length, 0)
})

test('真实取消、断流与连接失败均恰好闭合一次，不消费流或吞掉应用 error', async t => {
  const origin = await upstream(t, (req, res) => {
    if (req.url === '/broken') {
      res.writeHead(200, { 'content-length': '999' }); res.write('partial')
      setTimeout(() => res.destroy(), 25)
    } else setTimeout(() => res.end('late'), 350)
  })
  const result = await child(`
    (async () => {
      const http = require('node:http'); const origin = ${JSON.stringify(origin)};
      await Promise.all([
        fetch(origin + '/cancel', { signal: AbortSignal.timeout(40) }).catch(() => {}),
        fetch(origin + '/broken').then(r => r.text()).catch(() => {}),
        new Promise(resolve => { const req = http.get(origin + '/cancel'); req.on('error', resolve); setTimeout(() => req.destroy(new DOMException('SECRET_ERROR', 'AbortError')), 40) }),
        new Promise(resolve => { http.get(origin + '/broken', r => { r.on('error', resolve); r.resume() }).on('error', resolve) })
      ]);
      await new Promise(resolve => setImmediate(resolve));
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_TEST_UPSTREAM_ORIGIN: origin })
  const ends = paired(result.events, 4)
  assert.equal(ends.filter(event => event.outcome === 'cancelled').length, 2)
  assert.equal(ends.filter(event => event.outcome === 'failed').length, 2)
  assert.doesNotMatch(result.raw, /SECRET_ERROR|broken|cancel\//)
})

test('公开 SDK fixture 同时支持 CJS/ESM：160 首与可进入的歌单艺人，单列 logical 调用', async () => {
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      const n = (await import('@neteasecloudmusicapienhanced/api')).default;
      const q = (await import('qq-music-api')).default;
      assert.equal(require('@neteasecloudmusicapienhanced/api'), n);
      await (await import('@neteasecloudmusicapienhanced/api/generateConfig.js')).default();
      const search = (await n.search({ keywords: 'SECRET_QUERY', limit: 20 })).body.result;
      assert.equal(search.songCount, 160); assert.equal(search.songs.length, 20);
      assert.equal(search.songs[0].name, '基准歌曲 001');
      assert.equal(search.songs[0].artists[0].id, 1);
      const lists = (await n.search({ keywords: 'SECRET', type: 1000 })).body.result.playlists;
      assert.equal(lists[0].id, 9001); assert.equal(lists[0].name, '基准歌单');
      const playlist = (await n.playlist_detail({ id: 9001 })).body.playlist;
      assert.equal(playlist.trackCount, 160); assert.equal(playlist.trackIds.length, 160);
      assert.equal((await n.artist_songs({ id: 1, limit: 30, offset: 150 })).body.songs.length, 10);
      const qq = await q.api('singer/songs', { singermid: 'artist-fixture', num: 30, page: 6 });
      assert.equal(qq.total, 160); assert.equal(qq.list.length, 10);
      assert.equal(qq.singer.name, '基准歌手');
      assert.equal((await q.api('songlist', { id: 9001 })).songlist.length, 160);
      assert.equal((await n.song_url_v1({ id: 1 })).body.data[0].url, 'https://203.0.113.10/audio.wav');
      assert.equal((await n.album({ id: 1 })).body.album.name, '基准专辑 001');
      await n.artist_mv({ id: 1 }); await n.mv_detail({ mvid: 1 }); await n.mv_url({ id: 1 });
      await assert.rejects(n.unsupported_private_operation({ cookie: 'SECRET_COOKIE' }), { code: 'HYPERPLAYER_FIXTURE_UNKNOWN' });
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_FIXTURES: '1' })
  const starts = result.events.filter(event => event.event === 'request-start')
  const ends = paired(result.events, starts.length)
  assert.equal(starts.length, 13)
  assert.ok(ends.every(event => event.transport === 'sdk-fixture'))
  assert.ok(ends.every(event => event.encodedBytes === null && event.transferredBytes === null))
  assert.equal(ends.filter(event => event.fixtureMiss).length, 1)
  assert.doesNotMatch(result.raw, /SECRET|unsupported_private_operation|9001|artist-fixture/)
})

test('fetch fixture 保留本地鉴权/JSON解析，延迟限速作用于上游，未知外部被阻断', async t => {
  let escapes = 0
  const origin = await upstream(t, (_req, res) => { escapes++; res.end('escaped') })
  const result = await child(`
    const assert = require('node:assert/strict'); const http = require('node:http');
    (async () => {
      const server = http.createServer(async (req, res) => {
        // 测试拥有真实本地路由，preload 不替换此路由或账号校验。
        if (req.headers.authorization !== 'SECRET_AUTH') { res.writeHead(401); res.end(); return }
        const data = await (await fetch('https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=SECRET_QUERY&n=20')).json();
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ name: data.data.song.list[0].songname }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const local = 'http://127.0.0.1:' + server.address().port;
      try {
        assert.equal((await fetch(local)).status, 401);
        const before = Date.now();
        const data = await (await fetch(local, { headers: { authorization: 'SECRET_AUTH' } })).json();
        assert.equal(data.name, '基准歌曲 001'); assert.ok(Date.now() - before >= 80);
        const unknown = await fetch(${JSON.stringify(origin)} + '/SECRET_PATH?cookie=SECRET_VALUE');
        assert.equal(unknown.status, 501); await unknown.text();
        const n = await (await fetch('https://music.163.com/api/playlist/detail?id=9001')).json();
        assert.equal(n.playlist.trackIds.length, 160);
        const detail = await (await fetch('https://music.163.com/api/song/detail/?ids=[1,2]')).json();
        assert.equal(detail.songs.length, 2);
        const wav = await fetch('https://203.0.113.10/audio.wav', { headers: { Range: 'bytes=0-43' } });
        assert.equal(wav.status, 206); assert.equal((await wav.arrayBuffer()).byteLength, 44);
        const cover = await (await fetch('https://203.0.113.10/cover.svg')).text(); assert.ok(cover.includes('<svg'));
        const search = await (await fetch('https://api.bilibili.com/x/web-interface/wbi/search/type?keyword=SECRET')).json();
        assert.equal(search.data.result[0].title, '基准歌曲 001');
      } finally { await new Promise(resolve => server.close(resolve)) }
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_FIXTURES: '1', HYPERPLAYER_LOADING_TEST_UPSTREAM_ORIGIN: origin,
    HYPERPLAYER_LOADING_LATENCY_MS: '45', HYPERPLAYER_LOADING_BYTES_PER_SECOND: '1000000' })
  assert.equal(escapes, 0)
  const ends = paired(result.events, 7)
  assert.equal(ends.filter(event => event.fixtureMiss).length, 1)
  assert.ok(ends.every(event => event.fixture && event.transport === 'fetch'))
  assert.equal(ends.find(event => event.category === 'media').encodedBytes, 44)
  assert.ok(ends.every(event => event.transferredBytes === null))
  assert.doesNotMatch(result.raw, /SECRET|fixture\.invalid|9001|bilibili\.com/)
})

test('Node HTTP/HTTPS fixture 运行真实 axios 解析，支持请求体且未知上游不逃逸', async t => {
  let escapes = 0
  const origin = await upstream(t, (_req, res) => { escapes++; res.end('escaped') })
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      const axios = (await import('axios')).default;
      const desc = await axios.get('https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_singer_desc.fcg?singermid=artist-fixture', { proxy: false });
      assert.ok(desc.data.includes('固定基准艺人'));
      const detail = await axios.post('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        req_1: { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_mid: 'song-fixture-3' } }
      }, { proxy: false });
      assert.equal(detail.data.req_1.data.track_info.name, '基准歌曲 003');
      const unknown = await axios.get(${JSON.stringify(origin)} + '/SECRET_PATH', { proxy: false, validateStatus: () => true });
      assert.equal(unknown.status, 501);
      const streamed = await axios.get('https://203.0.113.10/audio.wav', { proxy: false, responseType: 'stream', headers: { Range: 'bytes=0-43' } });
      const chunks = []; for await (const chunk of streamed.data) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).subarray(0, 4).toString(), 'RIFF');
      assert.equal(Buffer.concat(chunks).length, 44);
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_FIXTURES: '1', HYPERPLAYER_LOADING_TEST_UPSTREAM_ORIGIN: origin })
  assert.equal(escapes, 0)
  const ends = paired(result.events, 4)
  assert.equal(ends.filter(event => event.fixtureMiss).length, 1)
  assert.ok(ends.every(event => event.fixture && ['http', 'https'].includes(event.transport)))
  assert.doesNotMatch(result.raw, /SECRET|artist-fixture|song-fixture|fixed|musicu/)
})

test('fixture 本地重定向到外部及直接 ClientRequest 均失败关闭，不逃逸到测试上游', async t => {
  let escapes = 0
  const external = await upstream(t, (_req, res) => { escapes++; res.end('escaped') })
  const local = await upstream(t, (_req, res) => { res.writeHead(302, { location: external + '/SECRET_REDIRECT' }); res.end() })
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      await assert.rejects(fetch(${JSON.stringify(local)}));
      await new Promise(resolve => {
        const req = new (require('node:http').ClientRequest)(${JSON.stringify(external + '/SECRET_DIRECT')});
        req.on('error', resolve); req.end();
      });
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_FIXTURES: '1', HYPERPLAYER_LOADING_TEST_UPSTREAM_ORIGIN: external })
  assert.equal(escapes, 0)
  const ends = paired(result.events, 2)
  assert.ok(ends.every(event => event.fixtureMiss && event.outcome === 'failed'))
  assert.doesNotMatch(result.raw, /SECRET/)
})

test('HTTP encodedBytes 在 setEncoding 后仍统计原始正文，fetch 重定向按实际上游逐次计数', async t => {
  const origin = await upstream(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/target' }); res.end(); return }
    if (req.url === '/latin') { res.end(Buffer.from([255])); return }
    res.end('target')
  })
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      const origin = ${JSON.stringify(origin)};
      await new Promise((resolve, reject) => require('node:http').get(origin + '/latin', res => {
        res.setEncoding('latin1'); let text = ''; res.on('data', chunk => text += chunk);
        res.on('end', () => { assert.equal(text, 'ÿ'); resolve() });
      }).on('error', reject));
      assert.equal(await (await fetch(origin + '/redirect')).text(), 'target');
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_TEST_UPSTREAM_ORIGIN: origin })
  const ends = paired(result.events, 3)
  assert.equal(ends.find(event => event.transport === 'http').encodedBytes, 1)
  assert.deepEqual(ends.filter(event => event.transport === 'fetch').map(event => event.status).sort(), [200, 302])
})

test('fixture 头前取消、正文取消与 HTTP destroy 都闭合且清理等待 timer', async () => {
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      await assert.rejects(fetch('https://203.0.113.10/audio.wav', { signal: AbortSignal.timeout(20) }));
      const response = await fetch('https://203.0.113.10/audio.wav');
      await response.body.cancel();
      await new Promise(resolve => {
        const request = require('node:https').get('https://203.0.113.10/audio.wav');
        request.on('error', () => {}); request.on('close', resolve);
        setTimeout(() => request.destroy(), 20);
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(process.getActiveResourcesInfo().filter(x => x === 'Timeout').length, 0);
      assert.equal(require(${JSON.stringify(probe)}).getSnapshot().active, 0);
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_FIXTURES: '1', HYPERPLAYER_LOADING_LATENCY_MS: '60',
    HYPERPLAYER_LOADING_BYTES_PER_SECOND: '10000' })
  const ends = paired(result.events, 3)
  assert.ok(ends.every(event => event.outcome === 'cancelled'), JSON.stringify(ends))
})

test('QQ SDK 搜歌单 t=2 返回真实本地 route 所消费的摘要字段，能按 id 进入完整歌单', async () => {
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      const qq = (await import('qq-music-api')).default;
      const result = await qq.api('search', { key: '基准', t: 2, pageNo: 1, pageSize: 30 });
      assert.equal(result.total, 1); assert.equal(result.list.length, 1);
      const item = result.list[0];
      // local-server 的 type=playlist 消费这些上游公开字段；不替换自有路由。
      assert.equal(item.dissid || item.tid, '9001');
      assert.equal(item.dissname || item.name, '基准歌单');
      assert.equal(item.imgurl || item.picurl, 'https://203.0.113.10/cover.svg');
      assert.equal(Number(item.songnum || item.song_count), 160);
      const full = await qq.api('songlist', { id: item.dissid });
      assert.equal(full.songlist.length, 160);
      const page2 = await qq.api('search', { key: '基准', t: 2, pageNo: 2, pageSize: 30 });
      assert.equal(page2.list.length, 0);
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_FIXTURES: '1' })
  const ends = paired(result.events, 3)
  assert.ok(ends.every(event => !event.fixtureMiss && event.outcome === 'success'))
})

test('QQ MusicU 官方歌词边界返回可 base64 解码的三行普通 LRC，fetch/axios 不依赖 SDK fallback', async () => {
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      const axios = (await import('axios')).default;
      const endpoint = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
      const payload = {
        comm: { ct: 24, cv: 0 },
        lyric: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo',
          param: { songMID: 'song-fixture-1', songID: 1, lrc: 1, qrc: 1, qrc_t: 0,
            trans: 1, trans_t: 0, roma: 1, roma_t: 0, crypt: 1, ct: 19, cv: 2111, type: 0 } },
      };
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: 'SECRET_LYRIC_COOKIE' },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      const fetchData = await response.json();
      const postData = (await axios.post(endpoint, payload, { proxy: false })).data;
      const getData = (await axios.get(endpoint, {
        params: { data: JSON.stringify(payload) }, proxy: false,
      })).data;
      for (const result of [fetchData, postData, getData]) {
        assert.equal(result.code, 0); assert.equal(result.lyric.code, 0);
        const data = result.lyric.data;
        assert.match(data.lyric, /^[A-Za-z0-9+/=]+$/);
        const text = Buffer.from(data.lyric, 'base64').toString('utf8');
        assert.deepEqual(text.split('\\n'), [
          '[00:00.00]清晨的风吹过站台',
          '[00:04.00]我们沿着旋律向前',
          '[00:08.00]让每一句歌声被听见',
        ]);
        assert.doesNotMatch(text, /纯音乐|无歌词|instrumental|作词|作曲|编曲|制作人/i);
        // 普通 LRC fixture 不伪造逐字加密、翻译或罗马音；真实本地后续仲裁仍执行。
        assert.equal(data.qrc, ''); assert.equal(data.trans, ''); assert.equal(data.roma, '');
      }
      const invalid = { lyric: { ...payload.lyric, method: 'SECRET_UNKNOWN_LYRIC_METHOD' } };
      const miss = await fetch(endpoint, { method: 'POST', body: JSON.stringify(invalid) });
      assert.equal(miss.status, 501); await miss.text();
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_FIXTURES: '1' })
  const ends = paired(result.events, 4)
  assert.equal(ends.filter(event => event.fixtureMiss).length, 1)
  assert.equal(ends.filter(event => event.outcome === 'success' && event.status === 200).length, 3)
  assert.ok(ends.every(event => event.transport !== 'sdk-fixture' && event.fixture && event.platform === 'qq'))
  assert.doesNotMatch(result.raw, /SECRET|PlayLyricInfo|song-fixture|清晨|旋律|歌声/)
})

test('fixture 不把 127.evil.com 与 localhost 子域名当作 loopback 放行', async () => {
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      const axios = (await import('axios')).default;
      for (const host of ['127.evil.com', '127.0.0.1.evil.com', 'evil.localhost']) {
        const response = await fetch('http://' + host + '/SECRET_UPSTREAM', { signal: AbortSignal.timeout(1000) });
        assert.equal(response.status, 501); await response.text();
        const node = await axios.get('http://' + host + '/SECRET_UPSTREAM', {
          proxy: false, timeout: 1000, validateStatus: () => true,
        });
        assert.equal(node.status, 501);
      }
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_FIXTURES: '1' })
  const ends = paired(result.events, 6)
  assert.ok(ends.every(event => event.fixtureMiss && event.status === 501))
  assert.doesNotMatch(result.raw, /evil|localhost|SECRET/)
})

test('fixture 保留真实 IPv4-mapped IPv6 loopback 的本地响应，不误计为外部', async t => {
  const origin = await upstream(t, (_req, res) => res.end('mapped-local'))
  const port = new URL(origin).port
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]']) {
        const response = await fetch('http://' + host + ':${port}/');
        assert.equal(await response.text(), 'mapped-local');
      }
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_FIXTURES: '1' })
  assert.equal(result.events.length, 0)
})

test('QQ singer/songs 公开 SDK 边界提供歌曲而非艺人行，分页保留 route 所消费的身份标题专辑', async () => {
  const result = await child(`
    const assert = require('node:assert/strict');
    (async () => {
      const qq = (await import('qq-music-api')).default;
      const first = await qq.api('singer/songs', { singermid: 'artist-fixture', num: 40, page: 1 });
      const second = await qq.api('singer/songs', { singermid: 'artist-fixture', num: 40, page: 2 });
      assert.equal(first.total, 160); assert.equal(second.total, 160);
      assert.equal(first.list.length, 40); assert.equal(second.list.length, 40);
      for (const [item, id, title] of [
        [first.list[0], 1, '基准歌曲 001'],
        [second.list[0], 41, '基准歌曲 041'],
      ]) {
        assert.equal(item.id, id); assert.equal(item.mid, 'song-fixture-' + id);
        assert.equal(item.name || item.title, title);
        assert.equal(item.album.id, 1); assert.equal(item.album.mid, 'album-fixture');
        assert.equal(item.album.name || item.album.title, '基准专辑 001');
        assert.equal(item.singer[0].name, '基准歌手');
        assert.equal(item.singer[0].mid, 'artist-fixture');
        assert.equal(item.interval, 180); assert.equal(item.pay.payplay, 0);
      }
      assert.equal(new Set([...first.list, ...second.list].map(item => item.mid)).size, 80);
    })().catch(e => { console.error(e); process.exitCode = 1 });
  `, { HYPERPLAYER_LOADING_FIXTURES: '1' })
  const ends = paired(result.events, 2)
  assert.ok(ends.every(event => event.route === 'artist' && !event.fixtureMiss && event.outcome === 'success'))
})

test('IPC 快照仅显式启用时按固定请求响应，数值白名单且无 timer；关闭时无监听', async t => {
  async function ipcChild(enabled, run) {
    const dir = mkdtempSync(path.join(tmpdir(), 'hp-loading-ipc-'))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('HYPERPLAYER_LOADING_')) delete env[key]
    if (enabled) env.HYPERPLAYER_LOADING_PROBE_FILE = path.join(dir, 'events.ndjson')
    const proc = spawn(process.execPath, ['--require', probe, '-e', `
      process.send({ type: 'ready', listeners: process.listenerCount('message'),
        timers: process.getActiveResourcesInfo().filter(x => x === 'Timeout').length });
    `], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
    t.after(() => { if (proc.connected) proc.disconnect(); if (proc.exitCode === null) proc.kill() })
    const messages = []
    let stderr = ''
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('message', message => messages.push(message))
    const next = () => new Promise((resolve, reject) => {
      const onMessage = message => { cleanup(); resolve(message) }
      const onExit = code => { cleanup(); reject(new Error('IPC child exited: ' + code + ' ' + stderr)) }
      const timer = setTimeout(() => { cleanup(); reject(new Error('IPC child timed out: ' + stderr)) }, 4000)
      function cleanup() { clearTimeout(timer); proc.off('message', onMessage); proc.off('exit', onExit) }
      proc.once('message', onMessage); proc.once('exit', onExit)
    })
    const ready = await next()
    assert.equal(ready.type, 'ready'); assert.equal(ready.timers, 0)
    await run(proc, ready, next, messages)
  }
  await ipcChild(true, async (proc, ready, next, messages) => {
    assert.equal(ready.listeners, 1)
    // FIFO：所有无效请求位于有效请求前；收到有效响应后即可检查没有额外响应。
    for (const message of [null, {}, { type: 'other', id: 1 },
      { type: 'hyperplayer-loading-snapshot', id: 'SECRET_ID' },
      { type: 'hyperplayer-loading-snapshot', id: 1, private: 'SECRET_FIELD' }]) proc.send(message)
    const first = next()
    const before = Date.now()
    proc.send({ type: 'hyperplayer-loading-snapshot', id: 7 })
    const snapshot = await first
    assert.deepEqual(Object.keys(snapshot).sort(), ['type', 'id', 'at', 'cpu', 'memory', 'resource'].sort())
    assert.equal(snapshot.type, 'hyperplayer-loading-snapshot'); assert.equal(snapshot.id, 7)
    const receivedAt = Date.now()
    const clockToleranceMs = 50 // Windows 跨进程墙钟允许有限误差。
    assert.ok(Number.isSafeInteger(snapshot.at), 'IPC snapshot.at must be a safe integer timestamp')
    assert.ok(snapshot.at >= before - clockToleranceMs && snapshot.at <= receivedAt + clockToleranceMs,
      JSON.stringify({ at: snapshot.at, before, receivedAt, clockToleranceMs,
        sinceRequestMs: snapshot.at - before, untilReceiptMs: receivedAt - snapshot.at }))
    for (const [key, fields] of [
      ['cpu', ['user', 'system']],
      ['memory', ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']],
      ['resource', ['userCPUTime', 'systemCPUTime', 'maxRSS']],
    ]) {
      assert.deepEqual(Object.keys(snapshot[key]).sort(), fields.sort())
      for (const value of Object.values(snapshot[key])) assert.ok(Number.isFinite(value) && value >= 0)
    }
    const second = next(); proc.send({ type: 'hyperplayer-loading-snapshot', id: 8 })
    const after = await second
    assert.ok(after.cpu.user >= snapshot.cpu.user && after.cpu.system >= snapshot.cpu.system)
    assert.equal(after.id, 8)
    assert.deepEqual(messages.map(message => message.type), ['ready', 'hyperplayer-loading-snapshot', 'hyperplayer-loading-snapshot'])
    proc.disconnect()
  })
  await ipcChild(false, async (proc, ready) => { assert.equal(ready.listeners, 0); if (proc.connected) proc.disconnect() })
})

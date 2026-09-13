#!/usr/bin/env node
/**
 * 启动页视频「帧时基归一」—— 只改时间轴，不动一个像素。
 *
 * 为什么需要
 * ----------
 * 录制侧的时间轴常见两种毛病（2026-09-13 对 `new-splash/splash-webm.webm` 实测）：
 *   1. 内容以 ~32.6fps 产出，却被塞进 25fps（40ms）网格 —— 103 帧只有 79 个唯一
 *      时间戳，**24 对相邻帧共享同一时间戳**：这些帧永远拿不到独立显示时长，
 *      播放时表现为规律的"跳一下"；
 *   2. 25fps 与 60Hz 刷新率不成整数倍（60/25 = 2.4），叠加 3:2 式节拍不均。
 * 这两点都是**文件自带**的抖动，与播放环境无关；换何时播、换解码方式都治不好。
 *
 * 做法：把第 i 帧重铺到均匀网格 t_i = round(i * 1000 / fps)。默认 30fps ——
 * 30 对 60/120Hz 都是整数倍。只改写 SimpleBlock 里的 int16 相对时间戳与
 * DefaultDuration / Duration 三个字段，**编码数据一个字节都不碰**，因此：
 *   · 画质零损失（不是重编码，是改时基）；
 *   · 文件长度不变 ⇒ Cues / SeekHead 的字节偏移仍然有效，不需要重写索引；
 *   · 代价是动画整体放慢约 8.6%（3.16s → 3.43s），慢速渐变 + 进场动画不可感知。
 *
 * 自校验（每次归一后立即执行，任一不满足即抛错，绝不产出可疑文件）：
 *   · 帧数与源一致；时间戳唯一且严格递增；
 *   · 相邻间隔 ∈ {floor(1000/fps), ceil(1000/fps)} 毫秒；
 *   · 文件长度与源一致；DefaultDuration 与 Duration 已同步更新。
 * 幂等：对已归一的文件再跑一次，结果不变。
 *
 * 用法：node scripts/retime-splash-webm.mjs <in.webm> <out.webm> [--fps 30]
 * 也可作为模块使用：import { retimeSplashWebm } from './retime-splash-webm.mjs'
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 需要的 EBML 元素 ID ──
const EL = {
  SEGMENT: '18538067',
  INFO: '1549a966',
  TRACKS: '1654ae6b',
  TRACK_ENTRY: 'ae',
  VIDEO: 'e0',
  CLUSTER: '1f43b675',
  BLOCK_GROUP: 'a0',
  BLOCK: 'a1',
  TIMECODE_SCALE: '2ad7b1',
  DURATION: '4489',
  DEFAULT_DURATION: '23e383',
  CLUSTER_TIMECODE: 'e7',
  SIMPLE_BLOCK: 'a3',
}

/** 读取 EBML 元素 ID（保留 marker 位，按 16 进制字符串返回） */
function readId(buf, pos) {
  const first = buf[pos]
  if (first === undefined) return null
  let len = 1
  let mask = 0x80
  while (len <= 4 && !(first & mask)) { mask >>= 1; len++ }
  if (len > 4) throw new Error(`EBML ID 非法 @${pos}`)
  let id = ''
  for (let i = 0; i < len; i++) id += buf[pos + i].toString(16).padStart(2, '0')
  return { id, len }
}

/** 读取 EBML 长度（剥掉 marker 位；全 1 视为 unknown size） */
function readSize(buf, pos) {
  const first = buf[pos]
  if (first === undefined) return null
  let len = 1
  let mask = 0x80
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++ }
  if (len > 8) throw new Error(`EBML size 非法 @${pos}`)
  let value = first & (mask - 1)
  let unknown = (first & (mask - 1)) === (mask - 1)
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i]
    if (buf[pos + i] !== 0xff) unknown = false
  }
  return { value, len, unknown }
}

/** 列出 [start, end) 范围内的全部子元素 */
function children(buf, start, end) {
  const out = []
  let pos = start
  while (pos < end) {
    const idr = readId(buf, pos)
    if (!idr) break
    const sizer = readSize(buf, pos + idr.len)
    if (!sizer) break
    const dataStart = pos + idr.len + sizer.len
    const dataEnd = sizer.unknown ? end : dataStart + sizer.value
    if (dataEnd > end || dataEnd <= pos) throw new Error(`元素越界 @${pos}（最长 ${end}）`)
    out.push({ id: idr.id, dataStart, dataEnd })
    pos = dataEnd
  }
  return out
}

function readUint(buf, offset, len) {
  let v = 0
  for (let i = 0; i < len; i++) v = v * 256 + buf[offset + i]
  return v
}

function writeUint(buf, offset, len, value) {
  let v = value
  for (let i = len - 1; i >= 0; i--) {
    buf[offset + i] = v % 256
    v = Math.floor(v / 256)
  }
  if (v > 0) throw new Error(`数值 ${value} 无法塞进 ${len} 字节字段`)
}

function readFloat(buf, offset, len) {
  if (len === 4) return buf.readFloatBE(offset)
  if (len === 8) return buf.readDoubleBE(offset)
  throw new Error(`不支持 ${len} 字节浮点字段`)
}

function writeFloat(buf, offset, len, value) {
  if (len === 4) buf.writeFloatBE(value, offset)
  else if (len === 8) buf.writeDoubleBE(value, offset)
  else throw new Error(`不支持 ${len} 字节浮点字段`)
}

/** vint 的字节长度（用于跳过 SimpleBlock/Block 载荷里的轨道号） */
function vintLength(byte) {
  let len = 1
  let mask = 0x80
  while (len <= 8 && !(byte & mask)) { mask >>= 1; len++ }
  return len
}

/** 解析容器：取出帧时间戳字段、DefaultDuration、Duration 的位置与当前值 */
export function parseSplashWebm(buf) {
  const top = children(buf, 0, buf.length)
  const segment = top.find((e) => e.id === EL.SEGMENT)
  if (!segment) throw new Error('不是合法的 WebM：找不到 Segment')

  const segKids = children(buf, segment.dataStart, segment.dataEnd)
  const info = segKids.find((e) => e.id === EL.INFO)
  const tracks = segKids.find((e) => e.id === EL.TRACKS)
  const clusters = segKids.filter((e) => e.id === EL.CLUSTER)
  if (!info) throw new Error('WebM 缺少 Info 段')
  if (!tracks) throw new Error('WebM 缺少 Tracks 段')
  if (clusters.length === 0) throw new Error('WebM 没有任何 Cluster（没有帧）')

  let timecodeScale = 1000000 // 默认 1ms
  let durationEl = null
  for (const el of children(buf, info.dataStart, info.dataEnd)) {
    if (el.id === EL.TIMECODE_SCALE) timecodeScale = readUint(buf, el.dataStart, el.dataEnd - el.dataStart)
    if (el.id === EL.DURATION) durationEl = el
  }

  let defaultDurationEl = null
  let videoTrack = null
  for (const track of children(buf, tracks.dataStart, tracks.dataEnd)) {
    if (track.id !== EL.TRACK_ENTRY) continue
    for (const field of children(buf, track.dataStart, track.dataEnd)) {
      if (field.id === EL.DEFAULT_DURATION) defaultDurationEl = field
      if (field.id === EL.VIDEO) videoTrack = { hasVideo: true }
    }
  }
  if (!videoTrack) throw new Error('WebM 没有视频轨')

  // ── 逐簇收集帧（SimpleBlock 与 BlockGroup>Block 都算）──
  const frames = []
  for (const cluster of clusters) {
    let clusterTimecode = 0
    const payloads = []
    for (const el of children(buf, cluster.dataStart, cluster.dataEnd)) {
      if (el.id === EL.CLUSTER_TIMECODE) clusterTimecode = readUint(buf, el.dataStart, el.dataEnd - el.dataStart)
      else if (el.id === EL.SIMPLE_BLOCK) payloads.push({ kind: 'simple', ...el })
      else if (el.id === EL.BLOCK_GROUP) {
        for (const inner of children(buf, el.dataStart, el.dataEnd)) {
          if (inner.id === EL.BLOCK) payloads.push({ kind: 'group', ...inner })
        }
      }
    }
    for (const p of payloads) {
      const trackLen = vintLength(buf[p.dataStart])
      const tsOffset = p.dataStart + trackLen
      if (tsOffset + 2 > p.dataEnd) throw new Error('Block 载荷过短，无法读取时间戳')
      const rel = buf.readInt16BE(tsOffset)
      frames.push({ tsOffset, rel, absolute: clusterTimecode + rel, clusterTimecode, kind: p.kind })
    }
  }
  frames.sort((a, b) => a.tsOffset - b.tsOffset) // 按文件出现顺序

  return { timecodeScale, durationEl, defaultDurationEl, frames, clusters }
}

/** 统计：唯一时间戳数、重复对数、最大间隔、标称帧率 */
export function summarize(frames, defaultDurationEl, buf) {
  const abs = frames.map((f) => f.absolute)
  const unique = new Set(abs)
  const sorted = [...unique].sort((a, b) => a - b)
  let maxGap = 0
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1])
  const nominalFps = defaultDurationEl
    ? Math.round(1e9 / readUint(buf, defaultDurationEl.dataStart, defaultDurationEl.dataEnd - defaultDurationEl.dataStart))
    : null
  return { count: frames.length, unique: unique.size, duplicates: frames.length - unique.size, maxGap, nominalFps }
}

/**
 * 归一：把全部帧重铺到均匀 fps 网格。返回 { buffer, report }，失败抛错。
 * @param {Buffer} input 原始 WebM
 * @param {{fps?: number}} [options]
 */
export function retimeSplashWebm(input, options = {}) {
  const fps = Number(options.fps) || 30
  if (!(fps > 0 && fps <= 240)) throw new Error(`fps 不合理：${fps}`)

  const before = summarize(parseSplashWebm(input).frames, parseSplashWebm(input).defaultDurationEl, input)
  const parsed = parseSplashWebm(input)
  const { frames, timecodeScale, durationEl, defaultDurationEl } = parsed
  if (frames.length < 2) throw new Error(`帧数过少（${frames.length}），无需/无法归一`)

  const out = Buffer.from(input) // 复制后原地改写
  const scaleMs = timecodeScale / 1e6
  const frameMs = 1000 / fps
  const gridTicks = frames.map((_, i) => Math.round((i * frameMs) / scaleMs))

  for (let i = 0; i < frames.length; i++) {
    const rel = gridTicks[i] - frames[i].clusterTimecode
    if (rel < -32768 || rel > 32767) {
      throw new Error(
        `第 ${i} 帧归一后相对时间戳 ${rel} 超出 int16 范围 —— 该文件簇结构不适合原地改时基，`
        + '请重新录制（建议恒定帧率）或改用重封装工具',
      )
    }
    out.writeInt16BE(rel, frames[i].tsOffset)
  }

  // DefaultDuration：纳秒
  if (defaultDurationEl) {
    const len = defaultDurationEl.dataEnd - defaultDurationEl.dataStart
    writeUint(out, defaultDurationEl.dataStart, len, Math.round(1e9 / fps))
  }
  // Duration：TimecodeScale 单位
  const lastTicks = gridTicks[gridTicks.length - 1]
  const durationTicks = lastTicks + frameMs / scaleMs
  if (durationEl) {
    writeFloat(out, durationEl.dataStart, durationEl.dataEnd - durationEl.dataStart, durationTicks)
  }

  const report = verifyRetimed(input, out, { fps, frameCount: frames.length })
  return { buffer: out, before, report }
}

/** 自校验：对拍源与产物，任一不满足即抛错 */
export function verifyRetimed(sourceBuf, outBuf, { fps, frameCount }) {
  if (outBuf.length !== sourceBuf.length) {
    throw new Error(`归一后文件长度变化（${sourceBuf.length} → ${outBuf.length}），索引偏移会失效，已中止`)
  }
  const parsed = parseSplashWebm(outBuf)
  const abs = parsed.frames.map((f) => f.absolute)
  if (abs.length !== frameCount) throw new Error(`归一后帧数变化（${frameCount} → ${abs.length}）`)

  const unique = new Set(abs)
  if (unique.size !== abs.length) throw new Error(`归一后仍有 ${abs.length - unique.size} 处重复时间戳`)

  const lo = Math.floor(1000 / fps)
  const hi = Math.ceil(1000 / fps)
  for (let i = 1; i < abs.length; i++) {
    if (abs[i] <= abs[i - 1]) throw new Error(`归一后时间戳非严格递增（第 ${i} 帧）`)
    const gap = abs[i] - abs[i - 1]
    if (gap < lo || gap > hi) throw new Error(`归一后第 ${i} 帧间隔 ${gap}ms 不在 {${lo},${hi}} 内`)
  }

  const defaultDuration = parsed.defaultDurationEl
    ? readUint(outBuf, parsed.defaultDurationEl.dataStart, parsed.defaultDurationEl.dataEnd - parsed.defaultDurationEl.dataStart)
    : null
  if (defaultDuration !== null && Math.abs(1e9 / defaultDuration - fps) > 0.01) {
    throw new Error(`DefaultDuration 未同步（${defaultDuration}ns ≈ ${(1e9 / defaultDuration).toFixed(2)}fps）`)
  }

  const durationTicks = parsed.durationEl
    ? readFloat(outBuf, parsed.durationEl.dataStart, parsed.durationEl.dataEnd - parsed.durationEl.dataStart)
    : null
  const durationSeconds = durationTicks === null ? null : (durationTicks * parsed.timecodeScale) / 1e9

  return {
    fps,
    frames: abs.length,
    uniqueTimestamps: unique.size,
    firstMs: abs[0] * (parsed.timecodeScale / 1e6),
    lastMs: abs[abs.length - 1] * (parsed.timecodeScale / 1e6),
    durationSeconds,
    defaultDurationNs: defaultDuration,
    bytesUnchanged: outBuf.length === sourceBuf.length,
  }
}

// ── CLI ──
const isCli = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isCli) {
  const [inPath, outPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const fpsArg = process.argv.find((a) => a.startsWith('--fps'))
  const fps = fpsArg ? Number(fpsArg.split('=')[1] ?? process.argv[process.argv.indexOf(fpsArg) + 1]) : 30
  if (!inPath || !outPath) {
    console.error('用法: node scripts/retime-splash-webm.mjs <in.webm> <out.webm> [--fps 30]')
    process.exit(2)
  }
  try {
    const { buffer, before, report } = retimeSplashWebm(readFileSync(inPath), { fps })
    writeFileSync(outPath, buffer)
    console.log(`[retime] ${inPath} → ${outPath}`)
    console.log(`  归一前: ${before.count} 帧 / 标称 ${before.nominalFps}fps / 唯一时间戳 ${before.unique}（重复 ${before.duplicates} 对）/ 最大间隔 ${before.maxGap}ms`)
    console.log(`  归一后: ${report.frames} 帧 / ${report.fps}fps / 唯一时间戳 ${report.uniqueTimestamps} / 时长 ${report.lastMs}ms（${report.durationSeconds?.toFixed(3)}s）/ 字节数不变 ${report.bytesUnchanged}`)
  } catch (error) {
    console.error(`[retime] 失败：${error.message}`)
    process.exit(1)
  }
}

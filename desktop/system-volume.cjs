'use strict'

/**
 * 系统主音量读取（Windows，0-100，左右声道均值）。
 *
 * 消费方：渲染端 App 启动时读一次、之后每 10 分钟读一次，喂给 HSE 等响度补偿
 * （loudnessCompensation.volumePercent），让补偿跟随系统音量。
 *
 * 之所以单独成模块：这里是唯一需要 spawn PowerShell 的地方，抽出来才好在
 * node --test 里用注入的 execFile 覆盖「缓存 / 并发合流 / 失败不缓存 / 非 Windows」
 * 四条行为，不必真起进程。
 */

/** 成功结果缓存 2 分钟：避开每 10 分钟一次轮询之外的抖动，也不必频繁 spawn。 */
const DEFAULT_CACHE_TTL_MS = 120_000
const SPAWN_TIMEOUT_MS = 5_000

/** 取主输出音量：waveOutGetVolume 返回左右声道各 16 位，取均值百分比。 */
const VOLUME_SCRIPT = [
  "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class VolUtil { [DllImport(\"winmm.dll\")] public static extern int waveOutGetVolume(System.IntPtr hwo, out uint dwVolume); }'",
  '$v = 0',
  '[VolUtil]::waveOutGetVolume([IntPtr]::Zero, [ref]$v) | Out-Null',
  '([math]::Round(((($v -band 0xFFFF) / 65535.0) + ((($v -shr 16) -band 0xFFFF) / 65535.0)) / 2 * 100))',
].join('; ')

/**
 * 造一个读取函数。返回值契约：
 *   { success: true, volume }            读到了（0-100）
 *   { success: false, volume: -1, error } 读不到——**错误不进缓存**，下次调用会重试
 *   { success: true, volume: -1, supported: false } 非 Windows，无此能力
 */
function createSystemVolumeReader(options = {}) {
  const {
    execFile,
    platform = process.platform,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    now = Date.now,
  } = options
  if (typeof execFile !== 'function') throw new TypeError('createSystemVolumeReader 需要注入 execFile')
  let cached = { value: -1, expiresAt: 0 }
  // 并发合流：启动时 App 只调一次，但多次轮询/多窗口同时问不应重复 spawn。
  let inflight = null

  const run = () => new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', VOLUME_SCRIPT],
      { windowsHide: true, timeout: SPAWN_TIMEOUT_MS },
      (error, stdout) => {
        const parsed = parseInt(String(stdout || '').trim(), 10)
        if (error || !Number.isFinite(parsed)) {
          resolve({ success: false, volume: -1, error: (error && error.message) || '音量解析失败' })
          return
        }
        const volume = Math.max(0, Math.min(100, parsed))
        cached = { value: volume, expiresAt: now() + cacheTtlMs }
        resolve({ success: true, volume })
      },
    )
  })

  return function readSystemVolume() {
    if (platform !== 'win32') return Promise.resolve({ success: true, volume: -1, supported: false })
    if (cached.value >= 0 && now() < cached.expiresAt) {
      return Promise.resolve({ success: true, volume: cached.value })
    }
    if (!inflight) {
      inflight = run().finally(() => { inflight = null })
    }
    return inflight
  }
}

module.exports = { createSystemVolumeReader, VOLUME_SCRIPT }

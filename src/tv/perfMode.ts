/**
 * 性能模式（配置检查面板配套）。
 *
 * WaveForge 减配版：TV 形态已剥离，性能模式不再依赖 TV 检测 / 设备内存自动分档，
 * 固定以普通档（normal）为默认。缓存上限统一取桌面档（见 getCacheLimits）。
 * 生效机制：html 上打 wf-perf-* 类 + JS 侧（组件读 usePerfMode）。
 */
import { useSyncExternalStore } from 'react'

export type PerfMode = 'efficiency' | 'normal' | 'enhanced'

const KEY = 'waveforge:perf-mode'
const listeners = new Set<() => void>()
let mode: PerfMode = readStored()

/** 默认档：固定普通档（不再做 TV / 内存检测）。 */
function readStored(): PerfMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'efficiency' || v === 'normal' || v === 'enhanced') return v
  } catch {
    // ignore
  }
  return 'normal'
}

export function getPerfMode(): PerfMode {
  return mode
}

export function isPerfModeEfficiency(): boolean {
  return mode === 'efficiency'
}

export function isPerfModeEnhanced(): boolean {
  return mode === 'enhanced'
}

function emit(): void {
  listeners.forEach((fn) => fn())
}

export function setPerfMode(m: PerfMode): void {
  if (mode === m) return
  mode = m
  try {
    localStorage.setItem(KEY, m)
  } catch {
    // ignore
  }
  applyPerfModeClasses()
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** React Hook：当前性能模式。 */
export function usePerfMode(): PerfMode {
  return useSyncExternalStore(subscribe, getPerfMode)
}

/** 在 html 上打模式类，供 tv.css 分档控制动画/桌面模式可见性。 */
export function applyPerfModeClasses(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.classList.remove('wf-perf-efficiency', 'wf-perf-normal', 'wf-perf-enhanced')
  root.classList.add('wf-perf-' + mode)
}

/** 启动时调用（main.tsx）：应用模式类。 */
export function initPerfMode(): void {
  applyPerfModeClasses()
}

/**
 * 缓存上限（减配版固定取桌面档，不再随 TV / 性能档收紧）。
 *  - coverCount/coverBytes/singleImage：cacheManager（localStorage 封面）
 *  - idbCoverBytes/playlistCount/playlistBytes/lyricCount/lyricBytes：indexedDBCache
 */
export interface CacheLimits {
  coverCount: number
  coverBytes: number
  singleImage: number
  idbCoverBytes: number
  playlistCount: number
  playlistBytes: number
  lyricCount: number
  lyricBytes: number
}

export function getCacheLimits(): CacheLimits {
  const MB = 1024 * 1024
  return {
    coverCount: 500, coverBytes: 2 * 1024 * MB, singleImage: 10 * MB,
    idbCoverBytes: 256 * MB, playlistCount: 100, playlistBytes: 50 * MB,
    lyricCount: 1000, lyricBytes: 128 * MB,
  }
}

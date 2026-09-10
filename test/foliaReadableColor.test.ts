/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('../src/services/indexedDBCache', () => ({
  indexedDBCache: {
    getCoverBlob: vi.fn(async () => null),
    cacheCover: vi.fn(async () => undefined),
  },
}))

import { useColorThief } from '../src/hooks/useColorThief'
import {
  parseHexColor,
  relativeLuminance,
  contrastRatio,
  mixHex,
  resolveReadableForegroundColor,
  resolveReadableThemeColor,
  rgbToHex,
} from '../src/services/foliaReadableColor'

const pendingImages = new Map<string, Array<{ onload: (() => void) | null }>>()

class ControlledImage {
  crossOrigin = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private source = ''

  set src(value: string) {
    this.source = value
    if (value) {
      const queue = pendingImages.get(value) ?? []
      queue.push(this)
      pendingImages.set(value, queue)
    }
  }

  get src(): string {
    return this.source
  }
}

function finishImage(url: string): void {
  const image = pendingImages.get(url)?.shift()
  if (!image?.onload) throw new Error(`没有等待加载的图片: ${url}`)
  image.onload()
}

beforeEach(() => {
  pendingImages.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: false,
    blob: vi.fn(),
    url,
  })))
  vi.stubGlobal('Image', ControlledImage)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([200, 100, 50, 255]) })),
  } as unknown as CanvasRenderingContext2D)
})

describe('useColorThief', () => {
  it('切换 URL 时立即清空旧颜色，并忽略旧请求的迟到结果', async () => {
    const proxyA = `http://localhost:3001/api/proxy-image?url=${encodeURIComponent('cover-a')}`
    const proxyB = `http://localhost:3001/api/proxy-image?url=${encodeURIComponent('cover-b')}`
    const { result, rerender } = renderHook(({ url }) => useColorThief(url), {
      initialProps: { url: 'cover-a' },
    })

    await act(async () => { await Promise.resolve() })
    await act(async () => { finishImage('cover-a') })
    expect(result.current.dominantColor).toBe('rgb(100, 50, 25)')

    rerender({ url: 'cover-b' })
    expect(result.current.status).toBe('loading')
    expect(result.current.dominantColor).toBeNull()
    expect(result.current.palette).toEqual([])
    await act(async () => { await Promise.resolve() })

    rerender({ url: 'cover-c' })
    await act(async () => { await Promise.resolve() })
    await act(async () => { finishImage('cover-b') })
    expect(result.current.status).toBe('loading')
    expect(result.current.dominantColor).toBeNull()
    expect(result.current.palette).toEqual([])
  })
})

describe('desktop player lyric fill', () => {
  it('逐字填充、罗马音填充和完成态都使用主题色变量', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/desktop-player/style.css'), 'utf8')
    expect(css).toMatch(/\.dp-lyric-word[\s\S]*?linear-gradient\(90deg, var\(--dp-accent\) 0 var\(--word-fill\)/)
    expect(css).toMatch(/\.dp-lyric-word\.complete \{ color: var\(--dp-accent\)/)
    expect(css).toMatch(/\.dp-lyric-word\.roman \{ background: linear-gradient\(90deg, var\(--dp-accent\) 0 var\(--word-fill\)/)
  })
})

describe('parseHexColor', () => {
  it('解析 #rgb / #rrggbb / rgb()', () => {
    expect(parseHexColor('#a3f')).toEqual({ r: 0xaa, g: 0x33, b: 0xff })
    expect(parseHexColor('#123456')).toEqual({ r: 0x12, g: 0x34, b: 0x56 })
    expect(parseHexColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 })
  })
  it('无效输入返回 null', () => {
    expect(parseHexColor('not-a-color')).toBeNull()
    expect(parseHexColor('#12')).toBeNull()
    expect(parseHexColor('')).toBeNull()
  })
})

describe('relativeLuminance', () => {
  it('黑白端点', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5)
  })
  it('暗色亮度低、亮色亮度高', () => {
    expect(relativeLuminance({ r: 20, g: 10, b: 40 })).toBeLessThan(0.05)
    expect(relativeLuminance({ r: 200, g: 180, b: 160 })).toBeGreaterThan(0.4)
  })
})

describe('mixHex', () => {
  it('向白混合提亮', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
  })
})

describe('cover extraction wiring', () => {
  it('does not cache failed cover extraction as a successful color result', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/hooks/useColorThief.ts'), 'utf8')
    expect(source).toContain("setResult({ imageUrl, status: 'error', dominantColor: null, palette: [] })")
    expect(source).toContain('throw error')
    expect(source).toContain('finally')
  })
})

describe('resolveReadableForegroundColor', () => {
  it('按实际深色背景提亮前景色至最小对比度', () => {
    const result = resolveReadableForegroundColor('#3b2a60', '#171923', 4.5)
    expect(contrastRatio(result, '#171923')).toBeGreaterThanOrEqual(4.5)
    expect(result).not.toBe('#3b2a60')
  })

  it('按实际浅色背景压暗前景色至最小对比度', () => {
    const result = resolveReadableForegroundColor('#b2c9ff', '#f5f6fa', 7)
    expect(contrastRatio(result, '#f5f6fa')).toBeGreaterThanOrEqual(7)
  })

  it('已满足阈值时保留原色', () => {
    expect(resolveReadableForegroundColor('#ffffff', '#171923', 4.5)).toBe('#ffffff')
  })

  it('无效输入保持原前景色，阈值限制在 WCAG 有效范围', () => {
    expect(resolveReadableForegroundColor('currentColor', '#171923')).toBe('currentColor')
    expect(resolveReadableForegroundColor('#777777', 'transparent')).toBe('#777777')
    expect(contrastRatio('#ffffff', '#000000')).toBe(21)
    expect(resolveReadableForegroundColor('#777777', '#777777', 99)).toBe('#000000')
  })
})
describe('resolveReadableThemeColor', () => {
  it('深色主题：过暗的主题色被提亮到目标亮度', () => {
    const dark = '#1a1030' // 极暗紫
    const result = resolveReadableThemeColor(dark, true)
    const lum = relativeLuminance(parseHexColor(result)!)
    expect(lum).toBeGreaterThanOrEqual(0.4)
    expect(lum).toBeCloseTo(0.42, 1)
  })
  it('深色主题：已经够亮的主题色保持不变', () => {
    const bright = '#8fd3ff' // 亮蓝
    expect(resolveReadableThemeColor(bright, true)).toBe(bright)
  })
  it('浅色主题：过亮的主题色被压暗', () => {
    const light = '#f0f8ff' // 几乎白
    const result = resolveReadableThemeColor(light, false)
    const lum = relativeLuminance(parseHexColor(result)!)
    expect(lum).toBeLessThanOrEqual(0.4)
  })
  it('浅色主题：已经够暗的主题色保持不变', () => {
    const dark = '#3355aa'
    expect(resolveReadableThemeColor(dark, false)).toBe(dark)
  })
  it('无效输入原样返回', () => {
    expect(resolveReadableThemeColor('transparent', true)).toBe('transparent')
    expect(resolveReadableThemeColor('', false)).toBe('')
  })
  it('rgbToHex 往返一致', () => {
    expect(rgbToHex({ r: 0xab, g: 0xcd, b: 0xef })).toBe('#abcdef')
  })
})

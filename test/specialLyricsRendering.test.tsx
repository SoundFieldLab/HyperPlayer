/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toPvLyrics } from '../src/components/pvLyrics/pvBridge'
import LyricsDisplay from '../src/components/LyricsDisplay'
import type { LyricLine } from '../src/services/musicApi'

/**
 * 特殊歌词渲染的通用契约（减配后）：
 * - PV 适配器保留 agent / 和声 / 备用文本等特殊字段；
 * - LyricsDisplay 仅在和声时间窗内展示括号和声。
 * Folia / Diorama / 摩登页面相关断言已随对应模块删除。
 */

const specialLyrics: LyricLine[] = [{
  time: 10,
  endTime: 14,
  text: 'Main vocal',
  words: [{ word: 'Main', startTime: 0, duration: 500 }],
  translation: '主唱翻译',
  roman: 'main roman',
  agentId: 'v1',
  alternateTexts: [
    { role: 'translation', language: 'zh', text: '备用翻译' },
    { role: 'romanization', text: 'alternate roman' },
  ],
  backgroundVocals: [{
    time: 10.5,
    endTime: 12,
    text: 'Harmony',
    words: [{ word: 'Harmony', startTime: 0, duration: 700 }],
    translation: '和声翻译',
    romanization: 'harmony roman',
    agentId: 'v2',
    alternateTexts: [{ role: 'translation', text: '和声备用翻译' }],
  }],
}]

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('appleMusicSettings', JSON.stringify({ duetColors: true }))
  vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('special lyric rendering', () => {
  it('preserves special lyric fields in the PV adapter', () => {
    const [pv] = toPvLyrics(specialLyrics)
    expect(pv).toMatchObject({
      agentId: 'v1',
      backgroundVocals: [{ text: 'Harmony', agentId: 'v2' }],
    })
    expect(pv.alternateTexts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'translation', text: '备用翻译' }),
      expect.objectContaining({ role: 'romanization', text: 'alternate roman' }),
    ]))
  })

  it('shows parenthesized background vocals only inside their time window', async () => {
    const view = render(
      <LyricsDisplay
        currentTime={11}
        isPlaying={false}
        accentColor="#ffffff"
        lyrics={specialLyrics}
        displayMode="single"
      />,
    )

    expect(await screen.findByText('（Harmony）')).toBeTruthy()

    view.rerender(
      <LyricsDisplay
        currentTime={12.5}
        isPlaying={false}
        accentColor="#ffffff"
        lyrics={specialLyrics}
        displayMode="single"
      />,
    )
    await waitFor(() => expect(screen.queryByText('（Harmony）')).toBeNull())
  })
})

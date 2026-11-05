import { describe, expect, it } from 'vitest'
import {
  detectLyricsCapabilities,
  isMetadataOnlyLyrics,
  mergeLyricsWithTranslationAndRoman,
  platformLyricsSourceName,
  selectLyrics,
  type LyricsCandidate,
} from '../src/services/lyricsSelection'
import type { LyricLine } from '../src/services/musicApi'

const line = (time: number, text: string, extra: Partial<LyricLine> = {}): LyricLine => ({
  time,
  text,
  ...extra,
})

const words = (time: number) => [
  { word: 'a', startTime: 0, duration: 200 },
  { word: 'b', startTime: 200, duration: 200 },
]

const candidate = (source: string, lyrics: LyricLine[]): LyricsCandidate => ({ source, lyrics })

const timeline = (count: number, start = 0, step = 1): LyricLine[] =>
  Array.from({ length: count }, (_, index) => line(start + index * step, `line ${index + 1}`))

describe('platformLyricsSourceName', () => {
  it('把平台映射为稳定的来源名', () => {
    expect(platformLyricsSourceName('qq')).toBe('QQ音乐')
    expect(platformLyricsSourceName('netease')).toBe('网易云')
  })
})

describe('detectLyricsCapabilities / isMetadataOnlyLyrics', () => {
  it('识别逐字、翻译、罗马音', () => {
    expect(detectLyricsCapabilities([
      line(1, 'a', { words: words(1), translation: '译', roman: 'ro' }),
    ])).toEqual({ hasWordByWord: true, hasTranslation: true, hasRoman: true })

    expect(detectLyricsCapabilities([
      line(1, 'a', { romanWords: [{ word: 'a', startTime: 0, duration: 100 }] }),
    ])).toEqual({ hasWordByWord: false, hasTranslation: false, hasRoman: true })
  })

  it('只有元数据的歌词视为空壳', () => {
    expect(isMetadataOnlyLyrics([line(1, '作词: 某人'), line(2, '作曲: 另一人')])).toBe(true)
    expect(isMetadataOnlyLyrics([line(1, '作词: 某人'), line(2, '第一句正文')])).toBe(false)
    expect(isMetadataOnlyLyrics([])).toBe(false)
  })
})

describe('selectLyrics', () => {
  it('QQ 平台强制以 QQ 官方为骨架，第三方只补空缺', () => {
    const qq = candidate('QQ音乐', timeline(6, 0, 1))
    const amll = candidate('AMLL TTML DB', timeline(6, 0, 1).map((item, index) => ({
      ...item,
      words: words(item.time),
      translation: `译 ${index + 1}`,
      roman: `ro ${index + 1}`,
    })))

    // 故意把第三方放前面：QQ 平台必须靠强制规则胜出，而不是靠数组顺序
    const result = selectLyrics([amll, qq], {
      platform: 'qq',
      primarySource: 'AMLL',
      duration: 60_000,
    })

    expect(result.skeletonSource).toBe('QQ音乐')
    expect(result.lyrics[0].words).toBeUndefined()
    expect(result.lyrics[0].translation).toBe('译 1')
    expect(result.hasWordByWord).toBe(false)
    expect(result.hasTranslation).toBe(true)
    expect(result.hasRoman).toBe(true)
    expect(result.finalSources).toEqual({ roman: 'AMLL TTML DB', translation: 'AMLL TTML DB' })
  })

  it('网易云按评分选择逐字更完整的第三方骨架', () => {
    const platform = candidate('网易云', timeline(6, 0, 1))
    const amll = candidate('AMLL TTML DB', timeline(6, 0, 1).map(item => ({
      ...item,
      words: words(item.time),
    })))

    const result = selectLyrics([platform, amll], {
      platform: 'netease',
      primarySource: 'AMLL',
      duration: 60_000,
    })

    expect(result.skeletonSource).toBe('AMLL TTML DB')
    expect(result.hasWordByWord).toBe(true)
  })

  it('逐字权重能压过主源偏好', () => {
    const platform = candidate('网易云', timeline(6).map(item => ({
      ...item,
      words: words(item.time),
    })))
    const amll = candidate('AMLL TTML DB', timeline(6))

    const result = selectLyrics([amll, platform], {
      platform: 'netease',
      primarySource: 'AMLL',
      duration: 60_000,
    })

    expect(result.skeletonSource).toBe('网易云')
  })

  it('时长明显不一致的候选被降权', () => {
    const platform = candidate('网易云', [line(59, '结尾')])
    const short = candidate('AMLL TTML DB', [line(20, '结尾')])

    const result = selectLyrics([platform, short], {
      platform: 'netease',
      primarySource: 'AMLL',
      duration: 60_000,
    })

    expect(result.skeletonSource).toBe('网易云')
  })

  it('时间轴明显不同步的第三方源被排除', () => {
    const platform = candidate('网易云', timeline(10, 0, 1))
    const shifted = candidate('AMLL TTML DB', timeline(10, 5, 1).map(item => ({
      ...item,
      words: words(item.time),
    })))

    const result = selectLyrics([platform, shifted], {
      platform: 'netease',
      primarySource: 'AMLL',
      duration: 30_000,
    })

    expect(result.skeletonSource).toBe('网易云')
  })

  it('同步良好 +30 能胜过平台的功能加分，轻微偏差 +10 则不能', () => {
    const platformLines = timeline(24, 0, 1).map(item => ({
      ...item,
      translation: `译 ${item.time}`,
      roman: `ro ${item.time}`,
    }))
    const platform = candidate('网易云', platformLines)

    const aligned = candidate('AMLL TTML DB', timeline(20, 0.5, 1))
    const shifted = candidate('AMLL TTML DB', timeline(20, 2, 1))

    const alignedResult = selectLyrics([platform, aligned], {
      platform: 'netease',
      primarySource: 'AMLL',
      duration: 30_000,
    })
    const shiftedResult = selectLyrics([platform, shifted], {
      platform: 'netease',
      primarySource: 'AMLL',
      duration: 30_000,
    })

    expect(alignedResult.skeletonSource).toBe('AMLL TTML DB')
    expect(shiftedResult.skeletonSource).toBe('网易云')
  })

  it('元数据空壳候选不参与骨架选择', () => {
    const shell = candidate('AMLL TTML DB', [line(1, '作词: 某人'), line(2, '作曲: 另一人')])
    const platform = candidate('网易云', timeline(2))

    const result = selectLyrics([shell, platform], {
      platform: 'netease',
      primarySource: 'AMLL',
      duration: 60_000,
    })

    expect(result.skeletonSource).toBe('网易云')
  })

  it('骨架已有翻译时不被第三方覆盖', () => {
    const qq = candidate('QQ音乐', [
      line(1, '第一句', { translation: '官方翻译', roman: 'official-ro' }),
    ])
    const amll = candidate('AMLL TTML DB', [
      line(1, '第一句', { translation: '第三方翻译', roman: 'third-ro' }),
    ])

    const result = selectLyrics([qq, amll], {
      platform: 'qq',
      primarySource: 'AMLL',
      duration: 60_000,
    })

    expect(result.lyrics[0].translation).toBe('官方翻译')
    expect(result.lyrics[0].roman).toBe('official-ro')
    expect(result.finalSources.translation).toBe('QQ音乐')
    expect(result.finalSources.roman).toBe('QQ音乐')
  })

  it('第三方翻译全部超出时间阈值时不记来源', () => {
    const qq = candidate('QQ音乐', [line(1, '第一句')])
    const farAway = candidate('AMLL TTML DB', [line(30, '第一句', { translation: '太远' })])

    const result = selectLyrics([qq, farAway], {
      platform: 'qq',
      primarySource: 'AMLL',
      duration: 60_000,
    })

    expect(result.hasTranslation).toBe(false)
    expect(result.finalSources.translation).toBeUndefined()
  })

  it('没有有效候选时返回空结果', () => {
    const result = selectLyrics([], {
      platform: 'netease',
      primarySource: 'AMLL',
      duration: 60_000,
    })

    expect(result).toEqual({
      lyrics: [],
      skeletonSource: null,
      hasWordByWord: false,
      hasTranslation: false,
      hasRoman: false,
      finalSources: {},
    })
  })

  it('QQ 平台没有官方候选时仍可从第三方选骨架', () => {
    const amll = candidate('AMLL TTML DB', timeline(3).map(item => ({
      ...item,
      words: words(item.time),
    })))

    const result = selectLyrics([amll], {
      platform: 'qq',
      primarySource: 'AMLL',
      duration: 60_000,
    })

    expect(result.skeletonSource).toBe('AMLL TTML DB')
  })

  it('不修改传入的候选与歌词', () => {
    const source = timeline(2)
    const snapshot = JSON.parse(JSON.stringify(source))

    selectLyrics([candidate('网易云', source)], {
      platform: 'netease',
      primarySource: 'Platform',
      duration: 60_000,
    })

    expect(source).toEqual(snapshot)
  })
})

describe('mergeLyricsWithTranslationAndRoman', () => {
  it('按最近时间匹配，且同一条不得复用', () => {
    const lyrics = [line(1, 'a'), line(10, 'b')]
    const translations = [line(1.2, '译 a'), line(10.4, '译 b')]

    const merged = mergeLyricsWithTranslationAndRoman(lyrics, translations)

    expect(merged[0].translation).toBe('译 a')
    expect(merged[1].translation).toBe('译 b')
  })

  it('同一条翻译不会复用到下一句', () => {
    const lyrics = [line(1, 'a'), line(1.3, 'b')]
    const translations = [line(1.1, '唯一译')]

    const merged = mergeLyricsWithTranslationAndRoman(lyrics, translations)

    expect(merged[0].translation).toBe('唯一译')
    expect(merged[1].translation).toBe('')
  })

  it('开头放宽翻译与罗马音的匹配阈值', () => {
    const lyrics = [line(1, 'a'), line(9, 'b')]
    const translations = [line(2.9, '开头痛'), line(9.8, '后段译')]
    const romans = [line(3.8, '开头罗马'), line(11.5, '后段罗马')]

    const merged = mergeLyricsWithTranslationAndRoman(lyrics, translations, romans)

    expect(merged[0].translation).toBe('开头痛')
    expect(merged[0].roman).toBe('开头罗马')
    expect(merged[1].translation).toBe('后段译')
    expect(merged[1].roman).toBe('')
  })

  it('元数据与标题行不匹配翻译', () => {
    const lyrics = [
      line(0.5, '歌名 - 歌手'),
      line(1, '作词: 某人'),
      line(1.5, '制作人: 某人'),
      line(2, '正文'),
    ]
    const translations = [line(1, '误配'), line(1.5, '误配2'), line(2.2, '正文译')]

    const merged = mergeLyricsWithTranslationAndRoman(lyrics, translations)

    expect(merged[0].translation).toBeUndefined()
    expect(merged[1].translation).toBeUndefined()
    expect(merged[2].translation).toBeUndefined()
    expect(merged[3].translation).toBe('正文译')
  })

  it('只补空缺，不擦掉已有内容', () => {
    const lyrics = [line(1, 'a', { translation: '已有', roman: '已有罗马' })]
    const merged = mergeLyricsWithTranslationAndRoman(
      lyrics,
      [line(1, '新译')],
      [line(1, '新罗马')],
    )

    expect(merged[0].translation).toBe('已有')
    expect(merged[0].roman).toBe('已有罗马')
  })
})

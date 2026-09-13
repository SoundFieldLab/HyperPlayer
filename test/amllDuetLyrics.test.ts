// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseAMLLTTMLLyrics } from '../src/services/musicApi'
import { DUET_AGENT_COLORS, getAgentTintColor } from '../src/services/appleLyricsStyle'
import { parseTTML } from '../src/utils/ttmlParser'

/**
 * 网易云 / QQ 的逐字歌词走 AMLL TTML DB（musicApi.getAMLLTTMLLyrics → parseAMLLTTMLLyrics）。
 * Apple 音源移除后，对唱着色只能在 AMLL 路径上生效——本用例锁定这条链路的
 * agent 数据不会被解析时丢弃，否则渲染端永远拿不到第二个演唱者的配色。
 *
 * 最小 TTML：head 声明两个 ttm:agent，两个 <p> 各带 ttm:agent，
 * 第一行内再嵌一个 ttm:role="x-bg" 的背景和声 span（由 v2 演唱）。
 */
const AMLL_TTML_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="zh-Hans">
  <head>
    <metadata>
      <ttm:agent xml:id="v1" type="person"/>
      <ttm:agent xml:id="v2" type="person"/>
    </metadata>
  </head>
  <body>
    <div>
      <p begin="00:10.000" end="00:14.000" ttm:agent="v1"><span begin="00:10.000" end="00:11.500">第一句</span><span begin="00:11.500" end="00:13.000">主唱</span><span begin="00:13.000" end="00:14.000" ttm:role="x-bg" ttm:agent="v2">和声</span></p>
      <p begin="00:14.000" end="00:18.000" ttm:agent="v2"><span begin="00:14.000" end="00:16.000">第二句</span><span begin="00:16.000" end="00:18.000">副唱</span></p>
    </div>
  </body>
</tt>`

describe('AMLL 逐字歌词的对唱数据', () => {
  it('保留行与背景和声的 agent，供对唱着色使用', () => {
    const lyrics = parseAMLLTTMLLyrics(AMLL_TTML_FIXTURE)

    expect(lyrics).toHaveLength(2)
    const [firstLine, secondLine] = lyrics

    // 两个演唱者：行 ttm:agent 与 agentId 同时保留
    expect(firstLine.agent).toBe('v1')
    expect(firstLine.agentId).toBe('v1')
    expect(secondLine.agent).toBe('v2')
    expect(secondLine.agentId).toBe('v2')
    expect(firstLine.text).toBe('第一句主唱')
    // 背景和声承接主行的 agent（v2），且不被并入主行文本
    expect(firstLine.backgroundVocals).toHaveLength(1)
    expect(firstLine.backgroundVocals?.[0].agent).toBe('v2')
    expect(firstLine.backgroundVocals?.[0].agentId).toBe('v2')
    expect(firstLine.backgroundVocals?.[0].text).toBe('和声')
    expect(firstLine.backgroundVocals?.[0].agent).not.toBe(firstLine.agent)
    expect(secondLine.backgroundVocals).toBeUndefined()

    // 行时间保持 AMLL 的歌曲绝对秒；逐字时间为行内相对毫秒
    expect(firstLine.time).toBe(10)
    expect(secondLine.time).toBe(14)
    expect(firstLine.words?.map(word => word.word)).toEqual(['第一句', '主唱'])
    expect(firstLine.words?.[0].startTime).toBe(0)
  })

  it('第二个演唱者能取到调色板颜色（对唱着色在 AMLL 路径可达）', () => {
    // agent 声明顺序即渲染端传入的 agentOrder
    const agents = parseTTML(AMLL_TTML_FIXTURE).agents ?? []
    expect(agents.map(agent => agent.id)).toEqual(['v1', 'v2'])
    const [a1, a2] = agents.map(agent => agent.id)

    const lyrics = parseAMLLTTMLLyrics(AMLL_TTML_FIXTURE)
    const secondAgent = lyrics[1].agentId

    // 主唱（第一个 agent）不着色，副唱取调色板第二色
    expect(getAgentTintColor(a1, 2, true, undefined, [a1, a2])).toBeUndefined()
    expect(getAgentTintColor(secondAgent, 2, true, undefined, [a1, a2])).toBe(DUET_AGENT_COLORS[1])
    expect(DUET_AGENT_COLORS[1]).not.toBe(DUET_AGENT_COLORS[0])
    // 仅一个演唱者时不着色
    expect(getAgentTintColor(secondAgent, 1, true, undefined, [a1, a2])).toBeUndefined()
  })
})

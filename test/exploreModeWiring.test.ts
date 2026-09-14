import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = (name: string) => readFileSync(new URL(`../src/components/${name}`, import.meta.url), 'utf8')

describe('Explore mode wiring regressions', () => {
  it('routes Explore only to the surviving netease/QQ platforms', () => {
    const source = component('ExploreView.tsx')
    // Apple 探索面板与其载荷管线已随音源移除，不得再被引用
    expect(source).not.toContain('AppleExplorePanel')
    expect(source).not.toContain('appleExplore')
    expect(source).toContain("const loggedIn = platform === 'qq' ? qqLoggedIn : neteaseLoggedIn")
    expect(source).toContain("platform === 'qq' ? (")
  })

  it('adds a shared return-to-top control to the Explore home scroll container', () => {
    const source = component('ExploreView.tsx')
    expect(source).toContain("import ScrollToTop from './ScrollToTop'")
    expect(source).toContain('const exploreScrollRef = useRef<HTMLDivElement>(null)')
    expect(source).toContain('ref={exploreScrollRef}')
    expect(source).toContain('containerRef={exploreScrollRef}')
    expect(source).toContain('threshold={200}')
    expect(source).toContain('offsetBottom={currentSong ? 168 : 24}')
    expect(source).toContain('{!moreSection && !detailOpen && !settingsOpen && (')
  })

  it('uses the normalized playlist search response and exposes local retry', () => {
    const source = component('SearchPanel.tsx')
    expect(source).toContain('setPlaylistResults(data.playlists)')
    expect(source).not.toContain('data?.result?.playlists')
    expect(source).toContain("setSearchError(error instanceof Error ? error.message : '搜索失败，请稍后重试')")
  })
})

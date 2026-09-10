import { useMemo, useState } from 'react'
import { ChevronRight, Loader2, Play, Radio, RefreshCw, Sparkles } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import {
  fetchQQNativeFeedPage,
  type ExplorePlaylist,
  type QQNativeExploreFeed,
  type QQNativeExploreModule,
} from '../../services/exploreApi'

interface QQNativeExploreContentProps {
  feed: QQNativeExploreFeed
  accent: string
  showDescription: boolean
  onPlaySongs: (song: Song, songs: Song[], continuous?: boolean) => void
  onOpenPlaylist: (playlist: ExplorePlaylist, autoplay?: boolean) => void
  onRefresh: () => void
}

function cardKey(module: QQNativeExploreModule, cardId: string, index: number) {
  return `${module.id}-${cardId || index}-${index}`
}

export default function QQNativeExploreContent({
  feed,
  accent,
  showDescription,
  onPlaySongs,
  onOpenPlaylist,
  onRefresh,
}: QQNativeExploreContentProps) {
  const [extraModules, setExtraModules] = useState<QQNativeExploreModule[]>([])
  const [cursor, setCursor] = useState(feed.cursor)
  const [hasMore, setHasMore] = useState(feed.hasMore)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const modules = useMemo(() => {
    const seen = new Set<string>()
    return [...feed.modules, ...extraModules].filter(module => {
      const key = `${module.id}:${module.cards.map(card => card.id).join(',')}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [feed.modules, extraModules])

  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    setLoadError('')
    try {
      const result = await fetchQQNativeFeedPage(cursor, {
        shelfIds: modules.map(module => module.id),
        feedKeys: modules.flatMap(module => module.cards.map(card => card.id)).filter(Boolean),
      })
      setExtraModules(previous => [...previous, ...result.modules])
      setCursor(result.cursor)
      setHasMore(result.hasMore && result.modules.length > 0)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '加载更多失败')
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section aria-label="QQ 音乐账号推荐">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="h-5 w-5" style={{ color: accent }} />
            QQ 音乐账号推荐
          </div>
          {showDescription && (
            <p className="mt-1 text-sm text-white/40">与手机客户端推荐页使用同一账号推荐流</p>
          )}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="flex h-9 items-center gap-2 rounded-full border border-white/[0.09] bg-white/[0.045] px-3 text-xs text-white/58 transition hover:bg-white/[0.09] hover:text-white"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新推荐
        </button>
      </div>

      <div className="space-y-8">
        {modules.map(module => (
          <div key={`${module.id}-${module.cards[0]?.id || ''}`}>
            {module.title && <h3 className="mb-3 text-base font-semibold text-white/88">{module.title}</h3>}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {module.cards.map((card, index) => {
                const isDaily30 = card.subtype === 510 || /每日\s*30\s*首/.test(card.title)
                const dailySongs = isDaily30 ? feed.daily30?.songs || [] : []
                const songs = dailySongs.length > 0 ? dailySongs : card.songs
                const playlist = isDaily30 && feed.daily30
                  ? {
                      id: feed.daily30.playlistId,
                      name: '每日30首',
                      coverUrl: feed.daily30.coverUrl || card.coverUrl || '',
                      trackCount: feed.daily30.songs.length,
                      platform: 'qq' as const,
                      source: 'qq-native-daily30',
                    }
                  : card.playlist
                const actionable = songs.length > 0 || Boolean(playlist)
                return (
                  <button
                    key={cardKey(module, card.id, index)}
                    type="button"
                    disabled={!actionable}
                    onClick={() => {
                      if (songs[0]) onPlaySongs(songs[0], songs, false)
                      else if (playlist) onOpenPlaylist(playlist)
                    }}
                    className="group flex min-h-24 min-w-0 items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.035] p-3 text-left transition hover:bg-white/[0.075] disabled:cursor-default disabled:opacity-65"
                  >
                    <span className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-white/[0.06]">
                      {card.coverUrl || playlist?.coverUrl ? (
                        <img src={card.coverUrl || playlist?.coverUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center"><Radio className="h-5 w-5 text-white/28" /></span>
                      )}
                      {actionable && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition group-hover:opacity-100">
                          <Play className="h-4 w-4 fill-current text-white" />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block line-clamp-2 text-sm font-medium text-white/86">{card.title || card.reason || '专属推荐'}</span>
                      {(card.reason || card.subtitle || (isDaily30 ? '今天更新' : '')) && (
                        <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-white/40">
                          {card.reason || card.subtitle || '今天更新'}
                        </span>
                      )}
                    </span>
                    {actionable && <ChevronRight className="h-4 w-4 shrink-0 text-white/25 transition group-hover:translate-x-0.5 group-hover:text-white/60" />}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-col items-center gap-2">
        {loadError && <p className="text-xs text-rose-200/75">{loadError}</p>}
        {hasMore && (
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className="flex h-10 items-center gap-2 rounded-full border border-white/[0.09] bg-white/[0.04] px-5 text-sm text-white/58 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4 rotate-90" />}
            加载更多专属推荐
          </button>
        )}
      </div>
    </section>
  )
}

import { memo, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Song } from '../services/musicApi'

interface SearchSongListProps {
  songs: Song[]
  scrollContainerRef: RefObject<HTMLDivElement | null>
  children: (song: Song, index: number) => ReactNode
}

const SongContent = memo(function SongContent({ song, index, children }: {
  song: Song
  index: number
  children: SearchSongListProps['children']
}) {
  return children(song, index)
})

/** 保留原歌曲行与交互，只挂载视口附近的行；融合搜索的实体区仍留在列表上方。 */
export default function SearchSongList({ songs, scrollContainerRef, children }: SearchSongListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: songs.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 88,
    gap: 8,
    overscan: 2,
    useFlushSync: false,
    scrollMargin,
    getItemKey: index => `${songs[index].platform}-${songs[index].mid || songs[index].id}-${index}`,
    // offsetHeight 不受弹窗入场 scale 与歌曲 hover scale 影响。
    measureElement: element => element.offsetHeight,
  })

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const updateOffset = () => setScrollMargin(list.offsetTop)
    updateOffset()
    const observer = new ResizeObserver(updateOffset)
    // 实体区位于歌曲容器的外侧；逐层观察到滚动区，覆盖其折行、图片就绪与窗口变化。
    let ancestor = list.parentElement
    while (ancestor) {
      observer.observe(ancestor)
      if (ancestor === scrollContainerRef.current) break
      ancestor = ancestor.parentElement
    }
    return () => observer.disconnect()
  }, [songs, scrollContainerRef])

  return (
    <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(row => (
        <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          className="absolute left-0 top-0 w-full"
          style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
        >
          <SongContent song={songs[row.index]} index={row.index}>
            {children}
          </SongContent>
        </div>
      ))}
    </div>
  )
}

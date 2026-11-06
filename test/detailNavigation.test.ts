import { describe, expect, it } from 'vitest'
import {
  DetailNavigationLedger,
  MAX_DETAIL_STACK_DEPTH,
  type DetailNavigationEntry,
} from '../src/services/detailNavigation'
import type { Song } from '../src/services/musicApi'

const song = (id: number): Song => ({
  id,
  name: `song ${id}`,
  artists: [{ id: 1, name: 'artist' }],
  album: { id: 2, name: 'album' },
  duration: 180000,
  platform: 'netease',
} as Song)

const artist = (id: string): DetailNavigationEntry => ({
  type: 'artist',
  id,
  platform: 'netease',
})

const album = (id: string): DetailNavigationEntry => ({
  type: 'album',
  id,
  platform: 'netease',
})

describe('压栈', () => {
  it('栈顶重复条目不入栈', () => {
    const ledger = new DetailNavigationLedger()
    ledger.push(artist('1'))
    ledger.push(artist('1'))

    expect(ledger.size).toBe(1)
  })

  it('相同 id 但不同平台视为不同条目', () => {
    const ledger = new DetailNavigationLedger()
    ledger.push({ type: 'artist', id: '1', platform: 'netease' })
    ledger.push({ type: 'artist', id: '1', platform: 'qq' })

    expect(ledger.size).toBe(2)
  })

  it('歌曲按歌曲键去重', () => {
    const ledger = new DetailNavigationLedger()
    ledger.push({ type: 'song', song: song(7) })
    ledger.push({ type: 'song', song: song(7) })

    expect(ledger.size).toBe(1)
  })

  it('只有栈顶重复才忽略，A→B→A 允许', () => {
    const ledger = new DetailNavigationLedger()
    ledger.push(artist('A'))
    ledger.push(artist('B'))
    ledger.push(artist('A'))

    expect(ledger.size).toBe(3)
  })

  it('超过深度上限时丢弃最旧条目', () => {
    const ledger = new DetailNavigationLedger()
    for (let index = 0; index < MAX_DETAIL_STACK_DEPTH + 3; index += 1) {
      ledger.push(artist(String(index)))
    }

    expect(ledger.size).toBe(MAX_DETAIL_STACK_DEPTH)
    expect(ledger.entries()[0]).toMatchObject({ id: '3' })
  })
})

describe('出栈与清空', () => {
  it('pop 返回栈顶并移除', () => {
    const ledger = new DetailNavigationLedger()
    ledger.push(artist('1'))
    ledger.push(album('2'))

    expect(ledger.pop()).toMatchObject({ type: 'album', id: '2' })
    expect(ledger.size).toBe(1)
  })

  it('空栈 pop 返回 undefined', () => {
    expect(new DetailNavigationLedger().pop()).toBeUndefined()
  })

  it('clear 清空全部条目', () => {
    const ledger = new DetailNavigationLedger()
    ledger.push(artist('1'))
    ledger.push(album('2'))

    ledger.clear()

    expect(ledger.size).toBe(0)
    expect(ledger.pop()).toBeUndefined()
  })

  it('entries 返回副本，外部修改不影响账本', () => {
    const ledger = new DetailNavigationLedger()
    ledger.push(artist('1'))
    const copy = ledger.entries()
    copy.push(album('2'))

    expect(ledger.size).toBe(1)
  })
})

describe('批量压栈（打开新详情前）', () => {
  it('pushAll 保留已有历史，并按给定顺序追加', () => {
    const ledger = new DetailNavigationLedger()
    ledger.push(album('existing'))

    ledger.pushAll([album('1'), artist('2'), { type: 'song', song: song(3) }])

    expect(ledger.entries()).toEqual([
      { type: 'album', id: 'existing', platform: 'netease' },
      { type: 'album', id: '1', platform: 'netease' },
      { type: 'artist', id: '2', platform: 'netease' },
      { type: 'song', song: song(3) },
    ])
  })

  it('pushAll 忽略栈顶连续重复', () => {
    const ledger = new DetailNavigationLedger()

    ledger.pushAll([artist('1'), artist('1')])

    expect(ledger.size).toBe(1)
  })

  it('pushAll 空数组是 no-op，不清空历史', () => {
    const ledger = new DetailNavigationLedger()
    ledger.push(artist('1'))

    ledger.pushAll([])

    expect(ledger.size).toBe(1)
  })
})

describe('列表顺序语义', () => {
  it('多次 pop 按后进先出返回', () => {
    const ledger = new DetailNavigationLedger()
    ledger.pushAll([artist('a'), album('b'), artist('c')])

    expect(ledger.pop()).toMatchObject({ id: 'c' })
    expect(ledger.pop()).toMatchObject({ id: 'b' })
    expect(ledger.pop()).toMatchObject({ id: 'a' })
    expect(ledger.pop()).toBeUndefined()
  })
})

describe('歌曲身份', () => {
  it('QQ 歌曲按 mid 去重（同 mid 不同 id 视为同一首）', () => {
    const ledger = new DetailNavigationLedger()
    const first = { ...song(1), platform: 'qq' as const, mid: 'abc' }
    const second = { ...song(2), platform: 'qq' as const, mid: 'abc' }

    ledger.push({ type: 'song', song: first })
    ledger.push({ type: 'song', song: second })

    expect(ledger.size).toBe(1)
  })

  it('同 id 不同 mid 视为不同歌曲', () => {
    const ledger = new DetailNavigationLedger()
    ledger.push({ type: 'song', song: { ...song(1), platform: 'qq' as const, mid: 'a' } })
    ledger.push({ type: 'song', song: { ...song(1), platform: 'qq' as const, mid: 'b' } })

    expect(ledger.size).toBe(2)
  })
})

import { describe, expect, it, beforeEach } from 'vitest'
import {
  compareVersions,
  getManifestUrls,
  readUpdateChannel,
  writeUpdateChannel,
  DEFAULT_UPDATE_CHANNEL,
  UPDATE_CHANNEL_KEY,
} from '../src/services/updateConstants'

describe('compareVersions（含预发布语义）', () => {
  it('按数字段比较核心版本号', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
  })

  it('兼容 v 前缀', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v1.2.4', 'v1.2.3')).toBeGreaterThan(0)
  })

  it('按 semver 规则：有预发布 < 无预发布', () => {
    expect(compareVersions('1.0.1-nightly.20260911', '1.0.1')).toBeLessThan(0)
    expect(compareVersions('1.0.1', '1.0.1-nightly.20260911')).toBeGreaterThan(0)
  })

  it('预发布号低于正式版，因此正式版用户切到 nightly 能发现 patch+1 的 nightly', () => {
    // 关键语义：nightly 版本号取「正式版 patch+1」，故 1.0.1-nightly.x > 1.0.0
    expect(compareVersions('1.0.1-nightly.20260911', '1.0.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.1-nightly.20260911')).toBeLessThan(0)
  })

  it('nightly 之间按日期递增', () => {
    expect(compareVersions('1.0.1-nightly.20260912', '1.0.1-nightly.20260911')).toBeGreaterThan(0)
    expect(compareVersions('1.0.1-nightly.20260911', '1.0.1-nightly.20260912')).toBeLessThan(0)
    expect(compareVersions('1.0.1-nightly.20260911', '1.0.1-nightly.20260911')).toBe(0)
  })

  it('beta 与 rc 之间按字母序，数字标识优先级低于字母标识', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0-alpha.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-beta.9')).toBeGreaterThan(0)
    // 1.0.0-1 < 1.0.0-alpha（数字标识 < 字母标识）
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  it('标识数量少者更小（1.0.0-beta < 1.0.0-beta.1）', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBeGreaterThan(0)
  })

  it('忽略 build 元数据（+）', () => {
    expect(compareVersions('1.0.0+build1', '1.0.0+build2')).toBe(0)
  })

  it('健壮处理空值 / 非法输入', () => {
    expect(compareVersions('', '')).toBe(0)
    expect(compareVersions('1.0.0', '')).toBeGreaterThan(0)
    expect(compareVersions('', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('abc', 'abc')).toBe(0)
  })
})

describe('更新渠道', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('默认渠道为正式版', () => {
    expect(readUpdateChannel()).toBe('stable')
    expect(DEFAULT_UPDATE_CHANNEL).toBe('stable')
  })

  it('写入后可读回，非法值回退正式版', () => {
    writeUpdateChannel('nightly')
    expect(readUpdateChannel()).toBe('nightly')
    expect(localStorage.getItem(UPDATE_CHANNEL_KEY)).toBe('nightly')

    writeUpdateChannel('stable')
    expect(readUpdateChannel()).toBe('stable')

    localStorage.setItem(UPDATE_CHANNEL_KEY, 'garbage')
    expect(readUpdateChannel()).toBe('stable')
  })

  it('两个渠道指向不同清单文件（版本无关的固定地址）', () => {
    const stable = getManifestUrls('stable')
    const nightly = getManifestUrls('nightly')
    expect(stable.some((u) => u.endsWith('/update.json'))).toBe(true)
    expect(nightly.some((u) => u.endsWith('/update-nightly.json'))).toBe(true)
    // 渠道间不重叠
    expect(stable.filter((u) => nightly.includes(u))).toEqual([])
  })

  it('每个渠道均提供「代理优先 + 直连兜底」两个源', () => {
    for (const channel of ['stable', 'nightly'] as const) {
      const urls = getManifestUrls(channel)
      expect(urls.length).toBe(2)
      expect(urls[0].startsWith('https://ghproxy.net/')).toBe(true)
      expect(urls[1].startsWith('https://raw.githubusercontent.com/')).toBe(true)
    }
  })
})

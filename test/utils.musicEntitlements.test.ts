import { describe, it, expect } from 'vitest'
import {
  createPlatformEntitlements,
  detectQQMusicVip,
  entitlementSatisfies,
  entitlementTierFromSpotifyProduct,
  getSongRequiredTier,
  shouldShowEntitlementBadge,
} from '../src/utils/musicEntitlements.ts'

describe('detectQQMusicVip（QQ 音乐会员检测，兼容多套返回结构）', () => {
  it('显式布尔字段 isVip 命中', () => {
    expect(detectQQMusicVip({ data: { creator: { isVip: true } } })).toBe(true)
  })

  it('嵌套 creator 中的 vip 数字字段命中', () => {
    expect(detectQQMusicVip({ data: { creator: { vip: 1 } } })).toBe(true)
    expect(detectQQMusicVip({ data: { creator: { vip: 0 } } })).toBe(false)
  })

  it('字符串 "1"/"true"/"yes" 等命中，其余回退', () => {
    expect(detectQQMusicVip({ vip: '1' })).toBe(true)
    expect(detectQQMusicVip({ vip: 'true' })).toBe(true)
    expect(detectQQMusicVip({ vip: 'yes' })).toBe(true)
    expect(detectQQMusicVip({ vip: 'no' })).toBe(false)
  })

  it('绿钻等级字段（greenVipLevel > 0）命中', () => {
    expect(detectQQMusicVip({ data: { creator: { greenVipLevel: 5 } } })).toBe(true)
    expect(detectQQMusicVip({ data: { creator: { greenVipLevel: 0 } } })).toBe(false)
  })

  it('lvinfo 徽章列表包含绿钻且 active 时命中', () => {
    expect(detectQQMusicVip({
      data: { lvinfo: [{ name: '绿钻豪华版', active: true }] },
    })).toBe(true)
  })

  it('memberships 列表含 superVip 名称且无状态字段时命中', () => {
    expect(detectQQMusicVip({
      vipInfo: [{ title: 'superVip' }],
    })).toBe(true)
  })

  it('memberships 含 音乐包 名称时命中', () => {
    expect(detectQQMusicVip({
      memberships: [{ name: '音乐包', status: 'open' }],
    })).toBe(true)
  })

  it('无会员信息返回 false', () => {
    expect(detectQQMusicVip({ data: { creator: { nickname: '路人甲' } } })).toBe(false)
    expect(detectQQMusicVip({})).toBe(false)
    expect(detectQQMusicVip(null)).toBe(false)
    expect(detectQQMusicVip(undefined)).toBe(false)
  })
})

describe('cross-platform entitlement tiers', () => {
  it('orders free, vip, and svip while keeping unknown conservative', () => {
    expect(entitlementSatisfies('svip', 'vip')).toBe(true)
    expect(entitlementSatisfies('vip', 'svip')).toBe(false)
    expect(entitlementSatisfies('unknown', 'vip')).toBe(false)
    expect(createPlatformEntitlements({ qq: 'vip' })).toMatchObject({ qq: 'vip', netease: 'unknown' })
  })

  it('maps Spotify product evidence', () => {
    expect(entitlementTierFromSpotifyProduct('premium')).toBe('vip')
    expect(entitlementTierFromSpotifyProduct('free')).toBe('free')
    expect(entitlementTierFromSpotifyProduct(undefined)).toBe('unknown')
  })

  it('honors explicit requiredTier and treats legacy song.vip as vip', () => {
    expect(getSongRequiredTier({ requiredTier: 'svip', vip: true })).toBe('svip')
    expect(getSongRequiredTier({ vip: true })).toBe('vip')
    expect(getSongRequiredTier({ vip: false })).toBe('free')
    expect(shouldShowEntitlementBadge({ requiredTier: 'vip' }, 'vip')).toBe(false)
    expect(shouldShowEntitlementBadge({ requiredTier: 'svip' }, 'vip')).toBe(true)
    expect(shouldShowEntitlementBadge({ vip: true }, 'unknown')).toBe(true)
  })
})

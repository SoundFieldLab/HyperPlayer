import { describe, expect, it } from 'vitest'
import { cookieToArray, cookieToJson, extractLoginCookie } from './cookie'

describe('netease cookie 纯函数', () => {
  it('解析 cookie 字符串为对象（分号/等号/trim）', () => {
    const cookie = cookieToJson(
      ' MUSIC_U=abc; MUSIC_A=def ; os=pc; empty= ; bad=has=equals ',
    )
    expect(cookie.MUSIC_U).toBe('abc')
    expect(cookie.MUSIC_A).toBe('def')
    expect(cookie.os).toBe('pc')
    expect(cookie.bad).toBe('has=equals')
  })

  it('对象转数组只保留已知键且按固定顺序', () => {
    const array = cookieToArray({ MUSIC_U: 'u', MUSIC_A: 'a', os: 'pc', custom: 'x' })
    expect(array).toEqual(['MUSIC_U=u', 'MUSIC_A=a', 'os=pc'])
  })

  it('从响应 body 提取登录 cookie（字符串与数组两种形态）', () => {
    expect(extractLoginCookie({ cookie: 'MUSIC_U=u; os=pc' }).MUSIC_U).toBe('u')
    expect(extractLoginCookie({ cookie: ['MUSIC_U=u', 'os=pc'] }).os).toBe('pc')
    expect(extractLoginCookie({})).toEqual({})
  })
})

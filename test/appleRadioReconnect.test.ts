import { describe, expect, it } from 'vitest'
import {
  decideAppleRadioFailure,
  getAppleRadioReconnectKey,
} from '../src/services/appleRadioReconnect'

describe('Apple radio reconnect policy', () => {
  it('allows one delayed reconnect for a station', () => {
    const key = getAppleRadioReconnectKey('cn', 'ra.1')
    expect(decideAppleRadioFailure('', key, '网络中断')).toEqual({
      type: 'reconnect',
      reconnectKey: key,
      delayMs: 1000,
    })
  })

  it('turns the second failure into a visible error', () => {
    const key = getAppleRadioReconnectKey('cn', 'ra.1')
    expect(decideAppleRadioFailure(key, key, '授权失败')).toEqual({
      type: 'error',
      reconnectKey: key,
      message: '授权失败',
    })
  })

  it('gives a newly selected station its own reconnect budget', () => {
    const first = getAppleRadioReconnectKey('cn', 'ra.1')
    const second = getAppleRadioReconnectKey('cn', 'ra.2')
    expect(decideAppleRadioFailure(first, second)).toMatchObject({
      type: 'reconnect',
      reconnectKey: second,
    })
  })
})

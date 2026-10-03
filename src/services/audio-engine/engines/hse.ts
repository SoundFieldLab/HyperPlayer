/**
 * v3 引擎清单 —— 纯 TS DSP 内核引擎
 *
 * 14 级处理链 + worklet/script 双模式 + 11 场景 + 分享串 + 听力分析。
 * 响度归一化/频响补偿引擎内实时实现（不走外部服务）。
 * 引擎源码：src/services/HyperSoundEngine-v1/
 */

import type { EngineManifest } from '../types'
import { HSEAdapter } from '../HSEAdapter'

export const hseManifest: EngineManifest = {
  id: 'hse',
  displayName: 'HSE',
  description: 'HyperSoundEngine DSP 内核（14 级链 + 11 场景 + 分享串）',
  createAdapter: () => new HSEAdapter(),
}

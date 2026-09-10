/**
 * Cuefield AutoMix API 客户端
 * 与后端通信，获取过渡计划
 */

import type { 
  CuefieldSong, 
  CuefieldTransitionPlan 
} from '../services/cuefieldAutoMix'

const API_BASE = 'http://localhost:3001'

export async function fetchCuefieldTransition(
  fromKey: string,
  toKey: string,
  fromSong: CuefieldSong,
  toSong: CuefieldSong
): Promise<CuefieldTransitionPlan> {
  try {
    const response = await fetch(`${API_BASE}/api/cuefield/transition`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fromKey,
        toKey,
        fromSong,
        toSong,
      }),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const plan = await response.json()
    return plan
  } catch (error) {
    console.error('[Cuefield API] 获取过渡计划失败:', error)
    return { ok: false }
  }
}

export async function ensureBeatMap(song: CuefieldSong): Promise<boolean> {
  // 模拟节拍分析
  // 实际实现中应该调用 Python 节拍分析服务
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), 100)
  })
}

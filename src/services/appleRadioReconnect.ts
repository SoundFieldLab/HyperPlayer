export type AppleRadioFailureDecision =
  | { type: 'reconnect'; reconnectKey: string; delayMs: number }
  | { type: 'error'; reconnectKey: string; message: string }

export function getAppleRadioReconnectKey(storefront: string, stationId: string): string {
  return `${storefront}:${stationId}`
}

export function decideAppleRadioFailure(
  previousReconnectKey: string,
  reconnectKey: string,
  fallbackReason?: string,
): AppleRadioFailureDecision {
  if (previousReconnectKey !== reconnectKey) {
    return { type: 'reconnect', reconnectKey, delayMs: 1000 }
  }
  return {
    type: 'error',
    reconnectKey,
    message: fallbackReason || 'Apple Music 电台连接中断',
  }
}

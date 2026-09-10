export const LOCAL_API_SERVICE = 'waveforge-local-api'
export const LOCAL_API_PROTOCOL_VERSION = 1

export function isCompatibleLocalApiHealth(body) {
  return Boolean(
    body &&
    typeof body === 'object' &&
    body.status === 'ok' &&
    body.service === LOCAL_API_SERVICE &&
    body.protocolVersion === LOCAL_API_PROTOCOL_VERSION
  )
}

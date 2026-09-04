// HyperPlayer adaptations: vendored 网易云协议包浏览器化 —— os 浏览器 shim。
// 协议包只用 tmpdir（anonymous_token/xeapi_public_key 路径）与
// networkInterfaces（client-sign 获取 MAC，浏览器不可用返回空）。

export function tmpdir(): string {
  return '/tmp'
}

export function networkInterfaces(): Record<string, never> {
  return {}
}

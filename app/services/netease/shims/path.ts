// HyperPlayer adaptations: vendored 网易云协议包浏览器化 —— path 浏览器 shim。
// 协议包只用 join/resolve（拼接 anonymous_token / xeapi_public_key 路径），
// 浏览器端路径无实际文件系统语义，按 POSIX 风格拼接即可。

export function join(...segments: string[]): string {
  return segments.filter(Boolean).join('/').replace(/\/+/g, '/')
}

export function resolve(...segments: string[]): string {
  return join(...segments)
}

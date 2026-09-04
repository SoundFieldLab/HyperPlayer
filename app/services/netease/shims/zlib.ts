// HyperPlayer adaptations: vendored 网易云协议包浏览器化 —— zlib 浏览器 shim。
// 协议包在 eapiResDecrypt(aeapi)/xeapiResDecrypt 中 gunzip，ncbl 中 gzip。
// pako（MIT）为浏览器 zlib 移植，API 同步对齐。

import { gzip, ungzip } from 'pako'

export function gunzipSync(buffer: Uint8Array): Uint8Array {
  return ungzip(buffer)
}

export function gzipSync(buffer: Uint8Array): Uint8Array {
  return gzip(buffer)
}

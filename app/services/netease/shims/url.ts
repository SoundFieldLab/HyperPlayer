// HyperPlayer adaptations: vendored 网易云协议包浏览器化 —— url 浏览器 shim。
// 协议包 require('url') 仅取 URL / URLSearchParams，浏览器原生已有。

export const URL = globalThis.URL
export const URLSearchParams = globalThis.URLSearchParams

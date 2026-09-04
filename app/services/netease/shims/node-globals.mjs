// HyperPlayer adaptations: vendored 网易云协议包浏览器化所需的 Node 全局兜底。
// 由 scripts/build-netease-vendor.mjs 作为入口副作用注入；导出 Buffer 供
// esbuild 把 vendored 代码中的 Buffer 引用替换为本模块实现。
import { Buffer } from 'buffer'

globalThis.Buffer = Buffer
globalThis.global = globalThis
globalThis.process = { env: {} }
// node-forge 用 `typeof self === "undefined" ? window : self` 探测全局；
// WebView2 有 self，Node 冒烟/单测环境补上
globalThis.self = globalThis

export { Buffer }

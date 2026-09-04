// HyperPlayer adaptations: vendored 网易云协议包浏览器化 —— 空 stub。
// 仅用于让协议包中未被产品启用的 Node 侧依赖可被 esbuild 解析；
// 任何运行时调用都会得到明确错误（fail loud）。

function unavailable(): never {
  throw new Error(
    'this module is not available in the HyperPlayer browser protocol shim',
  )
}

export default unavailable

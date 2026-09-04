// HyperPlayer adaptations: vendored 网易云协议包浏览器化 —— http/https 浏览器 shim。
// 协议包 util/request.js 仅为 axios settings 创建 Agent（keepAlive），
// 浏览器 fetch 无连接池概念，空实现即可。

export class Agent {
  constructor(_options?: Record<string, unknown>) {}
}

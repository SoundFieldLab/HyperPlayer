# HyperPlayer adaptations — vendored netease-cloudmusic-api

This directory is a vendored copy of `@neteasecloudmusicapienhanced/api` 4.39.0 (MIT).
Per `docs/架构基线.md` §11, HyperPlayer applies a **one-time browser adaptation** to
this copy. Every adaptation is marked inline with a `// HyperPlayer adaptations`
comment; upstream files are never modified in a way that changes their semantics.

Registered adaptations:

- **P0** — Removed the `@neteasecloudmusicapienhanced/unblockmusic-utils`
  dependency from `package.json` (LGPL unblock path; red line in
  `THIRD_PARTY_NOTICES.md`). `song_url_match` and its fallback are never used.
  The npm `package-lock.json` / `node_modules` artifacts were removed so the
  workspace install is managed solely by pnpm.
- **P4** — 浏览器一次性适配（全部标注 `// HyperPlayer adaptations`）：
  - `util/browserHttp.js`（新增）：axios-like 传输层，经 `setBrowserHttpTransport`
    注入 infra tauriHttp；`util/request.js` / `module/register_checktoken_v2|v3.js`
    的 axios 指向该层；
  - `util/request.js`：移除 node fs/path/os/http/https/tunnel/代理依赖；
    anonymous_token / xeapi 公钥由注入 storage 惰性提供（`setBrowserStorage`）；
    eapi 响应解密改 async（bytes→hex）；导出注入函数；
  - `util/crypto.js`：weapi/linuxapi/eapi 保持原语义（crypto-js/forge 纯 JS）；
    xeapi（X25519/AES-GCM/node crypto）浏览器不支持 → 抛错，由音质降级链覆盖；
    `eapiResDecrypt` 改 async（aeapi=gzip 用 DecompressionStream）；
  - `util/index.js`：移除 fs/path（中国 IP 段加载退化到兜底随机 IP）；
  - `server.js`（express 服务器）与 `main.js` 动态模块加载不打包——app 侧以
    白名单入口 `app/src/domains/netease/api/neteaseApi.ts` 显式引入 92 路由所需
    端点模块（namespace import + unwrapCjs 互操作）；
  - **不引入** `module/song_url_match.js` 与 `@neteasecloudmusicapienhanced/unblockmusic-utils`
    （LGPL 解灰红线，waveforge song/url fallback 路径废除）。

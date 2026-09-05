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
- **P4** (planned) — Transport layer (`util/request.js`) axios → `infra tauriHttp`;
  `fs` persistence (anonymous token, xeapi key cache) → browser storage /
  stronghold; Node `crypto` → `globalThis.crypto`; Node server entry (`server.js`)
  is not bundled. 431 endpoint modules keep their original semantics.

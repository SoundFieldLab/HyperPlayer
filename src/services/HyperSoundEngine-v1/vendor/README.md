# vendor/ —— 随模块自带的第三方库（离线可用）

> 目的：**下一个 AI（融合方）不需要联网找库**，本目录已随模块携带 LGPL 库的原始副本。
> ⚠️ **现状（2026-09-13）**：本模块**没有自己的 `package.json`**（已并入 HyperPlayer），
> 仓库根 `package.json` 也**没有 `optionalDependencies`**；soundtouchjs / meyda / signalsmith-stretch
> **均未安装**（`node_modules/soundtouchjs` 不存在），因此不参与构建与测试；
> LGPL 相关用例由 `describe.skipIf` 自动跳过，功能走自研回退路径。

## 目录内容

| 目录 | 库 | 许可证 | 用途 | 使用方式 |
|---|---|---|---|---|
| `soundtouchjs/` | soundtouchjs v0.3.0（SoundTouch 核心，cutterbl/SoundTouchJS） | **LGPL-2.1** | 变速/变调（`src/dsp/StretchLgplAdapter.ts` 动态链接调用） | **随模块自带原包副本；当前未安装未链接**（适配器动态 import 失败返回 null，自动回退自研相位声码器）。如需启用：把本目录复制进仓库根 `node_modules/soundtouchjs`，或按同名包安装 |

## LGPL 合规（用户策略：不修改源码、动态/静态链接调用）

- 本 vendor 副本为 **npm 原包原样拷贝**（dist/LICENSE/package.json/README 均未修改）；
- 使用方式：`StretchLgplAdapter.ts` 运行时 `import('soundtouchjs')` 只调公开 API；
- 分发时随附其 `LICENSE`（本目录内）并满足"可重新链接"（源码即 npm 包）；
- **未安装/不可用时适配器返回 null，自动回退自研相位声码器，功能不中断**（当前仓库即此状态，LGPL 用例自动跳过）。

## 使用方式（给融合方 AI）

```bash
# 在仓库根目录执行（本模块无独立 package.json）
npm run test         # 全仓 vitest：2026-09-13 实测 140 文件 = 139 过 + 1 跳过 /
                     # 1269 用例 = 1264 过 + 5 跳过 + 0 todo（5 项跳过来自 LGPL 可选依赖未安装）
npm run lint         # tsc --noEmit，0 错误
npm run build:v3-worklet   # 打包 HSE AudioWorklet 单文件 → public/v3-worklet.js
```

> 可选依赖（soundtouchjs LGPL-2.1 / meyda MIT / signalsmith-stretch MIT）当前**未安装**；
> 仓库根 `package.json` 未声明 `optionalDependencies`，需手动安装或把 vendor 副本放入 `node_modules/` 后才会启用。
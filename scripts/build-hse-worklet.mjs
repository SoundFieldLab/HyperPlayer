/**
 * v3 引擎 AudioWorklet 处理器打包脚本
 *
 * AudioWorklet 全局作用域不支持裸 import/export：引擎与全部 DSP 依赖必须内联进
 * 单个处理器文件（见 src/services/HyperSoundEngine-v1/src/worklet/AudioEffectsProcessor.ts
 * 头注释与 docs/FUSION_GUIDE.md 步骤 3）。
 *
 * 产物：public/hse-worklet.js（dev 由 Vite 静态服务；build 由 Vite 拷入 dist/，
 * electron-builder 的 dist 通配打包规则已覆盖）。
 * esbuild 为 vite 的直接依赖，无需单独安装。
 */
import { build } from 'esbuild'
import { mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'src/services/HyperSoundEngine-v1/src/worklet/AudioEffectsProcessor.ts')
const outfile = path.join(root, 'public/hse-worklet.js')

mkdirSync(path.dirname(outfile), { recursive: true })

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  minify: true,
  outfile,
  banner: {
    js: '// HyperPlayer HSE AudioWorklet processor (hyperplayer-hse-effects) — 自动生成，勿手改；重新生成：npm run build:hse-worklet',
  },
  logLevel: 'info',
})

console.log(`[build-hse-worklet] ${path.relative(root, outfile)} 已生成`)

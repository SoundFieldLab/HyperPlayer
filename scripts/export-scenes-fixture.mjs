#!/usr/bin/env node
/**
 * 从 TS oracle（shared/hse-ts-core `ScenePresets`）重新导出 12 场景冻结夹具：
 * `crates/hyperplayer-hse-core/tests/fixtures/engine/scenes.48000.json`。
 *
 * 背景：HyperPlayer 已对 12 个内置场景做 ieq/dynamicEq/modulation/limiter 的
 * 逐场景定制（TS 与 Rust `hyperplayer-hse-core/src/scenes.rs` 逐字段镜像），
 * 夹具不再等价于纯上游 HyperSoundEngine v1.5.1 冻结导出，因此在文档中显式
 * 标注 provenance（version = 1.5.1-hyperplayer-scenes-ext），不得冒充上游导出。
 *
 * 实现：用仓库内 TypeScript 编译器把 ScenePresets.ts 及其依赖树发射为 CJS 到
 * 临时目录后由 Node 加载（行为事实源仍是 TS 本体，非手抄数值）；输出文档的
 * 顶层键顺序与上游导出器一致（schemaVersion/sampleRate/sceneIds/scenes），
 * 仅在 sampleRate 之后插入 provenance 标注。写入采用与上游一致的
 * JSON.stringify(value, null, 2) + 换行。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const targetPath = resolve(
  repoRoot,
  'crates/hyperplayer-hse-core/tests/fixtures/engine/scenes.48000.json',
)
const SAMPLE_RATE = 48000
const SCHEMA_VERSION = 1

/** 用仓库内 tsc 把 TS oracle 发射为 CJS 后加载 SCENE_IDS / SCENE_PRESETS。 */
function loadTsFacts() {
  const outDir = mkdtempSync(path.join(tmpdir(), 'hpe-scenes-fixture-'))
  const tsc = resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(
    process.execPath,
    [
      tsc,
      'shared/hse-ts-core/src/engine/ScenePresets.ts',
      '--ignoreConfig',
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--skipLibCheck',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  )
  const entry = path.join(outDir, 'engine', 'ScenePresets.js')
  const facts = createRequire(entry)(entry)
  return { facts, cleanup: () => rmSync(outDir, { recursive: true, force: true }) }
}

function main() {
  const { facts, cleanup } = loadTsFacts()
  try {
    const sceneIds = [...facts.SCENE_IDS]
    const scenes = facts.SCENE_PRESETS
    if (sceneIds.length !== 12 || scenes.length !== 12) {
      throw new Error('内置场景应固定为 12 个')
    }
    if (scenes.some((scene, index) => scene.id !== sceneIds[index])) {
      throw new Error('SCENE_IDS 与 SCENE_PRESETS 顺序不一致')
    }
    for (const scene of scenes) {
      const p = scene.params
      if (p.sampleRate !== SAMPLE_RATE || p.sceneId !== scene.id || p.customized !== false) {
        throw new Error(`场景 ${scene.id} 快照契约不满足`)
      }
      if (p.reverb.convolution.ir !== null) {
        throw new Error(`场景 ${scene.id} 不得携带卷积 IR 数据`)
      }
      if (p.spatial?.mode !== 'off') {
        throw new Error(`场景 ${scene.id} 空间模式必须为 off`)
      }
      for (const stage of ['ieq', 'dynamicEq', 'limiter']) {
        if (p[stage] === undefined) throw new Error(`场景 ${scene.id} 缺少 ${stage}`)
      }
      if (p.modulation === undefined) throw new Error(`场景 ${scene.id} 缺少 modulation`)
      if (p.dynamicEq.bands.length !== 5) {
        throw new Error(`场景 ${scene.id} dynamicEq 必须 5 带`)
      }
    }

    const document = {
      schemaVersion: SCHEMA_VERSION,
      sampleRate: SAMPLE_RATE,
      provenance: {
        version: '1.5.1-hyperplayer-scenes-ext',
        base: 'HyperSoundEngine v1.5.1 specs/engine/vectors/scenes.48000.json (commit f7017621b7d84005fbfed8a3c42a119487a17326)',
        note:
          'HyperPlayer 扩展导出：12 个内置场景对 ieq/dynamicEq/modulation/limiter 做逐场景定制后，' +
          '由 scripts/export-scenes-fixture.mjs 从 shared/hse-ts-core（TS oracle）重新生成；' +
          '不再是纯上游 v1.5.1 冻结导出，仅保留上游 schemaVersion/sampleRate/结构契约。',
      },
      sceneIds,
      scenes,
    }

    mkdirSync(path.dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, JSON.stringify(document, null, 2) + '\n', 'utf8')
    console.log(`已重新导出 ${path.relative(repoRoot, targetPath)}（${scenes.length} 个场景）`)
  } finally {
    cleanup()
  }
}

main()

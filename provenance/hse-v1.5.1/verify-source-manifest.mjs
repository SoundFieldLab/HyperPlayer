#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const EXPECTED_COMMIT = 'f7017621b7d84005fbfed8a3c42a119487a17326'
const EXPECTED_TAG = 'v1.5.1'
const EXPECTED_TAG_OBJECT = '3602b86906e6a345baaf6e87fe559f80ed399cc4'
const EXPECTED_FILE_COUNT = 84
const EXPECTED_AGGREGATE_SHA256 = '06fa8e8df5524d855b91fbbcb018072587a517d056576b2017c7a6665a2f72c5'
const SOURCE_URL = 'https://github.com/IceFireIcer/HyperSoundEngine.git'
const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = resolve(here, 'SOURCE-MANIFEST.json')
const writeMode = process.argv.includes('--write')
const sourceArgument = process.argv.slice(2).find((argument) => argument !== '--write')
const sourceRoot = resolve(sourceArgument ?? resolve(here, '../../temp/hse-v1.5.1'))

function git(...args) {
  return execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }).trim()
}

function trackedFiles(pathspec) {
  const output = git('ls-tree', '-r', '--name-only', 'HEAD', '--', ...pathspec)
  return output ? output.split(/\r?\n/u) : []
}

function isSelectedTsCore(path) {
  if (!path.endsWith('.ts')) return false
  if (path.startsWith('src/spatial/test/')) return false
  return path.startsWith('src/analysis/') ||
    path.startsWith('src/dsp/') ||
    path.startsWith('src/engine/') ||
    path.startsWith('src/spatial/') ||
    path === 'src/index.ts' ||
    path === 'src/interfaces.ts' ||
    path === 'src/types.ts'
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function selectedSourceFiles() {
  const rust = trackedFiles(['HyperSoundEngineRust/crates/hse-core', 'HyperSoundEngineRust/crates/hrtf-core'])
    .filter((path) => {
      if (path.endsWith('/Cargo.toml')) return true
      return path.endsWith('.rs') && (path.includes('/src/') || path.includes('/tests/'))
    })
  const typescript = trackedFiles(['src']).filter(isSelectedTsCore)
  const fixtures = [
    'specs/engine/vectors/default-params.48000.json',
    'specs/engine/vectors/scenes.48000.json',
    'specs/io/vectors/wav-standard.json',
  ]
  return [...rust, ...typescript, ...fixtures].sort((left, right) => left.localeCompare(right, 'en'))
}

async function buildManifest() {
  const paths = await selectedSourceFiles()
  const files = await Promise.all(paths.map(async (path) => ({
    path,
    sha256: await sha256(resolve(sourceRoot, path)),
  })))
  const aggregateSha256 = createHash('sha256')
    .update(files.map(({ path, sha256: hash }) => `${hash}  ${path}\n`).join(''))
    .digest('hex')

  return {
    schemaVersion: 1,
    source: {
      project: 'HyperSoundEngine',
      version: '1.5.1',
      tag: EXPECTED_TAG,
      tagObject: EXPECTED_TAG_OBJECT,
      commit: EXPECTED_COMMIT,
      repository: SOURCE_URL,
    },
    authorization: '../../LICENSE-HSE-AUTHORIZATION.md',
    sourceCheckout: {
      defaultRelativePath: '../../temp/hse-v1.5.1',
      note: 'Paths and hashes are derived from this source checkout, never from a vendor destination.',
    },
    selections: [
      {
        name: 'hse-core',
        originalPath: 'HyperSoundEngineRust/crates/hse-core',
        includes: ['Cargo.toml', 'src/**/*.rs', 'tests/**/*.rs'],
      },
      {
        name: 'hrtf-core',
        originalPath: 'HyperSoundEngineRust/crates/hrtf-core',
        includes: ['Cargo.toml', 'src/**/*.rs', 'tests/**/*.rs'],
      },
      {
        name: 'selected TypeScript core',
        originalPaths: ['src/analysis/**/*.ts', 'src/dsp/**/*.ts', 'src/engine/**/*.ts', 'src/spatial/**/*.ts', 'src/index.ts', 'src/interfaces.ts', 'src/types.ts'],
        excludes: ['src/spatial/test/**'],
      },
      {
        name: 'shared source fixtures',
        originalPaths: [
          'specs/engine/vectors/default-params.48000.json',
          'specs/engine/vectors/scenes.48000.json',
          'specs/io/vectors/wav-standard.json',
        ],
      },
    ],
    destinationAdaptations: [
      {
        sourcePath: 'HyperSoundEngineRust/crates/hse-core/src/params.rs',
        adaptation: 'Relocated fixture include_str! path to ../tests/fixtures/engine/default-params.48000.json.',
      },
      {
        sourcePath: 'HyperSoundEngineRust/crates/hse-core/src/scenes.rs',
        adaptation: 'Relocated fixture include_str! path to ../tests/fixtures/engine/scenes.48000.json.',
      },
      {
        sourcePath: 'HyperSoundEngineRust/crates/hse-core/src/wav.rs',
        adaptation: 'Relocated fixture include_str! path to ../tests/fixtures/io/wav-standard.json.',
      },
      {
        sourcePath: 'src/index.ts',
        adaptation: 'Scoped the destination index by removing exports for unselected offline and WAV I/O modules.',
      },
      {
        sourcePath: 'HyperSoundEngineRust/crates/hse-core/src/fft.rs',
        adaptation: "Restored the mandatory 'Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.' fdlibm notice and 'Copyright 2016 the V8 project authors. All rights reserved.' notice before the copied ts_trig implementation; algorithm code is unchanged.",
      },
    ],
    exclusions: [
      { category: 'UI', paths: ['ui/**'] },
      { category: 'browser host and worklet', paths: ['src/browser.ts', 'src/integration/**', 'src/worklet.ts', 'src/worklet/**'] },
      { category: 'service', paths: ['HyperSoundEngineRust/crates/hse-service/**'] },
      { category: 'WASAPI', paths: ['HyperSoundEngineRust/crates/hse-wasapi/**'] },
      { category: 'N-API', paths: ['HyperSoundEngineRust/crates/hse-napi/**'] },
      { category: 'WASM', paths: ['HyperSoundEngineRust/crates/hse-wasm/**', 'HyperSoundEngineRust/web/**'] },
      { category: 'build artifacts and dependencies', paths: ['dist/**', 'node_modules/**', 'HyperSoundEngineRust/target/**'] },
      { category: 'SOFA/HRTF datasets and other binary assets', paths: ['**/*.sofa', '**/*.hrtf', '**/*.bin'] },
    ],
    hashAlgorithm: 'SHA-256',
    aggregateFormat: '<lowercase-sha256><two spaces><source-path><LF>, sorted by source-path',
    aggregateSha256,
    fileCount: files.length,
    files,
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual || '<empty>'}`)
}

const head = git('rev-parse', 'HEAD')
assertEqual(head, EXPECTED_COMMIT, 'checkout commit')
assertEqual(git('rev-parse', `refs/tags/${EXPECTED_TAG}`), EXPECTED_TAG_OBJECT, 'tag object')
assertEqual(git('rev-parse', `refs/tags/${EXPECTED_TAG}^{}`), EXPECTED_COMMIT, 'peeled tag commit')

const status = git('status', '--porcelain', '--untracked-files=all')
if (status) throw new Error(`source checkout is not clean:\n${status}`)

const generated = await buildManifest()
assertEqual(generated.fileCount, EXPECTED_FILE_COUNT, 'selected source file count')
assertEqual(generated.aggregateSha256, EXPECTED_AGGREGATE_SHA256, 'selected source aggregate SHA-256')
if (writeMode) {
  await writeFile(manifestPath, `${JSON.stringify(generated, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${manifestPath}`)
}

const recorded = JSON.parse(await readFile(manifestPath, 'utf8'))
assertEqual(JSON.stringify(recorded), JSON.stringify(generated), 'complete source manifest')

console.log(`Verified clean ${EXPECTED_TAG} checkout at ${EXPECTED_COMMIT}`)
console.log(`Verified ${generated.fileCount} source files; aggregate SHA-256 ${generated.aggregateSha256}`)

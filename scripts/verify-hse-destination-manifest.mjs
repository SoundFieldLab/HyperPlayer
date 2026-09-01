#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..')
const defaultManifestPath = resolve(repositoryRoot, 'provenance/hse-v1.5.1/DESTINATION-MANIFEST.json')
const sourceManifestPath = resolve(repositoryRoot, 'provenance/hse-v1.5.1/SOURCE-MANIFEST.json')
const updateMode = process.argv.includes('--update')

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`)
  return resolve(value)
}

const destinationRoot = option('--destination-root', repositoryRoot)
const manifestPath = option('--manifest', defaultManifestPath)
const roots = [
  {
    destination: 'shared/hse-ts-core',
    source: '',
  },
  {
    destination: 'crates/hyperplayer-hrtf-core',
    source: 'HyperSoundEngineRust/crates/hrtf-core',
  },
  {
    destination: 'crates/hyperplayer-hse-core',
    source: 'HyperSoundEngineRust/crates/hse-core',
  },
]

function normalizePath(path) {
  return path.split(sep).join('/')
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

async function sha256(path) {
  const bytes = await readFile(path)
  const normalized = bytes.includes(13) ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'), 'utf8') : bytes
  return createHash('sha256').update(normalized).digest('hex')
}

async function validateRoot(root) {
  const rootPath = resolve(destinationRoot, root.destination)
  const metadata = await lstat(rootPath)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`vendored destination root must be a real directory: ${root.destination}`)
  }
  const repositoryRealPath = await realpath(destinationRoot)
  const rootRealPath = await realpath(rootPath)
  const relativeRoot = relative(repositoryRealPath, rootRealPath)
  if (relativeRoot.startsWith('..') || relativeRoot === '' || resolve(repositoryRealPath, relativeRoot) !== rootRealPath) {
    throw new Error(`vendored destination root escapes the repository: ${root.destination}`)
  }
  return rootPath
}

async function walk(root) {
  const paths = []

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => comparePaths(left.name, right.name))
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) paths.push(normalizePath(relative(root, path)))
      else throw new Error(`unsupported destination entry: ${normalizePath(relative(destinationRoot, path))}`)
    }
  }

  await visit(root)
  return paths
}

function sourcePathFor(root, relativePath) {
  const fixtureMappings = new Map([
    ['tests/fixtures/engine/default-params.48000.json', 'specs/engine/vectors/default-params.48000.json'],
    ['tests/fixtures/engine/scenes.48000.json', 'specs/engine/vectors/scenes.48000.json'],
    ['tests/fixtures/io/wav-standard.json', 'specs/io/vectors/wav-standard.json'],
  ])
  if (root.destination === 'shared/hse-ts-core') {
    return relativePath.startsWith('src/') ? relativePath : null
  }
  return fixtureMappings.get(relativePath) ?? `${root.source}/${relativePath}`
}

const checkpointApiPaths = new Set([
  'src/bass_enhancer.rs',
  'src/compressor.rs',
  'src/convolver.rs',
  'src/deesser.rs',
  'src/eq_chain.rs',
  'src/loudness_comp.rs',
  'src/lufs_meter.rs',
  'src/mod_effects.rs',
])

function adaptationsFor(relativePath, sourceSha256, destinationSha256) {
  if (relativePath === 'README.md') return ['license-notice']
  if (relativePath === 'package.json' || relativePath === 'tsconfig.json') return ['relocation']
  if (relativePath === 'Cargo.toml') return ['relocation']
  if (relativePath.startsWith('tests/fixtures/')) return ['relocation', 'test-only']
  if (relativePath.startsWith('tests/')) return ['test-only']
  if (relativePath === 'src/fft.rs' && sourceSha256 !== destinationSha256) return ['license-notice', 'algorithm-change']
  if (relativePath === 'src/lib.rs' && sourceSha256 !== destinationSha256) {
    return ['license-notice', 'lint-policy', 'runtime-checkpoint-api']
  }
  if (sourceSha256 === destinationSha256) return ['relocation']
  if (checkpointApiPaths.has(relativePath)) return ['runtime-checkpoint-api', 'algorithm-change']
  return ['algorithm-change']
}

async function buildManifest() {
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'))
  const sourceHashes = new Map(sourceManifest.files.map((file) => [file.path, file.sha256]))
  const files = []

  for (const root of roots) {
    const absoluteRoot = await validateRoot(root)
    for (const relativePath of await walk(absoluteRoot)) {
      const path = `${root.destination}/${relativePath}`
      const candidateSourcePath = sourcePathFor(root, relativePath)
      const sourceSha256 = sourceHashes.get(candidateSourcePath) ?? null
      const destinationSha256 = await sha256(resolve(destinationRoot, ...path.split('/')))
      files.push({
        path,
        sourcePath: sourceSha256 === null ? null : candidateSourcePath,
        sourceSha256,
        destinationSha256,
        adaptations: adaptationsFor(relativePath, sourceSha256, destinationSha256),
      })
    }
  }

  files.sort((left, right) => comparePaths(left.path, right.path))
  const aggregateSha256 = createHash('sha256')
    .update(files.map(({ path, destinationSha256 }) => `${destinationSha256}  ${path}\n`).join(''))
    .digest('hex')

  return {
    schemaVersion: 1,
    source: sourceManifest.source,
    authorization: 'LICENSE-HSE-AUTHORIZATION.md',
    roots: roots.map(({ destination }) => destination),
    pathFormat: 'Repository-relative paths with forward slashes, sorted by Unicode code point.',
    hashAlgorithm: 'SHA-256 over bytes with CRLF normalized to LF',
    aggregateFormat: '<lowercase-destination-sha256><two spaces><destination-path><LF>',
    aggregateSha256,
    fileCount: files.length,
    files,
  }
}

const allowedAdaptations = new Set([
  'relocation',
  'license-notice',
  'lint-policy',
  'runtime-checkpoint-api',
  'test-only',
  'algorithm-change',
])
const sha256Pattern = /^[0-9a-f]{64}$/u

function formatList(paths) {
  return paths.map((path) => `  - ${path}`).join('\n')
}

async function verify(recorded) {
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'))
  const sourceHashes = new Map(sourceManifest.files.map((file) => [file.path, file.sha256]))
  if (recorded.schemaVersion !== 1) throw new Error(`unsupported manifest schemaVersion: ${recorded.schemaVersion}`)
  if (JSON.stringify(recorded.source) !== JSON.stringify(sourceManifest.source)) {
    throw new Error('manifest source metadata does not match SOURCE-MANIFEST.json')
  }
  if (recorded.authorization !== 'LICENSE-HSE-AUTHORIZATION.md') throw new Error('unexpected authorization path')
  if (JSON.stringify(recorded.roots) !== JSON.stringify(roots.map(({ destination }) => destination))) {
    throw new Error('manifest roots do not match the vendored destination roots')
  }
  if (recorded.pathFormat !== 'Repository-relative paths with forward slashes, sorted by Unicode code point.') {
    throw new Error('unexpected path format')
  }
  if (recorded.aggregateFormat !== '<lowercase-destination-sha256><two spaces><destination-path><LF>') {
    throw new Error('unexpected aggregate format')
  }
  if (recorded.hashAlgorithm !== 'SHA-256 over bytes with CRLF normalized to LF') {
    throw new Error('unexpected hash algorithm')
  }
  if (!sha256Pattern.test(recorded.aggregateSha256)) throw new Error('invalid aggregate SHA-256')
  if (!Array.isArray(recorded.files)) throw new Error('manifest files must be an array')

  for (const file of recorded.files) {
    if (file.path.includes('\\') || file.path.startsWith('/') || file.path.split('/').includes('..')) {
      throw new Error(`destination path is not normalized: ${file.path}`)
    }
    const root = roots.find(({ destination }) => file.path.startsWith(`${destination}/`))
    if (!root) throw new Error(`destination path is outside vendored roots: ${file.path}`)
    const relativePath = file.path.slice(root.destination.length + 1)
    const candidateSourcePath = sourcePathFor(root, relativePath)
    const expectedSourceSha256 = sourceHashes.get(candidateSourcePath) ?? null
    const expectedSourcePath = expectedSourceSha256 === null ? null : candidateSourcePath
    if (file.sourcePath !== expectedSourcePath || file.sourceSha256 !== expectedSourceSha256) {
      throw new Error(`source mapping does not match SOURCE-MANIFEST.json: ${file.path}`)
    }
    if (!sha256Pattern.test(file.destinationSha256)) throw new Error(`invalid destination SHA-256: ${file.path}`)
    const expectedAdaptations = adaptationsFor(relativePath, file.sourceSha256, file.destinationSha256)
    if (JSON.stringify(file.adaptations) !== JSON.stringify(expectedAdaptations)) {
      throw new Error(`adaptation classification drift: ${file.path}`)
    }
    for (const adaptation of file.adaptations) {
      if (!allowedAdaptations.has(adaptation)) throw new Error(`unknown adaptation ${adaptation}: ${file.path}`)
    }
  }

  const expectedFiles = new Map(recorded.files.map((file) => [file.path, file]))
  if (expectedFiles.size !== recorded.files.length) throw new Error('manifest contains duplicate destination paths')

  const sortedPaths = [...expectedFiles.keys()].sort(comparePaths)
  if (JSON.stringify([...expectedFiles.keys()]) !== JSON.stringify(sortedPaths)) {
    throw new Error('manifest destination paths are not in stable sorted order')
  }
  if (recorded.fileCount !== recorded.files.length) {
    throw new Error(`manifest fileCount is ${recorded.fileCount}, but contains ${recorded.files.length} entries`)
  }

  const actualPaths = []
  for (const root of roots) {
    const absoluteRoot = resolve(destinationRoot, root.destination)
    for (const relativePath of await walk(absoluteRoot)) actualPaths.push(`${root.destination}/${relativePath}`)
  }
  actualPaths.sort(comparePaths)

  const actualSet = new Set(actualPaths)
  const missing = sortedPaths.filter((path) => !actualSet.has(path))
  const extra = actualPaths.filter((path) => !expectedFiles.has(path))
  const drifted = []
  for (const path of actualPaths) {
    const expected = expectedFiles.get(path)
    if (!expected) continue
    const actualHash = await sha256(resolve(destinationRoot, ...path.split('/')))
    if (actualHash !== expected.destinationSha256) {
      drifted.push(`${path} (expected ${expected.destinationSha256}, got ${actualHash})`)
    }
  }

  const failures = []
  if (missing.length) failures.push(`missing destination files:\n${formatList(missing)}`)
  if (extra.length) failures.push(`unregistered destination files:\n${formatList(extra)}`)
  if (drifted.length) failures.push(`destination hash drift:\n${formatList(drifted)}`)
  if (failures.length) throw new Error(failures.join('\n'))

  const aggregateSha256 = createHash('sha256')
    .update(recorded.files.map(({ path, destinationSha256 }) => `${destinationSha256}  ${path}\n`).join(''))
    .digest('hex')
  if (aggregateSha256 !== recorded.aggregateSha256) {
    throw new Error(`manifest aggregate SHA-256 drift: expected ${recorded.aggregateSha256}, got ${aggregateSha256}`)
  }

  console.log(`Verified ${recorded.fileCount} vendored destination files; aggregate SHA-256 ${recorded.aggregateSha256}`)
}

if (updateMode) {
  if (destinationRoot !== repositoryRoot) throw new Error('--update cannot be combined with --destination-root')
  const generated = await buildManifest()
  await writeFile(manifestPath, `${JSON.stringify(generated, null, 2)}\n`, 'utf8')
  console.log(`Updated ${manifestPath}`)
  await verify(generated)
} else {
  await verify(JSON.parse(await readFile(manifestPath, 'utf8')))
}

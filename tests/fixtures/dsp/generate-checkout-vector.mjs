import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXPECTED_SOURCE = {
  project: 'HyperSoundEngine',
  version: '1.5.1',
  commit: 'f7017621b7d84005fbfed8a3c42a119487a17326',
}

function verifyCheckout(root) {
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (commit !== EXPECTED_SOURCE.commit) throw new Error(`unexpected HSE commit: ${commit}`)
  const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
  if (status.trim() !== '') throw new Error('HSE checkout must be clean before generating vectors')
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (pkg.version !== EXPECTED_SOURCE.version) throw new Error(`unexpected HSE version: ${pkg.version}`)
}

function readInputs(bytes, frames) {
  const inputLeft = new Float32Array(frames)
  const inputRight = new Float32Array(frames)
  for (let index = 0; index < frames; index++) {
    inputLeft[index] = bytes.readFloatLE(index * 4)
    inputRight[index] = bytes.readFloatLE((frames + index) * 4)
  }
  return [inputLeft, inputRight]
}

function neutralize(params) {
  params.eq.enabled = false
  params.deesser.enabled = false
  params.compressor.enabled = false
  params.nightMode.enabled = false
  params.reverb.enabled = false
  params.surround3d.enabled = false
  params.bassEnhancer.enabled = false
  params.loudnessCompensation.enabled = false
  params.loudnessNormalization.enabled = false
  params.limiter.enabled = false
  params.ieq.enabled = false
  params.dynamicEq.enabled = false
  params.pitch.enabled = false
  params.modulation.enabled = false
  params.modulation.routes = []
  for (const effect of Object.values(params.modEffects)) effect.enabled = false
  params.stereoWidth = 1
  params.spatial.mode = 'off'
}

function standaloneProcessor(moduleName, meta, hse) {
  switch (moduleName) {
    case 'bass-enhancer': {
      const processor = new hse.BassEnhancer(meta.sampleRate)
      processor.setParams(meta.params)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'biquad': {
      const create = () => new hse.Biquad(meta.params.type, meta.params.f0, meta.params.q, meta.params.gainDb, meta.sampleRate)
      const leftProcessor = create()
      const rightProcessor = create()
      return (left, right) => {
        leftProcessor.processBlock(left, left)
        rightProcessor.processBlock(right, right)
      }
    }
    case 'compressor': {
      const processor = new hse.Compressor(meta.sampleRate)
      processor.setParams(meta.params)
      return (left, right) => {
        if (!meta.params.sidechainEnabled) return processor.processStereo(left, right)
        const side = new Float32Array(left.length)
        for (let index = 0; index < side.length; index++) side[index] = left[index] + right[index]
        processor.processStereo(left, right, side, side)
      }
    }
    case 'deesser': {
      const processor = new hse.Deesser(meta.sampleRate)
      processor.setParams(meta.params)
      return (left, right) => {
        if (!meta.params.sidechainEnabled) return processor.processStereo(left, right)
        const side = new Float32Array(left.length)
        for (let index = 0; index < side.length; index++) side[index] = left[index] + right[index]
        processor.processStereo(left, right, side, side)
      }
    }
    case 'eq-chain': {
      const processor = new hse.EqChain(meta.sampleRate, meta.params.bandCount)
      processor.setBands(meta.params.bands)
      processor.setQCompensation(meta.params.qCompensation)
      return (left, right) => processor.processStereo(left, right)
    }
    case 'mid-side': {
      const processor = new hse.MidSide()
      processor.setParams(meta.params.width, meta.params.voiceBalance)
      return (left, right) => processor.processStereo(left, right)
    }
    default:
      return null
  }
}

function engineProcessor(moduleName, meta, hse) {
  const params = hse.createDefaultParams(meta.sampleRate)
  neutralize(params)
  if (moduleName === 'loudness-normalization') {
    params.loudnessNormalization = meta.params
  } else if (moduleName === 'surround3d') {
    params.surround3d = meta.params
  } else {
    return null
  }
  const engine = new hse.HyperSoundEngine(meta.sampleRate, 2)
  engine.setParams(params)
  engine.prepare(meta.blockSize)
  return (left, right) => {
    const outputLeft = new Float32Array(left.length)
    const outputRight = new Float32Array(right.length)
    engine.process([left, right], [outputLeft, outputRight])
    left.set(outputLeft)
    right.set(outputRight)
  }
}

function candidateBytes(meta, oldBytes, process) {
  const [inputLeft, inputRight] = readInputs(oldBytes, meta.frames)
  const outputLeft = inputLeft.slice()
  const outputRight = inputRight.slice()
  for (let offset = 0; offset < meta.frames; offset += meta.blockSize) {
    const end = Math.min(offset + meta.blockSize, meta.frames)
    process(outputLeft.subarray(offset, end), outputRight.subarray(offset, end))
  }
  const candidate = Buffer.alloc(meta.frames * 16)
  let byteOffset = 0
  for (const segment of [inputLeft, inputRight, outputLeft, outputRight]) {
    for (const sample of segment) {
      candidate.writeFloatLE(sample, byteOffset)
      byteOffset += 4
    }
  }
  return candidate
}

export async function verifyAndStamp(moduleName) {
  const checkout = process.argv[2]
  if (!checkout) throw new Error(`usage: node generate-${moduleName}-vectors.mjs <hse-v1.5.1-checkout>`)
  const root = resolve(checkout)
  verifyCheckout(root)
  const buildCommand = process.platform === 'win32'
    ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build']]
    : ['npm', ['run', 'build']]
  execFileSync(buildCommand[0], buildCommand[1], { cwd: root, stdio: 'inherit' })
  const hse = await import(pathToFileURL(resolve(root, 'dist/index.js')))
  const outputDirectory = resolve(import.meta.dirname)
  const names = readdirSync(outputDirectory)
    .filter((name) => name.startsWith(`${moduleName}.`) && name.endsWith('.json'))
    .sort()
  if (names.length === 0) throw new Error(`no ${moduleName} vectors found`)

  let mismatches = 0
  for (const name of names) {
    const jsonPath = resolve(outputDirectory, name)
    const meta = JSON.parse(readFileSync(jsonPath, 'utf8'))
    const label = name.replace(/\.json$/, '')
    const oldBytes = readFileSync(resolve(outputDirectory, `${label}.f32`))
    const processBlock = standaloneProcessor(moduleName, meta, hse) ?? engineProcessor(moduleName, meta, hse)
    if (!processBlock) throw new Error(`unsupported generator module: ${moduleName}`)
    const candidate = candidateBytes(meta, oldBytes, processBlock)
    const mismatch = Buffer.compare(candidate, oldBytes)
    if (mismatch !== 0) {
      let first = 0
      while (first < candidate.length && candidate[first] === oldBytes[first]) first++
      console.error(`${label}: mismatch at byte ${first}; provenance not changed`)
      mismatches++
      continue
    }
    meta.source = EXPECTED_SOURCE
    writeFileSync(jsonPath, `${JSON.stringify(meta, null, 2)}\n`)
    console.log(`${label}: byte-identical; source recorded`)
  }
  if (mismatches > 0) process.exitCode = 1
}

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXPECTED_COMMIT = 'f7017621b7d84005fbfed8a3c42a119487a17326'
const checkout = process.argv[2]
if (!checkout) throw new Error('usage: node generate-night-mode-vectors.mjs <hse-v1.5.1-checkout>')
const root = resolve(checkout)
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (commit !== EXPECTED_COMMIT) throw new Error(`unexpected HSE commit: ${commit}`)
const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
if (status.trim() !== '') throw new Error('HSE checkout must be clean before generating vectors')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
if (pkg.version !== '1.5.1') throw new Error(`unexpected HSE version: ${pkg.version}`)
const buildCommand = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build']]
  : ['npm', ['run', 'build']]
execFileSync(buildCommand[0], buildCommand[1], { cwd: root, stdio: 'inherit' })
const { HyperSoundEngine, createDefaultParams } = await import(pathToFileURL(resolve(root, 'dist/index.js')))
const outputDirectory = resolve(import.meta.dirname)

function lcgNoise(frames, seed, amplitude) {
  const output = new Float32Array(frames)
  let state = seed >>> 0
  for (let index = 0; index < frames; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    output[index] = ((state / 4294967296) * 2 - 1) * amplitude
  }
  return output
}

function sineSum(frames, sampleRate, components) {
  const output = new Float32Array(frames)
  for (let index = 0; index < frames; index++) {
    let sample = 0
    for (const component of components) {
      sample += component.amplitude * Math.sin(2 * Math.PI * component.frequency * index / sampleRate + component.phase)
    }
    output[index] = sample
  }
  return output
}

function neutralize(params) {
  params.eq.enabled = false
  params.deesser.enabled = false
  params.compressor.enabled = false
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

function writeVector(spec) {
  const params = createDefaultParams(spec.sampleRate)
  neutralize(params)
  params.compressor = { ...params.compressor, ...spec.compressor, enabled: false }
  params.nightMode = { enabled: true, amount: spec.amount }
  const engine = new HyperSoundEngine(spec.sampleRate, 2)
  engine.setParams(params)
  engine.prepare(spec.blockSize)
  const outputLeft = new Float32Array(spec.frames)
  const outputRight = new Float32Array(spec.frames)
  for (let offset = 0; offset < spec.frames; offset += spec.blockSize) {
    const end = Math.min(offset + spec.blockSize, spec.frames)
    const blockLeft = new Float32Array(end - offset)
    const blockRight = new Float32Array(end - offset)
    engine.process([spec.inputLeft.subarray(offset, end), spec.inputRight.subarray(offset, end)], [blockLeft, blockRight])
    outputLeft.set(blockLeft, offset)
    outputRight.set(blockRight, offset)
  }
  const bytes = Buffer.alloc(spec.frames * 16)
  let byteOffset = 0
  for (const segment of [spec.inputLeft, spec.inputRight, outputLeft, outputRight]) {
    for (const sample of segment) {
      bytes.writeFloatLE(sample, byteOffset)
      byteOffset += 4
    }
  }
  const label = `night-mode.${spec.case}`
  writeFileSync(resolve(outputDirectory, `${label}.f32`), bytes)
  writeFileSync(resolve(outputDirectory, `${label}.json`), `${JSON.stringify({
    schemaVersion: 1,
    module: 'night-mode',
    case: spec.case,
    sampleRate: spec.sampleRate,
    blockSize: spec.blockSize,
    channels: 2,
    frames: spec.frames,
    params: { enabled: true, amount: spec.amount, compressor: params.compressor },
    tolerance: { kind: 'relative', value: 0.000001, floor: 1e-9 },
    source: { project: 'HyperSoundEngine', version: '1.5.1', commit: EXPECTED_COMMIT },
    notes: spec.notes,
  }, null, 2)}\n`)
}

const base = { thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 0, outputGain: 1, sidechainEnabled: false }
const cases = [
  { case: 'case1', sampleRate: 48000, blockSize: 128, frames: 1025, amount: 0, compressor: base, inputLeft: lcgNoise(1025, 93001, 0.7), inputRight: sineSum(1025, 48000, [{ frequency: 997, amplitude: 0.5, phase: Math.PI / 7 }]), notes: 'enabled=true 且 amount=0 的逐位旁路，包含 1 帧尾块。' },
  { case: 'case2', sampleRate: 48000, blockSize: 128, frames: 4097, amount: 1, compressor: base, inputLeft: sineSum(4097, 48000, [{ frequency: 1000, amplitude: 0.72, phase: 0 }, { frequency: 8000, amplitude: 0.2, phase: Math.PI / 4 }]), inputRight: lcgNoise(4097, 93002, 0.35), notes: '低强度 linked compression 与 6 kHz shelf，包含 1 帧尾块。' },
  { case: 'case3', sampleRate: 48000, blockSize: 333, frames: 12345, amount: 8, compressor: { thresholdDb: -24, ratio: 5, kneeDb: 8, attackMs: 4, releaseMs: 120, makeupDb: 1.5, outputGain: 0.25, sidechainEnabled: true }, inputLeft: sineSum(12345, 48000, [{ frequency: 180, amplitude: 0.7, phase: 0 }, { frequency: 7200, amplitude: 0.25, phase: Math.PI / 3 }]), inputRight: lcgNoise(12345, 93003, 0.65), notes: 'amount=8；base sidechain 与 outputGain 被 Night 忽略；333 帧跨块与尾块。' },
  { case: 'case4', sampleRate: 44100, blockSize: 257, frames: 8234, amount: 10, compressor: { thresholdDb: -30, ratio: 8, kneeDb: 0, attackMs: 0.2, releaseMs: 300, makeupDb: -2, outputGain: 2, sidechainEnabled: false }, inputLeft: sineSum(8234, 44100, [{ frequency: 73, amplitude: 0.82, phase: 0 }, { frequency: 9000, amplitude: 0.18, phase: Math.PI / 5 }]), inputRight: lcgNoise(8234, 93004, 0.75), notes: '满强度、硬 knee、44.1 kHz 与 10 帧尾块。' },
]
for (const spec of cases) writeVector(spec)

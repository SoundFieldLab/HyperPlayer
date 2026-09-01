import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXPECTED_COMMIT = 'f7017621b7d84005fbfed8a3c42a119487a17326'
const checkout = process.argv[2]
if (!checkout) throw new Error('usage: node generate-tremolo-vectors.mjs <hse-v1.5.1-checkout>')
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
const { TremoloEffect } = await import(pathToFileURL(resolve(root, 'dist/index.js')))
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
    for (const component of components) sample += component.amplitude * Math.sin(2 * Math.PI * component.frequency * index / sampleRate + component.phase)
    output[index] = sample
  }
  return output
}

function processVector(spec, chunked) {
  const effect = new TremoloEffect(spec.sampleRate)
  effect.setParams(spec.params)
  const outputLeft = spec.inputLeft.slice()
  const outputRight = spec.inputRight.slice()
  if (chunked) {
    for (let offset = 0; offset < spec.frames; offset += spec.blockSize) {
      const end = Math.min(offset + spec.blockSize, spec.frames)
      effect.processStereo(outputLeft.subarray(offset, end), outputRight.subarray(offset, end))
    }
  } else {
    effect.processStereo(outputLeft, outputRight)
  }
  return [outputLeft, outputRight]
}

function assertBitExact(actual, expected, label) {
  const actualBytes = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
  const expectedBytes = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)
  if (!actualBytes.equals(expectedBytes)) throw new Error(`${label} is not block invariant`)
}

function writeVector(spec) {
  const [outputLeft, outputRight] = processVector(spec, true)
  const [wholeLeft, wholeRight] = processVector(spec, false)
  assertBitExact(outputLeft, wholeLeft, `${spec.case} left output`)
  assertBitExact(outputRight, wholeRight, `${spec.case} right output`)

  const bytes = Buffer.alloc(spec.frames * 16)
  let byteOffset = 0
  for (const segment of [spec.inputLeft, spec.inputRight, outputLeft, outputRight]) {
    for (const sample of segment) {
      bytes.writeFloatLE(sample, byteOffset)
      byteOffset += 4
    }
  }
  const label = `tremolo.${spec.case}`
  writeFileSync(resolve(outputDirectory, `${label}.f32`), bytes)
  writeFileSync(resolve(outputDirectory, `${label}.json`), `${JSON.stringify({
    schemaVersion: 1, module: 'tremolo', case: spec.case, sampleRate: spec.sampleRate,
    blockSize: spec.blockSize, channels: 2, frames: spec.frames, params: spec.params,
    tolerance: { kind: 'relative', value: 0.000001, floor: 1e-9 },
    source: { project: 'HyperSoundEngine', version: '1.5.1', commit: EXPECTED_COMMIT }, notes: spec.notes,
  }, null, 2)}\n`)
}

const cases = [
  { case: 'case1', sampleRate: 44100, blockSize: 480, frames: 6000, params: { enabled: true, rateHz: 8, depth: 0.7, mix: 1 }, inputLeft: sineSum(6000, 44100, [{ frequency: 600, amplitude: 0.6, phase: 0 }, { frequency: 2400, amplitude: 0.3, phase: Math.PI / 4 }]), inputRight: lcgNoise(6000, 86004, 0.5), notes: '采用 HSE 官方 mod-effects.case4 的 Tremolo 参数与输入，独立排除 Phaser；480 帧块和 240 帧尾块。' },
  { case: 'case2', sampleRate: 48000, blockSize: 257, frames: 2057, params: { enabled: true, rateHz: 30, depth: 1, mix: 1 }, inputLeft: lcgNoise(2057, 98002, 0.65), inputRight: sineSum(2057, 48000, [{ frequency: 997, amplitude: 0.55, phase: Math.PI / 6 }]), notes: 'rate、depth 与 mix 参数上界，包含 1 帧尾块。' },
  { case: 'case3', sampleRate: 8000, blockSize: 31, frames: 1003, params: { enabled: true, rateHz: 0.01, depth: 1, mix: 0 }, inputLeft: sineSum(1003, 8000, [{ frequency: 211, amplitude: 0.7, phase: 0 }]), inputRight: lcgNoise(1003, 98003, 0.45), notes: 'rate 参数下界与 mix=0 音频逐位恒等，但 phase 继续推进；包含 11 帧尾块。' },
  { case: 'case4', sampleRate: 96000, blockSize: 511, frames: 4099, params: { enabled: true, rateHz: 3.25, depth: 0.35, mix: 0.63 }, inputLeft: lcgNoise(4099, 98004, 0.72), inputRight: sineSum(4099, 96000, [{ frequency: 173, amplitude: 0.4, phase: Math.PI / 5 }, { frequency: 6400, amplitude: 0.22, phase: Math.PI / 2 }]), notes: '96 kHz、分数 depth/mix 与 11 帧尾块。' },
]
for (const spec of cases) writeVector(spec)

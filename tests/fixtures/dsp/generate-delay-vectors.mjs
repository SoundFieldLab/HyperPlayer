import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXPECTED_COMMIT = 'f7017621b7d84005fbfed8a3c42a119487a17326'
const checkout = process.argv[2]
if (!checkout) throw new Error('usage: node generate-delay-vectors.mjs <hse-v1.5.1-checkout>')
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
const { DelayEffect } = await import(pathToFileURL(resolve(root, 'dist/index.js')))
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

function burstThenSilence(input, activeFrames) {
  input.fill(0, activeFrames)
  return input
}

function writeVector(spec) {
  const delay = new DelayEffect(spec.sampleRate)
  delay.setParams(spec.params)
  const outputLeft = spec.inputLeft.slice()
  const outputRight = spec.inputRight.slice()
  for (let offset = 0; offset < spec.frames; offset += spec.blockSize) {
    const end = Math.min(offset + spec.blockSize, spec.frames)
    delay.processStereo(outputLeft.subarray(offset, end), outputRight.subarray(offset, end))
  }

  const bytes = Buffer.alloc(spec.frames * 16)
  let byteOffset = 0
  for (const segment of [spec.inputLeft, spec.inputRight, outputLeft, outputRight]) {
    for (const sample of segment) {
      bytes.writeFloatLE(sample, byteOffset)
      byteOffset += 4
    }
  }
  const label = `delay.${spec.case}`
  writeFileSync(resolve(outputDirectory, `${label}.f32`), bytes)
  writeFileSync(resolve(outputDirectory, `${label}.json`), `${JSON.stringify({
    schemaVersion: 1,
    module: 'delay',
    case: spec.case,
    sampleRate: spec.sampleRate,
    blockSize: spec.blockSize,
    channels: 2,
    frames: spec.frames,
    params: spec.params,
    tolerance: { kind: 'relative', value: 0.000001, floor: 1e-9 },
    source: { project: 'HyperSoundEngine', version: '1.5.1', commit: EXPECTED_COMMIT },
    notes: spec.notes,
  }, null, 2)}\n`)
}

const cases = [
  {
    case: 'case1', sampleRate: 48000, blockSize: 333, frames: 6000,
    params: { enabled: true, delayMs: 40, feedback: 0.55, mix: 0.4 },
    inputLeft: burstThenSilence(sineSum(6000, 48000, [{ frequency: 1000, amplitude: 0.8, phase: 0 }, { frequency: 2500, amplitude: 0.3, phase: Math.PI / 3 }]), 3000),
    inputRight: lcgNoise(6000, 86002, 0.5),
    notes: '精确复刻 HSE 官方 mod-effects.case2 的 Delay-only 参数、输入与 6 帧尾块。',
  },
  {
    case: 'case2', sampleRate: 8000, blockSize: 17, frames: 211,
    params: { enabled: true, delayMs: 0.1875, feedback: 0.6, mix: 0.75 },
    inputLeft: sineSum(211, 8000, [{ frequency: 311, amplitude: 0.7, phase: 0 }]),
    inputRight: lcgNoise(211, 94002, 0.45),
    notes: '1.5 样本分数延迟，覆盖线性插值、读后写和 7 帧尾块。',
  },
  {
    case: 'case3', sampleRate: 32, blockSize: 9, frames: 70,
    params: { enabled: true, delayMs: 0, feedback: 0.98, mix: 1 },
    inputLeft: Float32Array.from({ length: 70 }, (_, index) => index === 0 ? 1 : 0),
    inputRight: Float32Array.from({ length: 70 }, (_, index) => index === 1 ? -0.75 : 0),
    notes: 'delayMs=0 的整环旧槽读取语义、最大反馈和纯 wet，包含 7 帧尾块。',
  },
  {
    case: 'case4', sampleRate: 100, blockSize: 37, frames: 240,
    params: { enabled: true, delayMs: 2000, feedback: 0, mix: 0.5 },
    inputLeft: lcgNoise(240, 94004, 0.8),
    inputRight: sineSum(240, 100, [{ frequency: 7, amplitude: 0.65, phase: Math.PI / 5 }]),
    notes: '2 秒最大延迟、零反馈、干湿各半，覆盖 size-1 索引与 18 帧尾块。',
  },
]

for (const spec of cases) writeVector(spec)

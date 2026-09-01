import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXPECTED_COMMIT = 'f7017621b7d84005fbfed8a3c42a119487a17326'
const checkout = process.argv[2]
if (!checkout) throw new Error('usage: node generate-chorus-vectors.mjs <hse-v1.5.1-checkout>')
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
const { ChorusEffect } = await import(pathToFileURL(resolve(root, 'dist/index.js')))
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

function writeVector(spec) {
  const chorus = new ChorusEffect(spec.sampleRate)
  chorus.setParams(spec.params)
  const outputLeft = spec.inputLeft.slice()
  const outputRight = spec.inputRight.slice()
  for (let offset = 0; offset < spec.frames; offset += spec.blockSize) {
    const end = Math.min(offset + spec.blockSize, spec.frames)
    chorus.processStereo(outputLeft.subarray(offset, end), outputRight.subarray(offset, end))
  }
  const bytes = Buffer.alloc(spec.frames * 16)
  let byteOffset = 0
  for (const segment of [spec.inputLeft, spec.inputRight, outputLeft, outputRight]) {
    for (const sample of segment) {
      bytes.writeFloatLE(sample, byteOffset)
      byteOffset += 4
    }
  }
  const label = `chorus.${spec.case}`
  writeFileSync(resolve(outputDirectory, `${label}.f32`), bytes)
  writeFileSync(resolve(outputDirectory, `${label}.json`), `${JSON.stringify({
    schemaVersion: 1,
    module: 'chorus',
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
    case: 'case1', sampleRate: 48000, blockSize: 128, frames: 4097,
    params: { enabled: true, rateHz: 1, depthMs: 3, mix: 0.4 },
    inputLeft: sineSum(4097, 48000, [{ frequency: 440, amplitude: 0.55, phase: 0 }, { frequency: 3100, amplitude: 0.18, phase: Math.PI / 5 }]),
    inputRight: lcgNoise(4097, 95001, 0.5),
    notes: '默认 Chorus 参数，覆盖块级 LFO 递进和 1 帧尾块。',
  },
  {
    case: 'case2', sampleRate: 48000, blockSize: 333, frames: 12000,
    params: { enabled: true, rateHz: 4, depthMs: 5, mix: 0.5 },
    inputLeft: sineSum(12000, 48000, [{ frequency: 440, amplitude: 0.5, phase: 0 }, { frequency: 1320, amplitude: 0.25, phase: Math.PI / 5 }]),
    inputRight: lcgNoise(12000, 86003, 0.5),
    notes: '采用 HSE 官方 mod-effects.case3 的 Chorus 参数与输入，独立排除 Flanger；333 帧块和 12 帧尾块。',
  },
  {
    case: 'case3', sampleRate: 8000, blockSize: 31, frames: 1003,
    params: { enabled: true, rateHz: 20, depthMs: 50, mix: 1 },
    inputLeft: lcgNoise(1003, 95003, 0.7),
    inputRight: sineSum(1003, 8000, [{ frequency: 211, amplitude: 0.65, phase: Math.PI / 7 }]),
    notes: 'rate/depth/mix 上界；负半周触发 d<1 环形旧槽语义，包含 11 帧尾块。',
  },
  {
    case: 'case4', sampleRate: 44100, blockSize: 257, frames: 2057,
    params: { enabled: true, rateHz: 0.01, depthMs: 17.25, mix: 0 },
    inputLeft: sineSum(2057, 44100, [{ frequency: 997, amplitude: 0.58, phase: 0 }]),
    inputRight: lcgNoise(2057, 95004, 0.62),
    notes: 'rate 下界、分数 depth、mix=0 音频逐位恒等但 ring/phase 继续推进，含 1 帧尾块。',
  },
]

for (const spec of cases) writeVector(spec)

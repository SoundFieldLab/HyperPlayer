import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildUpdateManifest,
  findHotUpdate,
  findInstaller,
  sha256File,
  writeUpdateManifest,
} from '../scripts/lib/update-manifest.mjs'

const directories: string[] = []

function fixture(files: Record<string, string> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperplayer-update-manifest-'))
  directories.push(directory)
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content)
  }
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('update manifest module', () => {
  it('识别安装包与热更新包', () => {
    expect(findInstaller(['readme.txt', 'HyperPlayer-1.0.1-Setup.exe'])).toBe('HyperPlayer-1.0.1-Setup.exe')
    expect(findHotUpdate(['readme.txt', 'hyperplayer-hot-1.0.1.zip'])).toBe('hyperplayer-hot-1.0.1.zip')
    expect(findInstaller(['readme.txt'])).toBeUndefined()
  })

  it('stable 清单包含安装包与热更新包，并写入摘要', () => {
    const directory = fixture({
      'HyperPlayer-1.0.1-Setup.exe': 'installer',
      'hyperplayer-hot-1.0.1.zip': 'hot',
    })
    const manifest = buildUpdateManifest({
      channel: 'stable',
      version: '1.0.1',
      tag: 'v1.0.1',
      repo: 'SoundFieldLab/HyperPlayer',
      notes: '修复若干问题\n',
      artifactsDir: directory,
    })

    expect(manifest.channel).toBe('stable')
    expect(manifest.version).toBe('1.0.1')
    expect(manifest.notes).toBe('修复若干问题')
    expect(manifest.artifacts['win-x64']).toEqual({
      urls: ['https://github.com/SoundFieldLab/HyperPlayer/releases/download/v1.0.1/HyperPlayer-1.0.1-Setup.exe'],
      sha256: crypto.createHash('sha256').update('installer').digest('hex'),
    })
    expect(manifest.artifacts['win-x64-hot']).toEqual({
      urls: ['https://github.com/SoundFieldLab/HyperPlayer/releases/download/v1.0.1/hyperplayer-hot-1.0.1.zip'],
      sha256: crypto.createHash('sha256').update('hot').digest('hex'),
    })
  })

  it('nightly 清单只包含安装包', () => {
    const directory = fixture({
      'HyperPlayer-1.0.2-nightly.20261105-Setup.exe': 'installer',
      'hyperplayer-hot-1.0.2-nightly.20261105.zip': 'hot',
    })
    const manifest = buildUpdateManifest({
      channel: 'nightly',
      version: '1.0.2-nightly.20261105',
      tag: 'nightly-20261105',
      repo: 'SoundFieldLab/HyperPlayer',
      notes: 'nightly',
      artifactsDir: directory,
    })

    expect(manifest.channel).toBe('nightly')
    expect(manifest.artifacts['win-x64']).toBeDefined()
    expect(manifest.artifacts['win-x64-hot']).toBeUndefined()
  })

  it('缺少安装包时直接失败', () => {
    const directory = fixture({ 'notes.txt': 'no installer' })
    expect(() => buildUpdateManifest({
      channel: 'stable',
      version: '1.0.1',
      tag: 'v1.0.1',
      repo: 'SoundFieldLab/HyperPlayer',
      notes: '',
      artifactsDir: directory,
    })).toThrow(/未找到 NSIS 安装包/)
  })

  it('写入文件时带末尾换行', () => {
    const directory = fixture({ 'HyperPlayer-1.0.1-Setup.exe': 'installer' })
    const output = path.join(directory, 'update.json')
    writeUpdateManifest({
      channel: 'stable',
      version: '1.0.1',
      tag: 'v1.0.1',
      repo: 'SoundFieldLab/HyperPlayer',
      notes: 'notes',
      artifactsDir: directory,
      outputPath: output,
    })

    const raw = fs.readFileSync(output, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw).channel).toBe('stable')
  })

  it('sha256File 对文件内容取摘要', () => {
    const directory = fixture({ 'a.bin': 'abc' })
    expect(sha256File(path.join(directory, 'a.bin')))
      .toBe(crypto.createHash('sha256').update('abc').digest('hex'))
  })

  it('CLI 读取 notes-file 并写出指定清单', () => {
    const directory = fixture({
      'HyperPlayer-1.0.1-Setup.exe': 'installer',
      'notes.md': 'cli notes\n',
    })
    const output = path.join(directory, 'update.json')
    const script = fileURLToPath(new URL('../scripts/build-update-manifest.mjs', import.meta.url))
    execFileSync(process.execPath, [
      script,
      '--channel', 'stable',
      '--version', '1.0.1',
      '--tag', 'v1.0.1',
      '--repo', 'SoundFieldLab/HyperPlayer',
      '--notes-file', path.join(directory, 'notes.md'),
      '--artifacts', directory,
      '--output', output,
    ], { encoding: 'utf8' })

    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({
      channel: 'stable',
      version: '1.0.1',
      notes: 'cli notes',
    })
  })

  it('CLI 支持 nightly 且不写入 hot', () => {
    const directory = fixture({
      'HyperPlayer-1.0.2-nightly.20261105-Setup.exe': 'installer',
      'hyperplayer-hot-1.0.2-nightly.20261105.zip': 'hot',
      'notes.md': 'nightly notes\n',
    })
    const output = path.join(directory, 'update-nightly.json')
    const script = fileURLToPath(new URL('../scripts/build-update-manifest.mjs', import.meta.url))
    execFileSync(process.execPath, [
      script,
      '--channel', 'nightly',
      '--version', '1.0.2-nightly.20261105',
      '--tag', 'nightly-20261105',
      '--repo', 'SoundFieldLab/HyperPlayer',
      '--notes-file', path.join(directory, 'notes.md'),
      '--artifacts', directory,
      '--output', output,
    ], { encoding: 'utf8' })

    const manifest = JSON.parse(fs.readFileSync(output, 'utf8'))
    expect(manifest.channel).toBe('nightly')
    expect(manifest.artifacts['win-x64-hot']).toBeUndefined()
  })

  it('CLI 缺安装包时返回非零退出码', () => {
    const directory = fixture({ 'notes.md': 'notes\n' })
    const script = fileURLToPath(new URL('../scripts/build-update-manifest.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [
      script,
      '--channel', 'stable',
      '--version', '1.0.1',
      '--tag', 'v1.0.1',
      '--repo', 'SoundFieldLab/HyperPlayer',
      '--notes-file', path.join(directory, 'notes.md'),
      '--artifacts', directory,
      '--output', path.join(directory, 'update.json'),
    ], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('未找到 NSIS 安装包')
  })

})

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 两个固定清单文件名：与客户端共同读取 shared/update-manifest-files.json。 */
export const UPDATE_MANIFEST_FILES = Object.freeze(
  JSON.parse(fs.readFileSync(new URL('../../shared/update-manifest-files.json', import.meta.url), 'utf8')),
)

export function isUpdateChannel(value) {
  return value === 'stable' || value === 'nightly'
}

const INSTALLER_PATTERN = /-Setup\.exe$/i
const HOT_UPDATE_PATTERN = /^hyperplayer-hot-.*\.zip$/i

export function findInstaller(files) {
  return files.find(file => INSTALLER_PATTERN.test(file))
}

export function findHotUpdate(files) {
  return files.find(file => HOT_UPDATE_PATTERN.test(file))
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

/**
 * 生成 stable / nightly 更新清单。
 * stable 可选携带热更新包；nightly 只带安装包。
 */
export function buildUpdateManifest({
  channel,
  version,
  tag,
  repo,
  notes,
  artifactsDir = 'artifacts',
}) {
  if (!isUpdateChannel(channel)) {
    throw new Error(`未知更新渠道: ${channel || '(empty)'}`)
  }
  if (!version || !tag || !repo) {
    throw new Error('version / tag / repo 均为必填')
  }
  if (typeof notes !== 'string') {
    throw new Error('notes 必须是字符串')
  }

  const files = fs.readdirSync(artifactsDir)
  const installer = findInstaller(files)
  if (!installer) throw new Error('未找到 NSIS 安装包（*-Setup.exe）')

  const base = `https://github.com/${repo}/releases/download/${tag}`
  const artifacts = {
    'win-x64': {
      urls: [`${base}/${installer}`],
      sha256: sha256File(path.join(artifactsDir, installer)),
    },
  }

  const wantHot = channel === 'stable'
  if (wantHot) {
    const hot = findHotUpdate(files)
    if (hot) {
      artifacts['win-x64-hot'] = {
        urls: [`${base}/${hot}`],
        sha256: sha256File(path.join(artifactsDir, hot)),
      }
    }
  }

  return {
    channel,
    version,
    notes: notes.trim(),
    artifacts,
  }
}

export function writeUpdateManifest(options) {
  const manifest = buildUpdateManifest(options)
  const outputPath = options.outputPath || UPDATE_MANIFEST_FILES[options.channel]
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { manifest, outputPath }
}

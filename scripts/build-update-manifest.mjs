#!/usr/bin/env node

import fs from 'node:fs'
import {
  UPDATE_MANIFEST_FILES,
  isUpdateChannel,
  writeUpdateManifest,
} from './lib/update-manifest.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`无法识别的参数: ${token}`)
    const equals = token.indexOf('=')
    if (equals >= 0) {
      args[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数缺少值: ${token}`)
    }
    args[key] = value
    index += 1
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const channel = args.channel
  if (!isUpdateChannel(channel)) {
    throw new Error('--channel 必须是 stable 或 nightly')
  }
  const version = args.version
  const tag = args.tag
  const repo = args.repo
  const notesFile = args['notes-file']
  if (!version || !tag || !repo || !notesFile) {
    throw new Error('--version / --tag / --repo / --notes-file 均为必填')
  }

  const notes = fs.readFileSync(notesFile, 'utf8')
  const outputPath = args.output || UPDATE_MANIFEST_FILES[channel]
  const { manifest } = writeUpdateManifest({
    channel,
    version,
    tag,
    repo,
    notes,
    artifactsDir: args.artifacts || 'artifacts',
    outputPath,
  })

  console.log(`已生成 ${outputPath}：`)
  console.log(JSON.stringify(manifest, null, 2))
}

try {
  main()
} catch (error) {
  console.error(`生成更新清单失败: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}

#!/usr/bin/env node
/**
 * 校验打包产物内 app.asar 的结构自洽 —— electron-builder 静默产坏包的兜底闸门。
 *
 * 为什么需要
 * ----------
 * electron-builder 打包 asar 分两步：先枚举文件尺寸、写出头部（含每个文件的
 * offset/size），再拷贝文件内容。若这两步之间有文件被编辑，头部声明的尺寸与
 * 实体字节数就会错位 —— 产出的 asar **Node 侧（@electron/asar）仍能读、也没有
 * 任何构建报错**，但 Electron 加载时会读出错位数据，导致 package.json 解析失败、
 * 整个应用起不来（症状：启动后停在 Electron 默认页/帮助文案，`.asar` 看起来好好的）。
 *
 * 2026-09-13 实测踩过：构建进行中编辑了 desktop/main.cjs（注释减 227 字节），
 * 头部声明 350392 而实体只有 350165，其后所有条目整体左移 227 字节 —— 排障花了
 * 半小时才定位。此脚本把这类问题在构建链内即时打回，避免坏包溜进发布。
 *
 * 校验项
 * ------
 *   1. asar 头部（pickle 前缀 + JSON）可解析；
 *   2. 每个文件条目 offset+size 不越过数据区末尾（越过 = 打包期文件被改）；
 *   3. package.json 可完整读出且 JSON 可解析（Electron 加载 app 的第一入口）。
 *
 * 用法：node scripts/verify-asar.cjs [packageDir|app.asar]
 *   默认 packageDir = release/win-unpacked（取其中的 resources/app.asar）。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const input = process.argv[2] || 'release/win-unpacked'
const resolved = path.resolve(ROOT, input)
const asarPath = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
  ? resolved
  : path.join(resolved, 'resources', 'app.asar')

function fail(message) {
  console.error(`[verify-asar] ✗ ${message}`)
  process.exit(1)
}

let fd
try {
  fd = fs.openSync(asarPath, 'r')
} catch (error) {
  fail(`打不开 ${asarPath}：${error.message}`)
}

try {
  const fileSize = fs.fstatSync(fd).size
  if (fileSize < 16) fail(`asar 过小（${fileSize} 字节），疑似损坏`)

  // ── pickle 前缀：[0..4)=4，[4..8)=载荷大小 P，[8..12)=内层载荷，[12..16)=JSON 字节数 ──
  const prefix = Buffer.alloc(16)
  fs.readSync(fd, prefix, 0, 16, 0)
  const pickleSizeField = prefix.readUInt32LE(0)
  const headerPayload = prefix.readUInt32LE(4)
  const jsonLen = prefix.readUInt32LE(12)
  if (pickleSizeField !== 4) fail(`asar 前缀异常（首个字段应为 4，实为 ${pickleSizeField}）`)

  const dataStart = 8 + headerPayload
  const dataArea = fileSize - dataStart
  if (jsonLen <= 0 || jsonLen > headerPayload || dataStart > fileSize) fail('asar 头部尺寸字段自相矛盾')

  const headerBuf = Buffer.alloc(jsonLen)
  fs.readSync(fd, headerBuf, 0, jsonLen, 16)
  let header
  try {
    header = JSON.parse(headerBuf.toString('utf8'))
  } catch (error) {
    fail(`asar 头部 JSON 解析失败：${error.message}`)
  }

  // ── 遍历条目：找越界者（打包期文件被改的直接证据）──
  const overflows = []
  let maxEnd = 0
  let fileCount = 0
  const walk = (node, name) => {
    if (!node || typeof node !== 'object') return
    if (node.files) {
      for (const key of Object.keys(node.files)) walk(node.files[key], `${name}/${key}`)
      return
    }
    if (typeof node.size !== 'number' || typeof node.offset !== 'string') return // 目录/unpacked/链接条目
    fileCount++
    const end = Number(node.offset) + node.size
    if (end > maxEnd) maxEnd = end
    if (end > dataArea) overflows.push({ name, end, over: end - dataArea })
  }
  walk(header, '')

  if (overflows.length > 0) {
    const sample = overflows.slice(0, 3).map((e) => `${e.name}（超出 ${e.over} 字节）`).join('、')
    fail(
      `asar 数据区比头部声明短 ${overflows[0].over} 字节，${overflows.length} 个条目越界：${sample}\n`
      + '  原因几乎总是：打包（electron-builder）进行中仓库文件被编辑。请勿在构建期间改动仓库，重新构建即可。',
    )
  }

  // ── package.json：Electron 加载 app 的第一入口，必须能完整读出并解析 ──
  const pkgNode = header.files && header.files['package.json']
  if (!pkgNode || typeof pkgNode.offset !== 'string') fail('asar 内缺少 package.json（Electron 将无法识别应用）')
  const pkgBuf = Buffer.alloc(pkgNode.size)
  fs.readSync(fd, pkgBuf, 0, pkgNode.size, dataStart + Number(pkgNode.offset))
  let pkg
  try {
    pkg = JSON.parse(pkgBuf.toString('utf8'))
  } catch (error) {
    fail(`asar 内 package.json 无法解析（条目错位的典型症状）：${error.message}`)
  }
  if (!pkg.main) fail('package.json 缺少 main 字段')

  console.log(
    `[verify-asar] ✓ ${path.relative(ROOT, asarPath)} 结构自洽`
    + `（${fileCount} 个文件条目，数据区 ${dataArea} 字节，余量 ${dataArea - maxEnd} 字节，main=${pkg.main}）`,
  )
} finally {
  fs.closeSync(fd)
}

/** Generate the 24-bit BMP assets used by the native NSIS setup UI. */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'build', 'ui')
const FONT = 'Microsoft YaHei UI, Microsoft YaHei, SimHei, sans-serif'
const { version: APP_VERSION } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const logoB64 = readFileSync(join(ROOT, 'logo.png')).toString('base64')
const W = 880
const H = 580
const RAIL = 232
const CX = 280
const ANIM_X = 280
const ANIM_Y = 532
const ANIM_W = 600
const ANIM_H = H - ANIM_Y
const FRAME_COUNT = 16
const CLOSE_LEVELS = 6
const SS_SCALE = 4
const DPI_SCALES = [1]

const THEMES = {
  dark: { railInk: '#EAF0F8', railSub: '#8FA1B7', railDone: '#C6D2E0', railDot: '#3A4B62', bg: '#151D29', rail: '#111925', panel: '#1D2838', panel2: '#263448', tx: '#EAF0F8', sub: '#AAB8CB', brand: '#4075DD', brand2: '#DDA177', border: '#35465D', edit: '#182231' },
  light: { railInk: '#1B2A3E', railSub: '#596B80', railDone: '#5F7288', railDot: '#D2DCE6', bg: '#F8FAFC', rail: '#EEF3F8', panel: '#FFFFFF', panel2: '#F0F4F8', tx: '#18273B', sub: '#596B80', brand: '#2864D7', brand2: '#B45B28', border: '#D6E0EA', edit: '#FFFFFF' },
}
const PHASES = ['欢迎', '用户协议', '安装目录', '正在安装', '安装完成']

function encodeBmp(width, height, rgb) {
  width = Math.round(width)
  height = Math.round(height)
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const buf = Buffer.alloc(54 + rowSize * height)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(rowSize * height, 34)
  for (let y = 0; y < height; y += 1) {
    const src = (height - 1 - y) * width * 3
    const dst = 54 + y * rowSize
    for (let x = 0; x < width; x += 1) {
      buf[dst + x * 3] = rgb[src + x * 3 + 2]
      buf[dst + x * 3 + 1] = rgb[src + x * 3 + 1]
      buf[dst + x * 3 + 2] = rgb[src + x * 3]
    }
  }
  return buf
}

async function svgToRgb(svg, width, height) {
  // 位图按逻辑坐标排版，但以 SS_SCALE 倍率栅格化后再精确下采样：低位深 BMP 没有 alpha，
  // 直接 1× 渲染的圆角、描边和中文小字边缘会发毛。超采样后边缘才是干净的抗锯齿。
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 * SS_SCALE })
    .resize(Math.round(width), Math.round(height), { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rgb = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    const p = i * info.channels
    rgb[i * 3] = data[p]
    rgb[i * 3 + 1] = data[p + 1]
    rgb[i * 3 + 2] = data[p + 2]
  }
  return rgb
}

async function svgToBmp(svg, width, height) {
  return encodeBmp(width, height, await svgToRgb(svg, width, height))
}

function cropRgb(rgb, sourceWidth, left, top, width, height) {
  const out = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const start = ((top + y) * sourceWidth + left) * 3
    rgb.copy(out, y * width * 3, start, start + width * 3)
  }
  return out
}

function esc(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function rail(theme, phase, phaseNames = PHASES) {
  const t = THEMES[theme]
  const railText = t.railInk
  const railSub = t.railSub
  let steps = ''
  phaseNames.forEach((name, index) => {
    const n = index + 1
    const y = 218 + index * 53
    const done = n < phase
    const active = n === phase
    steps += `<circle cx="47" cy="${y}" r="8" fill="${done ? t.brand2 : active ? t.brand : t.railDot}"/>
      <text x="47" y="${y + 4}" font-family="${FONT}" font-size="10" font-weight="700" fill="${active || done ? '#FFFFFF' : railText}" text-anchor="middle">${done ? '✓' : n}</text>
      <text x="72" y="${y + 5}" font-family="${FONT}" font-size="14" font-weight="${active ? 700 : 400}" fill="${active ? railText : done ? t.railDone : railSub}">${name}</text>`
  })
  return `<rect width="${W}" height="${H}" fill="${THEMES[theme].bg}"/><rect width="${RAIL}" height="${H}" fill="${THEMES[theme].rail}"/>
    <image href="data:image/png;base64,${logoB64}" x="72" y="28" width="88" height="88"/>
    <text x="116" y="145" font-family="${FONT}" font-size="19" font-weight="700" fill="${railText}" text-anchor="middle">HyperPlayer</text>
    <text x="116" y="168" font-family="${FONT}" font-size="12" letter-spacing="1.4" fill="${t.brand}" text-anchor="middle">HYPER PLAYER</text>
    <rect x="46" y="188" width="140" height="2" rx="1" fill="${t.brand}"/>${steps}
    <text x="116" y="488" font-family="${FONT}" font-size="11" letter-spacing="1.6" fill="${railSub}" text-anchor="middle">NATIVE SETUP</text>`
}

function heading(theme, title, sub) {
  const t = THEMES[theme]
  return `<text x="${CX}" y="82" font-family="${FONT}" font-size="30" font-weight="700" fill="${t.tx}">${esc(title)}</text>
    <text x="${CX}" y="114" font-family="${FONT}" font-size="13" fill="${t.sub}">${esc(sub)}</text>`
}

function footerBase(theme) {
  const t = THEMES[theme]
  return `<rect x="0" y="${ANIM_Y}" width="${RAIL}" height="${ANIM_H}" fill="${t.rail}"/>
    <rect x="${RAIL}" y="${ANIM_Y}" width="${W - RAIL}" height="${ANIM_H}" fill="${t.bg}"/>
    <text x="116" y="566" font-family="${FONT}" font-size="11" fill="${t.railSub}" text-anchor="middle">v${APP_VERSION}</text>`
}

function ambientStrip(theme, frame, yOffset = 0) {
  const t = THEMES[theme]
  const phase = 2 * Math.PI * frame / FRAME_COUNT
  const x1 = 420 + 72 * Math.cos(phase)
  const x2 = 690 + 54 * Math.cos(phase + Math.PI)
  const a1 = ((theme === 'light' ? 0.07 : 0.105) + 0.02 * Math.sin(phase)).toFixed(4)
  const a2 = ((theme === 'light' ? 0.05 : 0.075) + 0.014 * Math.sin(phase + Math.PI / 2)).toFixed(4)
  const lineA = ((theme === 'light' ? 0.09 : 0.12) + 0.02 * Math.sin(phase + Math.PI / 3)).toFixed(4)
  return `<defs><filter id="ambientBlur"><feGaussianBlur stdDeviation="18"/></filter></defs>
    <ellipse cx="${x1.toFixed(2)}" cy="${552 - yOffset}" rx="250" ry="20" fill="${t.brand}" opacity="${a1}" filter="url(#ambientBlur)"/>
    <ellipse cx="${x2.toFixed(2)}" cy="${566 - yOffset}" rx="205" ry="15" fill="${t.brand2}" opacity="${a2}" filter="url(#ambientBlur)"/>
    <path d="M260 ${552 - yOffset}H470 M510 ${562 - yOffset}H632 M674 ${548 - yOffset}H824" stroke="${t.brand}" stroke-width="1" opacity="${lineA}"/>
    <path d="M330 ${569 - yOffset}H414 M590 ${543 - yOffset}H705" stroke="${t.brand2}" stroke-width="1" opacity="${a2}"/>`
}

function windowBorder(theme = 'light') {
  const color = theme === 'light' ? '#DCE4EC' : '#2B3A4E'
  return `<rect x="0.5" y="0.5" width="879" height="579" rx="14" fill="none" stroke="${color}" stroke-width="1"/>`
}

function pageSvg(theme, phase, title, sub, body, phaseNames = PHASES) {
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${rail(theme, phase, phaseNames)}${heading(theme, title, sub)}${body(THEMES[theme])}${footerBase(theme)}${ambientStrip(theme, 0)}${windowBorder(theme)}</svg>`
}

function themePage(frame = 0, scopeSelected = 'current') {
  const t = THEMES.light
  // 这两个胶囊要和 installer.nsh 里原生单选控件的可点击区域对齐（250,140 与 390,140），
  // 否则点上去高亮和底图会错位。
  const scope = (x, width, text, selected) => `<rect x="${x}" y="246" width="${width}" height="34" rx="17" fill="${selected ? t.brand : t.panel}" stroke="${selected ? t.brand : t.border}"/><text x="${x + width / 2}" y="267" font-family="${FONT}" font-size="11" fill="${selected ? '#FFFFFF' : t.sub}" text-anchor="middle">${text}</text>`
  return `<svg width="${W * SS_SCALE}" height="${H * SS_SCALE}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="themeBg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#F4F8FD"/><stop offset=".58" stop-color="#FFFFFF"/><stop offset="1" stop-color="#EEF4FB"/></linearGradient>
      <linearGradient id="brandWash" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#2864D7" stop-opacity=".15"/><stop offset="1" stop-color="#B45B28" stop-opacity=".09"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#themeBg)"/>
    <circle cx="452" cy="96" r="196" fill="url(#brandWash)"/>
    <image href="data:image/png;base64,${logoB64}" x="58" y="26" width="92" height="92"/>
    <text x="820" y="66" font-family="${FONT}" font-size="10.5" letter-spacing="2" fill="#8A9AAC" text-anchor="end">H Y P E R P L A Y E R</text>
    <text x="440" y="186" font-family="${FONT}" font-size="32" font-weight="700" fill="${t.tx}" text-anchor="middle">HyperPlayer</text>
    <text x="440" y="214" font-family="${FONT}" font-size="12.5" fill="${t.sub}" text-anchor="middle">选一个界面色调，后面几步就按这个色调显示</text>
    ${scope(250, 140, '当前用户', scopeSelected === 'current')}${scope(390, 220, '所有用户（需要管理员权限）', scopeSelected === 'all')}
    ${cardSvg(false, false, 138, 304)}${cardSvg(true, false, 458, 304)}
    <rect y="${ANIM_Y}" width="${W}" height="${ANIM_H}" fill="#EEF3F8"/>${ambientStrip('light', frame)}
    <text x="440" y="566" font-family="${FONT}" font-size="11" fill="${t.railSub}" text-anchor="middle">v${APP_VERSION}</text>
    ${windowBorder('light')}
  </svg>`
}

function cardSvg(dark, hover, x = 0, y = 0) {
  const t = dark ? THEMES.dark : THEMES.light
  const bg = hover ? (dark ? '#22303F' : '#FFFFFF') : t.panel
  const border = hover ? t.brand : t.border
  const panelBg = dark ? '#111925' : '#EEF3F8'
  return `<g transform="translate(${x},${y})"><rect x="0.5" y="0.5" width="283" height="171" rx="12" fill="${bg}" stroke="${border}" stroke-width="${hover ? 2 : 1}"/>
    <rect x="24" y="24" width="236" height="66" rx="8" fill="${panelBg}"/>
    <rect x="36" y="36" width="34" height="42" rx="4" fill="${t.brand}"/>
    <rect x="82" y="38" width="96" height="7" rx="3.5" fill="${t.tx}"/>
    <rect x="82" y="54" width="142" height="5" rx="2.5" fill="${t.sub}"/>
    <rect x="82" y="68" width="62" height="5" rx="2.5" fill="${t.brand2}"/>
    <rect x="24" y="103" width="236" height="1" fill="${t.border}"/>
    <text x="24" y="128" font-family="${FONT}" font-size="16" font-weight="700" fill="${t.tx}">${dark ? '深色模式' : '亮色模式'}</text>
    <text x="24" y="148" font-family="${FONT}" font-size="11" fill="${hover ? t.brand : t.sub}">${dark ? '夜里看不刺眼' : '默认，白天更清楚'}</text>
    <text x="260" y="140" font-family="${FONT}" font-size="15" font-weight="700" fill="${hover ? t.brand : t.sub}" text-anchor="end">${hover ? '→' : ''}</text></g>`
}

function wrapText(text, maxChars = 20) {
  const lines = []
  let line = ''
  for (const char of text) {
    if (line.length >= maxChars && /[，。；、：]/.test(char)) {
      lines.push(line + char)
      line = ''
    } else if (line.length >= maxChars + 3) {
      lines.push(line)
      line = char
    } else {
      line += char
    }
  }
  if (line) lines.push(line)
  if (lines.length > 3) throw new Error(`Installer license card text exceeds three lines: ${text}`)
  return lines
}

function licenseBody(t) {
  const sections = [
    ['01  平台、账号与版权', '独立第三方播放器，非官方客户端。Cookie / Token 凭证可能明文存于本机；非官方接口有账号风险。内容版权归平台和权利人。'],
    ['02  联网服务与代理', '音乐功能会访问平台；部分跨域请求经本机服务（127.0.0.1:3211）转发。歌词会查 Lrclib、AMLL、amlldb。'],
    ['03  天气、地图与定位', '天气地图会访问 Open-Meteo、气象地震源、OpenStreetMap、Photon、Esri、DataV；可能用公网 IP 定位。'],
    ['04  更新与第三方图片', '版本检查会访问 GitHub 更新清单；壁纸和背景可能从 Bing 壁纸、风景或动漫图片 API 获取。'],
    ['05  本地数据与使用责任', '凭证、缓存、配置、歌单和分析数据主要存于本机，无系统级加密。不得批量抓取、绕过付费、侵权导出、再分发或商用。'],
    ['06  授权、风险与组件', '软件按“现状”提供。完整许可见随包 THIRD_PARTY_NOTICES.md。'],
  ]
  const cards = sections.map(([title, text], i) => {
    const x = CX + (i % 2) * 278
    const y = 136 + Math.floor(i / 2) * 91
    const lines = wrapText(text).map((line, lineIndex) => `<tspan x="${x + 15}" dy="${lineIndex === 0 ? 0 : 15}">${esc(line)}</tspan>`).join('')
    return `<rect x="${x}" y="${y}" width="268" height="82" rx="7" fill="${t.panel}" stroke="${t.border}"/>
      <rect x="${x}" y="${y}" width="4" height="82" rx="2" fill="${i % 2 ? t.brand2 : t.brand}"/>
      <text x="${x + 15}" y="${y + 23}" font-family="${FONT}" font-size="12" font-weight="700" fill="${i % 2 ? t.brand2 : t.brand}">${title}</text>
      <text x="${x + 15}" y="${y + 43}" font-family="${FONT}" font-size="10" fill="${t.tx}">${lines}</text>`
  }).join('')
  return cards
}

function dirBody(t) {
  return `<rect x="${CX}" y="140" width="560" height="224" rx="8" fill="${t.panel}" stroke="${t.border}"/>
    <rect x="${CX + 20}" y="160" width="42" height="42" rx="7" fill="${t.panel2}" stroke="${t.border}"/>
    <path d="M${CX + 30} 174h9l4 4h10v13H${CX + 30}z" fill="none" stroke="${t.brand}" stroke-width="2" stroke-linejoin="round"/>
    <text x="${CX + 76}" y="177" font-family="${FONT}" font-size="12" font-weight="700" fill="${t.tx}">目标文件夹</text>
    <text x="${CX + 76}" y="196" font-family="${FONT}" font-size="10.5" fill="${t.sub}">可直接编辑或粘贴路径</text>
    <rect x="${CX + 20}" y="216" width="468" height="42" rx="7" fill="${t.edit}" stroke="${t.border}"/>
    <rect x="${CX + 20}" y="278" width="520" height="48" rx="7" fill="${t.panel2}"/>
    <text x="${CX + 36}" y="298" font-family="${FONT}" font-size="10.5" fill="${t.sub}">磁盘与空间</text>
    <circle cx="${CX + 31}" cy="313" r="3" fill="${t.brand2}"/>
    <text x="${CX + 42}" y="317" font-family="${FONT}" font-size="11" fill="${t.tx}">空间数据将根据当前路径实时计算</text>
    <text x="${CX}" y="391" font-family="${FONT}" font-size="11" fill="${t.sub}">安装范围：所选用户范围 · 升级时保留原安装位置</text>`
}

const pages = {
  welcome: [1, '欢迎使用 HyperPlayer', '几步装完，随时可以开始听歌', (t) => `<rect x="${CX}" y="148" width="560" height="246" rx="8" fill="${t.panel}" stroke="${t.border}"/>
    <text x="${CX + 28}" y="184" font-family="${FONT}" font-size="13" font-weight="700" fill="${t.brand}">安装内容</text>
    ${['网易云 / QQ / B站 MV 三音源', '固定淡入淡出、专辑无缝与切歌提示', 'HSE 音效、空间音频与桌面歌词', '本地配置、缓存与播放列表'].map((x, i) => `<circle cx="${CX + 34}" cy="${220 + i * 42}" r="4" fill="${i % 2 ? t.brand2 : t.brand}"/><text x="${CX + 51}" y="${225 + i * 42}" font-family="${FONT}" font-size="13" fill="${t.tx}">${x}</text>`).join('')}
    <text x="${CX + 28}" y="377" font-family="${FONT}" font-size="10.5" fill="${t.sub}">继续前请关闭正在运行的 HyperPlayer，以便完整更新程序文件。</text>`],
  license: [2, '重点条款摘要', '本页不替代完整《法律声明与用户协议》；首次启动可查看全文', licenseBody],
  dir: [3, '选择安装位置', '路径可以直接改，空间大小会跟着变', dirBody],
  inst: [4, '正在安装', '正在把 HyperPlayer 写入磁盘', (t) => `<rect x="${CX}" y="148" width="560" height="122" rx="8" fill="${t.panel}" stroke="${t.border}"/><text x="${CX + 24}" y="181" font-family="${FONT}" font-size="11" fill="${t.sub}">安装进度</text><rect x="${CX + 24}" y="204" width="512" height="12" rx="6" fill="${t.panel2}"/><text x="${CX + 24}" y="248" font-family="${FONT}" font-size="11" fill="${t.sub}">正在准备文件...</text>`],
  finish: [5, '安装完成', '装好了，可以直接打开', (t) => `<circle cx="560" cy="224" r="58" fill="${t.brand2}" opacity=".12"/><circle cx="560" cy="224" r="38" fill="${t.brand2}"/><path d="M540 224l13 13 28-31" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><rect x="${CX}" y="310" width="560" height="62" rx="8" fill="${t.panel}" stroke="${t.border}"/><text x="560" y="336" font-family="${FONT}" font-size="11" fill="${t.sub}" text-anchor="middle">安装目录</text>`],
}

function buttonSvg(w, h, text, kind, theme, state) {
  const t = THEMES[theme]
  const primary = kind === 'primary'
  const disabled = state === 'disabled'
  const pressed = state === 'pressed'
  const hover = state === 'hover'
  let fill = primary ? t.brand : t.panel
  let border = primary ? t.brand : t.border
  let fg = primary ? '#FFFFFF' : t.tx
  if (hover) fill = primary ? (theme === 'dark' ? '#5A8BE8' : '#1C50B6') : t.panel2
  if (pressed) fill = primary ? (theme === 'dark' ? '#3566C4' : '#153E90') : (theme === 'dark' ? '#1B2533' : '#E4EAF1')
  if (disabled) { fill = theme === 'dark' ? '#273449' : '#E7EDF4'; border = fill; fg = theme === 'dark' ? '#718198' : '#98A7B8' }
  const y = pressed ? 1 : 0
  const content = text === '浏览'
    ? `<path d="M${w / 2 - 11} ${17 + y}h9l4 4h10v12h-23z" fill="none" stroke="${fg}" stroke-width="2" stroke-linejoin="round"/>`
    : `<text x="${w / 2}" y="${h / 2 + 5 + y}" font-family="${FONT}" font-size="14" font-weight="600" fill="${fg}" text-anchor="middle">${esc(text)}</text>`
  return `<svg width="${w * SS_SCALE}" height="${h * SS_SCALE}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="${t.bg}"/><rect x="1" y="${1 + y}" width="${w - 2}" height="${h - 3}" rx="7" fill="${fill}" stroke="${border}"/>${content}</svg>`
}

function checkSvg(w, text, theme, checked, kind) {
  const t = THEMES[theme]
  const accent = kind === 'agreement' ? t.brand : t.brand2
  return `<svg width="${w}" height="34" viewBox="0 0 ${w} 34" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="34" fill="${t.bg}"/><rect x="1" y="1" width="32" height="32" rx="7" fill="${checked ? accent : t.panel}" stroke="${checked ? accent : t.border}" stroke-width="1.5"/>${checked ? '<path d="M9 17l6 6 11-13" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' : ''}<text x="44" y="22" font-family="${FONT}" font-size="13" font-weight="600" fill="${t.tx}">${esc(text)}</text></svg>`
}

function compositeClose(baseRgb, level, size = 40) {
  // 关闭按钮按目标边长等比合成，圆形与叉号比例保持一致。
  const out = Buffer.from(baseRgb)
  const alpha = level / (CLOSE_LEVELS - 1)
  const k = size / 40
  const cx = 19.5 * k
  const rOuter = 15.5 * k
  const rStroke = 10 * k
  const strokeHalf = 1.15 * k
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - cx, y - cx)
      const circle = Math.max(0, Math.min(1, rOuter - distance)) * alpha
      const d1 = Math.abs(x - y) / Math.SQRT2
      const d2 = Math.abs(x + y - 2 * cx) / Math.SQRT2
      const stroke = distance < rStroke && Math.min(d1, d2) < strokeHalf ? alpha : 0
      const i = (y * size + x) * 3
      if (circle > 0) {
        out[i] = Math.round(out[i] * (1 - circle) + 200 * circle)
        out[i + 1] = Math.round(out[i + 1] * (1 - circle) + 60 * circle)
        out[i + 2] = Math.round(out[i + 2] * (1 - circle) + 60 * circle)
      }
      if (stroke > 0) {
        out[i] = Math.round(out[i] * (1 - stroke) + 255 * stroke)
        out[i + 1] = Math.round(out[i + 1] * (1 - stroke) + 255 * stroke)
        out[i + 2] = Math.round(out[i + 2] * (1 - stroke) + 255 * stroke)
      }
    }
  }
  return out
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
for (const S of DPI_SCALES) {
  const write = (name, buffer) => writeFileSync(join(OUT, name), buffer)
const themeRgb = await svgToRgb(themePage(), W * S, H * S)
write('theme.bmp', encodeBmp(W * S, H * S, themeRgb))
for (const name of ['dark', 'light']) {
  const cx = (name === 'dark' ? 458 : 138) * S
  const normal = cropRgb(themeRgb, W * S, cx, 304 * S, 284 * S, 172 * S)
  const hoverRgb = await svgToRgb(`<svg width="${284 * SS_SCALE}" height="${172 * SS_SCALE}" viewBox="0 0 284 172" xmlns="http://www.w3.org/2000/svg">${cardSvg(name === 'dark', true)}</svg>`, 284 * S, 172 * S)
  write(`card-${name}.bmp`, encodeBmp(284 * S, 172 * S, normal))
  write(`card-${name}-hover.bmp`, encodeBmp(284 * S, 172 * S, hoverRgb))
  write(`card-${name}-pressed.bmp`, encodeBmp(284 * S, 172 * S, hoverRgb))
}

const pageCache = new Map()
const pageRgb = async (theme, page, phases = PHASES) => {
  const key = `${page[1]}|${theme}|${phases.join('/')}`
  if (!pageCache.has(key)) pageCache.set(key, await svgToRgb(pageSvg(theme, ...page, phases), W * S, H * S))
  return pageCache.get(key)
}
const emitPage = async (name, theme, page, phases = PHASES) => write(`${name}-${theme}.bmp`, encodeBmp(W * S, H * S, await pageRgb(theme, page, phases)))

for (const [name, page] of Object.entries(pages)) {
  for (const theme of ['dark', 'light']) await emitPage(name, theme, page)
}

for (const theme of ['dark', 'light']) {
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const svg = `<svg width="${ANIM_W * SS_SCALE}" height="${ANIM_H * SS_SCALE}" viewBox="${ANIM_X} 0 ${ANIM_W} ${ANIM_H}" xmlns="http://www.w3.org/2000/svg">${footerBase(theme).replaceAll(`y="${ANIM_Y}"`, 'y="0"').replace('y="566"', 'y="34"')}${ambientStrip(theme, frame, ANIM_Y)}</svg>`
    write(`anim-${theme}-${frame}.bmp`, await svgToBmp(svg, ANIM_W * S, ANIM_H * S))
  }
}
for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
  const rgb = await svgToRgb(themePage(frame), W * S, H * S)
  write(`anim-theme-${frame}.bmp`, encodeBmp(ANIM_W * S, ANIM_H * S, cropRgb(rgb, W * S, ANIM_X * S, ANIM_Y * S, ANIM_W * S, ANIM_H * S)))
}

const buttons = [['下一步', 'primary', 160], ['同意并继续', 'primary', 200], ['安装', 'primary', 160], ['立即打开', 'primary', 160], ['取消安装', 'secondary', 160], ['上一步', 'secondary', 120], ['完成', 'secondary', 120], ['浏览', 'secondary', 52]]
for (const theme of ['dark', 'light']) {
  for (const [text, kind, width] of buttons) {
    for (const state of ['normal', 'hover', 'pressed', 'disabled']) {
      const suffix = state === 'normal' ? '' : `-${state}`
      write(`btn-${kind}-${theme}-${text}${suffix}.bmp`, await svgToBmp(buttonSvg(width, 44, text, kind, theme, state), width * S, 44 * S))
    }
  }
  for (const [kind, text, width] of [['agreement', '我已阅读并同意完整《法律声明与用户协议》', 380], ['desktop', '创建桌面快捷方式', 260]]) {
    for (const checked of [false, true]) write(`${kind}-${theme}-${checked ? 'checked' : 'unchecked'}.bmp`, await svgToBmp(checkSvg(width, text, theme, checked, kind), width * S, 34 * S))
  }
}
const closePages = {
  theme: themeRgb,
  dark: await svgToRgb(pageSvg('dark', ...pages.welcome), W * S, H * S),
  light: await svgToRgb(pageSvg('light', ...pages.welcome), W * S, H * S),
}
for (const [theme, page] of Object.entries(closePages)) {
  const base = cropRgb(page, W * S, 828 * S, 10 * S, 40 * S, 40 * S)
  for (let level = 0; level < CLOSE_LEVELS; level += 1) {
    write(`close-${theme}-${level}.bmp`, encodeBmp(40 * S, 40 * S, compositeClose(base, level, 40 * S)))
  }
}
// 范围选择叠加图直接从主题页底图对应区域裁出（两种选中态各裁一次），
// 这样叠在底图上不会露出异色矩形把胶囊盖成白条。
for (const [state, selected] of [['selected', 'current'], ['normal', 'all']]) {
  const rgb = await svgToRgb(themePage(0, selected), W * S, H * S)
  write(`scope-current-${state}.bmp`, encodeBmp(140 * S, 34 * S, cropRgb(rgb, W * S, 250 * S, 246 * S, 140 * S, 34 * S)))
  write(`scope-all-${state}.bmp`, encodeBmp(220 * S, 34 * S, cropRgb(rgb, W * S, 390 * S, 246 * S, 220 * S, 34 * S)))
}

const uninstallPages = {
  unconfirm: [1, '卸载 HyperPlayer', '确认后开始删除程序文件', (t) => `<rect x="${CX}" y="142" width="560" height="250" rx="8" fill="${t.panel}" stroke="${t.border}"/><text x="${CX + 24}" y="180" font-family="${FONT}" font-size="12" font-weight="700" fill="${t.tx}">将移除</text><text x="${CX + 24}" y="208" font-family="${FONT}" font-size="11" fill="${t.sub}">HyperPlayer 程序文件、开始菜单与桌面快捷方式</text><rect x="${CX + 24}" y="230" width="512" height="1" fill="${t.border}"/><text x="${CX + 24}" y="264" font-family="${FONT}" font-size="12" font-weight="700" fill="${t.brand2}">默认保留本地数据</text><text x="${CX + 24}" y="290" font-family="${FONT}" font-size="11" fill="${t.tx}">配置、登录凭据、缓存、歌单和分析数据不会删除</text><text x="${CX + 24}" y="326" font-family="${FONT}" font-size="10.5" fill="${t.sub}">安装目录</text><text x="${CX + 24}" y="357" font-family="${FONT}" font-size="10.5" fill="${t.sub}">安装范围</text>`],
  uninst: [2, '正在移除组件', '正在删除程序文件，请稍候', pages.inst[3]],
  unfinish: [3, '卸载完成', '程序文件已删除，本地数据保留', pages.finish[3]],
}
const UNINSTALL_PHASES = ['确认卸载', '移除组件', '完成']
for (const [name, page] of Object.entries(uninstallPages)) {
  for (const theme of ['light', 'dark']) await emitPage(name, theme, page, UNINSTALL_PHASES)
}
for (const [text, kind, width] of [['开始卸载', 'primary', 160], ['取消', 'secondary', 120], ['完成卸载', 'primary', 160]]) {
  for (const state of ['normal', 'hover', 'pressed', 'disabled']) {
    const suffix = state === 'normal' ? '' : `-${state}`
    for (const theme of ['light', 'dark']) write(`btn-${kind}-${theme}-${text}${suffix}.bmp`, await svgToBmp(buttonSvg(width, 44, text, kind, theme, state), width * S, 44 * S))
  }
}

}
console.log(`Installer UI generated: ${OUT} (${DPI_SCALES.length} DPI scales, ${FRAME_COUNT} animation frames)`)

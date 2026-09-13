const electronProcessStartedAt = performance.now()

// 强制设置 Node.js 输出编码为 UTF-8
if (process.stdout && typeof process.stdout.setDefaultEncoding === 'function') {
  process.stdout.setDefaultEncoding('utf8')
}
if (process.stderr && typeof process.stderr.setDefaultEncoding === 'function') {
  process.stderr.setDefaultEncoding('utf8')
}

// 防 EPIPE 崩溃：stdout/stderr 管道被关闭（如从启动器/脚本 detached 启动后管道断开、
// GUI 环境无控制台等）时，console.log 写已关闭管道会抛未捕获异常导致主进程崩溃。
// 捕获 'error' 事件静默吞掉 EPIPE（broken pipe），其他错误仍抛出。
for (const stream of [process.stdout, process.stderr]) {
  if (stream) {
    stream.on('error', (error) => {
      if (error && error.code === 'EPIPE') return
      throw error
    })
  }
}

// Avoid spawning chcp/cmd.exe here. Electron is a GUI process, and the child
// console can flash visibly whenever the main process is initialized.
const { app, BrowserWindow, ipcMain, protocol, shell, session, safeStorage, dialog, globalShortcut, clipboard, utilityProcess, net, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const dns = require('node:dns')

// 当前 Windows 网络的 IPv6 路由可能不可达；外部音乐 CDN/API 优先走 IPv4。
dns.setDefaultResultOrder('ipv4first')

const { selectHyperPlayerUserData } = require('./user-data-profile.cjs')

// HyperPlayer 拥有**独占**的配置目录，绝不与 WaveForge 或其他 Electron 应用共用：
// 打包版与开发版都固定使用 %APPDATA%/HyperPlayer（开发版仅认显式的绝对路径 override）。
// 历史：开发版曾因首次 getPath(userData) 时机过早而落在 Electron 的公共默认目录
// （%APPDATA%/Electron，所有 Electron 应用共享）；旧代码靠文件标记「认领」它，
// 随功能减配已不可靠，现彻底切断回退（详见 user-data-profile.cjs 注释）。
// 仅切换路径，不复制或覆盖任何凭据/数据库。
const appDataRoot = process.platform === 'win32'
  ? (process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'))
  : (process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config'))
const selectedUserDataPath = selectHyperPlayerUserData({
  appDataRoot,
  isPackaged: app.isPackaged,
  overridePath: process.env.HYPERPLAYER_USER_DATA,
  platform: process.platform,
})
app.setName('HyperPlayer')
fs.mkdirSync(selectedUserDataPath, { recursive: true })
app.setPath('userData', selectedUserDataPath)

const windowIconPath = path.join(__dirname, '..', 'logo.png')
const windowIcon = nativeImage.createFromPath(windowIconPath)
if (windowIcon.isEmpty()) {
  console.warn('[Startup] Failed to decode window icon:', windowIconPath)
}
const { createDocumentUrlMatcher, createTrustedIpcGuard } = require('./trusted-ipc.cjs')
const LOCAL_SERVICE_TOKEN = process.env.HYPERPLAYER_LOCAL_TOKEN || crypto.randomBytes(32).toString('base64url')
const {
  loadWindowState,
  saveWindowState,
  centerBoundsInWorkArea,
} = require('./window-state.cjs')
const startupTimingLogPath = process.env.HYPERPLAYER_STARTUP_LOG || ''
function logStartupTiming(message) {
  const line = '[Electron +' + Math.round(performance.now() - electronProcessStartedAt) + 'ms] ' + message
  console.log(line)
  if (startupTimingLogPath) {
    try { fs.appendFileSync(startupTimingLogPath, line + '\n', 'utf8') } catch {}
  }
}

const performanceSettingsPath = path.join(app.getPath('userData'), 'performance-settings.json')
const shortcutSettingsPath = path.join(app.getPath('userData'), 'shortcut-settings.json')
// 全局高刷：渲染帧率可选档位范围（跟随所在显示器刷新率，最高 360Hz）
const HIGH_REFRESH_MIN_HZ = 30
const HIGH_REFRESH_MAX_HZ = 360

function readPerformanceSettings() {
  const defaults = { hardwareAcceleration: true, gpuPreference: 'auto', pendingGpuChange: null, highRefreshRate: false, highRefreshHz: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(performanceSettingsPath, 'utf8'))
    const gpuPreference = ['auto', 'discrete', 'integrated'].includes(parsed?.gpuPreference)
      ? parsed.gpuPreference
      : defaults.gpuPreference
    const pending = parsed?.pendingGpuChange
    const savedHz = Number(parsed?.highRefreshHz)
    return {
      hardwareAcceleration: parsed?.hardwareAcceleration !== false,
      gpuPreference,
      pendingGpuChange: (pending && (pending.type === 'preference' || pending.type === 'acceleration')) ? pending : null,
      highRefreshRate: parsed?.highRefreshRate === true,
      highRefreshHz: Number.isInteger(savedHz) && savedHz >= 30 && savedHz <= HIGH_REFRESH_MAX_HZ ? savedHz : null,
    }
  } catch {
    return { ...defaults }
  }
}

function writePerformanceSettings(settings) {
  try {
    const temporaryPath = `${performanceSettingsPath}.tmp`
    fs.mkdirSync(path.dirname(performanceSettingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify(settings), 'utf8')
    fs.renameSync(temporaryPath, performanceSettingsPath)
  } catch (error) {
    console.error('[性能设置] 保存失败:', error?.message || error)
  }
}

const performanceSettings = readPerformanceSettings()
// 全局高刷：用户手动选了具体档位时，启动即用 --force-frame-rate 强制 Chromium 帧率
// （比运行时 setFrameRate 更可靠；「跟随显示器最高」档在 app ready 后按显示器实时应用）
if (performanceSettings.highRefreshRate === true && performanceSettings.highRefreshHz) {
  try { app.commandLine.appendSwitch('force-frame-rate', String(performanceSettings.highRefreshHz)) } catch { /* 忽略 */ }
}
// 硬件加速 / GPU 偏好（启动前必须决定，故用命令行开关）
if (!performanceSettings.hardwareAcceleration) {
  app.disableHardwareAcceleration()
} else {
  // 默认开启全部可用的 GPU 加速通道（用户要求「加速默认开起来」）：
  //   enable-gpu-rasterization         GPU 栅格化（页面/模糊图层走 GPU，减轻 CPU）
  //   enable-zero-copy                 零拷贝纹理上屏（视频/canvas 合成少一次内存拷贝）
  //   enable-accelerated-video-decode  硬件视频解码（启动页 VP9 视频与 MV 播放走 GPU）
  // 有意不加 --ignore-gpu-blocklist：本机实测（等 GPU 状态稳定后读）全部特性已 enabled，
  // 无需绕过黑名单；强行绕过可能在驱动层引入不稳定，风险大于收益。
  try {
    app.commandLine.appendSwitch('enable-gpu-rasterization')
    app.commandLine.appendSwitch('enable-zero-copy')
    app.commandLine.appendSwitch('enable-accelerated-video-decode')
  } catch { /* 忽略 */ }
  if (performanceSettings.gpuPreference === 'discrete') {
    // 强制使用独立显卡（高性能 GPU）
    app.commandLine.appendSwitch('force_high_performance_gpu')
  } else if (performanceSettings.gpuPreference === 'integrated') {
    // 强制使用核显/集成显卡（低功耗 GPU）
    app.commandLine.appendSwitch('force_low_power_gpu')
  }
}

app.on('child-process-gone', (_event, details) => {
  const processType = String(details?.type || '').toLowerCase()
  if (processType === 'gpu' || processType === 'renderer') {
    console.error('[ProcessHealth] Electron child process exited:', {
      type: details?.type,
      reason: details?.reason,
      exitCode: details?.exitCode,
      serviceName: details?.serviceName,
      name: details?.name,
    })
  }
})

// 立即设置应用名称（必须在 app.ready 之前）。打包版使用与安装器一致的
// AppUserModelID；开发版没有该 ID 对应的开始菜单快捷方式，强行设置会让
// Windows Shell 回退到空白文件图标，而不是 BrowserWindow 的自定义图标。
if (app.isPackaged) app.setAppUserModelId('com.hyperplayer.desktop')

const { execFile, execFileSync } = require('child_process')
const os = require('os')
const { pathToFileURL } = require('url')
const { ConfigManager } = require('./config-manager.cjs')
const { setupChromaIpc } = require('./chroma-ipc.cjs')
const { setupSignalRgbIpc } = require('./signalrgb-ipc.cjs')
logStartupTiming('Main-process modules loaded')

let desktopWidgetCpuSample = null
const DESKTOP_WIDGET_DISK_CACHE_MS = 60_000
let desktopWidgetDiskCache = []
let desktopWidgetDiskCacheExpiresAt = 0
let desktopWidgetDiskRequest = null

function readCpuTimes() {
  return os.cpus().reduce((total, cpu) => {
    const idle = total.idle + cpu.times.idle
    const all = total.all + Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
    return { idle, all }
  }, { idle: 0, all: 0 })
}

function readMediaKeysEnabled() {
  try {
    const parsed = JSON.parse(fs.readFileSync(shortcutSettingsPath, 'utf8'))
    return parsed?.mediaKeysEnabled !== false
  } catch {
    return true
  }
}

function writeMediaKeysEnabled(enabled) {
  try {
    const temporaryPath = `${shortcutSettingsPath}.tmp`
    fs.mkdirSync(path.dirname(shortcutSettingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify({ mediaKeysEnabled: enabled === true }), 'utf8')
    fs.renameSync(temporaryPath, shortcutSettingsPath)
  } catch (error) {
    console.error('[快捷键设置] 保存失败:', error?.message || error)
  }
}

function readDesktopWidgetDisks() {
  if (process.platform !== 'win32') return Promise.resolve([])

  const now = Date.now()
  if (now < desktopWidgetDiskCacheExpiresAt) {
    return Promise.resolve(desktopWidgetDiskCache)
  }
  if (desktopWidgetDiskRequest) return desktopWidgetDiskRequest

  const script = "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress"
  desktopWidgetDiskRequest = new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error || !String(stdout || '').trim()) return resolve([])
      try {
        const parsed = JSON.parse(stdout)
        const items = Array.isArray(parsed) ? parsed : [parsed]
        resolve(items.map(disk => {
          const total = Number(disk.Size) || 0
          const free = Number(disk.FreeSpace) || 0
          const used = Math.max(0, total - free)
          return { name: disk.DeviceID || '磁盘', used, total, percent: total ? used / total * 100 : 0 }
        }))
      } catch { resolve([]) }
    })
  }).then(disks => {
    desktopWidgetDiskCache = disks
    desktopWidgetDiskCacheExpiresAt = Date.now() + DESKTOP_WIDGET_DISK_CACHE_MS
    return disks
  }).finally(() => {
    desktopWidgetDiskRequest = null
  })

  return desktopWidgetDiskRequest
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const devServerUrl = process.env.HYPERPLAYER_DEV_SERVER_URL || 'http://127.0.0.1:3000'

// 导航白名单：只允许应用自身的地址（开发模式 Vite 服务器 / 生产模式打包产物），
// 阻止同窗口被任意外部页面导航——特权 preload 桥一旦跟到外部站点就会被滥用。
const ALLOWED_DEV_SERVER_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
])
const ALLOWED_APP_FILE_URLS = new Set([
  pathToFileURL(path.join(__dirname, '../dist/index.html')).href,
  pathToFileURL(path.join(__dirname, '../dist/desktop-player.html')).href,
  pathToFileURL(path.join(__dirname, '../dist/desktop-lyrics.html')).href,
])

function isAllowedNavigationTarget(url) {
  try {
    const parsed = new URL(String(url || ''))
    if (parsed.protocol === 'file:') {
      return ALLOWED_APP_FILE_URLS.has(parsed.href)
    }
    if (isDev && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      return ALLOWED_DEV_SERVER_ORIGINS.has(parsed.origin)
    }
  } catch {
    // 无法解析的 URL 一律不放行
  }
  return false
}

function guardAgainstExternalNavigation(webContents) {
  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationTarget(url)) {
      event.preventDefault()
    }
  })
}

let mainWindow = null
let wallpaperWatcher = null
let chromaControllerHandle = null
let signalRgbControllerHandle = null
let qqLoginWindow = null
let qqLoginWindowOpening = false
let qqSkillKeyWindow = null
let analysisRuntime = null
let mediaKeysEnabled = readMediaKeysEnabled()

const mediaKeyAccelerators = {
  MediaPlayPause: 'toggle',
  MediaNextTrack: 'next',
  MediaPreviousTrack: 'prev',
}

function setGlobalMediaKeysEnabled(enabled) {
  mediaKeysEnabled = enabled === true
  writeMediaKeysEnabled(mediaKeysEnabled)
  Object.keys(mediaKeyAccelerators).forEach(accelerator => globalShortcut.unregister(accelerator))

  const registrations = {}
  if (mediaKeysEnabled) {
    Object.entries(mediaKeyAccelerators).forEach(([accelerator, action]) => {
      registrations[accelerator] = globalShortcut.register(accelerator, () => {
        dispatchPlayerControl(action)
      })
    })
  }

  return { success: true, enabled: mediaKeysEnabled, registrations }
}
let configManager = null

const QQMUSIC_SKILL_CREDENTIAL = 'qqmusicSkillApiKey'
const allowedMediaFiles = new Set()
const MAX_ALLOWED_MEDIA_FILES = 256

// ===== 桌面播放器：独立置顶小窗口（card 悬浮卡片 / bar 紧凑条状） =====
let desktopPlayerWindow = null
let desktopPlayerEnabled = false
let desktopPlayerForm = 'card'
const desktopPlayerState = {
  song: null, // { name, artists, coverUrl }
  lyric: null, // { line, translation, words, lineStart }
  playing: false,
  live: false,
  spectrum: [0, 0, 0, 0, 0],
  accentColor: '',
  playlist: [],
  currentIndex: -1,
  progress: 0,
  duration: 0, // 当前歌曲时长（秒），用于任务栏进度条 0-1 换算
  hasTranslation: false,
  hasRomaji: false,
  volume: 0.5, // 遥控器状态回传用
  muted: false,
  page: 'home', // 'home' | 'playback' —— 遥控器「模式切换」据此展示模式列表或歌词样式列表
}
const DESKTOP_PLAYER_FORMS = new Set(['card', 'bar'])
const DESKTOP_PLAYER_BASE_SIZE = {
  card: { width: 380, height: 150 },
  bar: { width: 480, height: 80 },
}
let desktopPlayerExpansionDirection = 'down'
let desktopPlayerDragSession = null
let desktopPlayerResizeSession = null
let desktopPlayerBoundsAnimation = null

// ===== 桌面歌词：独立透明置顶窗口 =====
let desktopLyricsWindow = null
let desktopLyricsDragSession = null
let desktopLyricsResizeSession = null
let desktopLyricsSavedBounds = null
let desktopLyricsPanelRestoreBounds = null
let desktopLyricsMousePassthrough = false
const DESKTOP_LYRICS_DEFAULTS = Object.freeze({
  enabled: false,
  fontSize: 58,
  // 歌词字体族名；空字符串 = 默认字体栈。可选本机字体，因此只做字符串校验不做白名单
  fontFamily: '',
  colorMode: 'auto',
  orientation: 'horizontal',
  doubleLine: false,
  translationEnabled: false,
  romajiEnabled: false,
  traditionalEnabled: false,
  locked: false,
})
const DESKTOP_LYRICS_COLORS = new Set(['auto', 'rose', 'sky', 'gold', 'mint', 'white'])
const DESKTOP_LYRICS_ORIENTATIONS = new Set(['horizontal', 'vertical'])
let desktopLyricsSettings = { ...DESKTOP_LYRICS_DEFAULTS }

function getDesktopPlayerWorkArea(bounds) {
  const { screen } = require('electron')
  return screen.getDisplayMatching(bounds).workArea
}

function clampDesktopPlayerBounds(bounds) {
  const workArea = getDesktopPlayerWorkArea(bounds)
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  return {
    x: Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, bounds.x)),
    y: Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, bounds.y)),
    width,
    height,
  }
}

function animateDesktopPlayerBounds(targetBounds, duration = 240) {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerBoundsAnimation) clearInterval(desktopPlayerBoundsAnimation)
  const startBounds = desktopPlayerWindow.getBounds()
  const startedAt = Date.now()
  desktopPlayerBoundsAnimation = setInterval(() => {
    if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) {
      clearInterval(desktopPlayerBoundsAnimation)
      desktopPlayerBoundsAnimation = null
      return
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    const interpolate = key => Math.round(startBounds[key] + (targetBounds[key] - startBounds[key]) * eased)
    desktopPlayerWindow.setBounds(clampDesktopPlayerBounds({
      x: interpolate('x'), y: interpolate('y'), width: interpolate('width'), height: interpolate('height'),
    }))
    if (progress >= 1) {
      clearInterval(desktopPlayerBoundsAnimation)
      desktopPlayerBoundsAnimation = null
    }
  }, 16)
}

function getDesktopPlayerSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-player-settings.json')
}

function loadDesktopPlayerSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDesktopPlayerSettingsPath(), 'utf8'))
    return {
      enabled: parsed?.enabled === true,
      form: DESKTOP_PLAYER_FORMS.has(parsed?.form) ? parsed.form : 'card',
    }
  } catch {
    return { enabled: false, form: 'card' }
  }
}

function saveDesktopPlayerSettings() {
  try {
    const settingsPath = getDesktopPlayerSettingsPath()
    const temporaryPath = `${settingsPath}.tmp`
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify({ enabled: desktopPlayerEnabled, form: desktopPlayerForm }, null, 2), 'utf8')
    fs.renameSync(temporaryPath, settingsPath)
  } catch (error) {
    console.error('[桌面播放器] 保存设置失败:', error)
  }
}

function getDesktopPlayerSnapshot() {
  return { ...desktopPlayerState, enabled: desktopPlayerEnabled, form: desktopPlayerForm }
}

function broadcastDesktopPlayerState() {
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
    desktopPlayerWindow.webContents.send('desktop-player:state', getDesktopPlayerSnapshot())
  }
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.webContents.send('desktop-lyrics:state', getDesktopPlayerSnapshot())
  }
}


function broadcastDesktopPlayerPartial(partial) {
  if (!partial || Object.keys(partial).length === 0) return
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
    desktopPlayerWindow.webContents.send('desktop-player:state', partial)
  }
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    const lyricsPartial = {}
    for (const key of ['song', 'lyric', 'playing', 'accentColor', 'progress', 'hasTranslation', 'hasRomaji']) {
      if (Object.prototype.hasOwnProperty.call(partial, key)) lyricsPartial[key] = partial[key]
    }
    if (Object.keys(lyricsPartial).length > 0) {
      desktopLyricsWindow.webContents.send('desktop-lyrics:state', lyricsPartial)
    }
  }
}

function desktopPlayerSetExpanded(expanded) {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  const bounds = desktopPlayerWindow.getBounds()
  if (expanded) {
    const workArea = getDesktopPlayerWorkArea(bounds)
    const roomAbove = bounds.y - workArea.y
    const roomBelow = workArea.y + workArea.height - (bounds.y + bounds.height)
    desktopPlayerExpansionDirection = roomBelow >= 260 || roomBelow >= roomAbove ? 'down' : 'up'
  }
  return desktopPlayerExpansionDirection
}

function createDesktopPlayerWindow() {
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) return desktopPlayerWindow
  const size = DESKTOP_PLAYER_BASE_SIZE[desktopPlayerForm] || DESKTOP_PLAYER_BASE_SIZE.card
  desktopPlayerWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    title: 'HyperPlayer 桌面播放器',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'desktop-player-preload.cjs'),
      backgroundThrottling: false,
      cache: false,
    },
  })

  if (isDev) {
    desktopPlayerWindow.loadURL(`${devServerUrl}/desktop-player.html`)
  } else {
    desktopPlayerWindow.loadFile(path.join(__dirname, '../dist/desktop-player.html'))
  }

  desktopPlayerWindow.once('ready-to-show', () => {
    if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
      // 首次创建：卡片位于右上角，紧凑条状位于顶部居中。
      try {
        const { screen } = require('electron')
        const workArea = screen.getPrimaryDisplay().workArea
        const bounds = desktopPlayerWindow.getBounds()
        const x = desktopPlayerForm === 'bar'
          ? Math.round(workArea.x + (workArea.width - bounds.width) / 2)
          : Math.round(workArea.x + workArea.width - bounds.width - 24)
        const y = Math.round(workArea.y + (desktopPlayerForm === 'bar' ? 12 : 24))
        desktopPlayerWindow.setBounds({ x, y, width: bounds.width, height: bounds.height })
      } catch (positionError) {
        console.warn('[桌面播放器] 初始定位失败:', positionError)
      }
      // showInactive：不抢焦点。主窗口 kiosk 全屏（覆盖任务栏）时若被抢焦，
      // Windows 会退出 kiosk 露出任务栏，用户还需再点一次主窗口才能恢复全屏。
      desktopPlayerWindow.showInactive()
      desktopPlayerWindow.moveTop()
    }
  })
  desktopPlayerWindow.webContents.once('did-finish-load', () => {
    broadcastDesktopPlayerState()
  })
  guardAgainstExternalNavigation(desktopPlayerWindow.webContents)
  desktopPlayerWindow.on('closed', () => {
    desktopPlayerWindow = null
    // Alt+F4 等系统路径关闭：同步开关状态（UI 内关闭路径已做），否则渲染端开关残留
    // "开启"，频谱/状态推送持续打向已销毁窗口
    if (desktopPlayerEnabled) {
      desktopPlayerEnabled = false
      saveDesktopPlayerSettings()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop-player:enabled-changed', false)
      }
    }
  })
  return desktopPlayerWindow
}

function closeDesktopPlayerWindow() {
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
    desktopPlayerWindow.close()
  }
  desktopPlayerWindow = null
}

function getDesktopLyricsSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-lyrics-settings.json')
}

function sanitizeDesktopLyricsSettings(input = {}, base = DESKTOP_LYRICS_DEFAULTS) {
  return {
    enabled: input.enabled === undefined ? base.enabled === true : input.enabled === true,
    fontSize: input.fontSize === undefined
      ? base.fontSize
      : Math.round(Math.min(120, Math.max(26, Number(input.fontSize) || DESKTOP_LYRICS_DEFAULTS.fontSize))),
    // 字体族名：允许任意本机字体名，仅截断长度防止异常数据；空串 = 默认字体栈
    fontFamily: input.fontFamily === undefined
      ? (base.fontFamily || '')
      : String(input.fontFamily).trim().slice(0, 128),
    colorMode: input.colorMode === undefined
      ? base.colorMode
      : (DESKTOP_LYRICS_COLORS.has(input.colorMode) ? input.colorMode : 'auto'),
    orientation: input.orientation === undefined
      ? base.orientation
      : (DESKTOP_LYRICS_ORIENTATIONS.has(input.orientation) ? input.orientation : 'horizontal'),
    doubleLine: input.doubleLine === undefined ? base.doubleLine === true : input.doubleLine === true,
    translationEnabled: input.translationEnabled === undefined ? base.translationEnabled === true : input.translationEnabled === true,
    romajiEnabled: input.romajiEnabled === undefined ? base.romajiEnabled === true : input.romajiEnabled === true,
    traditionalEnabled: input.traditionalEnabled === undefined ? base.traditionalEnabled === true : input.traditionalEnabled === true,
    locked: input.locked === undefined ? base.locked === true : input.locked === true,
  }
}

function loadDesktopLyricsSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDesktopLyricsSettingsPath(), 'utf8'))
    desktopLyricsSavedBounds = parsed?.bounds && Number.isFinite(parsed.bounds.x) && Number.isFinite(parsed.bounds.y)
      ? parsed.bounds
      : null
    return sanitizeDesktopLyricsSettings(parsed)
  } catch {
    desktopLyricsSavedBounds = null
    return { ...DESKTOP_LYRICS_DEFAULTS }
  }
}

function saveDesktopLyricsSettings() {
  try {
    const settingsPath = getDesktopLyricsSettingsPath()
    const temporaryPath = `${settingsPath}.tmp`
    const bounds = desktopLyricsPanelRestoreBounds || (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()
      ? desktopLyricsWindow.getBounds()
      : desktopLyricsSavedBounds)
    desktopLyricsSavedBounds = bounds || desktopLyricsSavedBounds
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify({ ...desktopLyricsSettings, bounds }, null, 2), 'utf8')
    fs.renameSync(temporaryPath, settingsPath)
  } catch (error) {
    console.error('[桌面歌词] 保存设置失败:', error)
  }
}

function getDesktopLyricsSettings() {
  return { ...desktopLyricsSettings }
}

function broadcastDesktopLyricsSettings() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.webContents.send('desktop-lyrics:settings', getDesktopLyricsSettings())
  }
}

function setDesktopLyricsMousePassthrough(passthrough) {
  const next = desktopLyricsSettings.locked === true && passthrough === true
  desktopLyricsMousePassthrough = next
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    try {
      if (next) desktopLyricsWindow.setIgnoreMouseEvents(true, { forward: true })
      else desktopLyricsWindow.setIgnoreMouseEvents(false)
    } catch (error) {
      console.warn('[\u684c\u9762\u6b4c\u8bcd] \u5207\u6362\u9f20\u6807\u7a7f\u900f\u5931\u8d25:', error)
    }
  }
  return desktopLyricsMousePassthrough
}

function getDesktopLyricsDefaultBounds(orientation = desktopLyricsSettings.orientation) {
  const { screen } = require('electron')
  const workArea = screen.getPrimaryDisplay().workArea
  const size = orientation === 'vertical'
    ? { width: 300, height: Math.min(720, workArea.height - 48) }
    : { width: Math.min(980, workArea.width - 48), height: 180 }
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: orientation === 'vertical'
      ? Math.round(workArea.y + (workArea.height - size.height) / 2)
      : Math.round(workArea.y + workArea.height - size.height - 54),
    ...size,
  }
}

function clampDesktopLyricsBounds(bounds) {
  const workArea = getDesktopPlayerWorkArea(bounds)
  const vertical = desktopLyricsSettings.orientation === 'vertical'
  const minimumWidth = vertical ? 240 : 480
  const minimumHeight = vertical ? 340 : 116
  const width = Math.min(workArea.width, Math.max(minimumWidth, Math.round(bounds.width)))
  const height = Math.min(workArea.height, Math.max(minimumHeight, Math.round(bounds.height)))
  return {
    x: Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, Math.round(bounds.x))),
    y: Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, Math.round(bounds.y))),
    width,
    height,
  }
}

function createDesktopLyricsWindow() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) return desktopLyricsWindow
  const initialBounds = desktopLyricsSavedBounds || getDesktopLyricsDefaultBounds()
  desktopLyricsWindow = new BrowserWindow({
    ...initialBounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    title: 'HyperPlayer 桌面歌词',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'desktop-lyrics-preload.cjs'),
      backgroundThrottling: false,
      cache: false,
    },
  })

  if (isDev) desktopLyricsWindow.loadURL(`${devServerUrl}/desktop-lyrics.html`)
  else desktopLyricsWindow.loadFile(path.join(__dirname, '../dist/desktop-lyrics.html'))

  desktopLyricsWindow.once('ready-to-show', () => {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return
    desktopLyricsWindow.setBounds(clampDesktopLyricsBounds(desktopLyricsWindow.getBounds()))
    desktopLyricsWindow.showInactive()
    desktopLyricsWindow.moveTop()
    setDesktopLyricsMousePassthrough(desktopLyricsSettings.locked)
  })
  desktopLyricsWindow.webContents.once('did-finish-load', () => {
    broadcastDesktopPlayerState()
    broadcastDesktopLyricsSettings()
  })
  guardAgainstExternalNavigation(desktopLyricsWindow.webContents)
  desktopLyricsWindow.on('closed', () => {
    desktopLyricsWindow = null
    desktopLyricsPanelRestoreBounds = null
    desktopLyricsMousePassthrough = false
    // Alt+F4 等系统路径关闭：同步开关状态（UI 内关闭路径已做），否则渲染端开关残留"开启"
    if (desktopLyricsSettings.enabled) {
      desktopLyricsSettings = { ...desktopLyricsSettings, enabled: false }
      saveDesktopLyricsSettings()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop-lyrics:enabled-changed', false)
      }
    }
  })
  return desktopLyricsWindow
}

function closeDesktopLyricsWindow() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) desktopLyricsWindow.close()
  desktopLyricsWindow = null
  desktopLyricsPanelRestoreBounds = null
  desktopLyricsMousePassthrough = false
}

ipcMain.handle('desktop-lyrics:get-settings', () => getDesktopLyricsSettings())

ipcMain.handle('desktop-lyrics:set-enabled', (_event, enabled) => {
  desktopLyricsSettings = { ...desktopLyricsSettings, enabled: enabled === true }
  saveDesktopLyricsSettings()
  if (desktopLyricsSettings.enabled) createDesktopLyricsWindow()
  else closeDesktopLyricsWindow()
  // 回广播启用状态，让主窗口据此门控频谱推送
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-lyrics:enabled-changed', desktopLyricsSettings.enabled)
  }
  return { success: true, enabled: desktopLyricsSettings.enabled }
})

ipcMain.handle('desktop-lyrics:update-settings', (_event, partial) => {
  const previousOrientation = desktopLyricsSettings.orientation
  desktopLyricsSettings = sanitizeDesktopLyricsSettings(partial, desktopLyricsSettings)
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'locked')) {
    setDesktopLyricsMousePassthrough(desktopLyricsSettings.locked)
  }
  if (desktopLyricsSettings.enabled && !desktopLyricsWindow) createDesktopLyricsWindow()
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed() && previousOrientation !== desktopLyricsSettings.orientation) {
    const baseTarget = getDesktopLyricsDefaultBounds(desktopLyricsSettings.orientation)
    if (desktopLyricsPanelRestoreBounds) {
      desktopLyricsPanelRestoreBounds = baseTarget
      const workArea = getDesktopPlayerWorkArea(baseTarget)
      const targetHeight = Math.min(workArea.height, Math.max(baseTarget.height, 500))
      desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
        ...baseTarget,
        y: Math.max(workArea.y, baseTarget.y + baseTarget.height - targetHeight),
        height: targetHeight,
      }))
    } else {
      desktopLyricsWindow.setBounds(clampDesktopLyricsBounds(baseTarget))
    }
  }
  saveDesktopLyricsSettings()
  broadcastDesktopLyricsSettings()
  return getDesktopLyricsSettings()
})

ipcMain.handle('desktop-lyrics:set-panel-open', (_event, open) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsSettings.locked) return { open: false }
  if (open === true && !desktopLyricsPanelRestoreBounds) {
    const bounds = desktopLyricsWindow.getBounds()
    const workArea = getDesktopPlayerWorkArea(bounds)
    desktopLyricsPanelRestoreBounds = bounds
    const targetHeight = Math.min(workArea.height, Math.max(bounds.height, 500))
    desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
      x: bounds.x,
      y: Math.max(workArea.y, bounds.y + bounds.height - targetHeight),
      width: bounds.width,
      height: targetHeight,
    }))
  } else if (open !== true && desktopLyricsPanelRestoreBounds) {
    desktopLyricsWindow.setBounds(clampDesktopLyricsBounds(desktopLyricsPanelRestoreBounds))
    desktopLyricsPanelRestoreBounds = null
  }
  return { open: open === true }
})

ipcMain.handle('desktop-lyrics:set-mouse-passthrough', (_event, passthrough) => ({
  passthrough: setDesktopLyricsMousePassthrough(passthrough === true),
}))

ipcMain.on('desktop-lyrics:control', (_event, action) => {
  if (action === 'close') {
    desktopLyricsSettings = { ...desktopLyricsSettings, enabled: false }
    saveDesktopLyricsSettings()
    closeDesktopLyricsWindow()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-lyrics:enabled-changed', false)
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-player:control', action)
})

ipcMain.on('desktop-lyrics:drag-start', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsSettings.locked) return
  if (desktopLyricsPanelRestoreBounds) return
  desktopLyricsDragSession = {
    bounds: desktopLyricsWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
  }
})

ipcMain.on('desktop-lyrics:drag-to', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || !desktopLyricsDragSession) return
  const start = desktopLyricsDragSession
  desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
    ...start.bounds,
    x: start.bounds.x + ((Number(point?.x) || 0) - start.x),
    y: start.bounds.y + ((Number(point?.y) || 0) - start.y),
  }))
})

ipcMain.on('desktop-lyrics:drag-end', () => {
  desktopLyricsDragSession = null
  saveDesktopLyricsSettings()
})

ipcMain.on('desktop-lyrics:resize-start', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsSettings.locked) return
  if (desktopLyricsPanelRestoreBounds) return
  const edge = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].includes(point?.edge) ? point.edge : 'se'
  desktopLyricsResizeSession = {
    bounds: desktopLyricsWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    edge,
  }
})

ipcMain.on('desktop-lyrics:resize-to', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || !desktopLyricsResizeSession) return
  const start = desktopLyricsResizeSession
  const dx = (Number(point?.x) || 0) - start.x
  const dy = (Number(point?.y) || 0) - start.y
  const fromLeft = start.edge.includes('w')
  const fromRight = start.edge.includes('e')
  const fromTop = start.edge.includes('n')
  const fromBottom = start.edge.includes('s')
  const width = start.bounds.width + (fromLeft ? -dx : fromRight ? dx : 0)
  const height = start.bounds.height + (fromTop ? -dy : fromBottom ? dy : 0)
  const nextWidth = Math.max(desktopLyricsSettings.orientation === 'vertical' ? 240 : 480, width)
  const nextHeight = Math.max(desktopLyricsSettings.orientation === 'vertical' ? 340 : 116, height)
  desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
    x: fromLeft ? start.bounds.x + start.bounds.width - nextWidth : start.bounds.x,
    y: fromTop ? start.bounds.y + start.bounds.height - nextHeight : start.bounds.y,
    width: nextWidth,
    height: nextHeight,
  }))
})

ipcMain.on('desktop-lyrics:resize-end', () => {
  desktopLyricsResizeSession = null
  saveDesktopLyricsSettings()
})

ipcMain.handle('desktop-player:set-enabled', (_event, enabled) => {
  desktopPlayerEnabled = enabled === true
  saveDesktopPlayerSettings()
  if (desktopPlayerEnabled) {
    createDesktopPlayerWindow()
  } else {
    closeDesktopPlayerWindow()
  }
  // 回广播启用状态，让主窗口据此门控频谱推送（无消费者时跳过 IPC 与数组分配）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-player:enabled-changed', desktopPlayerEnabled)
  }
  return { success: true, enabled: desktopPlayerEnabled }
})

ipcMain.handle('desktop-player:set-form', (_event, form) => {
  if (!DESKTOP_PLAYER_FORMS.has(form)) return { success: false, form: desktopPlayerForm }
  const changed = desktopPlayerForm !== form
  desktopPlayerForm = form
  saveDesktopPlayerSettings()
  if (desktopPlayerEnabled && desktopPlayerWindow && !desktopPlayerWindow.isDestroyed() && changed) {
    const size = DESKTOP_PLAYER_BASE_SIZE[desktopPlayerForm]
    const bounds = desktopPlayerWindow.getBounds()
    const workArea = getDesktopPlayerWorkArea(bounds)
    const centerX = workArea.x + workArea.width / 2
    desktopPlayerWindow.setBounds({
      x: desktopPlayerForm === 'bar'
        ? Math.round(centerX - size.width / 2)
        : Math.round(workArea.x + workArea.width - size.width - 24),
      y: Math.round(workArea.y + (desktopPlayerForm === 'bar' ? 12 : 24)),
      width: size.width,
      height: size.height,
    })
  }
  broadcastDesktopPlayerState()
  return { success: true, form: desktopPlayerForm }
})

ipcMain.handle('desktop-player:get-state', () => getDesktopPlayerSnapshot())

ipcMain.handle('media-keys:set-enabled', (_event, enabled) => {
  if (!app.isReady()) return { success: false, enabled: false, registrations: {} }
  return setGlobalMediaKeysEnabled(enabled)
})

// IPC：OOBE 完成 flag 文件（用户数据目录下 .oobe-complete，独立于 localStorage——
// 双重保险：localStorage 被清/损坏时仍能识别已完成的 OOBE，跳过引导）
const oobeFlagPath = () => path.join(app.getPath('userData'), '.oobe-complete')

ipcMain.handle('oobe:get-flag', () => {
  try {
    return fs.existsSync(oobeFlagPath())
  } catch {
    return false
  }
})
ipcMain.handle('oobe:set-flag', () => {
  try {
    fs.writeFileSync(oobeFlagPath(), new Date().toISOString(), 'utf8')
    return true
  } catch {
    return false
  }
})

// 主窗口推送播放状态（歌曲 / 歌词 / 播放中 / 频谱）
ipcMain.on('desktop-player:state-update', (_event, partial) => {
  if (!partial || typeof partial !== 'object') return
  const changed = {}

  if (partial.song !== undefined) {
    const next = partial.song || null
    if (desktopPlayerState.song !== next) {
      desktopPlayerState.song = next
      changed.song = next
    }
  }
  if (partial.lyric !== undefined) {
    const next = partial.lyric || null
    if (desktopPlayerState.lyric !== next) {
      desktopPlayerState.lyric = next
      changed.lyric = next
    }
  }
  if (partial.playing !== undefined) {
    const next = partial.playing === true
    if (desktopPlayerState.playing !== next) {
      desktopPlayerState.playing = next
      changed.playing = next
    }
  }
  for (const key of ['hasTranslation', 'hasRomaji', 'live']) {
    if (partial[key] === undefined) continue
    const next = partial[key] === true
    if (desktopPlayerState[key] !== next) {
      desktopPlayerState[key] = next
      changed[key] = next
    }
  }
  if (partial.accentColor !== undefined) {
    const next = String(partial.accentColor || '')
    if (desktopPlayerState.accentColor !== next) {
      desktopPlayerState.accentColor = next
      changed.accentColor = next
    }
  }
  if (Array.isArray(partial.playlist)) {
    const next = partial.playlist.slice(0, 500).map(item => ({
      index: Number(item?.index) || 0,
      name: String(item?.name || ''),
      artists: String(item?.artists || ''),
    }))
    desktopPlayerState.playlist = next
    changed.playlist = next
  }
  if (partial.currentIndex !== undefined) {
    const value = Number(partial.currentIndex)
    const next = Number.isInteger(value) ? value : -1
    if (desktopPlayerState.currentIndex !== next) {
      desktopPlayerState.currentIndex = next
      changed.currentIndex = next
    }
  }
  if (typeof partial.progress === 'number' && Number.isFinite(partial.progress)) {
    desktopPlayerState.progress = partial.progress
    changed.progress = partial.progress
  }
  if (typeof partial.duration === 'number' && Number.isFinite(partial.duration)) {
    const next = Math.max(0, partial.duration)
    if (desktopPlayerState.duration !== next) {
      desktopPlayerState.duration = next
      changed.duration = next
    }
  }
  if (typeof partial.volume === 'number' && Number.isFinite(partial.volume)) {
    const next = Math.max(0, Math.min(1, partial.volume))
    if (desktopPlayerState.volume !== next) {
      desktopPlayerState.volume = next
      changed.volume = next
    }
  }
  if (typeof partial.muted === 'boolean') {
    if (desktopPlayerState.muted !== partial.muted) {
      desktopPlayerState.muted = partial.muted
      changed.muted = partial.muted
    }
  }
  if (partial.page === 'home' || partial.page === 'playback') {
    if (desktopPlayerState.page !== partial.page) {
      desktopPlayerState.page = partial.page
      changed.page = partial.page
    }
  }
  if (Array.isArray(partial.spectrum)) {
    const next = partial.spectrum.slice(0, 5).map(value => Math.max(0, Math.min(1, Number(value) || 0)))
    desktopPlayerState.spectrum = next
    changed.spectrum = next
  }
  broadcastDesktopPlayerPartial(changed)

  // Windows 任务栏：播放/暂停状态变化时切换缩略图按钮图标；进度/时长/播放状态/
  // 歌曲变化时刷新任务栏进度条（mode: normal 播放中 / paused 暂停 / none 停止）。
  if (changed.playing !== undefined) updateThumbarButtons()
  if (changed.playing !== undefined || changed.song !== undefined || changed.progress !== undefined || changed.duration !== undefined) {
    updateTaskbarProgress()
  }
  // 任务栏快捷播控 widget：歌曲/播放/进度变化时同步刷新；切歌后重新显示（关闭仅隐藏当前歌）
  if (changed.song !== undefined) taskbarWidgetClosedByUser = false
  if (changed.song !== undefined || changed.playing !== undefined || changed.progress !== undefined || changed.duration !== undefined || changed.muted !== undefined) {
    updateTaskbarWidget()
  }
})

// 小窗口内的播放控制指令，转发给主窗口执行
ipcMain.on('desktop-player:control', (_event, action, payload) => {
  // close 由主进程直接处理：关闭小窗口并同步开关状态
  if (action === 'close') {
    desktopPlayerEnabled = false
    saveDesktopPlayerSettings()
    closeDesktopPlayerWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop-player:enabled-changed', false)
    }
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-player:control', action, payload)
  }
})

ipcMain.on('desktop-player:resize-start', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerForm !== 'card') return
  if (desktopPlayerBoundsAnimation) {
    clearInterval(desktopPlayerBoundsAnimation)
    desktopPlayerBoundsAnimation = null
  }
  desktopPlayerResizeSession = {
    bounds: desktopPlayerWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    edge: ['nw', 'ne', 'sw', 'se'].includes(point?.edge) ? point.edge : 'se',
  }
})

ipcMain.on('desktop-player:resize-to', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed() || !desktopPlayerResizeSession) return
  const start = desktopPlayerResizeSession
  const workArea = getDesktopPlayerWorkArea(start.bounds)
  const dx = (Number(point?.x) || 0) - start.x
  const dy = (Number(point?.y) || 0) - start.y
  const fromLeft = start.edge.endsWith('w')
  const fromTop = start.edge.startsWith('n')
  const width = Math.min(720, Math.max(300, Math.round(start.bounds.width + (fromLeft ? -dx : dx))))
  const height = Math.min(workArea.height, Math.max(112, Math.round(start.bounds.height + (fromTop ? -dy : dy))))
  const x = fromLeft ? start.bounds.x + start.bounds.width - width : start.bounds.x
  const y = fromTop ? start.bounds.y + start.bounds.height - height : start.bounds.y
  desktopPlayerWindow.setBounds(clampDesktopPlayerBounds({ x, y, width, height }))
})

ipcMain.on('desktop-player:resize-end', () => {
  desktopPlayerResizeSession = null
})

ipcMain.handle('desktop-player:set-expanded', (_event, expanded) => {
  return { direction: desktopPlayerSetExpanded(expanded === true) || desktopPlayerExpansionDirection }
})


// 内容高度同步：根据屏幕剩余空间保持顶边或底边不动，避免面板跑出屏幕。
ipcMain.on('desktop-player:content-height', (_event, height) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerResizeSession) return
  // 最小高度与 resize 的 112 一致（此前用 BASE_SIZE.height=150，卡片缩到 112 后收起会被撑回 150，尺寸变长）
  const minimum = desktopPlayerForm === 'bar' ? 80 : 112
  const bounds = desktopPlayerWindow.getBounds()
  const workArea = getDesktopPlayerWorkArea(bounds)
  const target = Math.min(workArea.height, Math.max(minimum, Math.ceil(Number(height) || 0)))
  if (bounds.height === target) return
  const y = desktopPlayerExpansionDirection === 'up' ? bounds.y + bounds.height - target : bounds.y
  animateDesktopPlayerBounds(clampDesktopPlayerBounds({ x: bounds.x, y, width: bounds.width, height: target }))
})

// 使用拖动开始时的绝对窗口坐标，避免高频 IPC 延迟造成位移累计误差和窗口抽搐。
ipcMain.on('desktop-player:drag-start', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerBoundsAnimation) {
    clearInterval(desktopPlayerBoundsAnimation)
    desktopPlayerBoundsAnimation = null
  }
  desktopPlayerDragSession = {
    bounds: desktopPlayerWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
  }
})

ipcMain.on('desktop-player:drag-to', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed() || !desktopPlayerDragSession) return
  const start = desktopPlayerDragSession
  const next = {
    ...start.bounds,
    x: Math.round(start.bounds.x + (Number(point?.x) - start.x)),
    y: Math.round(start.bounds.y + (Number(point?.y) - start.y)),
  }
  desktopPlayerWindow.setBounds(clampDesktopPlayerBounds(next))
})

ipcMain.on('desktop-player:drag-end', () => {
  desktopPlayerDragSession = null
})

function getSecureCredentialsPath() {
  return path.join(app.getPath('userData'), 'secure-credentials.json')
}

function readSecureCredentials() {
  const credentialsPath = getSecureCredentialsPath()
  if (!fs.existsSync(credentialsPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSecureCredentials(credentials) {
  const credentialsPath = getSecureCredentialsPath()
  const temporaryPath = `${credentialsPath}.tmp`
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
  fs.writeFileSync(temporaryPath, JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporaryPath, credentialsPath)
}

function readQQMusicSkillKey() {
  if (!safeStorage.isEncryptionAvailable()) return ''
  const encrypted = readSecureCredentials()[QQMUSIC_SKILL_CREDENTIAL]
  if (typeof encrypted !== 'string' || !encrypted) return ''
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return ''
  }
}

// 开发者模式状态（默认关闭）
let developerMode = false

// 日志辅助函数，仅在开发者模式下输出壁纸相关日志
function logWallpaper(...args) {
  if (developerMode) {
    console.log(...args)
  }
}

function safeSendToWindow(targetWindow, channel, ...args) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return false
  }

  const contents = targetWindow.webContents
  if (!contents || contents.isDestroyed()) {
    return false
  }

  try {
    contents.send(channel, ...args)
    return true
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    if (!message.includes('Render frame was disposed')) {
      console.warn(`[IPC] Failed to send "${channel}":`, message)
    }
    return false
  }
}

// 统一的播放控制命令派发入口：全局媒体键与 Windows 任务栏缩略图按钮共用，
// 避免各来源各自实现一套「发给主窗口渲染进程」的逻辑。走 global-media-key 通道，
// 渲染进程已内置 280ms 防抖（Windows 可能把同一次按键同时交给 globalShortcut 与
// Media Session，防止同一动作重复触发）。
function dispatchPlayerControl(action, payload) {
  if (desktopPlayerState.live === true && (action === 'prev' || action === 'next' || action === 'seek')) return
  safeSendToWindow(mainWindow, 'global-media-key', action, payload)
}

// ===== Windows 任务栏缩略图按钮 + 进度条（仅 win32 生效，其余平台自动跳过） =====
const THUMBAR_ICON_SIZE = 32
let thumbarIconsCache = null

// 生成任务栏按钮图标。Electron 没有内置的播放/暂停图标素材，这里用
// nativeImage.createFromBitmap 从原始 BGRA 位图直接绘制三角形/竖线，
// 不依赖外部图片资源。图标统一为白色（RGB 相等），字节序差异不影响渲染。
function buildThumbarIcon(inside) {
  const size = THUMBAR_ICON_SIZE
  const buffer = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!inside(x, y)) continue
      const offset = (y * size + x) * 4
      buffer[offset] = 255
      buffer[offset + 1] = 255
      buffer[offset + 2] = 255
      buffer[offset + 3] = 255
    }
  }
  try {
    const image = nativeImage.createFromBitmap(buffer, { width: size, height: size })
    if (image.isEmpty()) return nativeImage.createEmpty()
    return image
  } catch {
    return nativeImage.createEmpty()
  }
}

function getThumbarIcons() {
  if (!thumbarIconsCache) {
    const center = THUMBAR_ICON_SIZE / 2
    const half = 10 // 三角形/竖线的垂直半高（图标上下对称，位图方向差异无影响）
    // 播放：向右的实心三角形（左底右尖）
    const playInside = (x, y) => {
      const t = (27 - x) / (27 - 8)
      return x >= 8 && x <= 27 && t >= 0 && Math.abs(y - center) <= half * t
    }
    // 暂停：两根竖线
    const pauseInside = (x, y) => {
      const inLeft = x >= 8 && x <= 13 && y >= 6 && y <= 26
      const inRight = x >= 19 && x <= 24 && y >= 6 && y <= 26
      return inLeft || inRight
    }
    // 上一首：左侧竖线 + 向左的实心三角形（右底左尖，尖贴着竖线）
    const prevInside = (x, y) => {
      const bar = x >= 4 && x <= 7 && y >= 7 && y <= 25
      const t = (x - 7) / (23 - 7)
      const triangle = x >= 7 && x <= 23 && t >= 0 && t <= 1 && Math.abs(y - center) <= half * t
      return bar || triangle
    }
    // 下一首：向右的实心三角形（左底右尖，尖贴着竖线）+ 右侧竖线
    const nextInside = (x, y) => {
      const bar = x >= 25 && x <= 28 && y >= 7 && y <= 25
      const t = (25 - x) / (25 - 9)
      const triangle = x >= 9 && x <= 25 && t >= 0 && t <= 1 && Math.abs(y - center) <= half * t
      return bar || triangle
    }
    thumbarIconsCache = {
      play: buildThumbarIcon(playInside),
      pause: buildThumbarIcon(pauseInside),
      prev: buildThumbarIcon(prevInside),
      next: buildThumbarIcon(nextInside),
    }
  }
  return thumbarIconsCache
}

function updateThumbarButtons() {
  if (process.platform !== 'win32') return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const icons = getThumbarIcons()
  if (icons.play.isEmpty() || icons.pause.isEmpty()) return
  const playing = desktopPlayerState.playing === true
  const buttons = desktopPlayerState.live === true
    ? [{
        tooltip: playing ? '暂停直播' : '播放直播',
        icon: playing ? icons.pause : icons.play,
        click: () => dispatchPlayerControl('toggle'),
      }]
    : [
        { tooltip: '上一首', icon: icons.prev, click: () => dispatchPlayerControl('prev') },
        {
          tooltip: playing ? '暂停' : '播放',
          icon: playing ? icons.pause : icons.play,
          click: () => dispatchPlayerControl('toggle'),
        },
        { tooltip: '下一首', icon: icons.next, click: () => dispatchPlayerControl('next') },
      ]
  try {
    mainWindow.setThumbarButtons(buttons)
  } catch {
    // 非 Windows / 窗口无任务栏按钮等场景：静默忽略
  }
}

function getTaskbarProgressRatio() {
  const duration = Number(desktopPlayerState.duration) || 0
  const progress = Number(desktopPlayerState.progress) || 0
  if (duration <= 0 || progress <= 0) return 0
  return Math.max(0, Math.min(1, progress / duration))
}

function updateTaskbarProgress() {
  if (process.platform !== 'win32') return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const playing = desktopPlayerState.playing === true
  const hasSong = Boolean(desktopPlayerState.song)
  const ratio = getTaskbarProgressRatio()
  try {
    if (!hasSong || desktopPlayerState.live === true) {
      mainWindow.setProgressBar(0, { mode: 'none' })
    } else {
      mainWindow.setProgressBar(ratio, { mode: playing ? 'normal' : 'paused' })
    }
  } catch {
    // 静默忽略
  }
}

function updateTaskbar() {
  updateThumbarButtons()
  updateTaskbarProgress()
}

// ===== 任务栏迷你播控（贴任务栏带的迷你歌词播放器，win32 生效） =====
// 与 Echo 的「迷你底栏」对齐：窗口高度精确等于任务栏带高度，贴任务栏右侧（或居中），
// 播放时显示封面/歌词行/进度并提供控制；默认鼠标穿透，悬停进入交互态不挡任务栏。
// 设置（userData/taskbar-widget-settings.json）由「设置-个性化」控制开关/位置/宽度/模式。
const TASKBAR_WIDGET_DEFAULTS = { enabled: false, position: 'right', width: 340, mode: 'normal', darken: false, darkenLevel: 0.5, hideControls: false }
let taskbarWidgetSettings = { ...TASKBAR_WIDGET_DEFAULTS }
let taskbarWidgetWindow = null

// IPC 权限同时绑定窗口身份、顶层 frame 和当前文档 URL。辅助窗口只保留各自
// 播控能力；凭据、路径、启动器、模型、下载与更新操作仅主应用文档可调用。
const trustedIpc = createTrustedIpcGuard({
  roles: {
    main: {
      getWindow: () => mainWindow,
      isAllowedUrl: createDocumentUrlMatcher([
        devServerUrl,
        pathToFileURL(path.join(__dirname, '../dist/index.html')).href,
      ]),
    },
    desktopPlayer: {
      getWindow: () => desktopPlayerWindow,
      isAllowedUrl: createDocumentUrlMatcher([
        `${devServerUrl}/desktop-player.html`,
        pathToFileURL(path.join(__dirname, '../dist/desktop-player.html')).href,
      ]),
    },
    desktopLyrics: {
      getWindow: () => desktopLyricsWindow,
      isAllowedUrl: createDocumentUrlMatcher([
        `${devServerUrl}/desktop-lyrics.html`,
        pathToFileURL(path.join(__dirname, '../dist/desktop-lyrics.html')).href,
      ]),
    },
    taskbarWidget: {
      getWindow: () => taskbarWidgetWindow,
      isAllowedUrl: createDocumentUrlMatcher([
        pathToFileURL(path.join(__dirname, 'taskbar-widget.html')).href,
      ]),
    },
  },
  capabilities: {
    privileged: ['main'],
    models: ['main'],
    update: ['main'],
    desktopPlayer: ['main', 'desktopPlayer', 'desktopLyrics'],
    desktopLyrics: ['main', 'desktopLyrics'],
    taskbarWidget: ['main', 'taskbarWidget'],
  },
})
const guardTrustedIpc = trustedIpc.handle

let taskbarWidgetClosedByUser = false
let taskbarWidgetInteractive = false
let taskbarWidgetExpanded = false
let taskbarDisplayMetricsBound = false
// 设置文件重载节流：updateTaskbarWidget 随播放进度每秒触发，避免每次同步读盘
let taskbarWidgetSettingsLastLoad = 0
const TASKBAR_WIDGET_SETTINGS_RELOAD_MS = 5000

function getTaskbarWidgetSettingsPath() {
  return path.join(app.getPath('userData'), 'taskbar-widget-settings.json')
}

function sanitizeTaskbarWidgetSettings(input = {}, base = TASKBAR_WIDGET_DEFAULTS) {
  return {
    enabled: input.enabled === undefined ? base.enabled === true : input.enabled === true,
    position: input.position === 'right' || input.position === 'center' ? input.position : (base.position === 'center' ? 'center' : 'right'),
    width: Math.round(Math.min(420, Math.max(260, Number(input.width) || base.width))),
    mode: input.mode === 'pure' || input.mode === 'normal' ? input.mode : (base.mode === 'pure' ? 'pure' : 'normal'),
    darken: input.darken === undefined ? base.darken === true : input.darken === true,
    darkenLevel: Math.min(0.95, Math.max(0.05, Number(input.darkenLevel) || base.darkenLevel)),
    hideControls: input.hideControls === undefined ? base.hideControls === true : input.hideControls === true,
  }
}

function loadTaskbarWidgetSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getTaskbarWidgetSettingsPath(), 'utf8'))
    taskbarWidgetSettings = sanitizeTaskbarWidgetSettings(parsed)
  } catch {
    taskbarWidgetSettings = { ...TASKBAR_WIDGET_DEFAULTS }
  }
  return taskbarWidgetSettings
}

function saveTaskbarWidgetSettings() {
  try {
    const settingsPath = getTaskbarWidgetSettingsPath()
    const temporaryPath = `${settingsPath}.tmp`
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify(taskbarWidgetSettings, null, 2), 'utf8')
    fs.renameSync(temporaryPath, settingsPath)
  } catch (error) {
    console.error('[任务栏播控] 保存设置失败:', error)
  }
}

function getTaskbarWidgetSettings() {
  return { ...taskbarWidgetSettings }
}

function broadcastTaskbarWidgetSettings() {
  if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) {
    taskbarWidgetWindow.webContents.send('taskbar-widget:settings', getTaskbarWidgetSettings())
  }
}

// 系统托盘（通知区域）左缘测量：Windows 下查询 TrayNotifyWnd 的物理像素矩形。
// 右侧定位需要「紧贴托盘外侧」，固定留白在托盘宽度变化时会叠进托盘，故按真实托盘位置计算。
let taskbarTrayCache = null // { left, right } 物理像素
let taskbarTrayCacheAt = 0
let taskbarTrayRequest = null
const TASKBAR_TRAY_CACHE_MS = 30000
// 托盘不可测时靠右贴齐：留 12px 边距
const TASKBAR_TRAY_FALLBACK_RATIO = 0.04

function fetchTaskbarTrayRectPhysical() {
  if (taskbarTrayRequest) return taskbarTrayRequest
  const script = [
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class T{[DllImport("user32.dll")]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern IntPtr FindWindowEx(IntPtr p,IntPtr c,string cn,string tn);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);public struct R{public int L,T,Rt,B;}}'`,
    `$t=[T]::FindWindow('Shell_TrayWnd',$null)`,
    `$n=[T]::FindWindowEx($t,[IntPtr]::Zero,'TrayNotifyWnd',$null)`,
    `if($n -eq [IntPtr]::Zero){'none'}else{$r=New-Object T+R;[T]::GetWindowRect($n,[ref]$r)|Out-Null;"$($r.L),$($r.Rt)"}`,
  ].join(';')
  taskbarTrayRequest = new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      taskbarTrayRequest = null
      if (error) return resolve(null)
      const lines = String(stdout || '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      const match = (lines[lines.length - 1] || '').match(/^(-?\d+),(-?\d+)$/)
      if (!match) return resolve(null)
      const rect = { left: Number(match[1]), right: Number(match[2]) }
      taskbarTrayCache = rect
      taskbarTrayCacheAt = Date.now()
      resolve(rect)
    })
  })
  return taskbarTrayRequest
}

function getTaskbarTrayLeftDip() {
  if (taskbarTrayCache && Date.now() - taskbarTrayCacheAt < TASKBAR_TRAY_CACHE_MS) {
    const { screen } = require('electron')
    const scale = screen.getPrimaryDisplay().scaleFactor || 1
    return Math.round(taskbarTrayCache.left / scale)
  }
  return null
}

/** 托盘缓存失效时后台刷新，完成后重新贴边（托盘图标增减导致宽度变化也能跟上） */
function refreshTaskbarTray() {
  if (getTaskbarTrayLeftDip() !== null) return Promise.resolve(taskbarTrayCache)
  return fetchTaskbarTrayRectPhysical().then(rect => {
    if (rect) dockTaskbarWidgetWindow()
    return rect
  })
}

function getTaskbarWidgetPosition() {
  const { screen } = require('electron')
  const display = screen.getPrimaryDisplay()
  const bounds = display.bounds // 含任务栏的完整屏幕区域
  const workArea = display.workArea
  const width = taskbarWidgetSettings.width
  // 任务栏方位判定：对比 bounds 与 workArea 的四边差（DIP）
  const taskbarTop = Math.round(workArea.y - bounds.y)
  const taskbarBottom = Math.round((bounds.y + bounds.height) - (workArea.y + workArea.height))
  const taskbarLeft = Math.round(workArea.x - bounds.x)
  const taskbarRight = Math.round((bounds.x + bounds.width) - (workArea.x + workArea.width))
  const horizontalX = taskbarWidgetSettings.position === 'center'
    ? Math.round(bounds.x + (bounds.width - width) / 2)
    : (() => {
        // 右侧：紧贴系统托盘左侧外部（间隙 8px），避免叠进托盘/时钟区域
        const trayLeft = getTaskbarTrayLeftDip()
        if (trayLeft !== null && trayLeft - width - 8 >= bounds.x) {
          return Math.round(trayLeft - width - 8)
        }
        // 托盘尚未测出：保守预留 30% 屏宽，绝不叠进托盘
        return Math.round(bounds.x + bounds.width - width - Math.round(bounds.width * TASKBAR_TRAY_FALLBACK_RATIO))
      })()

  if (taskbarBottom > 0) {
    // 底部任务栏（Windows 11 默认）
    return { x: horizontalX, y: Math.round(bounds.y + bounds.height - taskbarBottom), width, height: taskbarBottom }
  }
  if (taskbarTop > 0) {
    // 顶部任务栏
    return { x: horizontalX, y: Math.round(bounds.y), width, height: taskbarTop }
  }
  if (taskbarLeft > 0) {
    // 左侧任务栏：竖条贴左缘（内容仍按横向布局，长度取用户宽度）
    return { x: Math.round(bounds.x), y: Math.round(bounds.y + (bounds.height - width) / 2), width: taskbarLeft, height: width }
  }
  if (taskbarRight > 0) {
    // 右侧任务栏：竖条贴右缘
    return { x: Math.round(bounds.x + bounds.width - taskbarRight), y: Math.round(bounds.y + (bounds.height - width) / 2), width: taskbarRight, height: width }
  }
  // 无任务栏/自动隐藏：贴底部
  return { x: Math.round(bounds.x + (bounds.width - width) / 2), y: Math.round(bounds.y + bounds.height - 40), width, height: 40 }
}

function dockTaskbarWidgetWindow() {
  if (!taskbarWidgetWindow || taskbarWidgetWindow.isDestroyed()) return
  const pos = getTaskbarWidgetPosition()
  try {
    // 展开状态保留：重新贴边时按当前展开/收起状态应用对应高度
    if (taskbarWidgetExpanded) {
      taskbarWidgetWindow.setBounds({ x: pos.x, y: pos.y - TASKBAR_WIDGET_POPUP_HEIGHT, width: pos.width, height: pos.height + TASKBAR_WIDGET_POPUP_HEIGHT })
    } else {
      taskbarWidgetWindow.setBounds(pos)
    }
  } catch { /* 忽略 */ }
}

function createTaskbarWidgetWindow() {
  if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) return taskbarWidgetWindow
  loadTaskbarWidgetSettings()
  const pos = getTaskbarWidgetPosition()
  // 窗口参数与可正常点击的桌面播放器保持一致（不设 type:'toolbar'/focusable:false/movable:false）：
  // 这三个参数组合在 Win11 透明置顶窗口上会导致系统命中测试跳过该窗口，点击永远落不进来。
  taskbarWidgetWindow = new BrowserWindow({
    ...pos,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'taskbar-widget-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  })
  taskbarWidgetWindow.setAlwaysOnTop(true, 'screen-saver')
  taskbarWidgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 默认鼠标穿透。注意：不能靠 forward:true 转发 mouseenter 来切换交互态——
  // 在 Win11 + 透明置顶组合下，setIgnoreMouseEvents 每次切换都会让系统重新命中
  // 测试并触发 mouseenter/mouseleave 振荡，交互态永远不稳定，点击无法落窗。
  // 改为主进程光标轮询检测悬停；轮询由窗口 show/hide/closed 生命周期控制。
  try {
    taskbarWidgetWindow.setIgnoreMouseEvents(true, { forward: true })
  } catch { /* 忽略 */ }
  taskbarWidgetWindow.loadFile(path.join(__dirname, 'taskbar-widget.html'))
  taskbarWidgetPolling.bindWindow(taskbarWidgetWindow)
  taskbarWidgetWindow.on('closed', () => {
    taskbarWidgetWindow = null
    taskbarWidgetInteractive = false
    taskbarWidgetExpanded = false
  })
  // 托盘位置后台测量：首次显示用保守预留，测出真实托盘后立即贴齐
  refreshTaskbarTray()
  return taskbarWidgetWindow
}

// 显示器/任务栏尺寸变化时重新贴边（任务栏高/宽变化、换显示器等）
function bindTaskbarDisplayMetrics() {
  if (taskbarDisplayMetricsBound) return
  taskbarDisplayMetricsBound = true
  const { screen } = require('electron')
  screen.on('display-metrics-changed', () => {
    taskbarTrayCache = null // 显示器变化后托盘位置作废，后台重测
    dockTaskbarWidgetWindow()
    refreshTaskbarTray()
  })
}

// 系统深浅色切换时刷新 widget 主题（推状态带 theme 字段）
let taskbarThemeSyncBound = false
function bindTaskbarThemeSync() {
  if (taskbarThemeSyncBound) return
  taskbarThemeSyncBound = true
  const { nativeTheme } = require('electron')
  nativeTheme.on('updated', () => {
    updateTaskbarWidget()
  })
}

/** 把当前播放状态推送到 widget（并控制显隐） */
// 仅进度变化时 1s 节流：避免渲染端每秒多次 timeupdate（约 4 次/s）把整份状态
// （含逐词歌词 words）序列化推送，widget 内部按 lastCur + rAF 插值，1s 更新足够平滑。
let taskbarWidgetLastSendAt = 0
let taskbarWidgetLastSendKey = ''
const TASKBAR_WIDGET_SEND_THROTTLE_MS = 1000

function updateTaskbarWidget() {
  if (process.platform !== 'win32') return
  // 设置仅在开关/更新设置时写入，这里节流重载（避免播放进度每秒触发同步读盘）
  if (Date.now() - taskbarWidgetSettingsLastLoad > TASKBAR_WIDGET_SETTINGS_RELOAD_MS) {
    loadTaskbarWidgetSettings()
    taskbarWidgetSettingsLastLoad = Date.now()
  }
  bindTaskbarDisplayMetrics()
  bindTaskbarThemeSync()
  const hasSong = Boolean(desktopPlayerState.song?.name)
  // 开启时始终显示（冷启动无歌时显示品牌名），关闭/用户手动关闭才隐藏
  if (!taskbarWidgetSettings.enabled || taskbarWidgetClosedByUser) {
    if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed() && taskbarWidgetWindow.isVisible()) {
      taskbarWidgetWindow.hide()
    }
    return
  }
  const win = createTaskbarWidgetWindow()
  if (!win) return
  const song = desktopPlayerState.song || {}
  const lyric = desktopPlayerState.lyric || null
  const { nativeTheme } = require('electron')
  // 内容键：歌曲/播放态/歌词行/静音/主题变化必须立即推送，仅进度变化时允许节流
  const contentKey = `${song.name}|${desktopPlayerState.playing === true}|${desktopPlayerState.live === true}|${lyric?.line || ''}|${desktopPlayerState.muted === true}|${nativeTheme.shouldUseDarkColors}`
  const now = Date.now()
  if (contentKey === taskbarWidgetLastSendKey && now - taskbarWidgetLastSendAt < TASKBAR_WIDGET_SEND_THROTTLE_MS) {
    return
  }
  taskbarWidgetLastSendKey = contentKey
  taskbarWidgetLastSendAt = now
  const payload = {
    title: song.name || '',
    artist: Array.isArray(song.artists) ? song.artists.join(' / ') : (song.artists || ''),
    cover: song.coverUrl || '',
    playing: desktopPlayerState.playing === true,
    live: desktopPlayerState.live === true,
    cur: desktopPlayerState.live === true ? 0 : Number(desktopPlayerState.progress) || 0,
    dur: desktopPlayerState.live === true ? 0 : Number(desktopPlayerState.duration) || 0,
    muted: desktopPlayerState.muted === true,
    // 歌曲主题色：暂停按钮/进度条跟随（App 推送 dominantColor）
    accent: String(desktopPlayerState.accentColor || '') || '#FB7299',
    lyric: lyric ? {
      line: lyric.line || '',
      nextLine: lyric.nextLine || '',
      translation: lyric.translation || '',
      nextTranslation: lyric.nextTranslation || '',
      lineStart: Number(lyric.lineStart) || 0,
      lineDuration: Number(lyric.lineDuration) || 0,
      // 逐词时序（毫秒，相对行首）：任务栏按词做「柔和」式逐字填充，与播放页同一套归一化逻辑
      words: Array.isArray(lyric.words)
        ? lyric.words.map((w) => ({
            word: String(w?.word ?? ''),
            startTime: Number(w?.startTime) || 0,
            duration: Number(w?.duration) || 0,
          }))
        : [],
    } : null,
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return
      win.showInactive()
      win.webContents.send('taskbar-widget:state', payload)
    })
  } else {
    win.webContents.send('taskbar-widget:state', payload)
    if (!win.isVisible()) win.showInactive()
  }
}

/** 显示/隐藏任务栏 widget（兼容旧调用；新入口统一走 set-enabled 持久化设置） */
function setTaskbarWidgetVisible(visible) {
  if (process.platform !== 'win32') return { success: false, reason: '仅支持 Windows' }
  taskbarWidgetClosedByUser = !visible
  if (visible) {
    updateTaskbarWidget()
  } else {
    if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) taskbarWidgetWindow.hide()
  }
  return { success: true }
}

// 光标轮询：任务栏 widget 悬停检测。页面 mouseenter/mouseleave 转发在
// 透明置顶窗口上会因 setIgnoreMouseEvents 切换而振荡，改由主进程每 120ms
// 判断光标是否落在窗口内，据此稳定切换交互态（见 createTaskbarWidgetWindow 注释）。
const { createTaskbarWidgetPolling } = require('./taskbar-widget-polling.cjs')

function taskbarWidgetCursorInside() {
  if (!taskbarWidgetWindow || taskbarWidgetWindow.isDestroyed() || !taskbarWidgetWindow.isVisible()) return false
  const { screen } = require('electron')
  const pt = screen.getCursorScreenPoint()
  const b = taskbarWidgetWindow.getBounds()
  return pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height
}

function updateTaskbarWidgetInteractive() {
  if (!taskbarWidgetWindow || taskbarWidgetWindow.isDestroyed()) return
  // 窗口隐藏时无需轮询/发 hover IPC：直接停（创建窗口后、窗口销毁前由 show/hide 触发重测）
  if (!taskbarWidgetWindow.isVisible()) {
    if (taskbarWidgetInteractive) {
      taskbarWidgetInteractive = false
      try { taskbarWidgetWindow.setIgnoreMouseEvents(true, { forward: true }) } catch { /* 忽略 */ }
    }
    return
  }
  const inside = taskbarWidgetCursorInside()
  if (inside !== taskbarWidgetInteractive) {
    taskbarWidgetInteractive = inside
    if (inside) {
      try {
        taskbarWidgetWindow.moveTop() // 进入交互态时确保窗口在该位置最顶，点击不被其他窗口截走
      } catch { /* 忽略 */ }
    }
    try {
      taskbarWidgetWindow.setIgnoreMouseEvents(!inside, { forward: true })
    } catch { /* 忽略 */ }
  }
  if (taskbarWidgetWindow.isDestroyed()) return
  // 通知页面悬停状态：进入取消收拢定时器，离开触发收拢（原 mouseleave 行为）
  taskbarWidgetWindow.webContents.send('taskbar-widget:hover', inside === true)
  // 托盘缓存过期时后台重测并贴齐（托盘图标增减改变宽度也能跟上）
  if (inside && taskbarTrayCache && Date.now() - taskbarTrayCacheAt > TASKBAR_TRAY_CACHE_MS) {
    refreshTaskbarTray()
  }
}

const taskbarWidgetPolling = createTaskbarWidgetPolling({ poll: updateTaskbarWidgetInteractive })

ipcMain.on('taskbar-widget:action', (_event, action, payload) => {
  if (action === 'close') {
    taskbarWidgetClosedByUser = true
    if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) taskbarWidgetWindow.hide()
    return
  }
  if (action === 'seek' && typeof payload === 'number') {
    dispatchPlayerControl('seek', payload)
    return
  }
  if (action === 'toggleMute') {
    dispatchPlayerControl('mute')
    return
  }
  if (action === 'toggle' || action === 'prev' || action === 'next') {
    dispatchPlayerControl(action)
    return
  }
})

// 点击播控展开/收起：窗口高度在任务栏高度上额外加一段，供向上弹出的按钮面板显示
const TASKBAR_WIDGET_POPUP_HEIGHT = 218
ipcMain.on('taskbar-widget:set-expanded', (_event, expanded) => {
  if (!taskbarWidgetWindow || taskbarWidgetWindow.isDestroyed()) return
  taskbarWidgetExpanded = expanded === true
  try {
    const pos = getTaskbarWidgetPosition()
    if (taskbarWidgetExpanded) {
      taskbarWidgetWindow.setBounds({ x: pos.x, y: pos.y - TASKBAR_WIDGET_POPUP_HEIGHT, width: pos.width, height: pos.height + TASKBAR_WIDGET_POPUP_HEIGHT })
    } else {
      taskbarWidgetWindow.setBounds({ x: pos.x, y: pos.y, width: pos.width, height: pos.height })
    }
  } catch { /* 忽略 */ }
})

ipcMain.on('taskbar-widget:set-interactive', (_event, interactive) => {
  // 已废弃：交互态改由主进程光标轮询（updateTaskbarWidgetInteractive）维护，
  // 页面驱动的 setInteractive 在透明置顶窗口上会造成 mouseenter/mouseleave 振荡。
  // 保留空处理器仅为兼容旧 preload 调用，不再改变窗口鼠标穿透状态。
})

ipcMain.handle('taskbar-widget:set-visible', (_event, visible) => setTaskbarWidgetVisible(Boolean(visible)))
ipcMain.handle('taskbar-widget:get-state', () => ({
  visible: Boolean(taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed() && taskbarWidgetWindow.isVisible()),
  closedByUser: taskbarWidgetClosedByUser,
}))

// 设置-个性化 开关：启用/禁用任务栏迷你播控（持久化）
ipcMain.handle('taskbar-widget:set-enabled', (_event, enabled) => {
  if (process.platform !== 'win32') return { success: false, reason: '仅支持 Windows' }
  loadTaskbarWidgetSettings()
  taskbarWidgetSettings = { ...taskbarWidgetSettings, enabled: enabled === true }
  saveTaskbarWidgetSettings()
  taskbarWidgetClosedByUser = false
  if (taskbarWidgetSettings.enabled) {
    updateTaskbarWidget()
  } else {
    if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) taskbarWidgetWindow.hide()
  }
  broadcastTaskbarWidgetSettings()
  return { success: true, enabled: taskbarWidgetSettings.enabled }
})

ipcMain.handle('taskbar-widget:get-settings', () => {
  loadTaskbarWidgetSettings()
  return getTaskbarWidgetSettings()
})

ipcMain.handle('taskbar-widget:update-settings', (_event, partial) => {
  loadTaskbarWidgetSettings()
  taskbarWidgetSettings = sanitizeTaskbarWidgetSettings(partial || {}, taskbarWidgetSettings)
  saveTaskbarWidgetSettings()
  dockTaskbarWidgetWindow()
  broadcastTaskbarWidgetSettings()
  return getTaskbarWidgetSettings()
})

function getWindowsSystemLocation() {
  const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Devices.Geolocation.Geolocator, Windows, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1
$accessOperation = [Windows.Devices.Geolocation.Geolocator]::RequestAccessAsync()
$accessTask = $asTask.MakeGenericMethod([Windows.Devices.Geolocation.GeolocationAccessStatus]).Invoke($null, @($accessOperation))
$access = $accessTask.GetAwaiter().GetResult()
if ([string]$access -ne 'Allowed') {
  throw "Windows location permission is $access"
}
$geolocator = New-Object Windows.Devices.Geolocation.Geolocator
$positionOperation = $geolocator.GetGeopositionAsync()
$positionTask = $asTask.MakeGenericMethod([Windows.Devices.Geolocation.Geoposition]).Invoke($null, @($positionOperation))
$position = $positionTask.GetAwaiter().GetResult()
$point = $position.Coordinate.Point.Position
[pscustomobject]@{
  latitude = $point.Latitude
  longitude = $point.Longitude
  accuracy = $position.Coordinate.Accuracy
} | ConvertTo-Json -Compress
`

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message || '无法读取 Windows 系统定位'))
          return
        }
        try {
          const jsonLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
          const location = JSON.parse(jsonLine || '{}')
          const latitude = Number(location.latitude)
          const longitude = Number(location.longitude)
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            throw new Error('Windows 系统定位没有返回有效坐标')
          }
          resolve({
            latitude,
            longitude,
            accuracy: Number(location.accuracy) || null,
            source: 'windows',
          })
        } catch (parseError) {
          reject(parseError)
        }
      },
    )
  })
}


protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hyperplayer-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      // 关键：允许从 http://127.0.0.1:3000（渲染 origin）跨源 fetch 该协议。
      // 缺失时 AI 混音 wav（hyperplayer-media://）被 Chromium CORS 拦截 → 缓冲加载失败
      // → 回退普通交叉淡化 → 音量突变 + MV 预载链路断裂（用户实测的"介入即衰减/
      // MV 不叠加/封面回退"均由此引起）。registerSchemesAsPrivileged 仅在启动时生效，
      // 修改后必须完全重启应用。
      corsEnabled: true,
    },
  },
])

// ── 启动页动画的放行与完成回报 ──
// 启动页是预渲染视频（desktop/splash.html，由 scripts/build-splash.mjs 生成），分两段走：
//   阶段一「假 splash」：窗口一显示就摆着视频第 0 帧 —— 那正好是**纯背景**（无 logo/文字），
//     零解码开销、天然不卡，用来兜住程序加载这段时间；
//   阶段二「真 splash」：程序就绪后才发 splash:start 放行动画（见 tryStartSplashAnimation 门控），
//     入场动画于是不会和启动抢资源。
// 视频播完（ended）或播放失败时经 splash-preload.cjs 通过 splash:entrance-done 回报，
// 主进程据此才切主窗口（见 createWindow 内的 showMainWindowWhenReady）。
//
// 兜底上限：正常路径由页面「播完回报」驱动；若回报因故始终未到达
//（桥接异常 / 视频卡死 / 页面脚本出错），**动画起播后**超过此时长就强行切主窗口，
// 保证主窗口一定会出现。锚定「起播时刻」而非「窗口显示时刻」——
// 放行推迟后，锚在显示时刻会把还在正常播放的视频拦腰切断。
const SPLASH_ENTRANCE_FALLBACK_MS = 4500
// 门控等待上限：窗口显示后最多等这么久「程序就绪」，超时就强制放行动画。
// 防止后端异常/信号丢失导致启动页一直停在静帧背景上（那样比掉几帧严重得多）。
// 取值依据（2026-09-13 实测）：本地后端从进程启动到 /health 可用约 3.85～4.2s
//（sweepBackendOrphans 的 PowerShell 探测 + utilityProcess 载入 11k 行模块），
// 故上限放在其之上，让"后端真的就绪"成为常态路径，超时只作安全网。
const SPLASH_START_MAX_WAIT_MS = 4500
// 后端探测自身的放弃上限（纯安全网，远大于门控上限）：
// **不能**和门控上限同值——那样探测器会抢在门控计时器之前"强行放行"，
// 让本该由「后端就绪」驱动的放行退化成超时路径，行为不确定。
const BACKEND_PROBE_GIVE_UP_MS = 15000
let splashEntranceDone = false
let onSplashEntranceDone = null
ipcMain.on('splash:entrance-done', () => {
  splashEntranceDone = true
  if (typeof onSplashEntranceDone === 'function') onSplashEntranceDone()
})
// 启动页诊断打点（页面侧时间点与帧节拍统计）：写入启动日志。
// 帧节拍行形如 `视频 3433ms / 呈现 103 帧 / 最大帧间隔 34ms / 解码掉帧 0/103 (ended)`，
// 是判断"动画到底卡不卡"的客观依据。开销可忽略，排障后保留。
ipcMain.on('splash:mark', (_event, name, sincePageLoadMs) => {
  logStartupTiming(`[splash] ${name} @页面内+${sincePageLoadMs}ms`)
})

// ── 动画放行门控：主窗口首帧 + 主窗口加载完成 + 本地后端就绪，三者齐备才放行 ──
// 为什么不是"窗口一显示就播"：启动页要在最忙的时段（主窗口加载 React、后端起服务）
// 只摆一张静帧背景，等这些重活干完再播入场动画 —— 动画是整段里最需要观感的部分。
const splashGate = { mainFirstFrame: false, mainLoaded: false, backendReady: false }
let splashAnimationStartedAt = 0
let splashGateWaitTimer = null

/** 记录门控条件并尝试放行（幂等，多处调用安全） */
function noteSplashGate(key) {
  if (key && splashGate[key] !== undefined) splashGate[key] = true
  tryStartSplashAnimation()
}

function tryStartSplashAnimation() {
  if (splashAnimationStartedAt > 0) return
  if (!splashWindow || splashWindow.isDestroyed()) return
  if (splashShownAt <= 0) return // 窗口还没显示，等 showSplash 再触发
  if (!(splashGate.mainFirstFrame && splashGate.mainLoaded && splashGate.backendReady)) return
  splashAnimationStartedAt = Date.now()
  if (splashGateWaitTimer) { clearTimeout(splashGateWaitTimer); splashGateWaitTimer = null }
  try { splashWindow.webContents.send('splash:start') } catch { /* 页面未就绪时忽略 */ }
  logStartupTiming(`Splash animation started (gate: firstFrame=${splashGate.mainFirstFrame} loaded=${splashGate.mainLoaded} backend=${splashGate.backendReady})`)
}

// ── 启动页：优先创建并显示，不等任何其它初始化 ──
// 背景：原先启动页与主窗口在 createWindow() 里一起创建，而 createWindow() 之前还有
// 若干阻塞等待（如后端就绪探测）；主窗口一创建又要启动后端、建渲染进程，
// 与启动页抢资源 —— 结果是「决定创建」到「真的显示」要花 300ms+，用户感觉启动页出来得慢。
// 现在改为：app 就绪后**第一步**就创建并显示启动页，主窗口仍并行在后台加载，
// 因此总启动时间不变（取两者最大值），只是启动页出现得更早。
//
// 与主窗口的关系：启动页恒为 alwaysOnTop，会一直盖着主窗口，直到主窗口确实
// 画出一帧后才撤下（见 commitSwitchToMain），因此不会出现「黑屏一闪」。
let splashWindow = null
let splashShownAt = 0

/**
 * 解析主窗口的目标布局（尺寸/位置），供启动页与主窗口共用 —— 两者用同一份 bounds
 * 才能保证切换时窗口不跳动。启动页需要它在「很早」就被调用（主窗口还没创建），
 * 因此这里只依赖 userData 里的窗口状态记忆 + 屏幕信息，不依赖任何其它初始化。
 *   - 尺寸 / 所在显示器：沿用记忆（尺寸钳制进工作区；无记忆用默认 1400×900 + 主屏）
 *   - 位置：**恒为工作区几何中心**，不恢复记忆里的 x/y —— 记忆位置可能来自最大化 /
 *     全屏 / kiosk 等瞬态（实测存出过贴顶的 y=7），照搬会让启动窗口不在屏幕正中
 * 注意：只返回尺寸/位置；最大化 / kiosk 这类「显示后」的状态由 createWindow 另行处理。
 */
function resolveTargetBounds() {
  const DEFAULT_MAIN_WIDTH = 1400
  const DEFAULT_MAIN_HEIGHT = 900
  try {
    const { screen } = require('electron')
    const saved = loadWindowState(app)
    const displays = screen.getAllDisplays()
    const targetDisplay = saved
      ? displays.find((d) => d.id === saved.displayId) || screen.getPrimaryDisplay()
      : screen.getPrimaryDisplay()
    const size = saved
      ? { width: saved.bounds.width, height: saved.bounds.height }
      : { width: DEFAULT_MAIN_WIDTH, height: DEFAULT_MAIN_HEIGHT }
    return centerBoundsInWorkArea(size, targetDisplay.workArea)
  } catch (error) {
    // 屏幕/状态不可用：退回默认尺寸（不使用 x/y，交给系统居中）
    return { width: DEFAULT_MAIN_WIDTH, height: DEFAULT_MAIN_HEIGHT }
  }
}

/** 创建并显示启动页。窗口尺寸/位置对齐主窗口的目标布局，避免切换时窗口跳动。 */
function createSplashWindowEarly(targetBounds) {
  splashEntranceDone = false
  onSplashEntranceDone = null

  splashWindow = new BrowserWindow({
    width: targetBounds.width,
    height: targetBounds.height,
    ...(typeof targetBounds.x === 'number' && typeof targetBounds.y === 'number'
      ? { x: targetBounds.x, y: targetBounds.y }
      : {}),
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    icon: windowIcon.isEmpty() ? undefined : windowIcon,
    show: false,
    // 底色与 splash.html 的最底层渐变起点一致（浅色），避免首帧出现深色闪烁
    backgroundColor: '#EEF2FF',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 隐藏期间持续绘制：启动页要在 show 之前就把首帧（渐变底+光斑+logo+词标）画完整，
      // 否则 show 出来的瞬间可能只是 OS 默认底色。这是「启动页出现即完整」的前提。
      paintWhenInitiallyHidden: true,
      // 极小的时序桥：只暴露 entranceDone（进场动画播完回报），
      // 主进程据此才知道动画何时播完、可以切主窗口。
      preload: path.join(__dirname, 'splash-preload.cjs'),
    },
  })

  let splashShown = false
  const showSplash = () => {
    if (splashShown || !splashWindow || splashWindow.isDestroyed() || splashWindow.isVisible()) return
    splashShown = true
    splashShownAt = Date.now()
    splashWindow.show()
    splashWindow.focus()
    logStartupTiming('Splash animation shown')
    // 窗口显示后先摆着视频第 0 帧（纯背景）当"假 splash"，等程序就绪（门控三条件）
    // 再放行动画 —— 入场动画不跟启动抢资源。
    // 兜底：等待超过 SPLASH_START_MAX_WAIT_MS 就强制放行，避免一直停在静帧上。
    splashGateWaitTimer = setTimeout(() => {
      splashGateWaitTimer = null
      if (splashAnimationStartedAt > 0) return
      logStartupTiming(`Splash gate not satisfied within ${SPLASH_START_MAX_WAIT_MS}ms; starting animation anyway`)
      splashGate.mainFirstFrame = true
      splashGate.mainLoaded = true
      splashGate.backendReady = true
      tryStartSplashAnimation()
    }, SPLASH_START_MAX_WAIT_MS)
    // 若显示时就已就绪（罕见：主窗口与后端都早于启动页显示完成），立即放行
    tryStartSplashAnimation()
  }
  let splashLoadDone = false
  let splashFrameDone = false
  const tryShowSplash = () => {
    if (splashLoadDone && splashFrameDone) showSplash()
  }
  splashWindow.once('ready-to-show', () => {
    splashFrameDone = true
    tryShowSplash()
  })
  splashWindow.loadFile(path.join(__dirname, 'splash.html'))
    .then(() => {
      splashLoadDone = true
      tryShowSplash()
    })
    .catch(error => {
      console.warn('[Startup] Failed to load splash animation:', error.message)
      splashLoadDone = true
      tryShowSplash()
    })
  // 兜底：任一事件异常未触发时也把启动页显示出来（否则用户面对空屏）
  setTimeout(() => {
    splashLoadDone = true
    splashFrameDone = true
    tryShowSplash()
  }, 3000)
}

function createWindow() {
  // ── 启动页停留时长 ──
  // 启动页至少可见 SPLASH_MIN_VISIBLE_MS 才允许切主窗口，且必须等动画真的播完
  //（见下方 showMainWindowWhenReady 的三个条件）。
  //
  // 启动页已是预渲染视频（3.2s），解码走 GPU 不与主窗口抢 CPU；此值实际只在
  // 「视频短于该时长」时才生效（托底最短观感）。打包版取 3500ms（视频播完后
  // 在末帧停留约 300ms 再切，避免「刚播完就立刻切走」的急促感）；
  // 开发模式放宽到 2 秒即可（前端热更新后主窗口很快就绪，视频时长本身已超过它）。
  const SPLASH_MIN_VISIBLE_MS = isDev ? 2000 : 3500
  const splashMinVisibleMsFor = () => SPLASH_MIN_VISIBLE_MS

  // ── 主窗口的目标布局 ──
  // 与启动页共用同一份 bounds（启动页在 app 就绪第一步就已按它创建），
  // 保证启动画面 → 主界面切换时窗口不跳动。解析逻辑见 resolveTargetBounds()。
  // 最大化 / kiosk 无法在窗口创建时套用到启动页（那要 show 之后才生效），
  // 启动页用还原后的 bounds（getNormalBounds 语义），切到主窗口时自然放大，属预期行为。
  const targetBounds = resolveTargetBounds()
  const savedWindowState = loadWindowState(app)

  // 启动页已在 app 就绪后**第一步**创建并显示（见 createSplashWindowEarly）——
  // 这里不再重复创建，只保留兜底：若那一步因异常没建起来，现在补建，
  // 避免后续逻辑（等待进场回报、切换主窗口）面对一个不存在的启动页。
  if (!splashWindow || splashWindow.isDestroyed()) {
    console.warn('[Startup] 启动页未提前创建，在此补建')
    createSplashWindowEarly(targetBounds)
  }

  // 创建主窗口：默认原生不透明窗口（Windows 11 系统圆角/阴影/对齐吸附）。
  // 桌面融合穿透需要透明窗口，而 transparent 仅创建时生效——开启/关闭融合时
  // 由 recreateMainWindow 销毁重建切换透明属性，普通模式始终用原生窗口。
  // 尺寸/位置复用上面解析好的 targetBounds，保证启动画面与主窗口完全重合、无跳动。
  mainWindow = new BrowserWindow({
    width: targetBounds.width,
    height: targetBounds.height,
    ...(typeof targetBounds.x === 'number' && typeof targetBounds.y === 'number'
      ? { x: targetBounds.x, y: targetBounds.y }
      : {}),
    minWidth: 1200,
    minHeight: 800,
    frame: false,
    backgroundColor: '#000000',
    transparent: false,
    titleBarStyle: 'hidden',
    title: 'HyperPlayer',
    icon: windowIcon.isEmpty() ? undefined : windowIcon,
    roundedCorners: true,
    show: false, // 初始隐藏窗口
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      paintWhenInitiallyHidden: true,  // 软件合成下隐藏时也持续绘制，避免显示时首帧空白
      backgroundThrottling: false, // Chroma 后台联动；各可视化仍由订阅者/可见性自行门控
    },
  })

  // 阻止同窗口被导航到外部站点（特权 preload 桥只允许停留在应用自身地址）
  guardAgainstExternalNavigation(mainWindow.webContents)

  // ── 窗口状态记忆：恢复上次关闭时的窗口布局（大小/位置/显示器/全屏或最大化） ──
  // 仅当记录的版本与当前版本一致（未经过应用内更新）时恢复，否则保持默认（主屏 + 1400×900）。
  // 尺寸/位置已在创建窗口时按同一份记录（targetBounds）套用，此处只处理「状态」（最大化 / kiosk）。
  if (savedWindowState) {
    try {
      if (savedWindowState.state === 'maximized') {
        // 窗口尚未显示时 maximize 可能不生效，等 show 后再设置
        mainWindow.once('show', () => {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isKiosk()) {
            mainWindow.maximize()
            mainWindowExpanded = true
          }
        })
      } else if (savedWindowState.state === 'kiosk') {
        // 全屏覆盖任务栏（kiosk）：同样等窗口显示后再进入
        mainWindow.once('show', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setKiosk(true)
            mainWindowExpanded = true
          }
        })
      }
    } catch (error) {
      console.error('[WindowState] 恢复窗口状态失败:', error?.message || error)
    }
  }

  // 开发模式加载 Vite 服务器
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[ProcessHealth] Main renderer exited:', {
      reason: details?.reason,
      exitCode: details?.exitCode,
    })
  })

  mainWindow.webContents.once('dom-ready', () => {
    logStartupTiming('Main renderer DOM ready')
  })
  mainWindow.webContents.once('did-finish-load', async () => {
    logStartupTiming('Main renderer finished loading')
    // 资源加载完成（React 已挂载）——满足主窗显示条件之一
    mainLoaded = true
    showMainWindowWhenReady()
    noteSplashGate('mainLoaded') // 启动页门控：主窗口加载完成
    try {
      const rendererMetrics = await mainWindow.webContents.executeJavaScript(`(() => {
        const resources = performance.getEntriesByType('resource')
          .map(entry => ({
            name: entry.name.replace(location.origin, ''),
            duration: Math.round(entry.duration),
            startTime: Math.round(entry.startTime),
            transferSize: entry.transferSize || 0,
          }))
          .sort((left, right) => right.duration - left.duration)
        return {
          resourceCount: resources.length,
          slowestResources: resources.slice(0, 12),
        }
      })()`)
      logStartupTiming(`Renderer resources: ${rendererMetrics.resourceCount}; slowest: ${JSON.stringify(rendererMetrics.slowestResources)}`)
    } catch (error) {
      logStartupTiming(`Renderer performance metrics unavailable: ${error.message}`)
    }
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      logStartupTiming(`Main renderer failed to load (${errorCode}: ${errorDescription}) ${validatedURL}`)
    }
  })

  // ===== WF_SMOKE=1 冒烟自检：验证任务栏播控 / 音频设备主进程接线，随后自动退出 =====
  if (process.env.WF_SMOKE === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      const results = []
      const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })
      try {
        // 1) 任务栏迷你播控：位置计算 + 窗口创建（win32）
        const pos = typeof getTaskbarWidgetPosition === 'function' ? getTaskbarWidgetPosition() : null
        check('taskbar position sane', Boolean(pos && pos.width >= 260 && pos.width <= 420 && pos.height >= 1 && Number.isFinite(pos.x) && Number.isFinite(pos.y)), JSON.stringify(pos))
        const settings = loadTaskbarWidgetSettings()
        check('taskbar settings load', settings && ['right', 'center'].includes(settings.position) && settings.width >= 260 && settings.width <= 420, JSON.stringify(settings))
        if (process.platform === 'win32') {
          const widgetWin = createTaskbarWidgetWindow()
          const widgetBounds = widgetWin ? widgetWin.getBounds() : null
          check('taskbar widget window', Boolean(widgetWin && !widgetWin.isDestroyed()), JSON.stringify(widgetBounds))
          if (widgetBounds && pos) check('taskbar widget height == taskbar band', widgetBounds.height === pos.height, `${widgetBounds.height} vs ${pos.height}`)
          if (widgetWin && !widgetWin.isDestroyed()) widgetWin.close()
        }
        // 3) 音频输出设备：渲染进程 enumerateDevices 真实返回 audiooutput（权限 handler 生效）
        mainWindow.webContents.executeJavaScript(`(async () => {
          try {
            const devices = await navigator.mediaDevices.enumerateDevices()
            return {
              ok: true,
              outputs: devices.filter(d => d.kind === 'audiooutput').map(d => ({ label: d.label || '', id: d.deviceId.slice(0, 8) })),
              mediaSupported: typeof navigator.mediaDevices.enumerateDevices === 'function',
            }
          } catch (error) {
            return { ok: false, error: String(error && error.message || error) }
          }
        })()`).then((result) => {
          check('enumerateDevices available', Boolean(result && result.ok && result.mediaSupported), JSON.stringify(result && result.outputs))
          check('audiooutput devices listed', Boolean(result && result.ok && Array.isArray(result.outputs) && result.outputs.length >= 0), JSON.stringify(result && result.outputs))
          finishSmoke(results)
        }).catch((error) => {
          check('enumerateDevices js', false, String(error && error.message || error))
          finishSmoke(results)
        })
      } catch (error) {
        check('smoke crash', false, String(error && error.stack || error))
        finishSmoke(results)
      }
    })
    const finishSmoke = (results) => {
      const failed = results.filter(r => !r.ok)
      console.log('=== WF_SMOKE RESULTS ===')
      for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`)
      console.log(`=== WF_SMOKE SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
      try { if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) taskbarWidgetWindow.close() } catch {}
      setTimeout(() => app.exit(failed.length === 0 ? 0 : 1), 200)
    }
  }

  if (isDev) {
    mainWindow.loadURL(devServerUrl)
    if (process.env.HYPERPLAYER_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools()
    }
  } else {
    // 生产模式加载打包后的文件
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
  
  // 主窗口显示：等「首帧渲染完成」且「资源加载完成（React 已挂载）」都满足才显示。
  // 仅依赖 ready-to-show 会在首帧（可能只是纯背景色帧）时就显示，用户会先看到黑屏再闪出内容；
  // 双条件保证 show 时页面内容已就绪，配合 splash 最短可见时间，启动画面自然过渡到主界面。
  let mainFirstFrameReady = false
  let mainLoaded = false
  let mainShown = false

  // 真正执行切换：显示主窗口，但**先不关启动页** ——
  // 主窗口底色是纯黑（app 自身首屏是深色），而 show() 到首帧真正提交之间有约
  // 100~250ms 空档（实测），这段空档会露出纯黑底色 = 用户看到的「黑屏一闪」。
  // 启动页是 alwaysOnTop，让它继续盖着主窗口，等主窗口确实画出一帧后再关闭，
  // 就能彻底消除这个空档。若等待异常，有兜底计时器保证启动页一定会关掉。
  let mainSwitchCommitted = false
  const closeSplash = () => {
    if (!splashWindow.isDestroyed()) splashWindow.close()
  }
  /** 等主窗口渲染器真的提交过一帧（double rAF）；失败/超时则直接返回，不阻塞启动 */
  const waitMainWindowPainted = () => new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve()
    const fallback = setTimeout(resolve, 900)
    mainWindow.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))',
    ).then(() => { clearTimeout(fallback); resolve() })
      .catch(() => { clearTimeout(fallback); resolve() })
  })
  const commitSwitchToMain = () => {
    if (mainSwitchCommitted || !mainWindow || mainWindow.isDestroyed()) return
    mainSwitchCommitted = true
    onSplashEntranceDone = null
    mainWindow.show()
    mainWindow.focus()
    logStartupTiming('Main window shown')
    // 主窗口已画出一帧后才撤下启动页，避免中间露出主窗口的纯黑底色
    void waitMainWindowPainted().then(() => {
      closeSplash()
      logStartupTiming('Splash closed after main window painted')
    })
  }

  const showMainWindowWhenReady = () => {
    if (mainShown || !mainWindow || mainWindow.isDestroyed()) return
    if (!mainFirstFrameReady || !mainLoaded) return
    mainShown = true

    // 只有「启动页根本不存在/已销毁」才跳过等待（加载失败等异常）。
    // 注意不能再用 `splashShownAt <= 0` 判定「没显示过就跳过」——
    // 视频版启动页加载极快，主窗口可能**先于**启动页就绪，此时 splashShownAt 仍是 0，
    // 那样会把启动页直接跳掉（实测：启动页只显示 23ms 就被关闭，视频完全没播）。
    // 正确做法：只要启动页还活着，就等它显示出来、并把动画播完再切。
    if (!splashWindow || splashWindow.isDestroyed()) {
      commitSwitchToMain()
      return
    }

    // 切换需同时满足三个条件：
    //   ① 启动页已真正显示（splashShownAt 由 showSplash 写入）；
    //   ② 已达启动页最短可见时间；
    //   ③ 进场动画已播完（视频版由 splash.html 的 ended 事件经 splash:entrance-done 回报）。
    const checkAndSwitch = () => {
      if (mainSwitchCommitted || !mainWindow || mainWindow.isDestroyed()) return
      if (splashShownAt <= 0) return                    // 启动页尚未显示，等它
      const shownFor = Date.now() - splashShownAt
      // 兜底①：回报迟迟未到（视频卡死 / 桥接失效）——**起播后**超过上限就强行切。
      // 锚定「起播时刻」而非「显示时刻」：动画放行已推迟到程序就绪，锚在显示时刻
      // 会把还在正常播放的视频拦腰切断。未起播时不判（门控自带等待上限）。
      if (!splashEntranceDone && splashAnimationStartedAt > 0
        && Date.now() - splashAnimationStartedAt >= SPLASH_ENTRANCE_FALLBACK_MS) {
        logStartupTiming(`Splash entrance not reported within ${SPLASH_ENTRANCE_FALLBACK_MS}ms of animation start; switching anyway`)
        commitSwitchToMain()
        return
      }
      if (shownFor < splashMinVisibleMsFor()) return    // 未到最短可见时间
      if (!splashEntranceDone) return                   // 动画尚未播完
      commitSwitchToMain()
    }
    // 动画播完时立即复查（正常路径就是在这里切换）
    onSplashEntranceDone = checkAndSwitch

    // 轮询复查：覆盖「启动页显示晚于主窗口就绪」的情形 ——
    // 此时 splashShownAt 还没有基准（为 0），必须靠轮询等到它显示；也驱动上面的兜底①。
    const poll = setInterval(() => {
      if (mainSwitchCommitted) { clearInterval(poll); return }
      checkAndSwitch()
    }, 100)
    // 兜底②：启动页一直没显示出来（创建/加载彻底失败）就强行切，避免无限等；
    // 若已显示但动画未回报，交给轮询里的兜底①（按显示时刻计时，不会掐断正常播放）。
    setTimeout(() => {
      if (!mainSwitchCommitted && splashShownAt <= 0) {
        logStartupTiming(`Splash not shown within ${SPLASH_ENTRANCE_FALLBACK_MS}ms; switching anyway`)
        commitSwitchToMain()
      }
    }, SPLASH_ENTRANCE_FALLBACK_MS)

    // 立即复查一次：处理「回报早于主窗口就绪」的竞态
    //（否则那一刻 onSplashEntranceDone 还没挂上，回报会落空）。
    checkAndSwitch()
  }
  // 兜底：任一事件异常未触发（如 GPU 合成器问题），8s 后强制显示，避免永远黑屏卡住
  setTimeout(() => {
    mainFirstFrameReady = true
    mainLoaded = true
    noteSplashGate('mainFirstFrame')
    noteSplashGate('mainLoaded')
    showMainWindowWhenReady()
  }, 8000)
  mainWindow.once('ready-to-show', () => {
    mainFirstFrameReady = true
    showMainWindowWhenReady()
    noteSplashGate('mainFirstFrame') // 启动页门控：主窗口首帧就绪
  })
  // 事件接线（状态推送/窗口记忆/F12 等）——与融合穿透重建（recreateMainWindow）共用
  wireMainWindowEvents(mainWindow)
}

// ========== 壁纸功能 ==========

// 获取 Windows 当前桌面壁纸路径
function detectImageMime(buffer, filePath) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length >= 3 && buffer.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'

  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/jpeg'
}

let wallpaperPayloadCache = null

async function buildWallpaperPayload(wallpaperPath) {
  const stats = await fs.promises.stat(wallpaperPath)
  const cacheKey = `${path.resolve(wallpaperPath)}:${stats.size}:${stats.mtimeMs}`
  if (wallpaperPayloadCache?.key === cacheKey) {
    return { ...wallpaperPayloadCache.payload }
  }

  // 壁纸 2-10MB：异步整读 + base64，避免阻塞主线程（原同步读取会造成事件循环尖峰）
  const buffer = await fs.promises.readFile(wallpaperPath)
  const mimeType = detectImageMime(buffer, wallpaperPath)
  const payload = {
    path: wallpaperPath,
    fileUrl: pathToFileURL(wallpaperPath).href,
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  }
  wallpaperPayloadCache = { key: cacheKey, payload }
  return { ...payload }
}

function toMediaUrl(filePath) {
  const resolved = path.resolve(filePath)
  allowedMediaFiles.delete(resolved)
  allowedMediaFiles.add(resolved)
  while (allowedMediaFiles.size > MAX_ALLOWED_MEDIA_FILES) {
    const oldest = allowedMediaFiles.values().next().value
    if (!oldest) break
    allowedMediaFiles.delete(oldest)
  }
  return `hyperplayer-media://local/${encodeURIComponent(resolved)}`
}

function registerMediaProtocol() {
  protocol.registerFileProtocol('hyperplayer-media', (request, callback) => {
    try {
      const url = new URL(request.url)
      const encodedPath = url.pathname.replace(/^\/+/, '')
      const filePath = path.resolve(decodeURIComponent(encodedPath))

      if (!filePath || !allowedMediaFiles.has(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        callback({ error: -6 })
        return
      }

      callback({ path: filePath })
    } catch (error) {
      console.warn('[MediaProtocol] Failed to resolve media URL:', error.message)
      callback({ error: -2 })
    }
  })
}

const WALLPAPER_ENGINE_CONFIG_CACHE_MS = 60_000
let wallpaperEngineConfigPathCache = null
let wallpaperEngineConfigPathCacheExpiresAt = 0
let wallpaperEngineConfigRequest = null

// 异步解析 Wallpaper Engine config 路径。原实现用 execFileSync('powershell.exe', ..., timeout:5000)，
// 被壁纸 watcher（每 10s tick）与 get-current-wallpaper IPC 触发时最坏每 60s 缓存过期一次、
// 最长冻结主线程 5 秒。改为 execFile 异步 + 缓存 Promise（同 windowsWallpaperRequest / desktopWidgetDiskRequest 模式），
// 过期期间并发调用共享同一个在途请求。
function getWallpaperEngineConfigPath() {
  const now = Date.now()
  if (now < wallpaperEngineConfigPathCacheExpiresAt) {
    return Promise.resolve(wallpaperEngineConfigPathCache)
  }
  if (wallpaperEngineConfigRequest) return wallpaperEngineConfigRequest

  wallpaperEngineConfigRequest = new Promise((resolve) => {
    const candidates = []
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process wallpaper32,wallpaper64 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)',
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        if (error) {
          console.warn('[WallpaperEngine] Process lookup failed:', error.message)
        } else {
          const processPath = String(stdout || '').trim()
          if (processPath) candidates.push(path.join(path.dirname(processPath), 'config.json'))
        }

        candidates.push(
          path.join(process.env.ProgramFiles || '', 'Steam', 'steamapps', 'common', 'wallpaper_engine', 'config.json'),
          path.join(process.env['ProgramFiles(x86)'] || '', 'Steam', 'steamapps', 'common', 'wallpaper_engine', 'config.json'),
          'D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\config.json'
        )

        wallpaperEngineConfigPathCache = candidates.find(candidate => candidate && fs.existsSync(candidate)) || null
        wallpaperEngineConfigPathCacheExpiresAt = Date.now() + WALLPAPER_ENGINE_CONFIG_CACHE_MS
        resolve(wallpaperEngineConfigPathCache)
      }
    )
  }).finally(() => {
    wallpaperEngineConfigRequest = null
  })

  return wallpaperEngineConfigRequest
}

function getWallpaperEngineSourceType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv'].includes(ext)) return 'video'
  if (['.html', '.htm'].includes(ext)) return 'web'
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image'
  if (ext === '.json' || ext === '.pkg') return 'scene'
  if (ext === '.exe') return 'application'
  return 'unknown'
}

function findWallpaperEngineUserConfig(config) {
  return Object.values(config).find((value) => (
    value &&
    typeof value === 'object' &&
    value.general &&
    value.general.wallpaperconfig &&
    value.general.wallpaperconfig.selectedwallpapers
  ))
}

async function getWallpaperEngineSource() {
  try {
    const configPath = await getWallpaperEngineConfigPath()
    if (!configPath) return null

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const userConfig = findWallpaperEngineUserConfig(config)
    const selected = userConfig?.general?.wallpaperconfig?.selectedwallpapers
    if (!selected || typeof selected !== 'object') return null

    const monitor = selected.Monitor0 ? 'Monitor0' : Object.keys(selected)[0]
    const wallpaper = selected[monitor]
    const wallpaperPath = wallpaper?.file
    if (!wallpaperPath || !fs.existsSync(wallpaperPath)) return null

    const stats = fs.statSync(wallpaperPath)
    const sourceType = getWallpaperEngineSourceType(wallpaperPath)

    // 对于 Scene 类型壁纸，标记为不支持
    if (sourceType === 'scene') {
      logWallpaper('[WallpaperEngine] Scene wallpaper detected - unsupported, falling back to Windows wallpaper')
      return {
        unsupported: true,
        sourceType: 'scene',
        path: wallpaperPath
      }
    }
    
    // 对于 Web 类型壁纸，尝试提取视频文件
    if (sourceType === 'web') {
      const wallpaperDir = path.dirname(wallpaperPath)
      logWallpaper('[WallpaperEngine] Web wallpaper detected, searching for video files in:', wallpaperDir)
      
      // 搜索目录中的视频文件
      const videoExtensions = ['.mp4', '.webm', '.mov', '.m4v']
      let foundVideo = null
      
      try {
        const files = fs.readdirSync(wallpaperDir)
        for (const file of files) {
          const ext = path.extname(file).toLowerCase()
          if (videoExtensions.includes(ext)) {
            foundVideo = path.join(wallpaperDir, file)
            logWallpaper('[WallpaperEngine] Found video file:', foundVideo)
            break
          }
        }
        
        // 如果找到视频文件，返回视频源
        if (foundVideo && fs.existsSync(foundVideo)) {
          const videoStats = fs.statSync(foundVideo)
          logWallpaper('[WallpaperEngine] Using extracted video from web wallpaper:', foundVideo)
          
          return {
            path: foundVideo,
            fileUrl: pathToFileURL(foundVideo).href,
            mediaUrl: toMediaUrl(foundVideo),
            sourceType: 'video', // 改为 video 类型
            monitor,
            local: Boolean(wallpaper.local),
            title: path.basename(wallpaperDir), // 使用目录名作为标题
            size: videoStats.size,
            mtimeMs: videoStats.mtimeMs,
            configPath,
          }
        }
      } catch (err) {
        console.warn('[WallpaperEngine] Failed to search for video files:', err.message)
      }
      
      // 如果没有找到视频，标记为不支持
      logWallpaper('[WallpaperEngine] Web wallpaper has no extractable video, falling back to Windows wallpaper')
      return {
        unsupported: true,
        sourceType: 'web',
        path: wallpaperPath
      }
    }
    
    // 对于 unknown 类型壁纸，标记为不支持
    if (sourceType === 'unknown') {
      logWallpaper('[WallpaperEngine] Unknown wallpaper type detected - unsupported, falling back to Windows wallpaper')
      return {
        unsupported: true,
        sourceType: 'unknown',
        path: wallpaperPath
      }
    }

    return {
      path: wallpaperPath,
      fileUrl: pathToFileURL(wallpaperPath).href,
      mediaUrl: toMediaUrl(wallpaperPath),
      sourceType,
      monitor,
      local: Boolean(wallpaper.local),
      title: path.basename(wallpaperPath),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      configPath,
    }
  } catch (error) {
    console.warn('[WallpaperEngine] Source lookup failed:', error.message)
    return null
  }
}

let windowsWallpaperRequest = null

function getWindowsWallpaper() {
  if (windowsWallpaperRequest) return windowsWallpaperRequest

  logWallpaper('🔍 [Wallpaper] 开始获取壁纸路径..')
  windowsWallpaperRequest = new Promise((resolve, reject) => {
    if (os.platform() !== 'win32') {
      console.error('❌ [Wallpaper] 不支持的操作系统:', os.platform())
      reject(new Error('此功能仅支持 Windows 系统'))
      return
    }
    logWallpaper('✅ [Wallpaper] 系统检查通过: Windows')

    execFile(
      'reg.exe',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'Wallpaper'],
      { encoding: null, maxBuffer: 1024 * 1024, windowsHide: true, timeout: 5000 },
      async (error, stdout, stderr) => {
        try {
          if (error) {
            console.error('❌ [Wallpaper] 注册表查询失败:', error.message)
            if (stderr?.length) console.error('❌ [Wallpaper] 错误输出:', new TextDecoder('gbk').decode(stderr))
            reject(error)
            return
          }

          const output = stdout?.length ? new TextDecoder('gbk').decode(stdout) : ''
          const match = output.match(/^\s*Wallpaper\s+REG_\w+\s+(.+?)\s*$/mi)
          const wallpaperPath = match?.[1]?.trim() || ''
          logWallpaper('📁 [Wallpaper] 壁纸路径:', wallpaperPath)

          if (wallpaperPath && fs.existsSync(wallpaperPath)) {
            logWallpaper('✓ [Wallpaper] 文件存在验证通过')
            const wallpaper = await buildWallpaperPayload(wallpaperPath)
            const wallpaperEngine = await getWallpaperEngineSource()
            if (wallpaperEngine) wallpaper.wallpaperEngine = wallpaperEngine
            // 多屏壁纸：Windows 把每块屏的独立壁纸转码为 Themes 目录的 TranscodedWallpaper 系列文件，
            // 一并采集进 payload 供 watcher 判断「任一屏幕壁纸变化」。
            try {
              const themesDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Themes')
              if (fs.existsSync(themesDir)) {
                const transcoded = fs.readdirSync(themesDir)
                  .filter(file => /^TranscodedWallpaper(_\d+)?$/.test(file))
                  .map(file => {
                    const filePath = path.join(themesDir, file)
                    let stat = null
                    try { stat = fs.statSync(filePath) } catch { return null }
                    return stat ? { file, path: filePath, mtimeMs: stat.mtimeMs, size: stat.size } : null
                  })
                  .filter(Boolean)
                if (transcoded.length > 0) wallpaper.wallpapers = transcoded
              }
            } catch (scanError) {
              logWallpaper('⚠️ [Wallpaper] 扫描多屏壁纸失败:', scanError?.message || scanError)
            }
            logWallpaper('🔗 [Wallpaper] 转换后的URL:', wallpaper.fileUrl)
            logWallpaper('📊 [Wallpaper] 壁纸数据:', {
              mimeType: wallpaper.mimeType,
              size: wallpaper.size,
              mtimeMs: wallpaper.mtimeMs,
              wallpapers: wallpaper.wallpapers?.length,
            })
            logWallpaper('✓ [Wallpaper] 壁纸获取成功')
            resolve(wallpaper)
          } else {
            console.error('❌ [Wallpaper] 文件不存在:', wallpaperPath)
            reject(new Error('壁纸文件不存在: ' + wallpaperPath))
          }
        } catch (err) {
          reject(err)
        }
      }
    )
  }).finally(() => {
    windowsWallpaperRequest = null
  })

  return windowsWallpaperRequest
}

// IPC 处理：获取当前壁纸
ipcMain.handle('get-current-wallpaper', async () => {
  logWallpaper('📞 [IPC] 收到获取壁纸请求')
  try {
    const wallpaper = await getWindowsWallpaper()
    logWallpaper('✓ [IPC] 返回壁纸:', wallpaper.fileUrl)
    return { success: true, ...wallpaper }
  } catch (error) {
    console.error('❌ [IPC] 获取壁纸失败:', error.message)
    return { success: false, error: error.message }
  }
})

// IPC 处理：打开外部链接
ipcMain.handle('open-external', guardTrustedIpc('privileged', async (event, url) => {
  logWallpaper('📞 [IPC] 收到打开外部链接请求:', url)
  try {
    const parsed = new URL(String(url || ''))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: '只允许打开 HTTP 或 HTTPS 链接' }
    }
    await shell.openExternal(parsed.href)
    logWallpaper('✓ [IPC] 成功在默认浏览器中打开链接')
    return { success: true }
  } catch (error) {
    console.error('❌ [IPC] 打开外部链接失败:', error.message)
    return { success: false, error: error.message }
  }
}))

ipcMain.handle('desktop-widgets:get-system-status', async () => {
  const current = readCpuTimes()
  const previous = desktopWidgetCpuSample
  desktopWidgetCpuSample = current
  const totalDelta = previous ? current.all - previous.all : 0
  const idleDelta = previous ? current.idle - previous.idle : 0
  const cpuUsage = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0
  const memoryTotal = os.totalmem()
  const memoryUsed = Math.max(0, memoryTotal - os.freemem())
  return {
    cpuUsage,
    memoryUsed,
    memoryTotal,
    memoryPercent: memoryTotal ? memoryUsed / memoryTotal * 100 : 0,
    disks: await readDesktopWidgetDisks(),
    uptime: os.uptime(),
    platform: `${os.type()} ${os.release()}`,
  }
})

ipcMain.handle('desktop-widgets:pick-launcher-target', guardTrustedIpc('privileged', async (_event, kind) => {
  const result = await dialog.showOpenDialog({
    title: kind === 'folder' ? '选择文件夹' : '选择应用或文件',
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
  })
  return result.canceled ? null : result.filePaths[0] || null
}))

// 启动器组件合法的可执行/快捷方式类型；扩展名不在白名单内的一律拒绝打开。
const ALLOWED_LAUNCHER_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.lnk', '.url', '.msi', '.appref-ms',
])

ipcMain.handle('desktop-widgets:open-launcher-target', guardTrustedIpc('privileged', async (_event, target, kind) => {
  const value = String(target || '').trim()
  if (!value) return { success: false, error: '目标为空' }
  if (kind === 'url') {
    let parsed
    try { parsed = new URL(value) } catch { return { success: false, error: '网址无效' } }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { success: false, error: '仅支持 HTTP/HTTPS 地址' }
    await shell.openExternal(parsed.href)
    return { success: true }
  }
  const resolved = path.resolve(value)
  if (!fs.existsSync(resolved)) return { success: false, error: '文件或目录不存在' }
  // 仅允许启动器组件合法的可执行/快捷方式类型，阻止任意文件被当作程序启动。
  const extension = path.extname(resolved).toLowerCase()
  if (!ALLOWED_LAUNCHER_EXTENSIONS.has(extension)) {
    return { success: false, error: '不支持的文件类型' }
  }
  const error = await shell.openPath(resolved)
  return error ? { success: false, error } : { success: true }
}))

// 启动壁纸监听（每10秒检查一次）
let lastWallpaperSignature = null
let wallpaperWatcherBusy = false

function stopWallpaperWatcher() {
  if (wallpaperWatcher) {
    clearInterval(wallpaperWatcher)
    wallpaperWatcher = null
  }
  wallpaperWatcherBusy = false
  lastWallpaperSignature = null
}

function startWallpaperWatcher() {
  logWallpaper('[Watcher] Starting wallpaper watcher')
  if (wallpaperWatcher) {
    clearInterval(wallpaperWatcher)
  }

  wallpaperWatcher = setInterval(async () => {
    logWallpaper('🔧 [Watcher] 检查壁纸变化..')
    // 重入保护：上一次 tick 尚未结束（如 powershell 查询最坏 5s 超时）则跳过本次，
    // 避免 10s interval 与仍在执行的检查重叠。
    if (wallpaperWatcherBusy) {
      logWallpaper('⏭️ [Watcher] 上次检查未完成，跳过本次')
      return
    }
    wallpaperWatcherBusy = true
    try {
      const wallpaper = await getWindowsWallpaper()
      const engineSignature = wallpaper.wallpaperEngine
        ? `${wallpaper.wallpaperEngine.path}:${wallpaper.wallpaperEngine.mtimeMs}:${wallpaper.wallpaperEngine.size}:${wallpaper.wallpaperEngine.sourceType}`
        : 'no-engine'
      const isLiveEngineWallpaper = wallpaper.wallpaperEngine &&
        (wallpaper.wallpaperEngine.sourceType === 'video' || wallpaper.wallpaperEngine.sourceType === 'web')
      const currentSignature = isLiveEngineWallpaper
        ? engineSignature
        : `${wallpaper.path}:${wallpaper.mtimeMs}:${wallpaper.size}:${engineSignature}`
      // 多屏：任一屏幕的独立壁纸（TranscodedWallpaper 系列）变化也视为壁纸变化
      const multiScreenSignature = Array.isArray(wallpaper.wallpapers)
        ? wallpaper.wallpapers.map(w => `${w.file}:${w.mtimeMs}:${w.size}`).join('|')
        : ''
      
      // 如果壁纸路径/任一屏幕壁纸发生变化，通知渲染进程
      if (`${currentSignature}|${multiScreenSignature}` !== lastWallpaperSignature) {
        logWallpaper('🎨 [Watcher] 检测到壁纸变化！')
        logWallpaper('   旧壁纸:', lastWallpaperSignature)
        logWallpaper('   新壁纸:', `${currentSignature}|${multiScreenSignature}`)
        lastWallpaperSignature = `${currentSignature}|${multiScreenSignature}`
        if (mainWindow && !mainWindow.isDestroyed()) {
          logWallpaper('📡 [Watcher] 发送壁纸变化事件到渲染进程')
          safeSendToWindow(mainWindow, 'wallpaper-changed', wallpaper)
        } else {
          console.warn('⚠️ [Watcher] 主窗口不存在或已销毁')
        }
      } else {
        logWallpaper('✅ [Watcher] 壁纸未变化')
      }
    } catch (error) {
      console.error('❌ [Watcher] 壁纸监听出错:', error.message)
    } finally {
      wallpaperWatcherBusy = false
    }
  }, 10000) // 每10秒检查一次
  
  logWallpaper('✓ [Watcher] 壁纸监听器已启动（10秒间隔）')
}

// 渲染端按需启停壁纸监控：仅在桌面模式 + 壁纸联动开启时启用（避免非桌面模式持续 powershell 查询拖慢性能）
ipcMain.handle('set-wallpaper-watcher', (_event, enabled) => {
  logWallpaper(`[Watcher] 收到启停请求: ${enabled ? '启动' : '停止'}`)
  if (enabled) {
    startWallpaperWatcher()
  } else {
    stopWallpaperWatcher()
  }
  return { success: true }
})

// ========== QQ音乐登录窗口 ==========

async function createQQLoginWindow() {
  return new Promise((resolve) => {
    if (qqLoginWindow || qqLoginWindowOpening) {
      if (qqLoginWindow && !qqLoginWindow.isDestroyed()) qqLoginWindow.focus()
      resolve({ success: false, error: 'QQ 音乐登录窗口已打开' })
      return
    }
    // 先同步占坑再清 Cookie：清理链路有 await，两次快速点击会在 await 间隙双双通过
    // 上面的检查并各开一个窗口，共享变量被后者覆盖（关闭时置 null 与实际窗口错位）
    qqLoginWindowOpening = true

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    // 清理 QQ 音乐相关的缓存和 Cookie
    void (async () => {
    try {
      const session = mainWindow.webContents.session
      
      console.log('🔧 [QQ登录] 清理 QQ 音乐缓存和 Cookie...')
      
      // 清理 Cookie
      const cookies = await session.cookies.get({ domain: '.qq.com' })
      for (const cookie of cookies) {
        await session.cookies.remove(`https://${cookie.domain}`, cookie.name)
      }
      
      // 登录窗口与主应用共用 session，不能清空全部 localStorage/indexDB，
      // 否则会连带删除 HyperPlayer 自身设置。QQ 域 Cookie 已在上面精准清理。
      console.log('✓ [QQ登录] QQ 域 Cookie 清理完成')
    } catch (err) {
      console.error('❌ [QQ登录] 清理缓存失败:', err)
    }

    const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
    
    qqLoginWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      parent: mainWindow,
      modal: true,
      frame: false, // 无边框
      backgroundColor: '#000000',
      titleBarStyle: 'hidden',
      title: 'HyperPlayer - QQ音乐登录',
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: mainWindow.webContents.session, // 共享 session 以保留 Cookie
      },
    })
    // 窗口已创建，解除同步占坑（此后由 qqLoginWindow 本身承担防重入）
    qqLoginWindowOpening = false

    // 导航守卫：登录页本身就是 y.qq.com（QQ 音乐官方域），登录流程还可能跳到
    // ptlogin2/graph 等 QQ 域做认证。只放行 qq.com 域（含子域），其余一律拦截并
    // 交给系统默认浏览器，避免共享 session 的 Cookie 被引导到外部站点。
    const isQQDomain = (url) => {
      try {
        const hostname = new URL(String(url || '')).hostname.toLowerCase()
        return hostname === 'qq.com' || hostname.endsWith('.qq.com')
      } catch {
        return false
      }
    }
    qqLoginWindow.webContents.on('will-navigate', (event, url) => {
      if (!isQQDomain(url)) {
        event.preventDefault()
        if (/^https?:\/\//i.test(String(url || ''))) {
          shell.openExternal(String(url)).catch(() => {})
        }
      }
    })
    // 阻止 window.open 创建新的 Electron 窗口；外链一律交给系统默认浏览器。
    qqLoginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(String(url || ''))) {
        shell.openExternal(String(url)).catch(() => {})
      }
      return { action: 'deny' }
    })

    // 加载 QQ 音乐喜欢的歌曲页面（需要登录）
    qqLoginWindow.loadURL('https://y.qq.com/n/ryqq_v2/profile/like/song')

    // 页面加载完成后注入关闭按钮
    qqLoginWindow.webContents.on('did-finish-load', () => {
      qqLoginWindow.webContents.executeJavaScript(`
        (function() {
          // 创建关闭按钮容器
          const closeBtn = document.createElement('div');
          closeBtn.id = 'hyperplayer-close-btn';
          closeBtn.innerHTML = \`
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          \`;
          
          // 样式
          closeBtn.style.cssText = \`
            position: fixed;
            top: 20px;
            right: 20px;
            width: 40px;
            height: 40px;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(10px);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 999999;
            color: white;
            opacity: 0;
            transition: all 0.3s ease;
            pointer-events: auto;
          \`;
          
          // 鼠标悬停显示
          let hideTimer = null;
          
          function showButton() {
            clearTimeout(hideTimer);
            closeBtn.style.opacity = '1';
          }
          
          function scheduleHide() {
            hideTimer = setTimeout(() => {
              closeBtn.style.opacity = '0';
            }, 3000);
          }
          
          closeBtn.addEventListener('mouseenter', () => {
            clearTimeout(hideTimer);
            closeBtn.style.opacity = '1';
            closeBtn.style.background = 'rgba(255, 0, 0, 0.7)';
          });
          
          closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'rgba(0, 0, 0, 0.5)';
            scheduleHide();
          });
          
          closeBtn.addEventListener('click', () => {
            window.close();
          });
          
          // 监听鼠标移动，靠近右上角时显示
          document.addEventListener('mousemove', (e) => {
            const distanceFromTopRight = Math.sqrt(
              Math.pow(window.innerWidth - e.clientX, 2) + 
              Math.pow(e.clientY, 2)
            );
            
            if (distanceFromTopRight < 150) {
              showButton();
              scheduleHide();
            }
          });
          
          // 添加到页面
          document.body.appendChild(closeBtn);
          
          // 初始显示3秒
          showButton();
          scheduleHide();
        })();
      `).catch(err => {
        console.error('❌ [QQ登录] 注入关闭按钮失败:', err)
      })
    })

    // 定期检查是否登录成功
    const checkLoginInterval = setInterval(async () => {
      if (!qqLoginWindow || qqLoginWindow.isDestroyed()) {
        clearInterval(checkLoginInterval)
        return
      }

      try {
        const cookies = await qqLoginWindow.webContents.session.cookies.get({ 
          domain: '.qq.com' 
        })

        // 检查关键 Cookie 是否存在
        const hasUserId = cookies.some(cookie =>
          cookie.name === 'uin' || cookie.name === 'wxuin'
        )
        const hasMusicKey = cookies.some(cookie =>
          cookie.name === 'qm_keyst' ||
          cookie.name === 'qqmusic_key'
        )
        const hasLogin = hasUserId && hasMusicKey

        if (hasLogin) {
        // 构建 Cookie 字符串
          const cookieString = cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ')

        console.log('✓ [QQ登录] 登录成功，获取到 Cookie')

          // 先完成 Promise，再关闭窗口，避免 closed 事件误报为取消。
          clearInterval(checkLoginInterval)
          finish({ success: true, cookie: cookieString })
          qqLoginWindow.close()
        }
      } catch (err) {
        console.error('❌ [QQ登录] 检查登录状态失败:', err)
      }
    }, 2000) // 每2秒检查一次

    qqLoginWindow.on('closed', () => {
      clearInterval(checkLoginInterval)
      qqLoginWindow = null
      finish({ success: false, error: '用户取消登录' })
    })
    })().catch(error => {
      console.error('[QQ Login] failed to initialize login window:', error)
      if (qqLoginWindow && !qqLoginWindow.isDestroyed()) qqLoginWindow.destroy()
      qqLoginWindow = null
      qqLoginWindowOpening = false
      finish({ success: false, error: error?.message || 'QQ login window initialization failed' })
    })
  })
}


// HSE 开发者模式：把调音室导出的「发布种子」写回仓库源文件 builtinSceneSeed.ts。
// 仅开发模式可用（打包版没有 src 源码树，app.isPackaged 直接拒绝），
// 内容必须带种子赋值语句标记且限长，防止变成任意文件写入通道。
ipcMain.handle('hse-write-scene-seed', async (_e, content) => {
  try {
    if (app.isPackaged) return { ok: false, error: '仅开发模式可写回仓库' }
    if (typeof content !== 'string' || !content.includes('export const BUILTIN_SCENE_SEED') || content.length > 2 * 1024 * 1024) {
      return { ok: false, error: '内容不符合种子文件格式' }
    }
    const target = path.join(app.getAppPath(), 'src', 'services', 'HyperSoundEngine-v1', 'src', 'engine', 'builtinSceneSeed.ts')
    if (!fs.existsSync(target)) return { ok: false, error: '仓库中不存在 builtinSceneSeed.ts（仅开发环境可用）' }
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, target)
    console.log('✍️ [HSE] 发布种子已写回:', target)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
})

// HSE 离线导出落盘：把调音室渲染好的 MP3 直写到用户桌面。
// 文件名由渲染层给（<歌曲名>-Modified.mp3），这里再做一次非法字符兜底清洗与
// 重名自动 (2) 序号，绝不覆盖用户已存在的文件。300MB 上限防误传巨型数据。
ipcMain.handle('hse-save-rendered-audio', (_e, data, fileName) => {
  try {
    const buf = Buffer.from(data)
    if (!buf.length) return { ok: false, error: '导出内容为空' }
    if (buf.length > 300 * 1024 * 1024) return { ok: false, error: '导出内容超过 300MB，疑似异常' }
    const safeName = String(fileName || '').replace(/[\\/:*?"<>|]/g, '_').trim()
      .replace(/^\.{1,2}$/, '_') || 'HyperPlayer-HSE-Modified.mp3'
    const dir = app.getPath('desktop')
    const ext = path.extname(safeName) || '.mp3'
    const stem = safeName.slice(0, safeName.length - ext.length)
    let target = path.join(dir, safeName)
    let n = 2
    while (fs.existsSync(target)) {
      target = path.join(dir, `${stem} (${n})${ext}`)
      n += 1
    }
    fs.writeFileSync(target, buf)
    console.log('🎵 [HSE] 渲染音频已保存:', target, `(${(buf.length / 1024 / 1024).toFixed(1)}MB)`)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
})


// 监听打开 QQ 登录窗口的请求
ipcMain.handle('open-qq-login-window', async () => {
  try {
    const result = await createQQLoginWindow()
    return result
  } catch (err) {
    console.error('❌[QQ登录] 打开登录窗口失败:', err)
    return { success: false, error: err.message }
  }
})

// 渲染进程日志桥：把前端（校验/登录流程）的诊断输出到主进程控制台（后台窗口可见）
ipcMain.on('app-log', (event, message) => {
  console.log('[渲染进程]', message)
})

// ── QQ 音乐官方增强：内置窗口领取 qmk API Key ──────────────────────────────
const QMK_OFFICIAL_KEY_URL = 'https://y.qq.com/n/ryqq_v2/qqmusic_skills'
// Dedicated isolated session for the claim window, wiped on every open so
// cached QQ login state from the app/browser is never reused.
const QMK_SESSION_PARTITION = 'hyperplayer-qq-skill-key'

// 注入：自动滚动到「获取 API Key」区块，并用动画引导点击「登录QQ音乐」按钮
const QMK_GUIDE_JS = `
(function () {
  if (window.__hyperplayerQmkGuideDismissed) return;
  var old = document.getElementById('hyperplayer-skill-guide');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  function findElByText(text) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (node.nodeValue && node.nodeValue.indexOf(text) !== -1) {
        var el = node.parentElement;
        var guard = 0;
        while (el && el.innerText && el.innerText.length > 60 && guard < 8) {
          el = el.parentElement;
          guard++;
        }
        return el;
      }
    }
    return null;
  }

  var heading = findElByText('获取 API Key');
  if (heading) {
    setTimeout(function () {
      try { heading.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    }, 350);
  }

  var loginBtn = findElByText('登录QQ音乐');
  if (!loginBtn) return;

  var overlay = document.createElement('div');
  overlay.id = 'hyperplayer-skill-guide';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;';

  var style = document.createElement('style');
  style.textContent = '@keyframes wf-guide-pulse{0%{box-shadow:0 0 0 0 rgba(49,230,139,.75)}70%{box-shadow:0 0 0 26px rgba(49,230,139,0)}100%{box-shadow:0 0 0 0 rgba(49,230,139,0)}}@keyframes wf-guide-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(10px)}}';
  (document.head || document.documentElement).appendChild(style);

  var ring = document.createElement('div');
  ring.style.cssText = 'position:fixed;border-radius:14px;border:3px solid #31e68b;background:rgba(49,230,139,.16);animation:wf-guide-pulse 1.6s infinite;pointer-events:none;';

  var arrow = document.createElement('div');
  arrow.style.cssText = 'position:fixed;width:44px;height:44px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.55));animation:wf-guide-bounce 1s infinite;pointer-events:none;';
  arrow.innerHTML = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14m0 0l-6-6m6 6l6-6" stroke="#31e68b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;padding:8px 14px;border-radius:10px;background:rgba(7,16,24,.92);color:#31e68b;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid rgba(49,230,139,.4);pointer-events:none;white-space:nowrap;';
  tip.textContent = '请点击「登录QQ音乐」领取 API Key';

  function reposition() {
    var rect = loginBtn.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    ring.style.left = (rect.left - 8) + 'px';
    ring.style.top = (rect.top - 8) + 'px';
    ring.style.width = (rect.width + 16) + 'px';
    ring.style.height = (rect.height + 16) + 'px';
    arrow.style.left = (rect.left + rect.width / 2 - 22) + 'px';
    arrow.style.top = (rect.top - 60) + 'px';
    tip.style.left = (rect.left + rect.width / 2 - 125) + 'px';
    tip.style.top = (rect.top - 106) + 'px';
  }

  overlay.appendChild(ring);
  overlay.appendChild(arrow);
  overlay.appendChild(tip);
  document.body.appendChild(overlay);
  reposition();
  var moveTimer = setInterval(reposition, 600);

  var dismissed = false;
  function dismissGuide() {
    if (dismissed) return;
    dismissed = true;
    window.__hyperplayerQmkGuideDismissed = true;
    clearInterval(moveTimer);
    clearInterval(goneTimer);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  loginBtn.addEventListener('click', dismissGuide);

  var goneTimer = setInterval(function () {
    if (!loginBtn.isConnected || !loginBtn.getBoundingClientRect().width) {
      clearInterval(moveTimer);
      clearInterval(goneTimer);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
  }, 1000);
})();
`

// 注入：右上角悬浮关闭按钮（鼠标靠近右上角出现）
const QMK_CLOSE_BTN_JS = `
(function () {
  if (document.getElementById('hyperplayer-close-btn')) return;
  var closeBtn = document.createElement('div');
  closeBtn.id = 'hyperplayer-close-btn';
  closeBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  closeBtn.style.cssText = 'position:fixed;top:20px;right:20px;width:40px;height:40px;background:rgba(0,0,0,.5);backdrop-filter:blur(10px);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:999999;color:white;opacity:0;transition:all .3s ease;pointer-events:auto;';
  var hideTimer = null;
  function showButton() { clearTimeout(hideTimer); closeBtn.style.opacity = '1'; }
  function scheduleHide() { hideTimer = setTimeout(function () { closeBtn.style.opacity = '0'; }, 3000); }
  closeBtn.addEventListener('mouseenter', function () { clearTimeout(hideTimer); closeBtn.style.opacity = '1'; closeBtn.style.background = 'rgba(255,0,0,.7)'; });
  closeBtn.addEventListener('mouseleave', function () { closeBtn.style.background = 'rgba(0,0,0,.5)'; scheduleHide(); });
  closeBtn.addEventListener('click', function () { window.close(); });
  document.addEventListener('mousemove', function (e) {
    var d = Math.sqrt(Math.pow(window.innerWidth - e.clientX, 2) + Math.pow(e.clientY, 2));
    if (d < 150) { showButton(); scheduleHide(); }
  });
  document.body.appendChild(closeBtn);
  showButton();
  scheduleHide();
})();
`

// 从官方页抓取 qmk- 开头的 API Key（输入框值 / 元素属性 / 文本节点）
const QMK_DETECT_KEY_JS = `
(function () {
  var fullRe = /qmk-[A-Za-z0-9._-]{8,}/;
  var maskedRe = /qmk-[A-Za-z0-9.*_-]{8,}/;
  var full = '';
  var masked = '';
  function hit(value, re) {
    if (!value) return '';
    var m = re.exec(String(value));
    return m ? m[0] : '';
  }
  function consider(value) {
    if (!full) full = hit(value, fullRe);
    if (!masked && value) {
      var mm = hit(value, maskedRe);
      if (mm) masked = mm;
    }
  }
  var inputs = document.querySelectorAll('input, textarea');
  for (var i = 0; i < inputs.length; i++) {
    consider(inputs[i].value);
  }
  var attrs = ['data-key', 'data-apikey', 'data-clipboard', 'title', 'placeholder', 'aria-label', 'value'];
  var els = document.querySelectorAll('[data-key],[data-apikey],[data-clipboard],[title],[placeholder],[aria-label],[value]');
  for (var j = 0; j < els.length && !full; j++) {
    for (var a = 0; a < attrs.length; a++) {
      consider(els[j].getAttribute(attrs[a]));
    }
  }
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var count = 0;
  while (walker.nextNode() && count < 30000 && !full) {
    count++;
    consider(walker.currentNode.nodeValue);
  }
  return JSON.stringify({ full: full, masked: masked });
})()
`
// 在官方页里定位「复制Key」按钮：按多组文案匹配 + 回退到 clipboard/copy 数据属性。
// 返回真实可点击的元素（button / a / [role=button] / 带 data-clipboard 的元素）。
function qmkFindCopyBtnSource() {
  return `(function () {
    var texts = ['复制Key', '复制 Key', '复制key', '复制', 'Copy Key', 'Copy', 'copy'];
    function findCopyBtn() {
      for (var t = 0; t < texts.length; t++) {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          var node = walker.currentNode;
          var v = node.nodeValue || '';
          if (v.indexOf(texts[t]) === -1) continue;
          var el = node.parentElement;
          var guard = 0;
          while (el && el.innerText && el.innerText.length > 30 && guard < 8) { el = el.parentElement; guard++; }
          var clickable = (el && el.closest && el.closest('button, a, [role=button], [data-clipboard], [data-copy], [data-clipboard-text], [data-clipboard-action]')) || el;
          if (clickable) return clickable;
        }
      }
      var attrEls = document.querySelectorAll('[data-clipboard], [data-copy], [data-clipboard-text], [data-clipboard-action]');
      if (attrEls.length) return attrEls[0];
      return null;
    }
    var btn = findCopyBtn();
    if (!btn) return false;
    try { btn.click(); return true; } catch (e) { return false; }
  })()`
}
const QMK_CLICK_COPY_JS = `
${qmkFindCopyBtnSource()}
`

// 注入：登录后页面只显示打码 key（qmk-12cc****…7916）时，用动画引导用户点击「复制Key」按钮。
// 复制按钮点击后完整 key 会进剪贴板，主进程轮询读到后自动完成登录并关闭窗口。
const QMK_COPY_GUIDE_JS = `
(function () {
  if (window.__hyperplayerQmkCopyGuideDismissed) return;
  var old = document.getElementById('hyperplayer-copy-guide');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var texts = ['复制Key', '复制 Key', '复制key', '复制', 'Copy Key', 'Copy', 'copy'];
  function findCopyBtn() {
    for (var t = 0; t < texts.length; t++) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        var node = walker.currentNode;
        var v = node.nodeValue || '';
        if (v.indexOf(texts[t]) === -1) continue;
        var el = node.parentElement;
        var guard = 0;
        while (el && el.innerText && el.innerText.length > 30 && guard < 8) { el = el.parentElement; guard++; }
        var clickable = (el && el.closest && el.closest('button, a, [role=button], [data-clipboard], [data-copy], [data-clipboard-text], [data-clipboard-action]')) || el;
        if (clickable) return clickable;
      }
    }
    var attrEls = document.querySelectorAll('[data-clipboard], [data-copy], [data-clipboard-text], [data-clipboard-action]');
    if (attrEls.length) return attrEls[0];
    return null;
  }

  function mount(target) {
    if (window.__hyperplayerQmkCopyGuideMounted) return;
    window.__hyperplayerQmkCopyGuideMounted = true;

    var overlay = document.createElement('div');
    overlay.id = 'hyperplayer-copy-guide';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;';

    var style = document.createElement('style');
    style.textContent = '@keyframes wf-copy-pulse{0%{box-shadow:0 0 0 0 rgba(49,230,139,.75)}70%{box-shadow:0 0 0 26px rgba(49,230,139,0)}100%{box-shadow:0 0 0 0 rgba(49,230,139,0)}}@keyframes wf-copy-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(10px)}}';
    (document.head || document.documentElement).appendChild(style);

    var ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;border-radius:10px;border:3px solid #31e68b;background:rgba(49,230,139,.18);animation:wf-copy-pulse 1.4s infinite;pointer-events:none;';

    var arrow = document.createElement('div');
    arrow.style.cssText = 'position:fixed;width:44px;height:44px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.55));animation:wf-copy-bounce 1s infinite;pointer-events:none;';
    arrow.innerHTML = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14m0 0l-6-6m6 6l6-6" stroke="#31e68b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;padding:9px 15px;border-radius:10px;background:rgba(7,16,24,.94);color:#31e68b;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid rgba(49,230,139,.4);pointer-events:none;white-space:nowrap;';
    tip.textContent = '请点击「复制Key」按钮，自动完成登录';

    function reposition() {
      if (!target.isConnected) { cleanup(); return; }
      var rect = target.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      ring.style.left = (rect.left - 6) + 'px';
      ring.style.top = (rect.top - 6) + 'px';
      ring.style.width = (rect.width + 12) + 'px';
      ring.style.height = (rect.height + 12) + 'px';
      var above = rect.top > 150;
      arrow.style.left = (rect.left + rect.width / 2 - 22) + 'px';
      arrow.style.top = above ? (rect.top - 58) + 'px' : (rect.bottom + 14) + 'px';
      arrow.style.transform = above ? '' : 'rotate(180deg)';
      tip.style.left = Math.max(8, Math.min(window.innerWidth - 270, rect.left + rect.width / 2 - 125)) + 'px';
      tip.style.top = above ? (rect.top - 108) + 'px' : (rect.bottom + 66) + 'px';
    }

    var moveTimer = null;
    var goneTimer = null;
    function cleanup() {
      window.__hyperplayerQmkCopyGuideDismissed = true;
      if (moveTimer) clearInterval(moveTimer);
      if (goneTimer) clearInterval(goneTimer);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    overlay.appendChild(ring);
    overlay.appendChild(arrow);
    overlay.appendChild(tip);
    document.body.appendChild(overlay);
    reposition();
    moveTimer = setInterval(reposition, 500);

    // 用户点击复制按钮后 key 进入剪贴板，主进程会读到并自动关闭窗口。
    target.addEventListener('click', function () { setTimeout(cleanup, 600); });
    goneTimer = setInterval(function () {
      if (!target.isConnected || !target.getBoundingClientRect().width) cleanup();
    }, 800);
  }

  var btn = findCopyBtn();
  if (btn) { mount(btn); return; }
  var tries = 0;
  var retry = setInterval(function () {
    if (window.__hyperplayerQmkCopyGuideMounted || ++tries > 12) { clearInterval(retry); return; }
    var b = findCopyBtn();
    if (b) { clearInterval(retry); mount(b); }
  }, 500);
})();
`


async function createQQSkillKeyWindow() {
  // 防重入检查必须先于 session 清空：窗口开着时再次点领取，若先清空会把正在使用的
  // 独立分区 storage 全清掉，正在登录的页面当场掉登录态（先检查后清理）
  if (qqSkillKeyWindow && !qqSkillKeyWindow.isDestroyed()) {
    qqSkillKeyWindow.focus()
    return Promise.resolve({ success: false, error: 'QQ 音乐官方增强领取窗口已打开' })
  }
  // Wipe the dedicated qmk session before opening so the login is always fresh.
  const qmkSession = session.fromPartition(QMK_SESSION_PARTITION)
  // Allow clipboard write so the official copy button can put the key on the clipboard.
  qmkSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read' || permission === 'geolocation')
  })
  qmkSession.setPermissionCheckHandler((_wc, permission) =>
    permission === 'clipboard-sanitized-write' || permission === 'clipboard-read' || permission === 'geolocation')
  try {
    await qmkSession.clearStorageData()
    await qmkSession.clearCache()
    await qmkSession.clearAuthCache()
    const qmkCookies = await qmkSession.cookies.get({})
    for (const cookie of qmkCookies) {
      await qmkSession.cookies.remove(`https://${cookie.domain}`, cookie.name)
    }
  } catch (err) {
    console.error('[QQ Skill Key] clear session failed:', err)
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')

    qqSkillKeyWindow = new BrowserWindow({
      width: 1100,
      height: 760,
      parent: mainWindow,
      modal: true,
      frame: false,
      backgroundColor: '#000000',
      titleBarStyle: 'hidden',
      title: 'HyperPlayer 波音工坊 - QQ音乐官方增强',
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: qmkSession,
      },
    })

    qqSkillKeyWindow.loadURL(QMK_OFFICIAL_KEY_URL)

    const injectGuide = () => {
      if (!qqSkillKeyWindow || qqSkillKeyWindow.isDestroyed()) return
      qqSkillKeyWindow.webContents.executeJavaScript(QMK_GUIDE_JS).catch((err) => {
        console.error('[QQ Skill Key] 注入引导失败:', err)
      })
      qqSkillKeyWindow.webContents.executeJavaScript(QMK_CLOSE_BTN_JS).catch((err) => {
        console.error('[QQ Skill Key] 注入关闭按钮失败:', err)
      })
    }

    qqSkillKeyWindow.webContents.on('did-finish-load', injectGuide)
    qqSkillKeyWindow.webContents.on('did-navigate', () => setTimeout(injectGuide, 350))
    qqSkillKeyWindow.webContents.on('did-navigate-in-page', () => setTimeout(injectGuide, 350))

    // 轮询抓取页面上出现的 qmk- API Key
    let copyGuideShown = false
    let copyClickAttempts = 0
    const keyPoll = setInterval(async () => {
      if (!qqSkillKeyWindow || qqSkillKeyWindow.isDestroyed()) {
        clearInterval(keyPoll)
        return
      }
      try {
        const raw = await qqSkillKeyWindow.webContents.executeJavaScript(QMK_DETECT_KEY_JS, true)
        let info = null
        try { info = JSON.parse(raw) } catch (e) { info = null }
        let key = info && info.full ? info.full : ''
        if (!key && info && info.masked) {
          // 先注入引导动画指向「复制Key」（用户可手动点，最可靠）；同时尽力自动点击复制。
          if (!copyGuideShown) {
            copyGuideShown = true
            await qqSkillKeyWindow.webContents.executeJavaScript(QMK_COPY_GUIDE_JS, true).catch(() => {})
          }
          if (copyClickAttempts < 3) {
            copyClickAttempts++
            const clicked = await qqSkillKeyWindow.webContents.executeJavaScript(QMK_CLICK_COPY_JS, true).catch(() => false)
            if (clicked) await new Promise((r) => setTimeout(r, 500))
          }
          const cb = clipboard.readText() || ''
          const m = cb.match(/qmk-[A-Za-z0-9._-]{8,}/)
          if (m) {
            const star = info.masked.indexOf('*')
            const prefix = star > 0 ? info.masked.slice(0, star) : ''
            const lastStar = info.masked.lastIndexOf('*')
            const suffix = lastStar >= 0 && lastStar < info.masked.length - 1 ? info.masked.slice(lastStar + 1) : ''
            if ((!prefix || m[0].startsWith(prefix)) && (!suffix || m[0].endsWith(suffix))) key = m[0]
          }
        }
        if (key) {
          clearInterval(keyPoll)
          console.log('[QQ Skill Key] auto captured API Key')
          finish({ success: true, apiKey: key })
          qqSkillKeyWindow.close()
        }
      } catch (err) {
        // page navigating; skip this tick
      }
    }, 1500)

    qqSkillKeyWindow.on('closed', () => {
      clearInterval(keyPoll)
      qqSkillKeyWindow = null
      finish({ success: false, error: '用户取消了领取' })
    })
  })
}

// 监听打开 QQ 音乐官方增强领取窗口的请求
ipcMain.handle('open-qq-skill-key-window', async () => {
  try {
    return await createQQSkillKeyWindow()
  } catch (err) {
    console.error('[QQ Skill Key] 打开领取窗口失败:', err)
    return { success: false, error: err.message }
  }
})


// IPC 处理：设置开发者模式
ipcMain.handle('set-developer-mode', (event, enabled) => {
  developerMode = enabled
  console.log(`🔧 [DevMode] 开发者模式已${enabled ? '启用' : '禁用'}`)
  return { success: true }
})

// IPC 处理：获取开发者模式状态
ipcMain.handle('get-developer-mode', () => {
  return { enabled: developerMode }
})


// 根据 vendor/设备名判断 GPU 类型（独显 / 核显 / 未知），用于显卡选择 UI 展示
function classifyGpuKind(device) {
  const vendor = String(device?.vendorString || '').toLowerCase()
  const name = String(device?.deviceString || '').toLowerCase()
  if (vendor.includes('nvidia')) return 'discrete'
  if (vendor.includes('intel')) return 'integrated'
  if (vendor.includes('amd') || vendor.includes('ati') || vendor.includes('advanced micro devices')) {
    // AMD：RX/Pro 系列为独显，Radeon Graphics/APU 为核显
    return /rx\s?\d|radeon\s?rx|radeon\s?pro/.test(name) ? 'discrete' : 'integrated'
  }
  return 'unknown'
}

ipcMain.handle('get-gpu-settings', () => ({
  enabled: performanceSettings.hardwareAcceleration,
  gpuPreference: performanceSettings.gpuPreference,
  pendingGpuChange: performanceSettings.pendingGpuChange,
}))

ipcMain.handle('get-hardware-acceleration', async () => {
  let gpuInfo = null
  try {
    gpuInfo = await app.getGPUInfo('complete')
  } catch (error) {
    console.warn('[GPU] Failed to read GPU information:', error?.message || error)
  }

  const devices = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : []
  const activeGpu = devices.find(device => device?.active) || devices[0] || null

  // 去重（同一显卡可能以不同 adapter 出现），保留首条
  const seen = new Set()
  const gpus = devices
    .filter(device => {
      const key = `${device?.vendorString || ''}|${device?.deviceString || ''}`
      if (!key.trim() || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(device => ({
      active: Boolean(device?.active),
      vendorId: device?.vendorId,
      deviceId: device?.deviceId,
      vendorString: device?.vendorString || '',
      deviceString: device?.deviceString || '',
      driverVersion: device?.driverVersion || '',
      kind: classifyGpuKind(device),
    }))

  return {
    enabled: performanceSettings.hardwareAcceleration,
    gpuPreference: performanceSettings.gpuPreference,
    pendingGpuChange: performanceSettings.pendingGpuChange,
    actualEnabled: app.isHardwareAccelerationEnabled(),
    featureStatus: app.getGPUFeatureStatus(),
    gpu: activeGpu ? {
      active: Boolean(activeGpu.active),
      vendorId: activeGpu.vendorId,
      deviceId: activeGpu.deviceId,
      vendorString: activeGpu.vendorString || '',
      deviceString: activeGpu.deviceString || '',
      driverVendor: activeGpu.driverVendor || '',
      driverVersion: activeGpu.driverVersion || '',
    } : null,
    gpus,
  }
})

ipcMain.handle('set-hardware-acceleration', (_event, enabled) => {
  performanceSettings.hardwareAcceleration = enabled !== false
  // 关闭 GPU 加速属于风险操作，重启后需要用户确认，否则 15 秒自动恢复
  performanceSettings.pendingGpuChange = performanceSettings.hardwareAcceleration ? null : { type: 'acceleration' }
  writePerformanceSettings(performanceSettings)
  return { success: true, enabled: performanceSettings.hardwareAcceleration, requiresRestart: true }
})

ipcMain.handle('set-gpu-preference', (_event, preference) => {
  const next = ['auto', 'discrete', 'integrated'].includes(preference) ? preference : 'discrete'
  performanceSettings.gpuPreference = next
  // 切换到强制显卡（独显/核显）属于风险操作，重启后需要用户确认；自动为安全默认
  performanceSettings.pendingGpuChange = next === 'auto' ? null : { type: 'preference' }
  writePerformanceSettings(performanceSettings)
  return { success: true, gpuPreference: next, requiresRestart: true }
})

// 用户确认新的 GPU 设置可用（保留当前设置，清除待确认标记）
ipcMain.handle('confirm-gpu-change', () => {
  performanceSettings.pendingGpuChange = null
  writePerformanceSettings(performanceSettings)
  return { success: true }
})

// 用户未确认 / 点击取消：回退到安全默认值（独显 / 开启 GPU 加速）
ipcMain.handle('revert-gpu-change', () => {
  const pending = performanceSettings.pendingGpuChange
  if (pending?.type === 'acceleration') {
    performanceSettings.hardwareAcceleration = true
  } else if (pending?.type === 'preference') {
    performanceSettings.gpuPreference = 'auto'
  }
  performanceSettings.pendingGpuChange = null
  writePerformanceSettings(performanceSettings)
  return {
    success: true,
    hardwareAcceleration: performanceSettings.hardwareAcceleration,
    gpuPreference: performanceSettings.gpuPreference,
  }
})

// ── 全局高刷：让所有窗口的渲染帧率跟随所在显示器的刷新率（默认软件渲染下 Chromium 锁 60Hz）──

/** 窗口所在显示器的刷新率（Hz），夹在 [30, 360]，取不到时回退 60 */
function getWindowDisplayFrequency(win) {
  try {
    const { screen } = require('electron')
    if (!win || win.isDestroyed()) return 60
    const display = screen.getDisplayMatching(win.getBounds())
    const hz = Math.round(Number(display.displayFrequency) || 0)
    if (hz <= 0) return 60
    return Math.min(HIGH_REFRESH_MAX_HZ, Math.max(HIGH_REFRESH_MIN_HZ, hz))
  } catch {
    return 60
  }
}

/** 把当前高刷设置应用到全部窗口的 webContents（渲染帧率跟随所在显示器） */
function applyHighRefreshRate() {
  const enabled = performanceSettings.highRefreshRate === true
  const displayHz = getWindowDisplayFrequency(mainWindow)
  // 开启：默认跟随所在显示器最高刷新率；用户手动选档时取其与显示器最高中的较小值
  const targetHz = enabled
    ? (performanceSettings.highRefreshHz ? Math.min(performanceSettings.highRefreshHz, displayHz) : displayHz)
    : HIGH_REFRESH_MIN_HZ
  const targets = [mainWindow, desktopPlayerWindow, desktopLyricsWindow, taskbarWidgetWindow]
  for (const win of targets) {
    try {
      if (win && !win.isDestroyed() && win.webContents) win.webContents.setFrameRate(targetHz)
    } catch { /* 忽略 */ }
  }
  return { enabled, hz: targetHz, displayFrequency: displayHz }
}

/** 显示器/主窗口移动后重新贴合所在显示器刷新率（只绑定一次，避免重复监听） */
let highRefreshBound = false
function rebindHighRefreshRate() {
  const { screen } = require('electron')
  if (performanceSettings.highRefreshRate === true) {
    if (highRefreshBound) return
    highRefreshBound = true
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.on('move', applyHighRefreshRate)
        mainWindow.on('resize', applyHighRefreshRate)
      } catch { /* 忽略 */ }
    }
    screen.on('display-metrics-changed', applyHighRefreshRate)
  } else {
    highRefreshBound = false
  }
}

ipcMain.handle('display:get-info', () => {
  try {
    const { screen } = require('electron')
    const mainWinDisplay = (mainWindow && !mainWindow.isDestroyed())
      ? screen.getDisplayMatching(mainWindow.getBounds())
      : screen.getPrimaryDisplay()
    return {
      highRefreshEnabled: performanceSettings.highRefreshRate === true,
      highRefreshHz: performanceSettings.highRefreshHz,
      currentHz: getWindowDisplayFrequency(mainWindow),
      primary: screen.getPrimaryDisplay().displayFrequency,
      mainWindowDisplayId: mainWinDisplay.id,
      displays: screen.getAllDisplays().map(display => ({
        id: display.id,
        isPrimary: display.id === screen.getPrimaryDisplay().id,
        isMainWindow: display.id === mainWinDisplay.id,
        bounds: display.bounds,
        workArea: display.workArea,
        frequency: Math.round(Number(display.displayFrequency) || 0),
        scaleFactor: display.scaleFactor,
        label: `${display.bounds.width}×${display.bounds.height}${Math.round(Number(display.displayFrequency) || 0) ? ` @${Math.round(Number(display.displayFrequency) || 0)}Hz` : ''}`,
      })),
    }
  } catch (error) {
    return { error: error?.message || String(error) }
  }
})

ipcMain.handle('display:set-high-refresh', (_event, enabled, hz) => {
  performanceSettings.highRefreshRate = enabled === true
  const savedHz = Number(hz)
  performanceSettings.highRefreshHz = Number.isInteger(savedHz) && savedHz >= HIGH_REFRESH_MIN_HZ && savedHz <= HIGH_REFRESH_MAX_HZ
    ? savedHz
    : null
  writePerformanceSettings(performanceSettings)
  applyHighRefreshRate()
  rebindHighRefreshRate()
  return { success: true, enabled: performanceSettings.highRefreshRate, hz: getWindowDisplayFrequency(mainWindow) }
})

// 保存主窗口当前状态（窗口化/最大化/全屏覆盖任务栏 + 位置大小 + 所在显示器）
function persistMainWindowState() {
  try {
    const { screen } = require('electron')
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveWindowState(app, mainWindow, screen)
    }
  } catch {
    // ignore
  }
}

// IPC 处理：窗口控制
ipcMain.handle('window-minimize', () => {
  if (mainWindow) {
    mainWindow.minimize()
  }
})

// 窗口"扩大态"自记状态：kiosk 全屏 / 原生全屏 / 最大化 任一成立即 true。
// Windows 上 setKiosk 进入全屏后，isKiosk()/isFullScreen()/isMaximized() 返回值可能
// 全部为 false（kiosk 走独立全屏路径且不触发 maximize 事件），导致最大化按钮的第二次
// 按压被误判为"非全屏"而重新进入全屏——看起来"按了没反应"。自记状态让进入/还原切换始终自洽。
let mainWindowExpanded = false
// 进入扩大态前的正常窗口边界：kiosk 退出后 Electron 在 Windows 上可能不恢复原位置/尺寸
//（停留在左上角或全屏尺寸），还原时显式 setBounds 恢复。
let mainWindowNormalBounds = null

// 窗口状态记忆：大小/位置/状态变化后防抖保存（关闭时会做最终保存）。
// 提升到模块级：主窗口重建（透明↔不透明切换）后事件接线继续共用。
let windowStateSaveTimer = null
const scheduleWindowStateSave = () => {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null
    persistMainWindowState()
  }, 400)
}

// 关闭全部从属窗口（主窗真关闭时清场用）：登录窗走 close()，各自 closed 处理器会把
// 挂起的登录 Promise 以"用户取消"收尾（不卡"登录中"）；任务栏 widget 与两个数据桥是
// 隐藏工具窗，直接 destroy。
function closeAllDependentWindows() {
  const closable = [qqLoginWindow, qqSkillKeyWindow, desktopPlayerWindow, desktopLyricsWindow]
  for (const w of closable) {
    try { if (w && !w.isDestroyed()) w.close() } catch { /* 忽略 */ }
  }
  try { if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) taskbarWidgetWindow.destroy() } catch { /* 忽略 */ }
}

// 主窗口事件接线：启动创建（createWindow）与融合穿透重建（recreateMainWindow）共用。
// 重建后必须重新挂接，否则窗口会失去状态推送（标题栏图标）/窗口记忆/F12 快捷键。
function wireMainWindowEvents(win) {
  // 阻止 window.open 创建新的 Electron 窗口（外部链接交给系统浏览器）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  // 窗口关闭（含退出）前做最终状态保存——will-quit 时窗口可能已销毁拿不到 bounds
  win.on('close', () => {
    persistMainWindowState()
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    if (wallpaperWatcher) {
      clearInterval(wallpaperWatcher)
      wallpaperWatcher = null
    }
    // 融合穿透重建：旧窗销毁也触发本事件，此场景绝不能清场（新主窗马上接管）
    if (win.__wfRecreating) return
    // 主窗真被关闭：同步关闭全部从属窗。它们无 parent（部分 skipTaskbar）不会随主窗
    // 级联销毁，否则 window-all-closed 永不触发，进程无窗残留、用户找不到任何入口
    closeAllDependentWindows()
  })

  // 最大化/还原/全屏事件：自记扩大态 + 向渲染端推送状态（标题栏按钮图标依赖）
  win.on('maximize', () => {
    mainWindowExpanded = true
    // 记录最大化前的正常边界（getNormalBounds 在最大化后仍返回还原态的位置/尺寸），
    // 覆盖 Win+Up / 拖到顶部等原生最大化路径——否则还原时没有边界可恢复
    if (!mainWindowNormalBounds) mainWindowNormalBounds = win.getNormalBounds()
    safeSendToWindow(win, 'window-maximized', true)
    safeSendToWindow(win, 'window-fullscreen-change', true)
  })
  win.on('unmaximize', () => {
    // 可能仍处于 kiosk/原生全屏（例如全屏内部状态变化），自记态仅在确认非全屏后清除
    mainWindowExpanded = win.isKiosk() || win.isFullScreen()
    safeSendToWindow(win, 'window-maximized', false)
    safeSendToWindow(win, 'window-fullscreen-change', mainWindowExpanded)
  })
  win.on('enter-full-screen', () => {
    mainWindowExpanded = true
    if (!mainWindowNormalBounds) mainWindowNormalBounds = win.getNormalBounds()
    safeSendToWindow(win, 'window-fullscreen-change', true)
  })
  win.on('leave-full-screen', () => {
    mainWindowExpanded = win.isKiosk() || win.isMaximized()
    safeSendToWindow(win, 'window-fullscreen-change', false)
  })

  // 加载完成后向渲染端推送当前窗口状态
  win.webContents.on('did-finish-load', () => {
    if (mainWindow === win && !win.isDestroyed()) {
      safeSendToWindow(win, 'window-maximized', win.isMaximized())
      safeSendToWindow(win, 'window-fullscreen-change', win.isKiosk() || win.isFullScreen())
    }
  })

  // 窗口状态记忆：大小/位置/状态变化后防抖保存
  win.on('resize', scheduleWindowStateSave)
  win.on('move', scheduleWindowStateSave)
  win.on('maximize', scheduleWindowStateSave)
  win.on('unmaximize', scheduleWindowStateSave)
  win.on('enter-full-screen', scheduleWindowStateSave)
  win.on('leave-full-screen', scheduleWindowStateSave)

  // F12 快捷键：开发者模式下打开开发者工具
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (developerMode) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
      }
    }
  })
}

// 重建主窗口：transparent 仅在创建时生效（透明窗口用于桌面融合穿透，普通模式用原生
// 不透明窗口+系统圆角/阴影），切换两者只能销毁重建。重建保留窗口边界与置顶状态，
// 融合特有的状态（kiosk 记忆/沉底/鼠标穿透）由调用方在重建后应用。
async function recreateMainWindow(transparent) {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const wasAlwaysOnTop = mainWindow.isAlwaysOnTop()
  // 先退出扩大态（kiosk/全屏/最大化），避免销毁时把全屏边界写进窗口状态记忆；
  // 退出后再取边界，否则 getBounds 会拿到 kiosk 的全屏尺寸
  try {
    if (mainWindow.isKiosk()) mainWindow.setKiosk(false)
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false)
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
  } catch { /* 忽略 */ }
  const savedBounds = mainWindow.getBounds()
  mainWindowExpanded = false
  mainWindowNormalBounds = null

  const oldWindow = mainWindow
  mainWindow = null
  // 标记重建销毁：closed 处理器据此跳过从属窗清场（否则会关掉桌面歌词/桌面播放器等）
  oldWindow.__wfRecreating = true
  if (!oldWindow.isDestroyed()) oldWindow.destroy()

  const win = new BrowserWindow({
    width: savedBounds.width,
    height: savedBounds.height,
    x: savedBounds.x,
    y: savedBounds.y,
    minWidth: 1200,
    minHeight: 800,
    frame: false,
    backgroundColor: transparent ? '#00000000' : '#000000',
    transparent,
    titleBarStyle: 'hidden',
    title: 'HyperPlayer',
    icon: windowIcon.isEmpty() ? undefined : windowIcon,
    // 不透明窗口用 Windows 11 原生圆角；透明窗口原生圆角无效，由渲染端 #root 自绘
    roundedCorners: !transparent,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      paintWhenInitiallyHidden: true, // 软件合成下隐藏时也持续绘制，避免显示时首帧空白
    },
  })
  mainWindow = win
  if (wasAlwaysOnTop) win.setAlwaysOnTop(true)
  guardAgainstExternalNavigation(win)
  wireMainWindowEvents(win)

  if (isDev) {
    win.loadURL(devServerUrl)
    if (process.env.HYPERPLAYER_OPEN_DEVTOOLS === '1') win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  win.once('ready-to-show', () => {
    if (mainWindow === win && !win.isDestroyed()) {
      win.show()
      win.focus()
    }
  })
  return win
}

// 应用融合穿透窗口状态：退出 kiosk/置顶并沉底（真实窗口浮在上层），开启鼠标穿透。
const applyFusionWindowState = (win) => {
  if (!win || win.isDestroyed()) return
  try {
    if (win.isKiosk()) win.setKiosk(false)
    if (win.isFullScreen()) win.setFullScreen(false)
    win.setAlwaysOnTop(false)
    win.moveBottom()
    win.setIgnoreMouseEvents(true, { forward: true })
  } catch (error) {
    console.error('[桌面融合穿透] 应用融合窗口状态失败:', error?.message || error)
  }
}

// 恢复原生窗口状态（关闭融合后）：重新置顶；开启前是 kiosk 全屏则还原。
const restoreNativeWindowState = (win) => {
  if (!win || win.isDestroyed()) return
  try {
    win.setAlwaysOnTop(true)
    win.moveTop()
    if (desktopFusionSavedKiosk) win.setKiosk(true)
    win.setIgnoreMouseEvents(false)
  } catch (error) {
    console.error('[桌面融合穿透] 恢复原生窗口状态失败:', error?.message || error)
  }
}

// 还原分支需要"无条件退出全部扩大形态"：isKiosk()/isFullScreen() 在 kiosk 时序下可能
// 返回 false，导致按状态判断的恢复被跳过（窗口一直停留在全屏，看起来"缩小没反应"）。
// 对非对应状态的 setKiosk(false)/setFullScreen(false)/unmaximize() 调用是无害 no-op。
const restoreMainWindowFromExpanded = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setKiosk(false)
    mainWindow.setFullScreen(false)
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    // 显式恢复进入前边界；未记录时（如启动即 kiosk）交给原生还原（unmaximize/
    // setKiosk(false)），不强行居中覆盖用户自定义位置/尺寸
    if (mainWindowNormalBounds) {
      mainWindow.setBounds(mainWindowNormalBounds)
      mainWindowNormalBounds = null
    }
  } catch (error) {
    console.error('[窗口最大化] 还原失败:', error?.message || error)
  }
}

ipcMain.handle('window-maximize', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindowExpanded) {
    // 扩大态 → 还原窗口
    console.log('[窗口最大化] 还原窗口（当前为扩大态）')
    restoreMainWindowFromExpanded()
    mainWindowExpanded = false
  } else {
    // 正常窗口 → 按用户设置进入全屏或最大化
    try {
      // 记录进入前边界，供还原时显式恢复（kiosk 退出后 Electron 可能不恢复原位置/尺寸）
      mainWindowNormalBounds = mainWindow.getBounds()
      // 从渲染进程读取全屏模式设置
      const fullscreenMode = await mainWindow.webContents.executeJavaScript(`
        (() => {
          try {
            return localStorage.getItem('fullscreenMode') || 'kiosk';
          } catch {
            return 'kiosk';
          }
        })()
      `)
      console.log('[窗口最大化] 读取到的全屏模式设置:', fullscreenMode)
      if (fullscreenMode === 'kiosk') {
        console.log('[窗口最大化] 进入全屏模式（覆盖任务栏）')
        mainWindow.setKiosk(true)
      } else {
        console.log('[窗口最大化] 进入全屏无边框模式（保留任务栏）')
        mainWindow.maximize()
      }
    } catch (error) {
      console.error('[窗口最大化] 读取设置失败，使用默认全屏模式', error)
      mainWindow.setKiosk(true)
    }
    mainWindowExpanded = true
  }
  // 切换完成后向渲染端推送真实状态，供标题栏按钮图标刷新
  // （kiosk 路径不触发 maximize/unmaximize 事件，必须在此显式同步）
  try {
    safeSendToWindow(mainWindow, 'window-maximized', mainWindow.isMaximized())
    safeSendToWindow(mainWindow, 'window-fullscreen-change', mainWindowExpanded)
    persistMainWindowState()
  } catch { /* 忽略 */ }
})

ipcMain.handle('window-close', () => {
  if (mainWindow) {
    mainWindow.close()
  }
})

// IPC 处理：获取窗口最大化状态?
ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false
})

// 桌面融合穿透：把桌面模式「融合」进真实桌面。
// 开启后：退出 kiosk、取消置顶并把窗口沉底（真实窗口浮在上层），
// 由渲染端按光标是否悬停在组件上（mousemove + elementFromPoint）实时切换鼠标穿透，
// 空区域点击穿透到真实桌面（可点文件夹/任务栏）。
// 注意：穿透需要透明窗口，而 transparent 只在窗口创建时生效——普通模式用原生不透明
// 窗口（系统圆角/阴影/对齐吸附），开启/关闭融合时销毁重建主窗口切换透明属性。
let desktopFusionEnabled = false
let desktopFusionSavedKiosk = false

ipcMain.handle('desktop-fusion:get-state', () => ({ enabled: desktopFusionEnabled }))

// 设置融合状态并重建窗口（透明↔不透明）。供渲染端关闭融合、以及应用启动时
// 从 localStorage 恢复融合态（此时主进程 desktopFusionEnabled 为 false）调用。
ipcMain.handle('desktop-fusion:set-enabled', async (_event, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, canceled: false }
  const next = enabled === true
  if (next === desktopFusionEnabled) return { success: true, enabled: desktopFusionEnabled, recreated: false }
  desktopFusionEnabled = next
  try {
    if (next) {
      // 开启：记录 kiosk 记忆，重建为透明窗口（启动恢复路径，无需确认）
      desktopFusionSavedKiosk = mainWindow.isKiosk()
      const win = await recreateMainWindow(true)
      if (!win) { desktopFusionEnabled = false; return { success: false, canceled: false } }
      applyFusionWindowState(win)
    } else {
      // 关闭：重建回原生不透明窗口并恢复置顶/kiosk
      const win = await recreateMainWindow(false)
      if (!win) { desktopFusionEnabled = true; return { success: false, canceled: false } }
      restoreNativeWindowState(win)
    }
  } catch (error) {
    console.error('[桌面融合穿透] 切换失败:', error?.message || error)
  }
  return { success: true, enabled: desktopFusionEnabled, recreated: true }
})

// 开启穿透需重建窗口（会中断当前播放/重载界面），确认框由渲染端应用内弹窗完成
//（FusionEnableConfirmModal，与删除歌单弹窗同款样式），确认后经 set-enabled 重建。
// 此路径同样承担"应用启动时从 localStorage 恢复融合态"（此时主进程 desktopFusionEnabled
// 为 false，渲染端启动同步调用 set-enabled(true) 触发重建为透明窗口）。

// 渲染端报告「光标是否悬停在组件上」→ 切换鼠标穿透
ipcMain.on('desktop-fusion:set-interactive', (_event, interactive) => {
  if (!desktopFusionEnabled || !mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setIgnoreMouseEvents(!(interactive === true), { forward: true })
  } catch { /* 忽略 */ }
})


// IPC 处理：全屏控制
ipcMain.handle('window-set-fullscreen', (event, fullscreen, kiosk = false) => {
  console.log('[全屏控制] fullscreen=', fullscreen, ', kiosk=', kiosk)
  console.log('[全屏控制] 当前状态: isKiosk=', mainWindow?.isKiosk(), ', isFullScreen=', mainWindow?.isFullScreen(), ', isMaximized=', mainWindow?.isMaximized())
  
  if (mainWindow) {
    if (fullscreen) {
      // 记录进入前边界（kiosk 退出后 Electron 可能不恢复原位置/尺寸）
      if (!mainWindowExpanded) mainWindowNormalBounds = mainWindow.getBounds()
      if (kiosk) {
        // 全屏模式（kiosk=true）- 覆盖任务栏
        console.log('[全屏控制] 启用全屏模式（覆盖任务栏）')
        // 先退出其他模式
        if (mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(false)
        }
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize()
        }
        // 使用 setKiosk 来覆盖任务栏（Windows 上最可靠的方式）
        mainWindow.setKiosk(true)
      } else {
        // 全屏无边框模式（kiosk=false）- 保留任务栏
        console.log('[全屏控制] 启用全屏无边框模式（保留任务栏，使用最大化）')
        // 先退出其他模式
        if (mainWindow.isKiosk()) {
          mainWindow.setKiosk(false)
        }
        if (mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(false)
        }
        // 使用最大化来保留任务栏
        mainWindow.maximize()
      }
      mainWindowExpanded = true
    } else {
      // 退出所有全屏模式（不依赖 isKiosk()/isFullScreen() 可能不可靠的查询，无条件恢复）
      console.log('[全屏控制] 退出全屏')
      restoreMainWindowFromExpanded()
      mainWindowExpanded = false
    }
    
    console.log(`[全屏控制] 执行后状态: isKiosk=${mainWindow.isKiosk()}, isFullScreen=${mainWindow.isFullScreen()}, isMaximized=${mainWindow.isMaximized()}`)
    // 向渲染端同步扩大态（kiosk 路径可能不触发 fullscreen 事件），刷新标题栏图标
    safeSendToWindow(mainWindow, 'window-fullscreen-change', mainWindowExpanded)
    persistMainWindowState() // 全屏/最大化切换后立即记忆
  }
})

// IPC 处理：获取全屏状态?
ipcMain.handle('window-is-fullscreen', () => {
  if (!mainWindow) return { fullscreen: false, kiosk: false, maximized: false, expanded: false }
  return {
    fullscreen: mainWindow.isFullScreen(),
    kiosk: mainWindow.isKiosk(),
    maximized: mainWindow.isMaximized(),
    expanded: mainWindowExpanded
  }
})

ipcMain.handle('get-system-location', async () => {
  try {
    return { success: true, ...(await getWindowsSystemLocation()) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * 启动生产版常驻本地后端。Express API（local-server.mjs，端口 3001）通过
 * utilityProcess.fork 启动。 */
let localApiChild = null

// ── 孤儿后端清扫：上次异常退出残留的子进程会占住后端端口，导致新实例误连旧后端 ──
// 必须在模块级声明：will-quit 的清扫调用在模块作用域，放进 startLocalBackend 的
// try 块内会因作用域不可见抛 ReferenceError（静默失效）。
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const BACKEND_PORTS = [3001]
async function sweepBackendOrphans(reason) {
  for (const port of BACKEND_PORTS) {
    try {
      const ps = [
        '$c = Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue',
        'foreach ($x in $c) {',
        '  $pp = Get-Process -Id $x.OwningProcess -ErrorAction SilentlyContinue',
        '  if ($pp -and ($pp.Path -like "*win-unpacked*" -or $pp.ProcessName -like "HyperPlayer*")) { Write-Output $x.OwningProcess }',
        '}',
      ].join('; ')
      const out = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 12000 })
      const pids = String(out.stdout || '').split(/[^0-9]+/).map(v => parseInt(v, 10)).filter(v => v > 0)
      for (const pid of pids) {
        try {
          await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000 })
          console.log('[LocalAPI] 清扫残留子进程 pid=' + pid + ' (port=' + port + ', reason=' + reason + ')')
        } catch { /* 已退出则忽略 */ }
      }
    } catch { /* 清扫失败不阻塞启动 */ }
  }
}

/**
 * 后端就绪探测（供启动页门控用）：轮询本机 /health 直到契约匹配。
 * 判定与 dev 启动器 `isLocalApiServerHealthy()` 完全一致（同 header、同健康契约），
 * 避免"两套就绪标准"各自漂移。轮询上限 SPLASH_START_MAX_WAIT_MS，超时后由主门控兜底放行。
 */
async function probeLocalBackendReady() {
  // 开发模式后端由 dev-electron.mjs 拉起（且它已等到健康才开 Electron），无需再探
  if (!app.isPackaged || process.env.HYPERPLAYER_DISABLE_LOCAL_BACKEND === '1') {
    noteSplashGate('backendReady')
    return
  }
  const startedAt = Date.now()
  const deadline = startedAt + BACKEND_PROBE_GIVE_UP_MS
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1500)
      const res = await fetch('http://127.0.0.1:3001/health', {
        headers: { 'X-HyperPlayer-Local-Token': LOCAL_SERVICE_TOKEN },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.ok) {
        const body = await res.json().catch(() => null)
        if (body && body.status === 'ok' && body.service === 'hyperplayer-local-api') {
          logStartupTiming(`Local backend ready after ${Date.now() - startedAt}ms`)
          noteSplashGate('backendReady')
          return
        }
      }
    } catch { /* 还没起来，继续轮询 */ }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  // 走到这里说明探测自己放弃了（安全网）。不在这里强行放行——放行与否交给门控计时器，
  // 避免两个计时器抢跑导致行为不确定。
  logStartupTiming(`Local backend probe gave up after ${BACKEND_PROBE_GIVE_UP_MS}ms`)
}

async function startLocalBackend() {
  if (!app.isPackaged) return // 开发模式由 dev-electron.mjs 启动
  if (process.env.HYPERPLAYER_DISABLE_LOCAL_BACKEND === '1') return

  // 1) Express API（3001）
  try {
    await sweepBackendOrphans('startup')
    const serverEntry = path.join(process.resourcesPath, 'app.asar', 'local-server.mjs')
    localApiChild = utilityProcess.fork(serverEntry, [], {
      env: {
        ...process.env,
        HYPERPLAYER_USERDATA: app.getPath('userData'),
        HYPERPLAYER_LOCAL_TOKEN: LOCAL_SERVICE_TOKEN,
      },
      stdio: 'pipe',
    })
    localApiChild.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) console.log('[LocalAPI]', text)
    })
    localApiChild.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) console.error('[LocalAPI:err]', text)
    })
    localApiChild.on('exit', (code) => {
      console.error('[LocalAPI] exited with code', code)
      localApiChild = null
    })
    console.log('[LocalAPI] starting local-server.mjs via utilityProcess')
  } catch (error) {
    console.error('[LocalAPI] failed to start:', error)
  }

}

// 应用退出时一并结束本地子进程
app.on('will-quit', async () => {
  persistMainWindowState() // 关闭前做最终窗口状态保存（防抖定时器可能尚未触发）
  try { localApiChild?.kill() } catch {}
  await sweepBackendOrphans('quit')
})

app.whenReady().then(async () => {
  logStartupTiming('Electron app ready')
  // 启动时应用上次「稍后」的待更新：拉起 updater 后立即退出，换完文件自动重启到新版本。
  // 返回 true 表示正在重启应用，跳过本窗口创建流程。
  try {
    const { applyPendingAtStartup } = require('./update-manager.cjs')
    if (applyPendingAtStartup()) return
  } catch (error) {
    console.error('⚠️ [更新] 启动应用待更新失败:', error instanceof Error ? error.message : error)
  }

  // ── 启动页优先：任何阻塞性初始化之前就把它建起来并显示 ──
  // 主窗口还要做很多准备（后端、渲染进程、窗口状态等），页面也要等 React 加载；
  // 而启动页只需一个轻量离线页面。让它先出现，用户不会面对空屏；
  // 主窗口仍并行加载，故总启动时间不变（取两者最大值）。
  // 窗口尺寸/位置先按「上次的记忆」解析出来，与主窗口共用，避免切换时窗口跳动。
  try {
    createSplashWindowEarly(resolveTargetBounds())
  } catch (error) {
    console.error('[Startup] 提前创建启动页失败（后续会补建）:', error?.message || error)
  }

  // GPU 状态诊断：区分"splash 未渲染出来"（GPU 合成器异常）与"未加载出来"（资源失败）。
  //
  // ⚠️ 时机陷阱（2026-09-11 实测）：app ready 后的一小段时间内 GPU 进程尚未初始化完成，
  // 此时 getGPUFeatureStatus() 返回过渡值 gpu_compositing='disabled_software'，
  // 约 300~400ms 后才变为 'enabled'。本机实测时间线：
  //   +128ms / +236ms → disabled_software ；+393ms 起 → enabled（并稳定保持）
  // 若在此窗口内读一次就定论，会把「显卡完全正常」的机器误判为软件合成 ——
  // 既误导排查方向（本机曾因此误以为走了虚拟显示器），又让 splashMinVisibleMs
  // 被错误地由 1200ms 拉长到 3500ms（白等 2.3s）。
  //
  // 修复要点：
  //   1. 轮询等待状态稳定（读到 'enabled' 立即返回；过渡值需连续两次一致才算稳定；2s 超时兜底）；
  //   2. **异步执行、不 await**，绝不阻塞窗口创建 —— splash 最短可见时间在「切主窗口」时才读取，
  //      那时状态早已稳定（见 createWindow 内的 splashMinVisibleMsFor()）。
  const readStableGpuStatus = async () => {
    const TRANSITIONAL = new Set(['disabled_software', 'disabled_off', 'unknown'])
    const deadline = Date.now() + 2000
    let previous = null
    while (Date.now() < deadline) {
      const status = app.getGPUFeatureStatus()
      const value = status.gpu_compositing
      if (value === 'enabled') return { status, settled: true }
      if (previous === value && !TRANSITIONAL.has(value)) return { status, settled: true }
      previous = value
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return { status: app.getGPUFeatureStatus(), settled: false }
  }
  void readStableGpuStatus().then(({ status: gpuInfo, settled }) => {
    // 仅作诊断记录：确认显卡合成是否正常（排查启动页黑/白屏时用）。
    // 启动页的停留时长已是固定值（见 createWindow 的 SPLASH_MIN_VISIBLE_MS），
    // 不再随该状态变化 —— 早前按它动态延长最短可见时间的做法已移除。
    logStartupTiming(`GPU feature status: accelerated=${gpuInfo.gpu_compositing || '?'} webgl=${gpuInfo.webgl || '?'} (settled=${settled})`)
  }).catch((error) => {
    logStartupTiming(`GPU feature status unavailable: ${error.message}`)
  })
  // Electron 默认不会自动放行渲染进程的定位权限。
  // 放行后，天气组件才能优先使用 Windows/Chromium 的设备定位，再回退到公网 IP。
  // media 权限：放行后渲染进程才能用 navigator.mediaDevices.enumerateDevices()
  // 列出真实的音频输出设备（设置-高级「音频输出设备」）。
  const isTrustedPermissionRequester = (webContents) => {
    if (!mainWindow || webContents !== mainWindow.webContents || webContents.isDestroyed()) return false
    const url = webContents.getURL?.() || ''
    return createDocumentUrlMatcher([
      devServerUrl,
      pathToFileURL(path.join(__dirname, '../dist/index.html')).href,
    ])(url)
  }
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => (
    isTrustedPermissionRequester(webContents) && (permission === 'geolocation' || permission === 'media')
  ))
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const frameTrusted = !details?.requestingUrl || createDocumentUrlMatcher([
      devServerUrl,
      pathToFileURL(path.join(__dirname, '../dist/index.html')).href,
    ])(details.requestingUrl)
    callback(isTrustedPermissionRequester(webContents) && frameTrusted && (permission === 'geolocation' || permission === 'media'))
  })
  session.defaultSession.setDevicePermissionHandler((details) => {
    const requestOrigin = details?.origin || details?.embeddingOrigin || ''
    const originTrusted = createDocumentUrlMatcher([
      devServerUrl,
      pathToFileURL(path.join(__dirname, '../dist/index.html')).href,
    ])(requestOrigin)
    if (!originTrusted) return false
    const type = details?.deviceType || ''
    return type === 'audiooutput' || type === 'audio' || details?.mediaType === 'audio'
  })

  // Electron 本地服务请求认证：token 只存在于主进程和受控子进程环境，renderer 无法读取。
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://localhost:3001/*', 'http://127.0.0.1:3001/*'] },
    (details, callback) => {
      if (mainWindow && details.webContentsId === mainWindow.webContents.id) {
        details.requestHeaders['X-HyperPlayer-Local-Token'] = LOCAL_SERVICE_TOKEN
      }
      callback({ requestHeaders: details.requestHeaders })
    },
  )

  // 初始化配置管理器
  configManager = new ConfigManager(app)
  const cachePath = configManager.getCachePath()
  console.log('📁 [Config] 缓存路径:', cachePath)
  
  // 创建缓存目录结构
  const requiredDirs = [
    cachePath,
    path.join(cachePath, 'temp'),           // 音频缓存
    path.join(cachePath, 'beat_analysis'),  // 节拍分析缓存
    path.join(cachePath, 'tracks'),         // 音轨缓存
    path.join(cachePath, 'transition-renders') // 过渡渲染
  ]
  
  requiredDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      console.log('📁 [Config] 创建目录:', dir)
    }
  })
  
  // 启动生产版常驻本地 API（3001）。
  // 开发模式继续由 scripts/dev-electron.mjs 预启动。
  startLocalBackend()
  // 启动页门控条件之三：后端就绪后放行动画（不等它把启动页挡住 —— 只是不抢资源）
  void probeLocalBackendReady()
  
  // Razer Chroma：本地 REST 会话、设备探测与高频灯效帧。
  try {
    chromaControllerHandle = setupChromaIpc({ ipcMain, getMainWindow: () => mainWindow, repairBasePath: app.getPath('userData') })
  } catch (error) {
    console.error('[Chroma] 初始化失败:', error instanceof Error ? error.message : error)
  }
  // SignalRGB：Effect 安装、Local API 与 Canvas Event 桥。
  try {
    signalRgbControllerHandle = setupSignalRgbIpc({ ipcMain, getMainWindow: () => mainWindow, shell })
  } catch (error) {
    console.error('[SignalRGB] 初始化失败:', error instanceof Error ? error.message : error)
  }
  ipcMain.handle('audio-output:is-supported', () => process.platform === 'win32' || process.platform === 'darwin')

  app.on('will-quit', async () => {
    if (chromaControllerHandle) {
      try { await chromaControllerHandle.dispose() } catch { /* 忽略 */ }
      chromaControllerHandle = null
    }
    if (signalRgbControllerHandle) {
      try { signalRgbControllerHandle.dispose() } catch { /* 忽略 */ }
      signalRgbControllerHandle = null
    }
  })
  
  ipcMain.handle('audio-download:selectLocalFile', guardTrustedIpc('privileged', async () => {
    if (!analysisRuntime?.audioDownload) throw new Error('Audio download service not initialized')
    const result = await dialog.showOpenDialog({
      title: '选择本地音频文件',
      properties: ['openFile'],
      filters: [{ name: '音频文件', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'opus', 'webm'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return analysisRuntime.audioDownload.authorizeLocalFile(result.filePaths[0])
  }))

  // Setup audio download IPC handlers
  ipcMain.handle('audio-download:prepare', guardTrustedIpc('privileged', async (_event, urlOrPath, trackKey) => {
    if (!analysisRuntime || !analysisRuntime.audioDownload) {
      throw new Error('Audio download service not initialized')
    }
    const result = await analysisRuntime.audioDownload.prepareAudioFile(urlOrPath, trackKey)
    const ext = String(result || '').split('.').pop()?.toLowerCase() || '?'
    return result
  }))


  // 只读缓存命中检查（不触发下载）：看歌等场景优先用本地已缓存音轨（mv-align 已下载
  // 同一 DASH 音频），命中即秒开；未命中返回 null，调用方照旧走流式 URL。
  ipcMain.handle('audio-download:peekCached', guardTrustedIpc('privileged', (_event, trackKey) => {
    if (!analysisRuntime || !analysisRuntime.audioDownload) {
      return null
    }
    return analysisRuntime.audioDownload.peekCached(trackKey)
  }))


  // 把已下载的音频文件映射为渲染进程可 fetch 的 hyperplayer-media:// URL
  // （浏览器端 decodeAudioData 原生支持 m4a/aac——Python/librosa 侧 libsndfile 打不开）。
  // 仅允许下载缓存目录内的文件，与 render:getAudioUrl 同款路径校验。
  ipcMain.handle('audio-download:getMediaUrl', guardTrustedIpc('privileged', (_event, filePath) => {
    if (!analysisRuntime || !analysisRuntime.audioDownload || !analysisRuntime.audioDownload.tempRoot) {
      throw new Error('Audio download service not initialized')
    }
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('Media file path is required')
    if (!analysisRuntime.audioDownload.isInsideTempRoot(filePath)) {
      throw new Error('Media file path is outside the audio download cache')
    }
    const resolved = fs.realpathSync.native(filePath)
    const url = toMediaUrl(resolved)
    return url
  }))


  // 保存渲染进程转码后的 WAV（Chromium decodeAudioData → 16bit PCM），供 Python
  // 渲染/AI worker 读取（libsndfile 只认 wav/flac/ogg/mp3，m4a/aac/opus 必须转码）。
  // 已存在同 key 的 WAV 直接复用，同一首歌只转码一次。
  ipcMain.handle('audio-download:saveWav', guardTrustedIpc('privileged', (_event, trackKey, wavArrayBuffer) => {
    if (!analysisRuntime || !analysisRuntime.audioDownload || !analysisRuntime.audioDownload.tempRoot) {
      throw new Error('Audio download service not initialized')
    }
    if (typeof trackKey !== 'string' || !trackKey.trim() || trackKey.length > 256) {
      throw new Error('A non-empty track key is required')
    }
    const buf = Buffer.from(wavArrayBuffer || new ArrayBuffer(0))
    if (buf.length < 44 || buf.length > 512 * 1024 * 1024
      || buf.toString('ascii', 0, 4) !== 'RIFF'
      || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Invalid WAV payload')
    }
    const contentHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
    const safeName = `${trackKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)}-${contentHash}.wav`
    const target = path.join(analysisRuntime.audioDownload.tempRoot, safeName)
    if (fs.existsSync(target)) {
      if (!analysisRuntime.audioDownload.isInsideTempRoot(target)) {
        throw new Error('WAV cache target escapes the audio download cache')
      }
      const existing = fs.realpathSync.native(target)
      return existing
    }
    const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temp, buf, { flag: 'wx' })
      fs.renameSync(temp, target)
      if (!analysisRuntime.audioDownload.isInsideTempRoot(target)) {
        fs.rmSync(target, { force: true })
        throw new Error('WAV cache target escapes the audio download cache')
      }
    } finally {
      try { fs.rmSync(temp, { force: true }) } catch {}
    }
    return target
  }))

  
  ipcMain.handle('audio-download:cleanup', guardTrustedIpc('privileged', () => {
    if (analysisRuntime && analysisRuntime.audioDownload) {
      analysisRuntime.audioDownload.clearLocalAuthorizations()
      analysisRuntime.audioDownload.cleanupOldFiles()
    }
    return { success: true }
  }))

  
  ipcMain.handle('audio-download:get-stats', guardTrustedIpc('privileged', () => {
    if (!analysisRuntime || !analysisRuntime.audioDownload) {
      return { fileCount: 0, totalSize: 0, maxSize: 2 * 1024 * 1024 * 1024, cachePath: '' }
    }
    const stats = analysisRuntime.audioDownload.getCacheStats()
    const cachePath = path.join(configManager.getCachePath(), 'temp')
    return { ...stats, cachePath }
  }))

  
  ipcMain.handle('audio-download:clear-cache', guardTrustedIpc('privileged', () => {
    if (analysisRuntime && analysisRuntime.audioDownload) {
      analysisRuntime.audioDownload.clearLocalAuthorizations()
      analysisRuntime.audioDownload.cleanupAll()
      return { success: true }
    }
    return { success: false }
  }))


  // 应用更新管理：后台静默下载 + 退出即应用 + 更新日志/版本历史。
  // 处理器集中在 update-manager.cjs（下载进度经 update:download-status 事件广播）。
  try {
    const { setupUpdateIPC } = require('./update-manager.cjs')
    setupUpdateIPC(ipcMain, () => mainWindow, event => trustedIpc.isTrusted(event, 'update'))
  } catch (error) {
    console.error('⚠️ [更新] 更新管理器初始化失败:', error instanceof Error ? error.message : error)
  }
  
  // 配置管理 IPC 处理器
  ipcMain.handle('config:get-cache-path', guardTrustedIpc('privileged', () => {
    return configManager.getCachePath()
  }))


  // QQ 音乐官方 Skills Key 使用系统安全存储（Windows 上为 DPAPI）加密后再落盘。
  // 不写入项目配置、环境文件或日志。
  ipcMain.handle('credentials:get-qqmusic-skill-key', guardTrustedIpc('privileged', () => ({
    success: true,
    configured: Boolean(readQQMusicSkillKey()),
    key: readQQMusicSkillKey(),
    secure: safeStorage.isEncryptionAvailable()
  })))

  ipcMain.handle('credentials:set-qqmusic-skill-key', guardTrustedIpc('privileged', (_event, value) => {
    const key = String(value || '').trim()
    if (!/^qmk-[A-Za-z0-9._-]+$/.test(key)) {
      return { success: false, error: 'API Key 格式应为 qmk-…' }
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: '当前系统安全存储不可用，密钥不会被明文保存' }
    }
    try {
      const credentials = readSecureCredentials()
      credentials[QQMUSIC_SKILL_CREDENTIAL] = safeStorage.encryptString(key).toString('base64')
      writeSecureCredentials(credentials)
      return { success: true, configured: true, secure: true }
    } catch (error) {
      return { success: false, error: error.message || '保存 API Key 失败' }
    }
  }))


  ipcMain.handle('credentials:delete-qqmusic-skill-key', guardTrustedIpc('privileged', () => {
    try {
      const credentials = readSecureCredentials()
      delete credentials[QQMUSIC_SKILL_CREDENTIAL]
      writeSecureCredentials(credentials)
      return { success: true, configured: false }
    } catch (error) {
      return { success: false, error: error.message || '删除 API Key 失败' }
    }
  }))

  
  ipcMain.handle('config:set-cache-path', guardTrustedIpc('privileged', (event, newPath) => {
    try {
      // 验证路径是否有效
      if (typeof newPath !== 'string' || !newPath.trim() || !path.isAbsolute(newPath.trim())) {
        return { success: false, error: '路径必须是绝对路径' }
      }
      
      // 保存配置
      const success = configManager.setCachePath(newPath.trim())
      if (success) {
        console.log('📁 [Config] 缓存路径已更新:', newPath)
        console.log('⚠️ [Config] 需要重启应用以生效')
        return { success: true, needRestart: true }
      } else {
        return { success: false, error: '保存配置失败' }
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }))

  
  ipcMain.handle('config:select-cache-path', guardTrustedIpc('privileged', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: '选择缓存存储路径',
        buttonLabel: '选择'
      })
      
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      
      const selectedPath = result.filePaths[0]
      
      // 自动保存选择的路径
      const success = configManager.setCachePath(selectedPath)
      if (success) {
        console.log('📁 [Config] 缓存路径已更新:', selectedPath)
        return selectedPath
      } else {
        throw new Error('保存配置失败')
      }
    } catch (error) {
      console.error('Failed to select cache path:', error)
      return null
    }
  }))

  
  ipcMain.handle('config:reset-cache-path', guardTrustedIpc('privileged', () => {
    try {
      const defaultCachePath = configManager.getDefaultCachePath()
      
      // 保存配置
      const success = configManager.setCachePath(defaultCachePath)
      if (success) {
        console.log('📁 [Config] 缓存路径已重置为默认值:', defaultCachePath)
        return defaultCachePath
      } else {
        throw new Error('保存配置失败')
      }
    } catch (error) {
      console.error('Failed to reset cache path:', error)
      throw error
    }
  }))

  
  registerMediaProtocol()

  // 桌面播放器：读取上次的开关与形态设置
  const desktopPlayerSaved = loadDesktopPlayerSettings()
  desktopPlayerEnabled = desktopPlayerSaved.enabled
  desktopPlayerForm = desktopPlayerSaved.form
  desktopLyricsSettings = loadDesktopLyricsSettings()

  // 若上次退出时开启了桌面播放器，等主窗口起来后再显示小窗口，避免抢占启动焦点
  setTimeout(() => {
    if (desktopPlayerEnabled) createDesktopPlayerWindow()
    if (desktopLyricsSettings.enabled) createDesktopLyricsWindow()
  }, 1500)
  logStartupTiming('Creating main and splash windows')
  createWindow()
  setGlobalMediaKeysEnabled(mediaKeysEnabled)
  updateTaskbar() // Windows 任务栏缩略图按钮与进度条初始化（渲染进程就绪后推送状态会再刷新）

  // 全局高刷：若设置已开启，启动即应用（跟随所在显示器刷新率，最高 300Hz）
  applyHighRefreshRate()
  rebindHighRefreshRate()
  
  // 移除默认菜单栏
  if (mainWindow) {
    mainWindow.setMenu(null)
  }
  
  // 等待渲染进程加载完成后读取开发者模式设置
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      (() => {
        try {
          const saved = localStorage.getItem('developerMode');
          return saved !== null ? JSON.parse(saved) : false;
        } catch {
          return false;
        }
      })()
    `).then(enabled => {
      developerMode = enabled
      console.log(`🔧 [DevMode] 从设置中加载开发者模式 ${enabled ? '启用' : '禁用'}`)
    }).catch(() => {
      console.log('🔧 [DevMode] 无法读取开发者模式设置，使用默认值: 禁用')
    })
  })

  // 壁纸监控不再全局启动：由渲染端在「桌面模式 + 壁纸联动开启」时经 set-wallpaper-watcher 启停

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  Object.keys(mediaKeyAccelerators).forEach(accelerator => globalShortcut.unregister(accelerator))
  if (wallpaperWatcher) {
    clearInterval(wallpaperWatcher)
    wallpaperWatcher = null
  }
})


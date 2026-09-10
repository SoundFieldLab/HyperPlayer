const { contextBridge, ipcRenderer } = require('electron')

// 向渲染进程暴露经过限制的安全 API。
contextBridge.exposeInMainWorld('electronAPI', {
  // 打开外部链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // OOBE 完成 flag 文件（userData/.oobe-complete，独立于 localStorage 的双重保险）
  oobe: {
    getFlag: () => ipcRenderer.invoke('oobe:get-flag'),
    setFlag: () => ipcRenderer.invoke('oobe:set-flag'),
  },
})

contextBridge.exposeInMainWorld('electron', {
  // System controls
  system: {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximize: () => ipcRenderer.invoke('window-maximize'),
    close: () => ipcRenderer.invoke('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    onMaximizedChange: (callback) => {
      const listener = (_event, isMaximized) => callback(isMaximized)
      ipcRenderer.on('window-maximized', listener)
      return () => ipcRenderer.removeListener('window-maximized', listener)
    },
    setFullscreen: (fullscreen, kiosk = false) => ipcRenderer.invoke('window-set-fullscreen', fullscreen, kiosk),
    isFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),
    onFullscreenChange: (callback) => {
      const listener = (_event, isFullscreen) => callback(isFullscreen)
      ipcRenderer.on('window-fullscreen-change', listener)
      return () => ipcRenderer.removeListener('window-fullscreen-change', listener)
    },
    getLocation: () => ipcRenderer.invoke('get-system-location'),
    getGpuSettings: () => ipcRenderer.invoke('get-gpu-settings'),
    getHardwareAcceleration: () => ipcRenderer.invoke('get-hardware-acceleration'),
    setHardwareAcceleration: (enabled) => ipcRenderer.invoke('set-hardware-acceleration', enabled),
    setGpuPreference: (preference) => ipcRenderer.invoke('set-gpu-preference', preference),
    confirmGpuChange: () => ipcRenderer.invoke('confirm-gpu-change'),
    revertGpuChange: () => ipcRenderer.invoke('revert-gpu-change'),
  },

  // 全局高刷：查询显示器信息与刷新率，设置全局渲染帧率（hz=null 表示跟随显示器最高）
  display: {
    getInfo: () => ipcRenderer.invoke('display:get-info'),
    setHighRefresh: (enabled, hz) => ipcRenderer.invoke('display:set-high-refresh', enabled, hz),
  },

  // 桌面融合穿透：桌面模式空区域鼠标穿透到真实桌面，组件区保持可交互
  desktopFusion: {
    getState: () => ipcRenderer.invoke('desktop-fusion:get-state'),
    setEnabled: (enabled) => ipcRenderer.invoke('desktop-fusion:set-enabled', enabled),
    // 开启穿透的确认框在渲染端（FusionEnableConfirmModal），确认后仍走 set-enabled 重建
    setInteractive: (interactive) => ipcRenderer.send('desktop-fusion:set-interactive', interactive),
  },

  mediaKeys: {
    setEnabled: (enabled) => ipcRenderer.invoke('media-keys:set-enabled', enabled),
    onControl: (callback) => {
      const listener = (_event, action, payload) => callback(action, payload)
      ipcRenderer.on('global-media-key', listener)
      return () => ipcRenderer.removeListener('global-media-key', listener)
    },
  },

  // 系统音量（频响补偿 / 低音量提示）
  audio: {
    getSystemVolume: () => ipcRenderer.invoke('audio:get-system-volume'),
  },

  desktopWidgets: {
    getSystemStatus: () => ipcRenderer.invoke('desktop-widgets:get-system-status'),
    pickLauncherTarget: (kind) => ipcRenderer.invoke('desktop-widgets:pick-launcher-target', kind),
    openLauncherTarget: (target, kind) => ipcRenderer.invoke('desktop-widgets:open-launcher-target', target, kind),
  },
  
  // 壁纸相关
  wallpaper: {
    getCurrentWallpaper: () => ipcRenderer.invoke('get-current-wallpaper'),
    onWallpaperChange: (callback) => {
      const listener = (_event, wallpaper) => callback(wallpaper)
      ipcRenderer.on('wallpaper-changed', listener)
      return () => ipcRenderer.removeListener('wallpaper-changed', listener)
    },
    // 按需启停壁纸监控：仅桌面模式 + 联动开启时启用（避免非桌面模式持续查询拖慢性能）
    setWallpaperWatcherEnabled: (enabled) => ipcRenderer.invoke('set-wallpaper-watcher', Boolean(enabled)),
  },
  
  // 只读构建诊断（不暴露 EVS 输出、路径或凭据）
  diagnostics: {
    getVmpStatus: () => ipcRenderer.invoke('diagnostics:get-vmp-status'),
  },

  // 开发者模式
  developerMode: {
    set: (enabled) => ipcRenderer.invoke('set-developer-mode', enabled),
    get: () => ipcRenderer.invoke('get-developer-mode'),
  },


  
  
  // Audio download for rendering
  audioDownload: {
    selectLocalFile: () => ipcRenderer.invoke('audio-download:selectLocalFile'),
    prepare: (urlOrPath, trackKey) => 
      ipcRenderer.invoke('audio-download:prepare', urlOrPath, trackKey),
    peekCached: (trackKey) =>
      ipcRenderer.invoke('audio-download:peekCached', trackKey),
    getMediaUrl: (filePath) => ipcRenderer.invoke('audio-download:getMediaUrl', filePath),
    saveWav: (trackKey, wavArrayBuffer) => ipcRenderer.invoke('audio-download:saveWav', trackKey, wavArrayBuffer),
    cleanupOldFiles: () => ipcRenderer.invoke('audio-download:cleanup'),
    getStats: () => ipcRenderer.invoke('audio-download:get-stats'),
    clearCache: () => ipcRenderer.invoke('audio-download:clear-cache'),
  },

  // 应用更新：后台静默下载 + 退出即应用 + 更新日志/版本历史
  update: {
    downloadAndInstall: (urls, sha256) =>
      ipcRenderer.invoke('update:download-and-install', urls, sha256),
    downloadBackground: (payload) =>
      ipcRenderer.invoke('update:download-background', payload),
    applyPending: () => ipcRenderer.invoke('update:apply-pending'),
    restartForUpdate: () => ipcRenderer.invoke('update:restart-for-update'),
    getPending: () => ipcRenderer.invoke('update:get-pending'),
    consumeLastApplied: () => ipcRenderer.invoke('update:consume-last-applied'),
    onDownloadStatus: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('update:download-status', listener)
      return () => ipcRenderer.removeListener('update:download-status', listener)
    },
  },
  
  // 配置管理
  config: {
    getCachePath: () => ipcRenderer.invoke('config:get-cache-path'),
    setCachePath: (path) => ipcRenderer.invoke('config:set-cache-path', path),
    selectCachePath: () => ipcRenderer.invoke('config:select-cache-path'),
    resetCachePath: () => ipcRenderer.invoke('config:reset-cache-path'),
  },

  // 账号绑定的 QQ 音乐官方 Skills Key（由主进程使用系统安全存储加密）
  credentials: {
    getQQMusicSkillKey: () => ipcRenderer.invoke('credentials:get-qqmusic-skill-key'),
    setQQMusicSkillKey: (key) => ipcRenderer.invoke('credentials:set-qqmusic-skill-key', key),
    deleteQQMusicSkillKey: () => ipcRenderer.invoke('credentials:delete-qqmusic-skill-key'),
  },
  
  // QQ 音乐登录
  openQQLoginWindow: () => ipcRenderer.invoke('open-qq-login-window'),
  // Spotify OAuth 授权（Electron 弹窗；clientId 可选，自定义 Client ID）
  openSpotifyLogin: (clientId) => ipcRenderer.invoke('open-spotify-login', clientId),
  // HSE 开发者模式：把场景微调的「发布种子」写回仓库源文件（仅开发模式生效）
  writeHseSceneSeed: (content) => ipcRenderer.invoke('hse-write-scene-seed', content),
  // HSE 离线导出：渲染完成的 MP3 直写用户桌面（<歌曲名>-Modified.mp3）
  saveHseRenderedAudio: (data, fileName) => ipcRenderer.invoke('hse-save-rendered-audio', data, fileName),
  // OOBE 完成 flag 文件（userData/.oobe-complete，独立于 localStorage 的双重保险）
  oobe: {
    getFlag: () => ipcRenderer.invoke('oobe:get-flag'),
    setFlag: () => ipcRenderer.invoke('oobe:set-flag'),
  },
  // Spotify 授权完成后回调（主进程返回 token/用户名）
  onSpotifyAuthResult: (callback) => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('spotify-auth-result', listener)
    return () => ipcRenderer.removeListener('spotify-auth-result', listener)
  },

  // Apple Music 网页一键登录：内置窗口登录 Apple ID，自动抓取凭据
  appleLogin: () => ipcRenderer.invoke('apple-login'),
  // Apple Music 登出：关闭登录窗口并清除专用网页会话与落盘 Cookie
  appleLogout: () => ipcRenderer.invoke('apple-logout'),
  // 从 Apple 网页前端资源获取可用的 Developer Token（免密钥，约 70 天有效）
  appleFetchDevToken: () => ipcRenderer.invoke('apple-fetch-dev-token'),
  // amp-api 代理：渲染进程浏览器直连会被 CORS 拦截，改由主进程请求
  appleApi: (path, developerToken, mediaUserToken, method, body) =>
    ipcRenderer.invoke('apple-api', { path, developerToken, mediaUserToken, method, body }),
  // Apple Music 原生音源：webPlayback 取流（主进程 POST play.itunes.apple.com，无 CORS）
  applePlayback: (songId, developerToken, mediaUserToken) =>
    ipcRenderer.invoke('apple-playback', { songId, developerToken, mediaUserToken }),
  // Apple Music 电台直播取流（主进程优先 GET amp-api.music.apple.com/v1/play/assets，无 CORS）
  applePlayAssets: (query, developerToken, mediaUserToken) =>
    ipcRenderer.invoke('apple-play-assets', { query, developerToken, mediaUserToken }),
  // Apple HLS 清单获取（主进程 fetch 文本，白名单限制 Apple 域名）
  appleFetchUrl: (url) => ipcRenderer.invoke('apple-fetch-url', { url }),
  // Apple 账号信息（buy.itunes 接口，需登录窗口抓取的 itunes cookie）
  appleAccountInfo: (cookies) => ipcRenderer.invoke('apple-account-info', cookies),
  // Apple 个人资料页（解析 og:image 头像）
  appleFetchProfile: (profileUrl) => ipcRenderer.invoke('apple-fetch-profile', profileUrl),
  // Apple 账号页面（Apple ID / Apple Account，带全量会话 cookie 解析名字与头像）
  appleFetchAccount: (cookies) => ipcRenderer.invoke('apple-fetch-account', cookies),
  // Apple 播放面 bridge（WebView2 原生源）：主进程拉起 apple_bridge.py（幂等）
  spawnAppleBridge: () => ipcRenderer.invoke('apple-bridge:spawn'),
  // Apple 播放面 bridge：渲染端节能联动（离开 Apple 平台 5 分钟）主动关闭
  stopAppleBridge: () => ipcRenderer.invoke('apple-bridge:stop'),
  // 渲染进程日志转发到主进程控制台（后台窗口可见，便于排查）
  log: (message) => ipcRenderer.send('app-log', String(message)),

  // QQ 音乐官方 Skills Key 领取窗口（内置 Electron 窗口，登录后自动抓取 API Key）
  openQQSkillKeyWindow: () => ipcRenderer.invoke('open-qq-skill-key-window'),

  // 桌面播放器：主窗口侧桥接（状态上报 + 接收小窗口的控制指令 + 开关/形态设置）
  desktopPlayer: {
    setEnabled: (enabled) => ipcRenderer.invoke('desktop-player:set-enabled', enabled),
    setForm: (form) => ipcRenderer.invoke('desktop-player:set-form', form),
    getInitialState: () => ipcRenderer.invoke('desktop-player:get-state'),
    pushState: (partial) => ipcRenderer.send('desktop-player:state-update', partial),
    onControl: (callback) => {
      const listener = (_event, action, payload) => callback(action, payload)
      ipcRenderer.on('desktop-player:control', listener)
      return () => ipcRenderer.removeListener('desktop-player:control', listener)
    },
    onEnabledChanged: (callback) => {
      const listener = (_event, enabled) => callback(enabled)
      ipcRenderer.on('desktop-player:enabled-changed', listener)
      return () => ipcRenderer.removeListener('desktop-player:enabled-changed', listener)
    },
  },

  // 桌面歌词：独立透明置顶窗口的开关与外观设置。
  desktopLyrics: {
    setEnabled: (enabled) => ipcRenderer.invoke('desktop-lyrics:set-enabled', enabled),
    getSettings: () => ipcRenderer.invoke('desktop-lyrics:get-settings'),
    updateSettings: (partial) => ipcRenderer.invoke('desktop-lyrics:update-settings', partial),
    onEnabledChanged: (callback) => {
      const listener = (_event, enabled) => callback(enabled)
      ipcRenderer.on('desktop-lyrics:enabled-changed', listener)
      return () => ipcRenderer.removeListener('desktop-lyrics:enabled-changed', listener)
    },
  },



  // Razer Chroma：会话和网络访问收敛在主进程，渲染端只提交已校验的灯效帧。
  chroma: {
    activate: () => ipcRenderer.invoke('chroma:activate'),
    deactivate: () => ipcRenderer.invoke('chroma:deactivate'),
    getStatus: () => ipcRenderer.invoke('chroma:get-status'),
    refreshDevices: () => ipcRenderer.invoke('chroma:refresh-devices'),
    scanHardware: () => ipcRenderer.invoke('chroma:scan-hardware'),
    setDeviceEnabled: (device, enabled) => ipcRenderer.invoke('chroma:set-device-enabled', device, enabled),
    inspectAppList: () => ipcRenderer.invoke('chroma:inspect-app-list'),
    repairAppList: () => ipcRenderer.invoke('chroma:repair-app-list'),
    pushFrame: (frame) => ipcRenderer.send('chroma:frame', frame),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('chroma:status', listener)
      return () => ipcRenderer.removeListener('chroma:status', listener)
    },
  },

  signalrgb: {
    getStatus: () => ipcRenderer.invoke('signalrgb:get-status'),
    refresh: () => ipcRenderer.invoke('signalrgb:refresh'),
    installEffect: () => ipcRenderer.invoke('signalrgb:install-effect'),
    uninstallEffect: () => ipcRenderer.invoke('signalrgb:uninstall-effect'),
    applyEffect: () => ipcRenderer.invoke('signalrgb:apply-effect'),
    restoreEffect: () => ipcRenderer.invoke('signalrgb:restore-effect'),
    sendEvent: (value, options) => ipcRenderer.invoke('signalrgb:send-event', value, options),
    open: () => ipcRenderer.invoke('signalrgb:open-signalrgb'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('signalrgb:status', listener)
      return () => ipcRenderer.removeListener('signalrgb:status', listener)
    },
  },

  // 音频输出设备：enumerateDevices 的权限授权已在 main 侧完成，这里仅暴露工具接口
  audioOutput: {
    isSupported: () => ipcRenderer.invoke('audio-output:is-supported'),
  },

  // 任务栏迷你播控（贴任务栏带）：开关/位置/宽度设置（个性化页控制）
  taskbarWidget: {
    setEnabled: (enabled) => ipcRenderer.invoke('taskbar-widget:set-enabled', enabled),
    getSettings: () => ipcRenderer.invoke('taskbar-widget:get-settings'),
    updateSettings: (partial) => ipcRenderer.invoke('taskbar-widget:update-settings', partial),
  },
})




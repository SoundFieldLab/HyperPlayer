'use strict'

/**
 * IPC capability registry.
 *
 * Every `ipcMain.handle` registration goes through this module. Capability is
 * derived from the channel name, and unknown channels fail at startup instead
 * of silently becoming callable from every renderer.
 */

const PREFIX_CAPABILITIES = [
  ['desktop-lyrics:', 'desktopLyrics'],
  ['desktop-player:', 'desktopPlayer'],
  ['taskbar-widget:', 'taskbarWidget'],
  ['update:', 'update'],
  ['chroma:', 'privileged'],
  ['signalrgb:', 'privileged'],
]

const MAIN_ONLY_CHANNELS = new Set([
  'audio-download:cleanup',
  'audio-download:clear-cache',
  'audio-download:get-stats',
  'audio-download:getMediaUrl',
  'audio-download:peekCached',
  'audio-download:prepare',
  'audio-download:saveWav',
  'audio-download:selectLocalFile',
  'audio-output:is-supported',
  'audio:get-system-volume',
  'config:get-cache-path',
  'config:reset-cache-path',
  'config:select-cache-path',
  'config:set-cache-path',
  'confirm-gpu-change',
  'credentials:delete-qqmusic-skill-key',
  'credentials:get-qqmusic-skill-key',
  'credentials:set-qqmusic-skill-key',
  'desktop-fusion:get-state',
  'desktop-fusion:set-enabled',
  'desktop-widgets:get-system-status',
  'desktop-widgets:open-launcher-target',
  'desktop-widgets:pick-launcher-target',
  'display:get-info',
  'display:set-high-refresh',
  'get-current-wallpaper',
  'get-developer-mode',
  'get-gpu-settings',
  'get-hardware-acceleration',
  'get-system-location',
  'hse-head-tracking:start',
  'hse-head-tracking:state',
  'hse-head-tracking:stop',
  'hse-save-rendered-audio',
  'hse-write-scene-seed',
  'media-keys:set-enabled',
  'oobe:get-flag',
  'oobe:set-flag',
  'open-external',
  'open-qq-login-window',
  'open-qq-skill-key-window',
  'revert-gpu-change',
  'set-developer-mode',
  'set-gpu-preference',
  'set-hardware-acceleration',
  'set-wallpaper-watcher',
  'window-close',
  'window-is-fullscreen',
  'window-is-maximized',
  'window-maximize',
  'window-minimize',
  'window-set-fullscreen',
])

class IpcRegistryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'IpcRegistryError'
  }
}

function getIpcCapability(channel) {
  for (const [prefix, capability] of PREFIX_CAPABILITIES) {
    if (channel.startsWith(prefix)) return capability
  }
  return MAIN_ONLY_CHANNELS.has(channel) ? 'privileged' : null
}

function createIpcRegistry({ ipcMain, guard }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new IpcRegistryError('createIpcRegistry 需要 ipcMain.handle')
  }
  if (typeof guard !== 'function') {
    throw new IpcRegistryError('createIpcRegistry 需要 trusted IPC guard')
  }

  const registered = new Map()

  function handle(channel, handler) {
    if (typeof channel !== 'string' || !channel) {
      throw new IpcRegistryError('IPC channel 必须是非空字符串')
    }
    if (typeof handler !== 'function') {
      throw new IpcRegistryError(`IPC 处理器必须是函数: ${channel}`)
    }
    if (registered.has(channel)) {
      throw new IpcRegistryError(`IPC 处理器重复注册: ${channel}`)
    }
    const capability = getIpcCapability(channel)
    if (!capability) {
      throw new IpcRegistryError(`IPC 处理器未声明 capability: ${channel}`)
    }
    const wrapped = guard(capability, handler)
    ipcMain.handle(channel, wrapped)
    registered.set(channel, { capability, handler: wrapped })
    return wrapped
  }

  return {
    handle,
    removeHandler: (channel) => {
      registered.delete(channel)
      return ipcMain.removeHandler(channel)
    },
    getCapability: (channel) => registered.get(channel)?.capability ?? getIpcCapability(channel),
  }
}

module.exports = {
  createIpcRegistry,
  getIpcCapability,
  IpcRegistryError,
  MAIN_ONLY_CHANNELS,
}

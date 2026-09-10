/**
 * 播放设备控制弹窗：音频输出设备切换（简约模式底栏入口）。
 * 风格与设置弹窗统一：暗色毛玻璃 + motion 动效。
 */
import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, RefreshCw, Speaker } from 'lucide-react'
import {
  listAudioOutputDevices,
  refreshAudioOutputDevices as refreshDevicesService,
  applyOutputDevice,
  getStoredOutputDevice,
  getActiveAudioContext,
  getCachedAudioOutputDevices,
  type AudioOutputDevice,
  type StoredOutputDevice,
} from '../services/audioOutput'

interface PlaybackDeviceModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
}

export default function PlaybackDeviceModal({ show, onClose, playerTheme = 'dark' }: PlaybackDeviceModalProps) {
  const dark = playerTheme !== 'light'
  const textPrimary = dark ? 'text-white' : 'text-black/85'
  const textSecondary = dark ? 'text-white/55' : 'text-black/55'
  const textTertiary = dark ? 'text-white/35' : 'text-black/40'
  const borderColor = dark ? 'border-white/10' : 'border-black/10'
  const accentColor = '#8B5CF6'

  // ── 音频输出设备状态 ──
  // 启动时已后台预载一次，这里直接显示缓存（不闪不重新入场）
  const [audioOutputDevices, setAudioOutputDevices] = useState<AudioOutputDevice[]>(() => getCachedAudioOutputDevices())
  const [audioOutputSupported, setAudioOutputSupported] = useState(false)
  const [audioOutputBusy, setAudioOutputBusy] = useState(false)
  const [audioOutputStored, setAudioOutputStored] = useState<StoredOutputDevice | null>(() => getStoredOutputDevice())

  const refreshAudioOutputDevices = useCallback(async () => {
    setAudioOutputBusy(true)
    try {
      const next = await refreshDevicesService()
      setAudioOutputSupported(true)
      // 合并：保持已有顺序，按 deviceId 刷新已存在项的数据（默认标记跟随刷新），
      // 新增设备追加（触发进入动画），已消失的移除；完全无变化时保持原列表
      setAudioOutputDevices(prev => {
        const prevList = prev || []
        const nextIds = new Set(next.map(d => d.deviceId))
        const prevIds = new Set(prevList.map(d => d.deviceId))
        const added = next.some(d => !prevIds.has(d.deviceId))
        const removed = prevList.some(d => !nextIds.has(d.deviceId))
        if (!added && !removed) return prevList
        const merged = prevList
          .map(old => next.find(d => d.deviceId === old.deviceId) || null)
          .filter((d): d is AudioOutputDevice => d !== null)
        for (const device of next) {
          if (!prevIds.has(device.deviceId)) merged.push(device)
        }
        return merged
      })
    } catch {
      // 扫描失败：保留当前显示列表
    } finally {
      setAudioOutputBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!show) return
    let active = true
    // 打开弹窗：直接显示缓存；后台扫一次——有新增自动加入（带动画），无变化保持
    void listAudioOutputDevices().then(devices => { if (active) setAudioOutputDevices(devices) }).catch(() => undefined)
    void refreshAudioOutputDevices()
    return () => { active = false }
  }, [show, refreshAudioOutputDevices])

  const handleAudioOutputSelect = async (device: AudioOutputDevice) => {
    const context = getActiveAudioContext()
    const result = await applyOutputDevice(context, { deviceId: device.deviceId, label: device.label })
    setAudioOutputStored(getStoredOutputDevice())
    if (result.success) {
      const message = (result as { pending?: boolean }).pending
        ? `已选择「${device.label}」，播放时自动应用`
        : `音频输出已切换到：${device.label}`
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message, type: 'success' },
      }))
    } else {
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: result.error === 'setSinkId-unsupported' ? '当前环境不支持切换输出设备' : `切换输出设备失败：${result.error || '未知错误'}`, type: 'error' },
      }))
    }
  }

  const handleAudioOutputDefault = async () => {
    const context = getActiveAudioContext()
    const result = await applyOutputDevice(context, null)
    setAudioOutputStored(getStoredOutputDevice())
    if (result.success) {
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: '已恢复跟随系统默认输出', type: 'success' },
      }))
    }
  }

  const followingDefault = !audioOutputStored

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <motion.div
            initial={{ scale: 0.92, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.92, opacity: 0, y: 12 }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full max-w-lg rounded-3xl shadow-2xl border ${dark ? 'bg-[#14161d]/95 border-white/10' : 'bg-white/95 border-black/10'}`}
            style={{ backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' }}
          >
            {/* 头部 */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b" style={{ borderColor: dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)' }}>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl" style={{ backgroundColor: `${accentColor}22` }}>
                  <Speaker className="w-5 h-5" style={{ color: accentColor }} />
                </div>
                <div>
                  <h2 className={`text-lg font-bold ${textPrimary}`}>播放设备控制</h2>
                  <p className={`text-xs ${textTertiary}`}>音频输出设备</p>
                </div>
              </div>
              <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                <X className="w-5 h-5" style={{ color: dark ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.6)' }} />
              </button>
            </div>

            <div className="px-6 py-5 space-y-6 max-h-[70vh] overflow-y-auto">
              {/* ── 音频输出设备 ── */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className={`text-sm font-semibold ${textPrimary}`}>音频输出设备</h3>
                  <button type="button" onClick={() => void refreshAudioOutputDevices()} className={`text-xs ${textSecondary} hover:opacity-80 flex items-center gap-1.5`} title="刷新设备列表">
                    <RefreshCw className={`w-3 h-3 ${audioOutputBusy ? 'animate-spin' : ''}`} />
                    刷新
                  </button>
                </div>

                {!audioOutputSupported ? (
                  <p className={`text-xs leading-5 ${textTertiary}`}>当前环境不支持枚举输出设备（仅桌面端支持），音频将跟随系统默认输出。</p>
                ) : audioOutputDevices.length === 0 ? (
                  <p className={`text-xs leading-5 ${textTertiary}`}>未检测到音频输出设备，音频将跟随系统默认输出。</p>
                ) : (
                  <div className="space-y-1.5 pr-1">
                    <button
                      type="button"
                      onClick={() => void handleAudioOutputDefault()}
                      className="w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors"
                      style={{
                        borderColor: followingDefault ? `${accentColor}99` : borderColor === 'border-white/10' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                        background: followingDefault ? `${accentColor}12` : 'transparent',
                      }}
                    >
                      <div className="min-w-0">
                        <div className={`${textPrimary} text-sm font-medium`}>跟随系统默认</div>
                        <div className={`${textTertiary} text-xs mt-0.5`}>勾选仅显示当前系统默认设备，刷新后自动跟随</div>
                      </div>
                    </button>
                    <AnimatePresence initial={false}>
                      {audioOutputDevices.map((device) => {
                        // 跟随默认：默认设备行只显示右侧「使用中」勾（不高亮整行）；
                        // 选中具体设备：该行高亮 + 勾
                        const isStoredDevice = audioOutputStored?.deviceId === device.deviceId
                        const isDefaultDisplay = followingDefault && device.isDefault
                        const highlight = isStoredDevice
                        const showCheck = isStoredDevice || isDefaultDisplay
                        return (
                          <motion.button
                            key={device.deviceId}
                            layout
                            initial={{ opacity: 0, y: -8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
                            type="button"
                            onClick={() => void handleAudioOutputSelect(device)}
                            className="w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors"
                            style={{
                              borderColor: highlight ? `${accentColor}99` : borderColor === 'border-white/10' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                              background: highlight ? `${accentColor}12` : 'transparent',
                            }}
                          >
                            <div className="min-w-0">
                              <div className={`${textPrimary} text-sm font-medium break-words leading-snug`}>{device.label}</div>
                              <div className={`${textTertiary} text-xs mt-0.5`}>
                                {device.isDefault ? '系统默认设备' : '外接设备'}
                              </div>
                            </div>
                            {showCheck && <span className="shrink-0 text-xs" style={{ color: accentColor }}>使用中</span>}
                          </motion.button>
                        )
                      })}
                    </AnimatePresence>
                  </div>
                )}
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

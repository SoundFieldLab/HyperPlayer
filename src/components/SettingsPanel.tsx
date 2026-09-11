// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 设置镜像机制声明（后续维护者 / AI 协作必读）⚠️
//
// 本组件是【简约模式设置】= 整软件的"总设置"。HyperPlayer 共 4 个界面模式
// （简约 / 传统 / 探索 / 桌面，后续可能更多），其中【全局功能性设置】通过
//   services/globalSettingsRegistry.ts（设置注册表，同键同事件双向同步）
//   components/MirroredGlobalSettings.tsx（按各模式设计语言渲染的镜像 UI）
// 自动镜像到传统 / 探索 / 桌面三个模式的设置界面。
//
// 因此在本面板新增设置项时，先判断它属于哪一类：
// 1. 全局功能设置（播放 / 歌词 / 性能 / 桌面集成 / 网络等，对所有模式生效）：
//    ✅ 除了写本面板的简约 UI，【必须】同步在 services/globalSettingsRegistry.ts
//      登记一条（read/write 与本面板读写同一存储键、派发同一事件），
//      其他模式的设置页就会自动出现该功能，无需逐模式手写 UI；
//    ✅ 如需自定义控件（如字体选择器 FontPicker），在 MirroredGlobalSettings.tsx
//      里为注册表的 control.kind 增加对应渲染分支（classic / panel 两种风格）。
//    ❌ 只写本面板不登记 = 其他模式的用户永远看不到这个功能开关。
// 2. 简约模式专属的自定义 / 外观设置（只影响简约模式自身，如"自定义首页显示内容"）：
//    不需要登记，写在这里即可。
// ═══════════════════════════════════════════════════════════════════════════
import React, { memo, useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import { X, Settings as SettingsIcon, User, Palette, Sparkles, Info, ExternalLink, Github, ChevronRight, ChevronLeft, Trash2, Heart, Code2, Users, Headphones, Eye, EyeOff, Music, FolderHeart, Trash, ListMusic } from 'lucide-react'
import LoginButton from './LoginButton'
import type { AppleUserInfo } from '../services/appleAuth'
import {
  MUSIC_PLATFORMS,
  PLATFORM_LABELS,
  PLATFORM_VISIBILITY_EVENT,
  PLATFORM_ORDER_EVENT,
  getHiddenPlatforms,
  getPlatformOrder,
  setPlatformOrder,
  setPlatformHidden,
  type MusicPlatform,
} from '../services/platforms'
import HomeCustomizeModal from './HomeCustomizeModal'
import PlaybackRadialMenuCustomizeModal from './PlaybackRadialMenuCustomizeModal'
import AudioQualitySettingsModal from './AudioQualitySettingsModal'
import FontPicker from './FontPicker'
import CacheClearModal from './CacheClearModal'
import packageInfo from '../../package.json'
import { getVersionDisplay, getVersionLabel } from '../services/versionInfo'
import {
  compareVersions,
  fetchUpdateManifest,
  withDownloadProxies,
  readUpdateChannel,
  writeUpdateChannel,
  UPDATE_CHANNEL_LABEL,
  UPDATE_CHANNEL_KEY,
  type UpdateChannel,
} from '../services/updateConstants'
import { VERSION_HISTORY } from '../services/versionHistory'
import { isTvModeActive } from '../platform'
import {
  loadPlaybackShortcutSettings,
  savePlaybackShortcutSettings,
  type PlaybackShortcutSettings,
} from '../services/playbackShortcutSettings'
import type { DesktopLyricsColorMode, DesktopLyricsSettings, TaskbarWidgetSettings } from '../electron'
import { parseStoredBoolean } from '../utils/storage'
import {
  AUDIO_QUALITY_SETTINGS_EVENT,
  loadAudioQualitySettings,
  type AudioQualityPreference,
} from '../services/audioQualitySettings'
import { getPlaybackRadialActions } from '../services/playbackRadialMenuSettings'
import {
  getAppleMusicSettings,
  type AppleMusicSettings,
} from '../services/appleMusic'
import { isAppleDynamicCoverEnabled, setAppleDynamicCoverEnabled } from '../services/appleDynamicCover'
import { checkBridgeRunning, ensureBridgeRunning, bridgeShowWindow, bridgeHideWindow, getState as getAppleBridgeState } from '../services/appleWebViewBridge'
import BilibiliLoginPanel from './BilibiliLoginPanel'
import BilibiliProfileModal from './BilibiliProfileModal'
import VmpStatusCard from './VmpStatusCard'
import LegalAgreement from './legal/LegalAgreement'
import {
  isBilibiliLoggedIn,
  getStoredBilibiliUser,
  getBilibiliRemainingDays,
  clearBilibiliLocal,
  clearBilibiliLoginExpiry,
  logoutBilibiliServer,
  resolveBiliPic,
  getLocalMvMarks,
  removeLocalMvMark,
  clearAllMvMatchCache,
} from '../services/bilibiliApi'

type UpdateCheckState = {
  status: 'idle' | 'checking' | 'current' | 'available' | 'error'
  message?: string
}
/** 检查到的更新详情（查看详情/下载弹窗由全局 UpdateManager 承接） */
type UpdateDetail = {
  version: string
  notes: string
  /** 来源渠道（正式版 / 每日构建），供弹窗标注 */
  channel?: UpdateChannel
  hotUrls?: string[]
  hotSha?: string
  installUrls?: string[]
  installSha?: string
}
type DeviceGrant = { feature: string; label: string; issuedAt: number; expiresAt: number | null; note?: string }
type DeviceState = { status: 'idle' | 'loading' | 'ready' | 'error'; deviceId: string; storage?: 'registry' | 'file'; grants: DeviceGrant[]; message?: string }

const audioQualityLabel = (quality: AudioQualityPreference | 'aac' | 'hi-res-lossless' | 'atmos') => ({
  auto: '自动最高',
  standard: '标准',
  high: '高品质',
  'very-high': '超高品质',
  lossless: '无损',
  'hi-res': 'Hi-Res',
  aac: 'AAC',
  'hi-res-lossless': '高解析无损',
  atmos: '空间音频',
}[quality])

const appLogoUrl = new URL('../../logo.png', import.meta.url).href

interface SettingsPanelProps {
  show: boolean
  onClose: () => void
  // 远程遥控器已随减配移除；保留可选 prop 仅为兼容 App 侧既有调用签名
  onOpenRemote?: () => void
  // 登录状态
  neteaseLoggedIn: boolean
  neteaseUsername: string
  onNeteaseLogin: (cookie: string) => void
  onNeteaseLogout: () => void
  qqLoggedIn: boolean
  qqUsername: string
  neteaseVip: boolean
  qqVip: boolean
  onQQLogin: (cookie: string) => void
  onQQLogout: () => void
  appleLoggedIn: boolean
  appleUsername: string
  onAppleLogin: (user: AppleUserInfo | null) => void
  onAppleLogout: () => void
  // 新三平台登录态
  spotifyLoggedIn: boolean
  spotifyUsername: string
  onSpotifyLogin: (cookie: string, username?: string) => void
  onSpotifyLogout: () => void
  playerTheme?: 'light' | 'dark'
}

function SettingsPanel({
  show,
  onClose,
  onOpenRemote,
  neteaseLoggedIn,
  neteaseUsername,
  onNeteaseLogin,
  onNeteaseLogout,
  qqLoggedIn,
  qqUsername,
  neteaseVip,
  qqVip,
  onQQLogin,
  onQQLogout,
  appleLoggedIn,
  appleUsername,
  onAppleLogin,
  onAppleLogout,
  spotifyLoggedIn,
  spotifyUsername,
  onSpotifyLogin,
  onSpotifyLogout,
  playerTheme = 'dark',
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<'account' | 'advanced' | 'personalization' | 'about'>('account')
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const switchTab = (tab: 'account' | 'advanced' | 'personalization' | 'about') => {
    setActiveTab(tab)
    requestAnimationFrame(() => contentScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' }))
  }
  
  // 根据主题生成颜色类名
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  const hoverBg = playerTheme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'

  // 隐藏平台（账号区块）：默认全部显示，用户可隐藏不常用的平台
  const [hiddenPlatforms, setHiddenPlatforms] = useState<MusicPlatform[]>(() => getHiddenPlatforms())
  useEffect(() => {
    const sync = () => setHiddenPlatforms(getHiddenPlatforms())
    window.addEventListener(PLATFORM_VISIBILITY_EVENT, sync)
    return () => window.removeEventListener(PLATFORM_VISIBILITY_EVENT, sync)
  }, [])

  // 平台卡片右上角小眼睛：切换隐藏当前平台（至少保留一个，隐藏第三个时 toast 提示）
  const togglePlatformVisibility = (platform: MusicPlatform, currentlyVisible: boolean) => {
    if (currentlyVisible) {
      // 隐藏：若当前可见平台只有这一个，则不允许（toast 提示）
      const visibleCount = MUSIC_PLATFORMS.filter(p => !hiddenPlatforms.includes(p)).length
      if (visibleCount <= 1) {
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: '您至少需要保留一个平台以正常使用本软件', type: 'info' }
        }))
        return
      }
      setPlatformHidden(platform, true)
    } else {
      setPlatformHidden(platform, false)
    }
  }

  // 平台排序（设置-账号：用户自定义顺序，三模式继承）
  const [platformOrder, setPlatformOrderState] = useState<MusicPlatform[]>(() => getPlatformOrder())
  useEffect(() => {
    const sync = () => setPlatformOrderState(getPlatformOrder())
    window.addEventListener(PLATFORM_ORDER_EVENT, sync)
    return () => window.removeEventListener(PLATFORM_ORDER_EVENT, sync)
  }, [])
  
  const [wordByWordLyrics, setWordByWordLyrics] = useState(() => {
    const saved = localStorage.getItem('wordByWordLyrics')
    return parseStoredBoolean(saved, true)
  })
  const [upNextEnabled, setUpNextEnabled] = useState(() => {
    const saved = localStorage.getItem('upNextEnabled')
    return parseStoredBoolean(saved, true)
  })
  const [showUpNextOutsidePlayer, setShowUpNextOutsidePlayer] = useState(() => {
    const saved = localStorage.getItem('showUpNextOutsidePlayer')
    return parseStoredBoolean(saved, false)
  })
  
  const [upNextSeconds, setUpNextSeconds] = useState(() => {
    const saved = localStorage.getItem('upNextSeconds')
    return saved !== null ? parseInt(saved) : 10
  })
  
  const [translationEnabled, setTranslationEnabled] = useState(() => {
    const saved = localStorage.getItem('translationEnabled')
    return parseStoredBoolean(saved, false)
  })
  const [translationPosition, setTranslationPosition] = useState<'traditional' | 'bottom-right'>(() => {
    const saved = localStorage.getItem('translationPosition')
    return (saved as 'traditional' | 'bottom-right') || 'traditional'
  })
  
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6' // 默认蓝色
  })
  const [showLocalMvMarks, setShowLocalMvMarks] = useState(false)
  const [localMvMarks, setLocalMvMarks] = useState<ReturnType<typeof getLocalMvMarks>>([])
  const [playbackShortcutSettings, setPlaybackShortcutSettings] = useState(loadPlaybackShortcutSettings)
  
  // 第三方歌词源设置
  const [thirdPartyLyricsEnabled, setThirdPartyLyricsEnabled] = useState(() => {
    const saved = localStorage.getItem('thirdPartyLyricsEnabled')
    return parseStoredBoolean(saved, true)
  })
  
  const [adaptiveLyrics, setAdaptiveLyrics] = useState(() => {
    const saved = localStorage.getItem('adaptiveLyrics')
    return parseStoredBoolean(saved, true)
  })
  
  const [primaryLyricsSource, setPrimaryLyricsSource] = useState<string>(() => {
    const saved = localStorage.getItem('primaryLyricsSource')
    return saved || 'AMLL'
  })

  // ── Apple Music 设置 ──
  const [appleMusic, setAppleMusic] = useState<AppleMusicSettings>(() => getAppleMusicSettings())
  // Apple 原生音源开关（Cider 式直连；默认开，localStorage 独立存储）
  const [appleNativeStreamEnabled, setAppleNativeStreamEnabled] = useState(() => localStorage.getItem('appleNativeStream') !== 'false')
  const [appleDynamicCoverEnabled, setAppleDynamicCoverEnabledState] = useState(isAppleDynamicCoverEnabled)

  // Apple Music 播放面（WebView2 bridge）状态与窗口开关
  const [appleBridgeWindowVisible, setAppleBridgeWindowVisible] = useState(false)
  const [appleBridgeBusy, setAppleBridgeBusy] = useState(false)
  const [appleBridgeReady, setAppleBridgeReady] = useState(false)
  const [appleBridgeAuthorized, setAppleBridgeAuthorized] = useState(false)
  useEffect(() => {
    let disposed = false
    checkBridgeRunning().then((ok) => {
      if (disposed) return
      setAppleBridgeReady(ok)
      if (ok) setAppleBridgeAuthorized(getAppleBridgeState().authorized)
    })
    return () => { disposed = true }
  }, [])
  const toggleAppleBridgeWindow = async () => {
    if (appleBridgeWindowVisible) {
      await bridgeHideWindow()
      setAppleBridgeWindowVisible(false)
      return
    }
    setAppleBridgeBusy(true)
    try {
      // 未运行时先拉起（可能等待 WebView2 冷启动），再显示窗口供登录
      const ok = await ensureBridgeRunning()
      if (ok) await bridgeShowWindow()
      setAppleBridgeReady(ok)
      setAppleBridgeAuthorized(ok && getAppleBridgeState().authorized)
      setAppleBridgeWindowVisible(ok)
    } finally {
      setAppleBridgeBusy(false)
    }
  }

  // ── 哔哩哔哩「看歌」账号 ──
  const [biliLoggedIn, setBiliLoggedIn] = useState(() => isBilibiliLoggedIn())
  const [biliUser, setBiliUser] = useState(() => getStoredBilibiliUser())
  const [biliRemainingDays, setBiliRemainingDays] = useState(() => getBilibiliRemainingDays())
  const [showBiliLogin, setShowBiliLogin] = useState(false)
  const [showBiliProfile, setShowBiliProfile] = useState(false)

  const refreshBiliAuth = () => {
    setBiliLoggedIn(isBilibiliLoggedIn())
    setBiliUser(getStoredBilibiliUser())
    setBiliRemainingDays(getBilibiliRemainingDays())
  }

  const handleBiliLogout = () => {
    clearBilibiliLocal()
    clearBilibiliLoginExpiry()
    void logoutBilibiliServer().catch(() => undefined)
    refreshBiliAuth()
    window.dispatchEvent(new CustomEvent('bilibili-auth-changed', { detail: { loggedIn: false } }))
  }

  useEffect(() => {
    const onBiliAuthChanged = () => refreshBiliAuth()
    window.addEventListener('bilibili-auth-changed', onBiliAuthChanged as EventListener)
    return () => window.removeEventListener('bilibili-auth-changed', onBiliAuthChanged as EventListener)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateAppleMusic = (patch: Partial<AppleMusicSettings>) => {
    const next = { ...appleMusic, ...patch }
    setAppleMusic(next)
    localStorage.setItem('appleMusicEnabled', JSON.stringify(next.enabled))
    localStorage.setItem('appleDeveloperToken', next.developerToken)
    localStorage.setItem('appleMediaUserToken', next.mediaUserToken)
    localStorage.setItem('appleStorefront', next.storefront)
    localStorage.setItem('appleLyricLang', next.lyricLang)
    localStorage.setItem('applePreferCover', JSON.stringify(next.preferAppleCover))
    localStorage.setItem('appleDuetColors', JSON.stringify(next.duetColors))
    if (next.enabled !== appleMusic.enabled || next.lyricLang !== appleMusic.lyricLang || next.storefront !== appleMusic.storefront) {
      window.dispatchEvent(new Event('hyperplayer:lyrics-policy-changed'))
    }
  }

  // 登录 Apple Music 后自动开启 Apple Music 歌词
  useEffect(() => {
    if (appleLoggedIn && !appleMusic.enabled) {
      updateAppleMusic({ enabled: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appleLoggedIn])

  const [crossPlatformFallbackEnabled, setCrossPlatformFallbackEnabled] = useState(() => {
    const saved = localStorage.getItem('crossPlatformFallbackEnabled')
    return parseStoredBoolean(saved, false)
  })
  const [hideHomeAccountId, setHideHomeAccountId] = useState(() => (
    parseStoredBoolean(localStorage.getItem('hideHomeAccountId'), false)
  ))

  const handleHideHomeAccountIdChange = () => {
    const nextValue = !hideHomeAccountId
    setHideHomeAccountId(nextValue)
    localStorage.setItem('hideHomeAccountId', String(nextValue))
    window.dispatchEvent(new CustomEvent('privacy-settings-changed', {
      detail: { hideHomeAccountId: nextValue },
    }))
  }
  
  // 首页自定义弹窗状态
  const [showHomeCustomize, setShowHomeCustomize] = useState(false)
  const [showPlaybackRadialCustomize, setShowPlaybackRadialCustomize] = useState(false)
  const [playbackRadialActionCount, setPlaybackRadialActionCount] = useState(() => getPlaybackRadialActions().length)
  const [showAudioQuality, setShowAudioQuality] = useState(false)
  const [audioQualitySettings, setAudioQualitySettings] = useState(loadAudioQualitySettings)

  useEffect(() => {
    const handleAudioQualityChange = () => setAudioQualitySettings(loadAudioQualitySettings())
    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, handleAudioQualityChange)
    return () => window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, handleAudioQualityChange)
  }, [])

  useEffect(() => {
    const sync = () => setPlaybackRadialActionCount(getPlaybackRadialActions().length)
    window.addEventListener('hyperplayer-playback-radial-menu-settings-changed', sync)
    return () => window.removeEventListener('hyperplayer-playback-radial-menu-settings-changed', sync)
  }, [])

  // 桌面播放器（独立置顶小窗口）设置
  const [desktopPlayerEnabled, setDesktopPlayerEnabled] = useState(false)
  const [desktopPlayerForm, setDesktopPlayerForm] = useState<'card' | 'bar'>('card')
  const [desktopLyricsSettings, setDesktopLyricsSettings] = useState<DesktopLyricsSettings>({
    enabled: false,
    fontSize: 58,
    fontFamily: '',
    colorMode: 'auto',
    orientation: 'horizontal',
    doubleLine: false,
    translationEnabled: false,
    romajiEnabled: false,
    traditionalEnabled: false,
    locked: false,
  })

  useEffect(() => {
    const hasBridge = typeof (window as any).electron?.desktopPlayer?.getInitialState === 'function'
    if (!hasBridge) return
    ;(window as any).electron.desktopPlayer
      .getInitialState()
      .then((snapshot: any) => {
        setDesktopPlayerEnabled(Boolean(snapshot?.enabled))
        setDesktopPlayerForm(snapshot?.form === 'bar' ? 'bar' : 'card')
      })
      .catch(() => undefined)
  }, [])

  // 小窗口点 X 关闭后同步开关状态
  useEffect(() => {
    const syncEnabled = (event: Event) => {
      setDesktopPlayerEnabled(Boolean((event as CustomEvent<boolean>).detail))
    }
    window.addEventListener('desktopPlayerEnabledChanged', syncEnabled)
    return () => window.removeEventListener('desktopPlayerEnabledChanged', syncEnabled)
  }, [])

  const handleDesktopPlayerToggle = async (enabled: boolean) => {
    const hasBridge = typeof (window as any).electron?.desktopPlayer?.setEnabled === 'function'
    setDesktopPlayerEnabled(enabled)
    if (!hasBridge) return
    try {
      const result = await (window as any).electron.desktopPlayer.setEnabled(enabled)
      setDesktopPlayerEnabled(Boolean(result?.enabled ?? enabled))
    } catch {
      setDesktopPlayerEnabled(false)
    }
  }

  const handleDesktopPlayerFormChange = async (form: 'card' | 'bar') => {
    const hasBridge = typeof (window as any).electron?.desktopPlayer?.setForm === 'function'
    setDesktopPlayerForm(form)
    if (!hasBridge) return
    try {
      const result = await (window as any).electron.desktopPlayer.setForm(form)
      setDesktopPlayerForm(result?.form === 'bar' ? 'bar' : 'card')
    } catch {
      // 保留当前选择
    }
  }

  // 任务栏迷你播控（贴任务栏带）设置
  const [taskbarWidgetEnabledState, setTaskbarWidgetEnabledState] = useState(false)
  const [taskbarWidgetSettings, setTaskbarWidgetSettings] = useState<TaskbarWidgetSettings>({
    enabled: false,
    position: 'right',
    width: 340,
    mode: 'normal',
    darken: false,
    darkenLevel: 0.5,
    hideControls: false,
  })

  useEffect(() => {
    const api = window.electron?.taskbarWidget
    if (!api) return
    void api.getSettings().then((settings) => {
      setTaskbarWidgetSettings(settings)
      setTaskbarWidgetEnabledState(settings.enabled)
    }).catch(() => undefined)
  }, [])

  const handleTaskbarWidgetToggle = async (enabled: boolean) => {
    setTaskbarWidgetEnabledState(enabled)
    setTaskbarWidgetSettings(previous => ({ ...previous, enabled }))
    const api = window.electron?.taskbarWidget
    if (!api) return
    try {
      const result = await api.setEnabled(enabled)
      if (result?.success) setTaskbarWidgetEnabledState(Boolean(result.enabled))
    } catch {
      setTaskbarWidgetEnabledState(false)
      setTaskbarWidgetSettings(previous => ({ ...previous, enabled: false }))
    }
  }

  const handleTaskbarWidgetUpdate = async (partial: Partial<TaskbarWidgetSettings>) => {
    setTaskbarWidgetSettings(previous => ({ ...previous, ...partial }))
    const api = window.electron?.taskbarWidget
    if (!api) return
    try {
      const result = await api.updateSettings(partial)
      setTaskbarWidgetSettings(result)
    } catch {
      // 保留当前选择
    }
  }

  useEffect(() => {
    const api = window.electron?.desktopLyrics
    if (!api) return
    void api.getSettings().then(setDesktopLyricsSettings).catch(() => undefined)
    const syncEnabled = (event: Event) => {
      setDesktopLyricsSettings(previous => ({
        ...previous,
        enabled: Boolean((event as CustomEvent<boolean>).detail),
      }))
    }
    window.addEventListener('desktopLyricsEnabledChanged', syncEnabled)
    return () => window.removeEventListener('desktopLyricsEnabledChanged', syncEnabled)
  }, [])

  const handleDesktopLyricsToggle = async (enabled: boolean) => {
    setDesktopLyricsSettings(previous => ({ ...previous, enabled }))
    try {
      const result = await window.electron?.desktopLyrics?.setEnabled(enabled)
      if (result) setDesktopLyricsSettings(previous => ({ ...previous, enabled: result.enabled }))
    } catch {
      setDesktopLyricsSettings(previous => ({ ...previous, enabled: false }))
    }
  }

  const updateDesktopLyrics = async (partial: Partial<DesktopLyricsSettings>) => {
    setDesktopLyricsSettings(previous => ({ ...previous, ...partial }))
    try {
      const result = await window.electron?.desktopLyrics?.updateSettings(partial)
      if (result) setDesktopLyricsSettings(result)
    } catch {
      // Electron 桥接不可用时保留界面预览值。
    }
  }
  
  // 缓存清理弹窗状态
  const [showCacheClear, setShowCacheClear] = useState(false)

  const [updateCheck, setUpdateCheck] = useState<UpdateCheckState>({ status: 'idle' })
  const [updateDetail, setUpdateDetail] = useState<UpdateDetail | null>(null)
  const [pendingUpdate, setPendingUpdate] = useState<{ version: string; stagedAt?: number } | null>(null)
  const [showVersionHistory, setShowVersionHistory] = useState(false)
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(() => parseStoredBoolean(localStorage.getItem('autoCheckUpdate'), true))
  const [skippedVersion, setSkippedVersion] = useState<string | null>(() => localStorage.getItem('skippedUpdateVersion'))
  // 更新渠道（正式版 / 每日构建）——与设置注册表同 localStorage 键，双端同步
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>(() => readUpdateChannel())

  // 待应用更新常驻提示（上次「稍后」/ 已下载完成的更新，重启即生效）
  useEffect(() => {
    void window.electron?.update?.getPending?.().then((p) => {
      if (p?.version) setPendingUpdate(p)
    }).catch(() => {})
  }, [])

  // 更新渠道可能被其他模式（设置镜像）改动：监听注册表事件保持同步
  useEffect(() => {
    const sync = () => setUpdateChannel(readUpdateChannel())
    window.addEventListener('hyperplayer:global-setting-changed', sync)
    window.addEventListener('hyperplayer:update-channel-changed', sync)
    return () => {
      window.removeEventListener('hyperplayer:global-setting-changed', sync)
      window.removeEventListener('hyperplayer:update-channel-changed', sync)
    }
  }, [])

  // 灰色歌曲跨平台补全：开启前必须阅读免责声明并等待倒计时结束
  const [showFallbackDisclaimer, setShowFallbackDisclaimer] = useState(false)
  const [fallbackCountdown, setFallbackCountdown] = useState(20)
  // 法律声明 / 用户协议弹窗（关于页入口；条款为简体中文单语）
  const [showLegalModal, setShowLegalModal] = useState(false)

  useEffect(() => {
    if (!showFallbackDisclaimer || fallbackCountdown <= 0) return
    const timer = window.setTimeout(() => setFallbackCountdown(value => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [showFallbackDisclaimer, fallbackCountdown])

  const confirmFallbackEnable = () => {
    setCrossPlatformFallbackEnabled(true)
    localStorage.setItem('crossPlatformFallbackEnabled', JSON.stringify(true))
    setShowFallbackDisclaimer(false)
    window.dispatchEvent(new CustomEvent('showToast', {
      detail: { message: '已开启灰色歌曲跨平台补全', type: 'success' },
    }))
  }

  /** 打开外部链接：TV 走原生浏览器（ACTION_VIEW），桌面/网页用 window.open */
  const openExternal = (url: string) => {
    const native = (window as any).HyperPlayerNative
    if (native?.openExternal) {
      native.openExternal(url)
      return
    }
    window.open(url, '_blank')
  }

  const checkForUpdates = async () => {
    setUpdateCheck({ status: 'checking', message: '正在检查…' })
    try {
      // Android（TV/平板）：交给原生更新器——它知道本机 versionCode 且能下载安装
      const nativeBridge = (window as any).HyperPlayerNative
      if (nativeBridge?.checkForUpdates) {
        nativeBridge.checkForUpdates()
        setUpdateCheck({ status: 'current', message: '已开始检查，如有新版本将弹出提示' })
        return
      }

      // 桌面/网页：按当前渠道拉更新清单（ghproxy 加速的 GitHub → GitHub 直连），比较版本号
      // fetchUpdateManifest 内部已按 readUpdateChannel() 选择 update.json / update-nightly.json
      let httpStatus = 0
      const manifest = await (async () => {
        const { getManifestUrls } = await import('../services/updateConstants')
        for (const url of getManifestUrls(updateChannel)) {
          try {
            const res = await fetch(url, { cache: 'no-store' })
            if (res.ok) return await res.json() as { version?: string; notes?: string; artifacts?: Record<string, { urls?: string[]; sha256?: string }> }
            httpStatus = res.status // 404 等：清单大概率还没发布
          } catch {
            // 网络异常，继续尝试下一个源
          }
        }
        return null
      })()
      if (!manifest?.version) {
        // 区分「未发布」与「网络问题」，方便用户判断
        const channelHint = updateChannel === 'nightly' ? '该渠道尚无构建' : '请确认已发布更新'
        throw new Error(httpStatus ? `更新清单不可用（HTTP ${httpStatus}），${channelHint}` : '更新清单不可用，请检查网络')
      }

      const remoteVersion = String(manifest.version)
      if (compareVersions(remoteVersion, packageInfo.version) <= 0) {
        setUpdateCheck({ status: 'current', message: `当前版本 ${packageInfo.version} 为最新版本（${UPDATE_CHANNEL_LABEL[updateChannel]}）` })
        return
      }

      const winArtifact = manifest.artifacts?.['win-x64']
      const hotArtifact = manifest.artifacts?.['win-x64-hot']
      const winUrl = winArtifact?.urls?.[0]
      const hotUrl = hotArtifact?.urls?.[0]
      const detail: UpdateDetail = {
        version: remoteVersion,
        notes: manifest.notes || '',
        channel: updateChannel,
        hotUrls: hotUrl ? withDownloadProxies(hotUrl) : undefined,
        hotSha: hotArtifact?.sha256 || '',
        installUrls: winUrl ? withDownloadProxies(winUrl) : undefined,
        installSha: winArtifact?.sha256 || '',
      }
      setUpdateDetail(detail)
      setUpdateCheck({ status: 'available', message: `当前版本：${packageInfo.version}  新版本：${getVersionDisplay(remoteVersion)}` })
      // 详情/下载/就绪/重启弹窗由全局 UpdateManager 承接（应用内美化弹窗）
      window.dispatchEvent(new CustomEvent('hyperplayer:update-open-details', { detail }))
    } catch (error) {
      setUpdateCheck({ status: 'error', message: `检查失败：${error instanceof Error ? error.message : '网络不可用'}` })
    }
  }

  const openUpdateDetails = () => {
    if (updateDetail?.version) {
      window.dispatchEvent(new CustomEvent('hyperplayer:update-open-details', { detail: updateDetail }))
    }
  }

  // 待更新已就绪：拉起 updater 并立即退出重启（重启后即为新版本）
  const handleRestartForUpdate = async () => {
    await window.electron?.update?.applyPending?.()
    await window.electron?.update?.restartForUpdate?.()
  }

  // 跳过此版本：把当前渠道最新版本记入跳过列表，自动检测不再提示；手动检查仍可更新
  const handleSkipVersion = async () => {
    try {
      const manifest = await fetchUpdateManifest(updateChannel)
      const remote = manifest?.version
      if (!remote) {
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '当前无法获取更新清单，请稍后再试', type: 'info' } }))
        return
      }
      if (compareVersions(remote, packageInfo.version) <= 0) {
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '当前已是最新版本，无需跳过', type: 'info' } }))
        return
      }
      localStorage.setItem('skippedUpdateVersion', remote)
      setSkippedVersion(remote)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已跳过版本 ${getVersionDisplay(remote)} 的更新提示，仍可手动检查更新`, type: 'success' } }))
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '跳过失败，请检查网络', type: 'error' } }))
    }
  }

  const handleUnskipVersion = () => {
    localStorage.removeItem('skippedUpdateVersion')
    setSkippedVersion(null)
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已恢复该版本的更新提示', type: 'success' } }))
  }
  
  const [gpuAcceleration, setGpuAcceleration] = useState(() => {
    const saved = localStorage.getItem('gpuAcceleration')
    return parseStoredBoolean(saved, true)
  })
  const [gpuStatus, setGpuStatus] = useState<{
    actualEnabled: boolean
    featureStatus: Record<string, string>
    gpu: { deviceString?: string; vendorString?: string; driverVersion?: string } | null
    gpus: Array<{ deviceString: string; vendorString: string; active: boolean; kind: 'discrete' | 'integrated' | 'unknown' }>
  } | null>(null)
  const [gpuPreference, setGpuPreference] = useState<'auto' | 'discrete' | 'integrated'>('auto')

  // 全局高刷：显示器信息 + 开关 + 可选档位（null = 跟随显示器最高）
  const [highRefreshEnabled, setHighRefreshEnabled] = useState(false)
  const [highRefreshHz, setHighRefreshHz] = useState<number | null>(null)
  const [displayInfo, setDisplayInfo] = useState<{
    highRefreshEnabled: boolean
    highRefreshHz: number | null
    currentHz: number
    primary: number
    mainWindowDisplayId: number
    error?: string
    displays?: Array<{ id: number; isPrimary: boolean; isMainWindow: boolean; bounds: { x: number; y: number; width: number; height: number }; workArea: { x: number; y: number; width: number; height: number }; frequency: number; scaleFactor: number; label: string }>
  } | null>(null)
  const HIGH_REFRESH_OPTIONS = [30, 60, 120, 144, 200, 240, 300, 360]

  const refreshDisplayInfo = useCallback(() => {
    void window.electron?.display?.getInfo().then(info => {
      if (!info) return
      setHighRefreshEnabled(Boolean(info.highRefreshEnabled))
      setHighRefreshHz(info.highRefreshHz ?? null)
      setDisplayInfo(info)
    }).catch(error => console.warn('读取显示器信息失败:', error))
  }, [])

  useEffect(() => { refreshDisplayInfo() }, [refreshDisplayInfo])

  const handleHighRefreshToggle = async (enabled: boolean) => {
    setHighRefreshEnabled(enabled)
    try {
      // 开启时默认跟随显示器最高（null）；用户后续可在档位里改
      const result = await window.electron?.display.setHighRefresh(enabled, enabled ? highRefreshHz : null)
      if (result) setHighRefreshEnabled(result.enabled)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: enabled ? `全局高刷已开启（${result?.hz || '跟随显示器'}Hz）` : '已关闭全局高刷', type: 'info' } }))
      refreshDisplayInfo()
    } catch (error) {
      setHighRefreshEnabled(!enabled)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '切换全局高刷失败，请重试', type: 'error' } }))
    }
  }

  const handleHighRefreshHzChange = async (hz: number | null) => {
    setHighRefreshHz(hz)
    if (!highRefreshEnabled) return
    try {
      const result = await window.electron?.display.setHighRefresh(true, hz)
      if (result) window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已切换为 ${hz || '跟随显示器最高'}Hz`, type: 'info' } }))
      refreshDisplayInfo()
    } catch (error) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '切换刷新率失败，请重试', type: 'error' } }))
    }
  }

  useEffect(() => {
    let cancelled = false
    void window.electron?.system.getHardwareAcceleration().then(result => {
      if (cancelled) return
      setGpuAcceleration(result.enabled)
      setGpuPreference(result.gpuPreference || 'discrete')
      setGpuStatus({
        actualEnabled: result.actualEnabled,
        featureStatus: result.featureStatus,
        gpu: result.gpu,
        gpus: result.gpus || [],
      })
      localStorage.setItem('gpuAcceleration', JSON.stringify(result.enabled))
    }).catch(error => console.warn('读取硬件加速设置失败:', error))
    return () => { cancelled = true }
  }, [])

  const [audioAnalyzerEnabled, setAudioAnalyzerEnabled] = useState(() => {
    const saved = localStorage.getItem('audioAnalyzerEnabled')
    return parseStoredBoolean(saved, true)
  })

  // 开发者模式（调试阶段 TV 端默认开，正式版默认关）
  const [developerMode, setDeveloperMode] = useState(() => {
    const saved = localStorage.getItem('developerMode')
    return parseStoredBoolean(saved, isTvModeActive())
  })
  // 过渡调试：开启后切歌/过渡时右上角弹窗显示引擎/策略/DJ 效果清单
  const [transitionDebugEnabled, setTransitionDebugEnabled] = useState(() => {
    try {
      return localStorage.getItem('hyperplayer:transition-debug') === '1'
    } catch {
      return false
    }
  })
  const handleTransitionDebugToggle = (enabled: boolean) => {
    setTransitionDebugEnabled(enabled)
    try {
      localStorage.setItem('hyperplayer:transition-debug', enabled ? '1' : '0')
    } catch {
      // 忽略持久化失败（隐身模式等）
    }
  }

  // 全屏模式设置
  const [fullscreenMode, setFullscreenMode] = useState<'kiosk' | 'normal'>(() => {
    const saved = localStorage.getItem('fullscreenMode')
    return (saved as 'kiosk' | 'normal') || 'kiosk'
  })

  // 视频播放完毕行为设置
  const [videoEndBehavior, setVideoEndBehavior] = useState<'next' | 'close' | 'replay'>(() => {
    const saved = localStorage.getItem('videoEndBehavior')
    return (saved as 'next' | 'close' | 'replay') || 'close'
  })

  // 监听开发者模式变化，实现跨组件同步
  useEffect(() => {
    const handleDeveloperModeChange = (e: Event) => {
      const customEvent = e as CustomEvent
      const enabled = customEvent.detail
      setDeveloperMode(enabled)
    }

    window.addEventListener('developerModeChanged', handleDeveloperModeChange)
    return () => {
      window.removeEventListener('developerModeChanged', handleDeveloperModeChange)
    }
  }, [])
  
  // 预设主题色
  const presetColors = [
    { name: '天空蓝', value: '#3B82F6' },
    { name: '翡翠绿', value: '#10B981' },
    { name: '紫罗兰', value: '#8B5CF6' },
    { name: '玫瑰红', value: '#EC4899' },
    { name: '橙黄色', value: '#F59E0B' },
    { name: '珊瑚红', value: '#EF4444' },
    { name: '青色', value: '#06B6D4' },
    { name: '石板灰', value: '#64748B' },
  ]

  // 保存逐字歌词设置
  const handleWordByWordToggle = (enabled: boolean) => {
    setWordByWordLyrics(enabled)
    localStorage.setItem('wordByWordLyrics', JSON.stringify(enabled))
    // 触发自定义事件，通知其他组件
    window.dispatchEvent(new Event('wordByWordLyricsChanged'))
  }

  // 保存即将播放提示设置
  const handleUpNextToggle = (enabled: boolean) => {
    setUpNextEnabled(enabled)
    localStorage.setItem('upNextEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('upNextEnabledChanged'))
  }

  const handleShowUpNextOutsidePlayerToggle = (enabled: boolean) => {
    setShowUpNextOutsidePlayer(enabled)
    localStorage.setItem('showUpNextOutsidePlayer', JSON.stringify(enabled))
    window.dispatchEvent(new Event('showUpNextOutsidePlayerChanged'))
  }
  
  const handleUpNextSecondsChange = (seconds: number) => {
    const newSeconds = Math.max(5, Math.min(30, seconds))
    setUpNextSeconds(newSeconds)
    localStorage.setItem('upNextSeconds', newSeconds.toString())
    window.dispatchEvent(new CustomEvent('upNextSecondsChanged', { detail: newSeconds }))
  }

  // 保存翻译设置
  const handleTranslationToggle = (enabled: boolean) => {
    setTranslationEnabled(enabled)
    localStorage.setItem('translationEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('translationSettingsChanged'))
  }

  const handleTranslationPositionChange = (position: 'traditional' | 'bottom-right') => {
    setTranslationPosition(position)
    localStorage.setItem('translationPosition', position)
    window.dispatchEvent(new Event('translationSettingsChanged'))
  }
  
  // 保存主题色设置
  const handleAccentColorChange = (color: string) => {
    setAccentColor(color)
    localStorage.setItem('accentColor', color)
    window.dispatchEvent(new CustomEvent('accentColorChanged', { detail: color }))
  }

  const updatePlaybackShortcutSettings = (patch: Partial<PlaybackShortcutSettings>) => {
    setPlaybackShortcutSettings(savePlaybackShortcutSettings(patch))
  }
  
  const handleGpuAccelerationToggle = async (enabled: boolean) => {
    try {
      const result = await window.electron?.system.setHardwareAcceleration(enabled)
      if (!result?.success) throw new Error('主进程未保存设置')
      setGpuAcceleration(result.enabled)
      localStorage.setItem('gpuAcceleration', JSON.stringify(result.enabled))
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: result.enabled ? 'GPU 加速已打开，重启软件后生效' : 'GPU 加速已关闭，重启软件后生效', type: 'info' }
      }))
    } catch (error) {
      console.error('保存硬件加速设置失败:', error)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: '硬件加速设置保存失败', type: 'error' }
      }))
    }
  }

  const handleGpuPreferenceChange = async (preference: 'auto' | 'discrete' | 'integrated') => {
    try {
      const result = await window.electron?.system.setGpuPreference(preference)
      if (!result?.success) throw new Error('主进程未保存设置')
      setGpuPreference(result.gpuPreference)
      const labels: Record<'auto' | 'discrete' | 'integrated', string> = {
        auto: '自动',
        discrete: '独立显卡',
        integrated: '核显',
      }
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: `已切换为${labels[result.gpuPreference]}，重启软件后生效`, type: 'info' }
      }))
    } catch (error) {
      console.error('保存显卡偏好设置失败:', error)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: '显卡偏好设置保存失败', type: 'error' }
      }))
    }
  }

  const handleAudioAnalyzerToggle = (enabled: boolean) => {
    setAudioAnalyzerEnabled(enabled)
    localStorage.setItem('audioAnalyzerEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new CustomEvent('audioAnalyzerEnabledChanged', { detail: enabled }))
    window.dispatchEvent(new CustomEvent('showToast', { 
      detail: { message: enabled ? '音频频谱分析已启用' : '音频频谱分析已禁用（性能模式）', type: 'success' }
    }))
  }

  // 开发者模式切换
  const handleDeveloperModeToggle = (enabled: boolean) => {
    setDeveloperMode(enabled)
    localStorage.setItem('developerMode', JSON.stringify(enabled))
    window.dispatchEvent(new CustomEvent('developerModeChanged', { detail: enabled }))
    
    // 通知 Electron 后端
    if (window.electron?.developerMode) {
      window.electron.developerMode.set(enabled).catch((err: Error) => {
        console.error('Failed to set developer mode:', err)
      })
    }
    
    window.dispatchEvent(new CustomEvent('showToast', { 
      detail: { message: enabled ? '开发者模式已启用' : '开发者模式已禁用', type: 'info' }
    }))
  }

  // 全屏模式切换
  const handleFullscreenModeChange = async (mode: 'kiosk' | 'normal') => {
    setFullscreenMode(mode)
    localStorage.setItem('fullscreenMode', mode)
    window.dispatchEvent(new CustomEvent('fullscreenModeChanged', { detail: mode }))
    
    // 如果当前已经是全屏状态，立即应用新的全屏模式
    if (window.electron?.system?.isFullscreen) {
      const status = await window.electron.system.isFullscreen()
      if (status.fullscreen || status.kiosk) {
        // 先退出全屏
        await window.electron.system.setFullscreen(false, false)
        // 再使用新的模式进入全屏
        await window.electron.system.setFullscreen(true, mode === 'kiosk')
        
        window.dispatchEvent(new CustomEvent('showToast', { 
          detail: { 
            message: mode === 'kiosk' ? '已切换到全屏模式（覆盖任务栏）' : '已切换到全屏无边框模式（保留任务栏）', 
            type: 'success' 
          }
        }))
      }
    }
  }
  
  // 视频播放完毕行为设置
  const handleVideoEndBehaviorChange = (behavior: 'next' | 'close' | 'replay') => {
    setVideoEndBehavior(behavior)
    localStorage.setItem('videoEndBehavior', behavior)
    window.dispatchEvent(new CustomEvent('videoEndBehaviorChanged', { detail: behavior }))
    
    const messages = {
      close: '视频播放完毕后将显示重播按钮',
      replay: '视频播放完毕后将自动重播',
      next: '视频播放完毕后将自动续播下一个'
    }
    
    window.dispatchEvent(new CustomEvent('showToast', { 
      detail: { 
        message: messages[behavior], 
        type: 'success' 
      }
    }))
  }
  
  // Crossfade 和 Gapless 设置
  const [crossfadeEnabled, setCrossfadeEnabled] = useState(() => {
    const saved = localStorage.getItem('crossfadeEnabled')
    return parseStoredBoolean(saved, false)
  })
  
  const [crossfadeDuration, setCrossfadeDuration] = useState(() => {
    const saved = localStorage.getItem('crossfadeDuration')
    return saved ? parseFloat(saved) : 4
  })
  
  const [gaplessEnabled, setGaplessEnabled] = useState(() => {
    const saved = localStorage.getItem('gaplessEnabled')
    return parseStoredBoolean(saved, false)
  })
  
  const [albumGaplessEnabled, setAlbumGaplessEnabled] = useState(() => {
    const saved = localStorage.getItem('albumGaplessEnabled')
    return parseStoredBoolean(saved, true)
  })
  
  const handleCrossfadeToggle = (enabled: boolean) => {
    // Crossfade 和 Gapless 互斥
    if (enabled) {
      if (gaplessEnabled) {
        setGaplessEnabled(false)
        localStorage.setItem('gaplessEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('gaplessSettingsChanged'))
      }
    }
    setCrossfadeEnabled(enabled)
    localStorage.setItem('crossfadeEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('crossfadeSettingsChanged'))
  }
  
  const handleCrossfadeDurationChange = (duration: number) => {
    const newDuration = Math.max(1, Math.min(12, duration))
    setCrossfadeDuration(newDuration)
    localStorage.setItem('crossfadeDuration', newDuration.toString())
    window.dispatchEvent(new Event('crossfadeSettingsChanged'))
  }
  
  const handleGaplessToggle = (enabled: boolean) => {
    // Gapless 和 Crossfade 互斥
    if (enabled) {
      if (crossfadeEnabled) {
        setCrossfadeEnabled(false)
        localStorage.setItem('crossfadeEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('crossfadeSettingsChanged'))
      }
    }
    setGaplessEnabled(enabled)
    localStorage.setItem('gaplessEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('gaplessSettingsChanged'))
  }
  
  const handleAlbumGaplessToggle = (enabled: boolean) => {
    setAlbumGaplessEnabled(enabled)
    localStorage.setItem('albumGaplessEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('albumGaplessSettingsChanged'))
  }

  // 深浅色主题：与播放页快捷设置共用同一存储与事件，App 监听后统一更新
  const handlePlayerThemeChange = (newTheme: 'dark' | 'light') => {
    localStorage.setItem('playerTheme', newTheme)
    window.dispatchEvent(new CustomEvent('playerThemeChanged', { detail: newTheme }))
  }

  return (
    <AnimatePresence>
      {show && (
        <React.Fragment key="settings-modal">
          {/* 背景遮罩 */}
          <motion.div
            key="settings-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          onClick={onClose}
          className={`fixed inset-0 backdrop-blur-sm z-40 ${playerTheme === 'dark' ? 'bg-black/60' : 'bg-white/40'}`}
        />

        {/* 设置面板 */}
        <motion.div
            key="settings-panel"
            data-tv-scope
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className={`fixed right-0 top-0 h-full w-full z-50 shadow-2xl overflow-hidden ${isTvModeActive() ? 'max-w-2xl' : 'max-w-md'}`}
          >
            {/* 液态玻璃背景层 - 增强版 */}
            <div className="absolute inset-0">
              {/* 主背景 - 根据主题变化 */}
              <div 
                className="absolute inset-0"
                style={{
                  background: playerTheme === 'dark'
                    ? 'linear-gradient(135deg, rgba(0,0,0,0.75) 0%, rgba(15,15,25,0.85) 30%, rgba(25,15,35,0.8) 70%, rgba(0,0,0,0.75) 100%)'
                    : 'linear-gradient(135deg, rgba(255,255,255,0.75) 0%, rgba(245,245,250,0.85) 30%, rgba(250,245,255,0.8) 70%, rgba(255,255,255,0.75) 100%)',
                  backdropFilter: 'blur(24px) saturate(170%) brightness(1.05)',
                  WebkitBackdropFilter: 'blur(24px) saturate(170%) brightness(1.05)',
                }}
              />
              
              {/* 多层光泽效果 */}
              <div 
                className="absolute inset-0"
                style={{
                  background: playerTheme === 'dark'
                    ? 'radial-gradient(circle at 20% 15%, rgba(255,255,255,0.15) 0%, transparent 40%), radial-gradient(circle at 80% 85%, rgba(255,255,255,0.08) 0%, transparent 40%)'
                    : 'radial-gradient(circle at 20% 15%, rgba(255,255,255,0.9) 0%, transparent 40%), radial-gradient(circle at 80% 85%, rgba(255,255,255,0.5) 0%, transparent 40%)',
                  pointerEvents: 'none',
                }}
              />
              
              {/* 细微噪点纹理 */}
              <div 
                className="absolute inset-0 opacity-30"
                style={{
                  backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\' opacity=\'0.05\'/%3E%3C/svg%3E")',
                  pointerEvents: 'none',
                }}
              />
              
              {/* 左边框高光 - 增强版 */}
              <div 
                className="absolute inset-y-0 left-0 w-px"
                style={{
                  background: playerTheme === 'dark'
                    ? 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.3), transparent)'
                    : 'linear-gradient(to bottom, transparent, rgba(0,0,0,0.2), transparent)',
                }}
              />
              
              {/* 边框高光 */}
              <div 
                className="absolute inset-0"
                style={{
                  border: playerTheme === 'dark' 
                    ? '1.5px solid rgba(255,255,255,0.2)'
                    : '1.5px solid rgba(0,0,0,0.15)',
                  boxShadow: playerTheme === 'dark'
                    ? '0 20px 60px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.2), inset 0 1px 1px rgba(255,255,255,0.15), inset 0 -1px 1px rgba(0,0,0,0.2)'
                    : '0 20px 60px rgba(0,0,0,0.2), 0 0 1px rgba(255,255,255,0.8), inset 0 1px 1px rgba(255,255,255,0.9), inset 0 -1px 1px rgba(0,0,0,0.05)',
                  pointerEvents: 'none',
                  borderRadius: '0',
                }}
              />
            </div>
            
            {/* Content area */}
            <div className="relative z-10 h-full flex flex-col">
            {/* 头部 */}
            <div className={`flex items-center justify-between p-6 border-b ${
              playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
            }`}>
              <div className="flex items-center gap-3">
                <SettingsIcon className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                <h2 className={`text-2xl font-bold ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`}>设置</h2>
              </div>
              <button
                onClick={onClose}
                className="relative p-2 rounded-full transition-all duration-300 group overflow-hidden"
                style={{
                  backdropFilter: 'blur(20px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                }}
              >
                {/* 液态玻璃背景层 */}
                <div 
                  className="absolute inset-0 transition-all duration-300"
                  style={{
                    background: playerTheme === 'dark'
                      ? 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)'
                      : 'linear-gradient(135deg, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.04) 100%)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    borderRadius: '9999px',
                  }}
                />
                
                {/* Hover 效果层 */}
                <div 
                  className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                  style={{
                    background: playerTheme === 'dark'
                      ? 'radial-gradient(circle at center, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0.1) 100%)'
                      : 'radial-gradient(circle at center, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.08) 100%)',
                    borderRadius: '9999px',
                  }}
                />
                
                {/* 边框光泽 */}
                <div 
                  className="absolute inset-0"
                  style={{
                    border: playerTheme === 'dark' 
                      ? '1px solid rgba(255,255,255,0.2)'
                      : '1px solid rgba(0,0,0,0.15)',
                    borderRadius: '9999px',
                    boxShadow: playerTheme === 'dark'
                      ? 'inset 0 1px 1px rgba(255,255,255,0.2), 0 2px 8px rgba(0,0,0,0.2)'
                      : 'inset 0 1px 1px rgba(255,255,255,0.5), 0 2px 8px rgba(0,0,0,0.1)',
                  }}
                />
                
                <ChevronLeft className={`w-6 h-6 relative z-10 transition-transform duration-300 group-hover:scale-110 ${
                  playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'
                }`} />
              </button>
            </div>

            {/* Tabs：激活项下方为蓝色指示条（layoutId 共享布局动画，切换时丝滑滑到选中 tab 下方） */}
            <div className={`relative flex border-b ${playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
              <button
                onClick={() => switchTab('account')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'account'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <User className="w-5 h-5" />
                账号
                {activeTab === 'account' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
              <button
                onClick={() => switchTab('personalization')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'personalization'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Sparkles className="w-5 h-5" />
                个性化
                {activeTab === 'personalization' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
              <button
                onClick={() => switchTab('advanced')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'advanced'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Palette className="w-5 h-5" />
                高级
                {activeTab === 'advanced' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
              <button
                onClick={() => switchTab('about')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'about'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Info className="w-5 h-5" />
                关于
                {activeTab === 'about' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
            </div>

            {/* Content area */}
            <div ref={contentScrollRef} className="p-6 overflow-y-auto h-[calc(100vh-140px)]">
              {activeTab === 'account' && (
                <div className="space-y-6">
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>音乐平台账号</h3>
                    <p className={`${textSecondary} text-sm mb-1`}>
                      登录后可以播放VIP歌曲、获取个人歌单
                    </p>
                    <p className={`${textTertiary} text-xs mb-6`}>
                      可拖拽平台卡片对平台进行显示排序
                    </p>

                    <div className="space-y-4">
                    {/* 平台账号卡片（按住卡片上下拖拽调整顺序，隐藏的平台不参与排序） */}
                    <Reorder.Group axis="y" values={platformOrder} onReorder={(next) => {
                      const valid = next.filter((p, i, arr) => MUSIC_PLATFORMS.includes(p) && arr.indexOf(p) === i)
                      setPlatformOrder(valid)
                      setPlatformOrderState(valid)
                    }} className="space-y-4">
                      {platformOrder.map(p => {
                        const hidden = hiddenPlatforms.includes(p)
                        const isNetease = p === 'netease'
                        const isQQ = p === 'qq'
                        const isApple = p === 'apple'
                        const label = PLATFORM_LABELS[p]
                        const sub = isNetease ? '使用手机扫码登录' : isQQ ? '使用网页扫码登录' : isApple ? '使用网页登录' : '使用 OAuth 授权登录'
                        const iconBg = isNetease ? 'bg-red-600' : isQQ ? 'bg-green-600' : isApple ? 'bg-pink-600' : 'bg-[#1DB954]'
                        const iconSrc = isNetease ? 'https://s1.music.126.net/style/favicon.ico' : isQQ ? 'https://y.qq.com/favicon.ico' : isApple ? 'https://www.apple.com/favicon.ico' : ''
                        const iconFallback = isNetease ? '%E7%BD%91' : isQQ ? 'QQ' : isApple ? '%E8%8B%B9' : ''
                        const loggedIn = isNetease ? neteaseLoggedIn : isQQ ? qqLoggedIn : isApple ? appleLoggedIn : spotifyLoggedIn
                        const username = isNetease ? neteaseUsername : isQQ ? qqUsername : isApple ? appleUsername : spotifyUsername
                        const onLogin = isNetease ? onNeteaseLogin : isQQ ? onQQLogin : isApple ? (() => undefined) : onSpotifyLogin
                        const onLogout = isNetease ? onNeteaseLogout : isQQ ? onQQLogout : isApple ? onAppleLogout : onSpotifyLogout
                        return (
                          <Reorder.Item key={p} value={p} className="relative">
                            <motion.div
                              layout
                              animate={{ opacity: hidden ? 0.45 : 1, scale: hidden ? 0.98 : 1 }}
                              transition={{ duration: 0.25 }}
                              className={`${bgCard} rounded-xl p-4 border ${borderColor} relative cursor-grab active:cursor-grabbing`}
                            >
                              {/* 隐藏平台小眼睛（右上角） */}
                              <button
                                type="button"
                                onClick={() => togglePlatformVisibility(p, !hidden)}
                                className="absolute top-3 right-3 p-1.5 rounded-lg transition-colors hover:bg-white/10"
                                aria-label={hidden ? `显示${label}` : `隐藏${label}`}
                                title={hidden ? '显示平台' : '隐藏平台'}
                              >
                                {hidden
                                  ? <EyeOff className="w-4 h-4 text-white/40" />
                                  : <Eye className="w-4 h-4 text-white/40" />}
                              </button>
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-3">
                                  <div className={`w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 ${iconBg} flex items-center justify-center`}>
                                    {iconSrc ? (
                                      <img
                                        src={iconSrc}
                                        alt={label}
                                        className="w-6 h-6"
                                        onError={(e) => {
                                          e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext x="50" y="70" text-anchor="middle" fill="white" font-size="45" font-weight="bold"%3E' + iconFallback + '%3C/text%3E%3C/svg%3E'
                                        }}
                                      />
                                    ) : (
                                      <Music className="w-5 h-5 text-white" />
                                    )}
                                  </div>
                                  <div>
                                    <div className={`${textPrimary} font-medium`}>{label}</div>
                                    <div className={`${textTertiary} text-xs`}>{sub}</div>
                                  </div>
                                </div>
                              </div>
                              <div className="mt-4">
                                <LoginButton
                                  platform={p}
                                  isLoggedIn={loggedIn}
                                  username={username}
                                  onLogin={onLogin}
                                  onLogout={onLogout}
                                  onAppleLogin={isApple ? onAppleLogin : undefined}
                                  playerTheme={playerTheme}
                                />
                              </div>
                            </motion.div>
                          </Reorder.Item>
                        )
                      })}
                    </Reorder.Group>
                      {/* 哔哩哔哩「看歌」登录 */}
                      <motion.div
                        layout
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.25 }}
                        className={`${bgCard} rounded-xl p-4 border ${borderColor} relative`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ backgroundColor: '#FB7299' }}>
                              <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.765-1.56 3.761-1.004.996-2.263 1.52-3.773 1.574h-.854c-1.51-.054-2.769-.578-3.773-1.574-.996-.996-1.51-2.251-1.542-3.76v-1.804h-4.996v1.804c-.032 1.509-.546 2.764-1.542 3.76-1.004.996-2.263 1.52-3.773 1.574h-.854C1.75 20.554.491 20.03-.513 19.034c-1.004-.996-1.524-2.251-1.56-3.76v-7.36c.036-1.511.556-2.765 1.56-3.761C.49 2.157 1.75 1.633 3.26 1.58h.854c1.51.054 2.769.578 3.773 1.574.996.996 1.51 2.251 1.542 3.76v1.804h4.996V6.914c.032-1.509.546-2.764 1.542-3.76 1.004-.996 2.263-1.52 3.773-1.574z" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>哔哩哔哩</div>
                              <div className={`${textTertiary} text-xs`}>看歌模式 · 扫码登录解锁 1080P</div>
                            </div>
                          </div>
                          {biliLoggedIn && (
                            <span className="text-xs font-medium text-green-500">已登录</span>
                          )}
                        </div>
                        <div className="mt-4 flex items-center gap-3">
                          {biliLoggedIn ? (
                            <>
                              {biliUser?.face && (
                                <img src={resolveBiliPic(biliUser.face)} alt="" className="w-8 h-8 rounded-full bg-white/10 flex-shrink-0" />
                              )}
                              <div className="min-w-0 flex-1">
                                <div className={`${textPrimary} text-sm truncate`}>{biliUser?.uname || '哔哩哔哩用户'}</div>
                                <div className={`${textTertiary} text-xs`}>
                                  {biliUser?.vipType ? '大会员 · ' : ''}
                                  {biliRemainingDays != null ? `登录有效期约 ${biliRemainingDays} 天` : '已登录'}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={handleBiliLogout}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-white/10 text-white/70"
                              >
                                退出登录
                              </button>
                              <button
                                type="button"
                                onClick={() => setShowBiliProfile(true)}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-transform hover:scale-105"
                                style={{ backgroundColor: "#FB7299" }}
                              >
                                个人中心
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setShowBiliLogin(true)}
                              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-transform hover:scale-105"
                              style={{ backgroundColor: '#FB7299' }}
                            >
                              扫码登录
                            </button>
                          )}
                        </div>
                      </motion.div>
                    </div>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className={`${textPrimary} font-medium`}>隐藏主页账号ID信息</div>
                          <div className={`${textTertiary} text-xs mt-1`}>隐藏个人信息中的 QQ号和网易云ID，录制视频时保护账号隐私</div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={hideHomeAccountId}
                          aria-label="隐藏主页账号ID信息"
                          onClick={handleHideHomeAccountIdChange}
                          className={`relative h-7 w-12 flex-shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${hideHomeAccountId ? '' : playerTheme === 'dark' ? 'bg-white/15' : 'bg-black/15'}`}
                          style={hideHomeAccountId ? { backgroundColor: accentColor } : undefined}
                        >
                          <span className={`pointer-events-none absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ${hideHomeAccountId ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'personalization' && (
                <div className="space-y-6">
                  {/* 首页自定义 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>自定义首页</h3>
                    <button
                      onClick={() => setShowHomeCustomize(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                          <Sparkles className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div className="text-left">
                          <div className={`${textPrimary} font-medium`}>自定义首页显示内容</div>
                          <div className={`${textSecondary} text-sm`}>
                            分别配置网易云和QQ音乐的推荐模块
                          </div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textTertiary} group-hover:translate-x-1 transition-transform`} />
                    </button>
                  </div>

                  {/* 右键轮盘 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放交互</h3>
                    <button
                      type="button"
                      onClick={() => setShowPlaybackRadialCustomize(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${accentColor}20` }}>
                          <ListMusic className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div className="text-left min-w-0">
                          <div className={`${textPrimary} font-medium`}>右键轮盘</div>
                          <div className={`${textSecondary} text-sm truncate`}>播放页长按右键呼出 · 已配置 {playbackRadialActionCount} 个功能</div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textTertiary} flex-shrink-0 group-hover:translate-x-1 transition-transform`} />
                    </button>
                  </div>

                  {/* 播放音质 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放音质</h3>
                    <button
                      onClick={() => setShowAudioQuality(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${accentColor}20` }}>
                          <Headphones className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div className="text-left min-w-0">
                        <div className={`${textPrimary} font-medium`}>各平台播放音质</div>
                        <div className={`${textSecondary} text-sm truncate`}>
                          Apple Music：{audioQualityLabel(audioQualitySettings.apple)} · 网易云：{audioQualityLabel(audioQualitySettings.netease)} · QQ音乐：{audioQualityLabel(audioQualitySettings.qq)} · Spotify：{audioQualityLabel(audioQualitySettings.spotify)}
                        </div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textTertiary} flex-shrink-0 group-hover:translate-x-1 transition-transform`} />
                    </button>
                  </div>

                  {/* 播放快捷键 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放快捷键</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} space-y-4`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>播放页快捷键</div>
                          <div className={`${textSecondary} text-sm`}>在播放页使用方向键调节进度，并可用空格键播放或暂停</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={playbackShortcutSettings.playbackPageEnabled}
                            onChange={(event) => updatePlaybackShortcutSettings({ playbackPageEnabled: event.target.checked })}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: playbackShortcutSettings.playbackPageEnabled ? accentColor : '' }} />
                        </label>
                      </div>

                      {playbackShortcutSettings.playbackPageEnabled && (
                        <div className="pt-4 border-t space-y-5" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          {([
                            ['右方向键快进', 'seekForwardSeconds'],
                            ['左方向键快退', 'seekBackwardSeconds'],
                          ] as const).map(([label, key]) => {
                            const seconds = playbackShortcutSettings[key]
                            const percent = ((seconds - 1) / 14) * 100
                            return (
                              <div key={key} className="flex items-center justify-between gap-5">
                                <div className={`${textPrimary} text-sm font-medium`}>{label}</div>
                                <div className="flex items-center gap-3">
                                  <input
                                    type="range"
                                    min="1"
                                    max="15"
                                    step="1"
                                    value={seconds}
                                    onChange={(event) => updatePlaybackShortcutSettings({ [key]: Number(event.target.value) })}
                                    className="w-36 h-2 rounded-lg appearance-none cursor-pointer range-slider-glass"
                                    style={{
                                      background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${percent}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} ${percent}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} 100%)`,
                                    }}
                                  />
                                  <span className={`${textPrimary} text-sm font-semibold w-12 text-right`}>{seconds} 秒</span>
                                </div>
                              </div>
                            )
                          })}

                          <div className="flex items-center justify-between gap-6 pt-1">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>空格键播放 / 暂停</div>
                              <div className={`${textTertiary} text-xs`}>关闭后，在播放页按空格键不会触发播放控制</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                              <input
                                type="checkbox"
                                checked={playbackShortcutSettings.spacePlayPauseEnabled}
                                onChange={(event) => updatePlaybackShortcutSettings({ spacePlayPauseEnabled: event.target.checked })}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: playbackShortcutSettings.spacePlayPauseEnabled ? accentColor : '' }} />
                            </label>
                          </div>
                        </div>
                      )}

                      <div className="pt-4 border-t flex items-center justify-between gap-6" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>键盘多媒体键支持</div>
                          <div className={`${textSecondary} text-sm`}>软件打开时，全局响应播放 / 暂停、上一曲和下一曲媒体键</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={playbackShortcutSettings.mediaKeysEnabled}
                            onChange={(event) => updatePlaybackShortcutSettings({ mediaKeysEnabled: event.target.checked })}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: playbackShortcutSettings.mediaKeysEnabled ? accentColor : '' }} />
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* 即将播放提示 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放提示</h3>
                    
                    {/* 即将播放提示开关 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>即将播放提示</div>
                          <div className={`${textSecondary} text-sm`}>
                            在歌曲结束前显示下一首歌曲信息
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={upNextEnabled}
                            onChange={(e) => handleUpNextToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: upNextEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {/* 秒数设置 */}
                      {upNextEnabled && (
                        <div className="space-y-4 pt-4 border-t" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          <div className="flex items-center justify-between gap-6">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>在播放页外显示播放提示</div>
                              <div className={`${textSecondary} text-xs`}>
                                在探索、简约首页和桌面模式的右上角显示提示
                              </div>
                            </div>
                            <label className="relative inline-flex shrink-0 items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={showUpNextOutsidePlayer}
                                onChange={(e) => handleShowUpNextOutsidePlayerToggle(e.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: showUpNextOutsidePlayer ? accentColor : '' }} />
                            </label>
                          </div>
                          <div className="border-t pt-4" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          <div className="flex items-center justify-between">
                            <div className={`${textPrimary} text-sm font-medium`}>提前显示时间</div>
                            <div className="flex items-center gap-3">
                              <input
                                type="range"
                                min="5"
                                max="30"
                                value={upNextSeconds}
                                onChange={(e) => handleUpNextSecondsChange(parseInt(e.target.value))}
                                className="w-32 h-2 rounded-lg appearance-none cursor-pointer range-slider-glass"
                                style={{
                                  background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${((upNextSeconds - 5) / 25) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} ${((upNextSeconds - 5) / 25) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} 100%)`
                                }}
                              />
                              <span className={`${textPrimary} text-sm font-medium w-12 text-right`}>{upNextSeconds}秒</span>
                            </div>
                          </div>
                          <div className={`${textTertiary} text-xs mt-2`}>
                            在歌曲结束前 {upNextSeconds} 秒显示下一首歌曲信息
                          </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {/* 歌词翻译位置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>歌词翻译</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>翻译显示位置</div>
                        <div className={`${textSecondary} text-sm`}>
                          选择歌词翻译在播放界面的显示位置
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          onClick={() => {
                            setTranslationPosition('traditional')
                            localStorage.setItem('translationPosition', 'traditional')
                            window.dispatchEvent(new CustomEvent('translationPositionChanged', { detail: 'traditional' }))
                          }}
                          className={`p-4 rounded-xl transition-all border-2 ${
                            translationPosition === 'traditional'
                              ? 'border-2'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: translationPosition === 'traditional' ? accentColor : 'transparent',
                            backgroundColor: translationPosition === 'traditional' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} text-sm font-medium`}>传统</div>
                              <div className={`${textTertiary} text-xs mt-1`}>显示于歌词下方</div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => {
                            setTranslationPosition('bottom-right')
                            localStorage.setItem('translationPosition', 'bottom-right')
                            window.dispatchEvent(new CustomEvent('translationPositionChanged', { detail: 'bottom-right' }))
                          }}
                          className={`p-4 rounded-xl transition-all border-2 ${
                            translationPosition === 'bottom-right'
                              ? 'border-2'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: translationPosition === 'bottom-right' ? accentColor : 'transparent',
                            backgroundColor: translationPosition === 'bottom-right' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} text-sm font-medium`}>现代</div>
                              <div className={`${textTertiary} text-xs mt-1`}>右下角浮动显示</div>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {/* 桌面歌词 */}
                  <div data-tv-hide="desktop">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>桌面歌词</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用桌面歌词</div>
                          <div className={`${textSecondary} text-sm`}>将当前歌词显示在桌面上，悬停后可拖动、缩放并快速调整样式</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                          <input
                            type="checkbox"
                            checked={desktopLyricsSettings.enabled}
                            onChange={(event) => handleDesktopLyricsToggle(event.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: desktopLyricsSettings.enabled ? accentColor : '' }} />
                        </label>
                      </div>

                      {desktopLyricsSettings.enabled && (
                        <div className="mt-4 pt-4 border-t space-y-5" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)' }}>
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className={`${textPrimary} text-sm font-medium`}>字体大小</span>
                              <span className={`${textTertiary} text-xs tabular-nums`}>{desktopLyricsSettings.fontSize}</span>
                            </div>
                            <input
                              type="range"
                              min="26"
                              max="120"
                              step="2"
                              value={desktopLyricsSettings.fontSize}
                              onChange={(event) => updateDesktopLyrics({ fontSize: Number(event.target.value) })}
                              className="w-full"
                              style={{ accentColor }}
                            />
                          </div>

                          {/* 歌词字体：内置霞鹜文楷 / 得意黑（OFL 开源可商用）+ 推荐系统字体 + 本机字体 */}
                          <div className="mt-4">
                            <div className="flex items-center justify-between gap-4">
                              <div className="min-w-0">
                                <div className={`${textPrimary} text-sm font-medium`}>字体</div>
                                <div className={`${textTertiary} text-xs mt-0.5`}>内置霞鹜文楷 / 得意黑，也可选择本机字体</div>
                              </div>
                              <FontPicker
                                value={desktopLyricsSettings.fontFamily}
                                onChange={(family) => updateDesktopLyrics({ fontFamily: family })}
                                dark={playerTheme === 'dark'}
                                accent={accentColor}
                                buttonWidth={200}
                              />
                            </div>
                          </div>

                          <div>
                            <div className={`${textPrimary} text-sm font-medium mb-3`}>字体颜色</div>
                            <div className="flex flex-wrap gap-3">
                              {([
                                ['auto', '随歌曲', 'linear-gradient(135deg,#67e8f9,#f9a8d4,#fde68a)'],
                                ['rose', '樱粉', '#f9a8d4'],
                                ['sky', '晴蓝', '#7dd3fc'],
                                ['gold', '暖金', '#fde68a'],
                                ['mint', '薄荷', '#86efac'],
                                ['white', '月白', '#f8fafc'],
                              ] as Array<[DesktopLyricsColorMode, string, string]>).map(([value, label, color]) => (
                                <button key={value} type="button" onClick={() => updateDesktopLyrics({ colorMode: value })} className="flex flex-col items-center gap-1.5">
                                  <span className="w-8 h-8 rounded-full p-1 transition-shadow" style={{ boxShadow: desktopLyricsSettings.colorMode === value ? `0 0 0 2px ${accentColor}` : '0 0 0 1px rgba(127,127,127,.22)' }}>
                                    <i className="block w-full h-full rounded-full" style={{ background: color }} />
                                  </span>
                                  <span className={`${textTertiary} text-[10px]`}>{label}</span>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-3">
                            {([
                              ['orientation', desktopLyricsSettings.orientation === 'vertical', '竖排显示'],
                              ['doubleLine', desktopLyricsSettings.doubleLine, '双行显示'],
                              ['traditionalEnabled', desktopLyricsSettings.traditionalEnabled, '繁体歌词'],
                            ] as const).map(([key, active, label]) => (
                              <button
                                key={key}
                                type="button"
                                onClick={() => updateDesktopLyrics(key === 'orientation'
                                  ? { orientation: active ? 'horizontal' : 'vertical' }
                                  : { [key]: !active })}
                                className="rounded-xl border px-3 py-2.5 text-xs transition-colors"
                                style={{
                                  color: active ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)',
                                  borderColor: active ? `${accentColor}99` : playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                                  background: active ? `${accentColor}18` : 'transparent',
                                }}
                              >{label}</button>
                            ))}
                          </div>
                          <p className={`${textTertiary} text-xs leading-5`}>翻译与罗马音按钮会在当前整首歌曲包含对应歌词时，自动显示在桌面歌词工具栏中。</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 桌面播放器 */}
                  <div data-tv-hide="desktop">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>桌面播放器</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>桌面播放器</div>
                          <div className={`${textSecondary} text-sm`}>
                            独立置顶小窗口，支持右上角悬浮卡片与顶部居中的紧凑条状
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={desktopPlayerEnabled}
                            onChange={(e) => handleDesktopPlayerToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: desktopPlayerEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>

                      {desktopPlayerEnabled && (
                        <div className="pt-4 border-t" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          <div className={`${textPrimary} text-sm font-medium mb-3`}>显示形态</div>
                          <div className="grid grid-cols-2 gap-3">
                            <button
                              onClick={() => handleDesktopPlayerFormChange('card')}
                              className="p-4 rounded-xl transition-all border-2"
                              style={{
                                borderColor: desktopPlayerForm === 'card' ? accentColor : 'transparent',
                                backgroundColor: desktopPlayerForm === 'card'
                                  ? `${accentColor}20`
                                  : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                              }}
                            >
                              <div className="flex flex-col items-center gap-2">
                                <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                                  <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16v11H4z M8 9h5 M8 12h3 M16 9v4 M18 10v2" />
                                  </svg>
                                </div>
                                <div>
                                  <div className={`${textPrimary} text-sm font-medium`}>悬浮卡片</div>
                                  <div className={`${textTertiary} text-xs mt-1`}>可拖动摆放，拖角调整大小</div>
                                </div>
                              </div>
                            </button>

                            <button
                              onClick={() => handleDesktopPlayerFormChange('bar')}
                              className="p-4 rounded-xl transition-all border-2"
                              style={{
                                borderColor: desktopPlayerForm === 'bar' ? accentColor : 'transparent',
                                backgroundColor: desktopPlayerForm === 'bar'
                                  ? `${accentColor}20`
                                  : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                              }}
                            >
                              <div className="flex flex-col items-center gap-2">
                                <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                                  <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15h18v4H3z M5 17h6 M17 16.5v1.5 M19 16v2" />
                                  </svg>
                                </div>
                                <div>
                                  <div className={`${textPrimary} text-sm font-medium`}>紧凑条状</div>
                                  <div className={`${textTertiary} text-xs mt-1`}>默认显示在屏幕顶部中央，支持完整控制</div>
                                </div>
                              </div>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 任务栏迷你播控（贴任务栏带） */}
                  <div data-tv-hide="desktop">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>任务栏迷你播控</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用任务栏迷你播控</div>
                          <div className={`${textSecondary} text-sm`}>
                            在任务栏上显示迷你播控栏（封面 / 歌词 / 进度 / 控制），精确贴合任务栏高度，播放时显示当前歌词行
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                          <input
                            type="checkbox"
                            checked={taskbarWidgetEnabledState}
                            onChange={(e) => void handleTaskbarWidgetToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: taskbarWidgetEnabledState ? accentColor : '' }} />
                        </label>
                      </div>

                      {taskbarWidgetEnabledState && (
                        <div className="mt-4 pt-4 border-t space-y-5" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)' }}>
                          <div>
                            <div className={`${textPrimary} text-sm font-medium mb-3`}>位置</div>
                            <div className="grid grid-cols-2 gap-3">
                              {([
                                ['right', '右侧', '靠近系统托盘，不遮挡托盘区域'],
                                ['center', '居中', '任务栏水平居中显示'],
                              ] as const).map(([value, label, hint]) => (
                                <button
                                  key={value}
                                  type="button"
                                  onClick={() => void handleTaskbarWidgetUpdate({ position: value })}
                                  className="rounded-xl border px-3 py-2.5 text-xs transition-colors text-left"
                                  style={{
                                    color: taskbarWidgetSettings.position === value ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)',
                                    borderColor: taskbarWidgetSettings.position === value ? `${accentColor}99` : playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                                    background: taskbarWidgetSettings.position === value ? `${accentColor}18` : 'transparent',
                                  }}
                                >
                                  <div className="font-medium">{label}</div>
                                  <div className={`${textTertiary} text-[10px] mt-0.5`}>{hint}</div>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div>
                            <div className={`${textPrimary} text-sm font-medium mb-3`}>显示模式</div>
                            <div className="grid grid-cols-2 gap-3">
                              {([
                                ['normal', '常规', '封面 + 上一曲/暂停/下一曲 + 歌词'],
                                ['pure', '纯享', '只显示当前播放的歌词'],
                              ] as const).map(([value, label, hint]) => (
                                <button
                                  key={value}
                                  type="button"
                                  onClick={() => void handleTaskbarWidgetUpdate({ mode: value })}
                                  className="rounded-xl border px-3 py-2.5 text-xs transition-colors text-left"
                                  style={{
                                    color: (taskbarWidgetSettings.mode || 'normal') === value ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)',
                                    borderColor: (taskbarWidgetSettings.mode || 'normal') === value ? `${accentColor}99` : playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                                    background: (taskbarWidgetSettings.mode || 'normal') === value ? `${accentColor}18` : 'transparent',
                                  }}
                                >
                                  <div className="font-medium">{label}</div>
                                  <div className={`${textTertiary} text-[10px] mt-0.5`}>{hint}</div>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div>
                            <div className={`${textPrimary} text-sm font-medium mb-3`}>背景效果</div>
                            <div className="grid grid-cols-2 gap-3">
                              {([
                                ['darken', '暗化', '加深背景遮罩，文字更清晰'],
                              ] as const).map(([value, label, hint]) => {
                                const enabled = taskbarWidgetSettings[value] === true
                                return (
                                  <button
                                    key={value}
                                    type="button"
                                    onClick={() => void handleTaskbarWidgetUpdate({ [value]: !enabled } as Partial<TaskbarWidgetSettings>)}
                                    className="rounded-xl border px-3 py-2.5 text-xs transition-colors text-left flex items-center justify-between gap-2"
                                    style={{
                                      color: enabled ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)',
                                      borderColor: enabled ? `${accentColor}99` : playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                                      background: enabled ? `${accentColor}18` : 'transparent',
                                    }}
                                  >
                                    <span>
                                      <div className="font-medium">{label}</div>
                                      <div className={`${textTertiary} text-[10px] mt-0.5`}>{hint}</div>
                                    </span>
                                    <span className={`inline-block w-9 h-5 rounded-full relative shrink-0 transition-colors`} style={{ backgroundColor: enabled ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.2)' }}>
                                      <span className={`absolute top-[2px] start-[2px] w-4 h-4 rounded-full bg-white shadow transition-all`} style={{ transform: enabled ? 'translateX(16px)' : '' }} />
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                            {taskbarWidgetSettings.darken && (
                              <div className="mt-3">
                                <div className="flex items-center justify-between mb-2"><span className={`${textPrimary} text-xs font-medium`}>暗化程度</span><span className={`${textTertiary} text-[10px] tabular-nums`}>{Math.round(taskbarWidgetSettings.darkenLevel * 100)}%</span></div>
                                <input type="range" min="5" max="95" step="5" value={Math.round(taskbarWidgetSettings.darkenLevel * 100)} onChange={(e) => void handleTaskbarWidgetUpdate({ darkenLevel: Number(e.target.value) / 100 })} className="w-full" style={{ accentColor }} />
                              </div>
                            )}
                            {(taskbarWidgetSettings.mode || 'normal') === 'normal' && (
                              <div className="mt-3 flex items-center justify-between">
                                <span className={`${textPrimary} text-xs font-medium`}>隐藏控件</span>
                                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                                  <input type="checkbox" checked={taskbarWidgetSettings.hideControls} onChange={(e) => void handleTaskbarWidgetUpdate({ hideControls: e.target.checked })} className="sr-only peer" />
                                  <div className={`w-9 h-5 rounded-full relative shrink-0 transition-colors`} style={{ backgroundColor: taskbarWidgetSettings.hideControls ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.2)' }}>
                                    <span className={`absolute top-[2px] start-[2px] w-4 h-4 rounded-full bg-white shadow transition-all`} style={{ transform: taskbarWidgetSettings.hideControls ? 'translateX(16px)' : '' }} />
                                  </div>
                                </label>
                              </div>
                            )}
                            <p className={`${textTertiary} text-[10px] mt-2 leading-4`}>
                              仅 Windows 可用。迷你播控栏覆盖在任务栏带区域，只有播控按钮可点击，其余区域鼠标穿透。
                            </p>
                          </div>

                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className={`${textPrimary} text-sm font-medium`}>宽度</span>
                              <span className={`${textTertiary} text-xs tabular-nums`}>{taskbarWidgetSettings.width} px</span>
                            </div>
                            <input
                              type="range"
                              min="260"
                              max="420"
                              step="10"
                              value={taskbarWidgetSettings.width}
                              onChange={(e) => void handleTaskbarWidgetUpdate({ width: Number(e.target.value) })}
                              className="w-full"
                              style={{ accentColor }}
                            />
                          </div>
                          <p className={`${textTertiary} text-xs leading-5`}>
                            仅 Windows 可用。迷你播控栏覆盖在任务栏带区域，悬停时变为可交互；移出后自动鼠标穿透，不遮挡任务栏其他按钮。
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 全屏窗口模式设置（TV 端常驻全屏，无需设置） */}
                  <div data-tv-hide="desktop">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>窗口设置</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>全屏化窗口模式</div>
                        <div className={`${textSecondary} text-sm`}>
                          选择全屏时的窗口行为
                        </div>
                      </div>
                      
                      {/* 全屏模式选项 */}
                      <div className="space-y-3">
                        <button
                          onClick={() => handleFullscreenModeChange('kiosk')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            fullscreenMode === 'kiosk'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: fullscreenMode === 'kiosk' ? accentColor : 'transparent',
                            backgroundColor: fullscreenMode === 'kiosk' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>全屏</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                覆盖整个屏幕包括任务栏
                              </div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => handleFullscreenModeChange('normal')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            fullscreenMode === 'normal'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: fullscreenMode === 'normal' ? accentColor : 'transparent',
                            backgroundColor: fullscreenMode === 'normal' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>全屏无边框</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                保留系统任务栏
                              </div>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {/* 视频播放设置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>视频播放</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>视频播放完毕行为</div>
                        <div className={`${textSecondary} text-sm`}>
                          选择MV视频播放结束后的行为
                        </div>
                      </div>
                      
                      {/* 视频结束行为选项 */}
                      <div className="space-y-3">
                        <button
                          onClick={() => handleVideoEndBehaviorChange('close')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            videoEndBehavior === 'close'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: videoEndBehavior === 'close' ? accentColor : 'transparent',
                            backgroundColor: videoEndBehavior === 'close' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-5 h-5" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>不重播</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                播放完毕后显示重播按钮
                              </div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => handleVideoEndBehaviorChange('replay')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            videoEndBehavior === 'replay'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: videoEndBehavior === 'replay' ? accentColor : 'transparent',
                            backgroundColor: videoEndBehavior === 'replay' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-5 h-5" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>自动重播</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                播放完毕后自动回到开头重播
                              </div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => handleVideoEndBehaviorChange('next')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            videoEndBehavior === 'next'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: videoEndBehavior === 'next' ? accentColor : 'transparent',
                            backgroundColor: videoEndBehavior === 'next' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-5 h-5" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>自动续播</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                播放完毕后自动播放下一个视频
                              </div>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {/* 主题色设置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>主题色</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      {/* 深浅色切换 */}
                      <div className="flex items-center justify-between mb-4 pb-4" style={{ borderBottom: `1px solid ${playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}` }}>
                        <div className={`${textPrimary} font-medium`}>外观主题</div>
                        <div className="flex gap-2">
                          {(['dark', 'light'] as const).map((themeOption) => (
                            <button
                              key={themeOption}
                              onClick={() => handlePlayerThemeChange(themeOption)}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                              style={{
                                backgroundColor:
                                  playerTheme === themeOption
                                    ? accentColor
                                    : playerTheme === 'dark'
                                    ? 'rgba(255,255,255,0.1)'
                                    : 'rgba(0,0,0,0.1)',
                                color:
                                  playerTheme === themeOption
                                    ? '#fff'
                                    : playerTheme === 'dark'
                                    ? 'rgba(255,255,255,0.6)'
                                    : 'rgba(0,0,0,0.6)',
                                boxShadow: playerTheme === themeOption ? `0 0 8px ${accentColor}30` : 'none',
                              }}
                            >
                              {themeOption === 'dark' ? (
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                              ) : (
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                              )}
                              {themeOption === 'dark' ? '深色' : '浅色'}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>选择主题色</div>
                        <div className={`${textSecondary} text-sm`}>
                          自定义应用的强调色
                        </div>
                      </div>
                      
                      {/* 色板 */}
                      <div className="grid grid-cols-4 gap-3">
                        {presetColors.map((color) => (
                          <button
                            key={color.value}
                            onClick={() => handleAccentColorChange(color.value)}
                            className={`relative p-3 rounded-xl transition-all ${
                              accentColor === color.value 
                                ? 'ring-2 ring-offset-2 scale-105' 
                                : 'hover:scale-105'
                            }`}
                            style={{
                              backgroundColor: color.value,
                              '--tw-ring-color': color.value,
                              ringOffsetColor: playerTheme === 'dark' ? '#000' : '#fff',
                            } as React.CSSProperties}
                          >
                            <div className="aspect-square rounded-lg" />
                            {accentColor === color.value && (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <svg className="w-6 h-6 text-white drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                      
                      {/* 色块下方显示颜色名称 */}
                      <div className={`mt-3 text-center ${textSecondary} text-sm`}>
                        当前：{presetColors.find(c => c.value === accentColor)?.name || '自定义'}
                      </div>
                    </div>
                  </div>

                </div>
              )}

              {/* 高级标签页 */}
              {activeTab === 'advanced' && (
                <div className="space-y-6">
                  {/* 播放过渡效果 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放过渡</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      选择歌曲切换时的过渡效果，提升听感体验
                    </p>
                    
                    {/* Crossfade 渐入渐出 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>渐入渐出 (Crossfade)</div>
                          <div className={`${textSecondary} text-sm`}>
                            在歌曲结束前开始淡出，同时淡入下一首
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={crossfadeEnabled}
                            onChange={(e) => handleCrossfadeToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: crossfadeEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {/* Crossfade 时长调节 */}
                      {crossfadeEnabled && (
                        <div className="mt-4 pt-4 border-t border-white/10">
                          <div className="flex items-center justify-between mb-2">
                            <span className={`${textSecondary} text-sm`}>过渡时长</span>
                            <span className={`${textPrimary} text-sm font-medium`}>{crossfadeDuration} 秒</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="12"
                            step="1"
                            value={crossfadeDuration}
                            onChange={(e) => handleCrossfadeDurationChange(parseInt(e.target.value))}
                            className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                            style={{
                              background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${((crossfadeDuration - 1) / 11) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} ${((crossfadeDuration - 1) / 11) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} 100%)`
                            }}
                          />
                        </div>
                      )}
                    </div>
                    
                    {/* Gapless 无缝衔接 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>无缝衔接 (Gapless)</div>
                          <div className={`${textSecondary} text-sm`}>
                            预加载下一首并在歌曲边界连续切换，消除歌曲间的空隙
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={gaplessEnabled}
                            onChange={(e) => handleGaplessToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: gaplessEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>

                      {gaplessEnabled && (
                        <div className="mt-4 pt-4 border-t border-white/10 space-y-4">
                          {/* 专辑融合 */}
                          <div className="flex items-center justify-between">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>专辑融合</div>
                              <div className={`${textSecondary} text-xs`}>
                                仅在同一专辑的相邻歌曲间使用尾部检测与 Equal Power 融合
                              </div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={albumGaplessEnabled}
                                onChange={(e) => handleAlbumGaplessToggle(e.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: albumGaplessEnabled ? accentColor : '' }}></div>
                            </label>
                          </div>

                        </div>
                      )}
                    </div>
                  </div>

                  {/* 网易云不可用歌曲补全 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>网易云可用性增强</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      当网易云官方没有返回播放链接时，可尝试从其他公开音乐源匹配同一首歌
                    </p>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1 flex items-center gap-2`}>
                            灰色歌曲跨平台补全
                            <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>Enhanced</span>
                          </div>
                          <div className={`${textSecondary} text-sm`}>
                            仅补全免费但受版权或地区影响的歌曲；VIP 与付费专辑不会绕过平台权限
                          </div>
                        </div>
                        <label className="relative inline-flex flex-shrink-0 items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={crossPlatformFallbackEnabled}
                            onChange={(event) => {
                              const enabled = event.target.checked
                              if (enabled) {
                                // 开启前先弹出免责声明，确认后才真正启用
                                setFallbackCountdown(20)
                                setShowFallbackDisclaimer(true)
                              } else {
                                setCrossPlatformFallbackEnabled(false)
                                localStorage.setItem('crossPlatformFallbackEnabled', JSON.stringify(false))
                              }
                            }}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: crossPlatformFallbackEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        使用本地服务完成匹配，不会开启系统代理、安装证书或修改网络设置。关闭后立即恢复仅使用网易云官方链接。
                      </div>
                    </div>
                  </div>
                  
                  {/* 第三方歌词源 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>第三方歌词源</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      启用后将从社区歌词库获取更丰富的歌词内容，包括逐字歌词和翻译
                    </p>
                    
                    {/* 启用第三方歌词源 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用第三方歌词源</div>
                          <div className={`${textSecondary} text-sm`}>
                            从 AMLL TTML DB 和 Lrclib 等社区歌词库获取高质量歌词
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={thirdPartyLyricsEnabled}
                            onChange={(e) => {
                              const enabled = e.target.checked
                              setThirdPartyLyricsEnabled(enabled)
                              localStorage.setItem('thirdPartyLyricsEnabled', JSON.stringify(enabled))
                              window.dispatchEvent(new Event('hyperplayer:lyrics-policy-changed'))
                            }}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: thirdPartyLyricsEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                    </div>

                    {/* 启用 Apple Music 歌词（已登录 AM 才可开启；登录后自动开启） */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用 Apple Music 歌词</div>
                          <div className={`${textSecondary} text-sm`}>
                            {appleLoggedIn
                              ? 'Apple 逐音节歌词与翻译（登录 Apple Music 后自动启用）'
                              : '需先登录 Apple Music 账号后才可启用'}
                          </div>
                        </div>
                        <label className={`relative inline-flex items-center ${appleLoggedIn ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                          <input
                            type="checkbox"
                            checked={appleMusic.enabled}
                            disabled={!appleLoggedIn}
                            onChange={(e) => updateAppleMusic({ enabled: e.target.checked })}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: appleMusic.enabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                    </div>

                    {/* Apple Music 动态封面 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>Apple Music 动态封面</div>
                          <div className={`${textSecondary} text-sm`}>播放页优先显示 Apple editorialVideo；不可用时自动回退静态封面</div>
                        </div>
                        <label className="relative inline-flex shrink-0 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={appleDynamicCoverEnabled}
                            onChange={(event) => {
                              setAppleDynamicCoverEnabledState(event.target.checked)
                              setAppleDynamicCoverEnabled(event.target.checked)
                            }}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: appleDynamicCoverEnabled ? accentColor : '' }} />
                        </label>
                      </div>
                    </div>

                    {/* Apple 原生音源（Cider 式直连 AM，需 Widevine；失败自动回退网易云/QQ） */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>Apple 原生音源</div>
                          <div className={`${textSecondary} text-sm`}>
                            直连 Apple 播放 AM 原版曲目（消除换源偏差），需浏览器/系统 Widevine 支持，失败自动回退网易云/QQ
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={appleNativeStreamEnabled}
                            onChange={(e) => {
                              const enabled = e.target.checked
                              setAppleNativeStreamEnabled(enabled)
                              localStorage.setItem('appleNativeStream', JSON.stringify(enabled))
                            }}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: appleNativeStreamEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                    </div>

                    {/* Apple Music 播放面（WebView2）：仅在原生 CENC 播放失败时作为兼容兜底；
                        兼容窗口保留独立登录会话，未授权时继续走网易云/QQ 载体兜底 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>Apple Music 播放面</div>
                          <div className={`${textSecondary} text-sm`}>
                            Electron 原生 CENC 无法播放时才启用此兼容窗口；首次使用需在窗口内单独登录 Apple Music。
                            {appleBridgeReady
                              ? (appleBridgeAuthorized ? '播放面已授权 ✓' : '播放面未授权：点「打开窗口」登录后即可作为兼容兜底')
                              : '正常播放无需启动；原生 CENC 失败时会自动拉起，也可手动打开登录'}
                          </div>
                        </div>
                        <button
                          onClick={toggleAppleBridgeWindow}
                          disabled={appleBridgeBusy}
                          className={`px-4 py-2 rounded-lg text-sm font-medium border ${borderColor} ${textPrimary} hover:opacity-80 disabled:opacity-50 whitespace-nowrap`}
                        >
                          {appleBridgeBusy ? '启动中…' : appleBridgeWindowVisible ? '隐藏窗口' : '打开窗口'}
                        </button>
                      </div>
                    </div>

                    {/* 自适应最佳歌词 */}
                    {thirdPartyLyricsEnabled && (
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                        <div className="flex items-center justify-between">
                          <div>
                            <div className={`${textPrimary} font-medium mb-1`}>自适应最佳歌词</div>
                            <div className={`${textSecondary} text-sm`}>
                              自动适配最佳歌词源，若关闭将使用当前平台源
                            </div>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={adaptiveLyrics}
                              onChange={(e) => {
                                const enabled = e.target.checked
                                setAdaptiveLyrics(enabled)
                                localStorage.setItem('adaptiveLyrics', JSON.stringify(enabled))
                                window.dispatchEvent(new Event('hyperplayer:lyrics-policy-changed'))
                              }}
                              className="sr-only peer"
                            />
                            <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: adaptiveLyrics ? accentColor : '' }}></div>
                          </label>
                        </div>
                      </div>
                    )}

                    {/* 歌词库选择 */}
                    {thirdPartyLyricsEnabled && adaptiveLyrics && (
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                        <div className={`${textPrimary} font-medium mb-3`}>首要歌词库</div>
                        <div className={`${textSecondary} text-sm mb-4`}>
                          仅请求当前歌曲平台及第三方来源，优先使用有逐字的歌词
                        </div>
                        
                        <div className="space-y-2">
                          {[
                            { key: 'AMLL', name: 'AMLL TTML DB', desc: '社区逐字歌词库（可含翻译与罗马音，以收录为准）' },
                            { key: 'Apple Music', name: 'Apple Music', desc: 'Apple Music 逐字歌词（对唱按演唱者着色）' },
                            { key: 'NetEase', name: '网易云音乐', desc: '仅网易云歌曲使用，其他平台自动回退' },
                            { key: 'QQMusic', name: 'QQ音乐', desc: '仅QQ歌曲使用，其他平台自动回退' },
                            { key: 'Platform', name: '当前平台', desc: '使用正在播放的平台' }
                          ].map((source) => (
                            <button
                              key={source.key}
                              onClick={() => {
                                setPrimaryLyricsSource(source.key)
                                localStorage.setItem('primaryLyricsSource', source.key)
                                window.dispatchEvent(new Event('hyperplayer:lyrics-policy-changed'))
                              }}
                              className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors border-2 ${
                                primaryLyricsSource === source.key
                                  ? playerTheme === 'dark'
                                    ? 'bg-white/5 hover:bg-white/10'
                                    : 'bg-black/5 hover:bg-black/10'
                                  : playerTheme === 'dark'
                                  ? 'bg-white/5 hover:bg-white/10 border-transparent'
                                  : 'bg-black/5 hover:bg-black/10 border-transparent'
                              }`}
                              style={{
                                borderColor: primaryLyricsSource === source.key ? accentColor : 'transparent',
                                backgroundColor: primaryLyricsSource === source.key 
                                  ? `${accentColor}20`
                                  : ''
                              }}
                            >
                              <div 
                                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center`}
                                style={{
                                  borderColor: primaryLyricsSource === source.key 
                                    ? accentColor 
                                    : playerTheme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
                                  backgroundColor: primaryLyricsSource === source.key ? accentColor : 'transparent'
                                }}
                              >
                                {primaryLyricsSource === source.key && (
                                  <div className="w-2 h-2 rounded-full bg-white"></div>
                                )}
                              </div>
                              <div className="flex-1 text-left">
                                <div className={`${textPrimary} text-sm font-medium`}>{source.name}</div>
                                <div className={`${textTertiary} text-xs`}>{source.desc}</div>
                              </div>
                              {primaryLyricsSource === source.key && (
                                <div 
                                  className={`px-2 py-1 rounded ${textPrimary} text-xs font-medium`}
                                  style={{ backgroundColor: `${accentColor}50` }}
                                >
                                  首选
                                </div>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 性能优化 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>性能优化</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      {!isTvModeActive() && (
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>GPU 硬件加速</div>
                          <div className={`${textSecondary} text-sm`}>使用显卡加速渲染动画，提升流畅度</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={gpuAcceleration}
                            onChange={(e) => void handleGpuAccelerationToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: gpuAcceleration ? accentColor : '' }}></div>
                        </label>
                      </div>
                      )}
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        {isTvModeActive() ? (
                          <div>TV 端渲染由系统 WebView 自动管理（GPU 合成），无需手动配置。当前状态：{gpuStatus?.actualEnabled ? 'GPU 合成已启用' : '未知'}</div>
                        ) : (
                          <>
                            <div>建议保持开启。动态壁纸、歌词动画和界面合成依赖 GPU；关闭后界面可能明显卡顿。仅建议在显卡驱动兼容故障时关闭，重启后生效。</div>
                            {gpuStatus && (
                              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                                <span>{gpuStatus.actualEnabled ? '当前已启用 GPU 合成' : '当前使用软件渲染'}</span>
                                {gpuStatus.gpu && <span>{gpuStatus.gpu.deviceString || gpuStatus.gpu.vendorString || '已检测显卡'}{gpuStatus.gpu.driverVersion ? ` | 驱动 ${gpuStatus.gpu.driverVersion}` : ''}</span>}
                                {gpuStatus.actualEnabled !== gpuAcceleration && <span className="text-amber-400">当前设置尚未生效，请重启软件</span>}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`} data-tv-hide="desktop">
                      <div className="mb-3">
                        <div className={`${textPrimary} font-medium mb-1`}>显卡选择</div>
                        <div className={`${textSecondary} text-sm`}>优先使用哪块显卡进行加速渲染（切换后重启生效）</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleGpuPreferenceChange('auto')}
                          className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'auto' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                          style={gpuPreference === 'auto' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                        >
                          自动
                        </button>
                        {(gpuStatus?.gpus ?? []).filter(g => g.kind === 'discrete').map(gpu => (
                          <button
                            key={gpu.vendorString + gpu.deviceString}
                            type="button"
                            onClick={() => void handleGpuPreferenceChange('discrete')}
                            className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'discrete' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                            style={gpuPreference === 'discrete' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                          >
                            <span className="font-medium">{gpu.deviceString || gpu.vendorString || '独立显卡'}</span>
                            <span className="ml-1.5 text-xs opacity-70">独显</span>
                          </button>
                        ))}
                        {(gpuStatus?.gpus ?? []).filter(g => g.kind === 'integrated').map(gpu => (
                          <button
                            key={gpu.vendorString + gpu.deviceString}
                            type="button"
                            onClick={() => void handleGpuPreferenceChange('integrated')}
                            className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'integrated' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                            style={gpuPreference === 'integrated' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                          >
                            <span className="font-medium">{gpu.deviceString || gpu.vendorString || '核显'}</span>
                            <span className="ml-1.5 text-xs opacity-70">核显</span>
                          </button>
                        ))}
                        {(!gpuStatus || (gpuStatus.gpus ?? []).filter(g => g.kind !== 'unknown').length === 0) && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleGpuPreferenceChange('discrete')}
                              className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'discrete' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                              style={gpuPreference === 'discrete' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                            >
                              独立显卡
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleGpuPreferenceChange('integrated')}
                              className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'integrated' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                              style={gpuPreference === 'integrated' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                            >
                              核显 / 集成显卡
                            </button>
                          </>
                        )}
                      </div>
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        默认使用独立显卡以获得最佳动画流畅度；笔记本想省电或独显驱动异常时可切换为核显或自动。切换后需重启软件生效。
                      </div>
                    </div>

                    {/* 全局高刷：渲染帧率跟随所在显示器刷新率（最高 300Hz） */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`} data-tv-hide="desktop">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>全局高刷</div>
                          <div className={`${textSecondary} text-sm`}>解除 60Hz 帧率限制，全局渲染跟随显示器刷新率（最高 360Hz），尤其提升播放页动画流畅度</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={highRefreshEnabled}
                            onChange={(e) => void handleHighRefreshToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: highRefreshEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>

                      {highRefreshEnabled && (
                        <>
                          {/* 档位选择：跟随显示器最高 / 30-360 */}
                          <div className="mt-4">
                            <div className={`mb-2 text-xs font-medium ${textSecondary}`}>渲染帧率</div>
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleHighRefreshHzChange(null)}
                                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${highRefreshHz === null ? 'border-transparent text-white' : `${borderColor} ${textSecondary} hover:opacity-80`}`}
                                style={highRefreshHz === null ? { backgroundColor: accentColor, boxShadow: `0 0 10px ${accentColor}44` } : undefined}
                              >
                                跟随显示器
                              </button>
                              {HIGH_REFRESH_OPTIONS.filter(hz => hz <= (displayInfo?.currentHz || 60)).map(hz => {
                                const active = highRefreshHz === hz
                                return (
                                  <button
                                    key={hz}
                                    type="button"
                                    onClick={() => void handleHighRefreshHzChange(hz)}
                                    className={`rounded-full border px-3 py-1.5 text-xs font-medium tabular-nums transition-all ${active ? 'border-transparent text-white' : `${borderColor} ${textSecondary} hover:opacity-80`}`}
                                    style={active ? { backgroundColor: accentColor, boxShadow: `0 0 10px ${accentColor}44` } : undefined}
                                    title={`${hz}Hz`}
                                  >
                                    {hz}
                                  </button>
                                )
                              })}
                            </div>
                            {highRefreshHz !== null && displayInfo && displayInfo.currentHz < highRefreshHz && (
                              <div className={`mt-2 text-[11px] text-amber-400`}>当前窗口所在显示器最高 {displayInfo.currentHz}Hz，已按此限制生效</div>
                            )}
                            {highRefreshHz === null && (
                              <div className={`mt-2 text-[11px] ${textTertiary}`}>跟随窗口所在显示器最高刷新率（当前 {displayInfo?.currentHz || 60}Hz），窗口移到其他显示器自动跟随</div>
                            )}
                          </div>
                        </>
                      )}

                      {displayInfo && (
                        <div className={`mt-3 space-y-1 rounded-lg p-3 text-xs ${textTertiary}`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-[13px]" style={{ color: textPrimary }}>当前渲染帧率</span>
                            <span className="tabular-nums" style={{ color: highRefreshEnabled ? accentColor : undefined }}>{displayInfo.currentHz || 60} Hz</span>
                            {highRefreshEnabled && <span className="ml-1 rounded-full px-2 py-0.5 text-[10px] text-white" style={{ background: accentColor }}>高刷已开启</span>}
                          </div>
                          <div className="mt-2 space-y-0.5">
                            {displayInfo.displays?.map(display => (
                              <div key={display.id} className="flex items-center justify-between gap-2">
                                <span className="truncate">
                                  {display.isMainWindow ? '🖥️ ' : ''}{display.label}
                                  {display.isPrimary ? ' · 主屏' : ''}
                                  {display.isMainWindow ? ' · 窗口所在' : ''}
                                </span>
                                {display.frequency >= 120 && <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">高刷屏</span>}
                              </div>
                            ))}
                          </div>
                          {displayInfo.error && <div className="mt-1 text-amber-400">显示器信息读取失败：{displayInfo.error}</div>}
                          <div className="mt-1">开启后立即生效；窗口移到其他显示器时自动跟随该显示器刷新率。</div>
                        </div>
                      )}
                    </div>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>音频频谱分析</div>
                          <div className={`${textSecondary} text-sm`}>用于封面脉动等可视化效果</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={audioAnalyzerEnabled}
                            onChange={(e) => handleAudioAnalyzerToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: audioAnalyzerEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        关闭后会降低 CPU 占用，适合低性能设备或省电场景。
                      </div>
                    </div>
                  </div>

                  {/* 开发者选项 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>开发者选项</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div className={`${textPrimary} font-medium`}>开发者模式</div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={developerMode}
                            onChange={(e) => handleDeveloperModeToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: developerMode ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {/* 警告文案 */}
                      {developerMode && (
                        <div className={`mt-3 p-3 rounded-lg ${playerTheme === 'dark' ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-100 border border-yellow-300'}`}>
                          <p className={`text-xs ${playerTheme === 'dark' ? 'text-yellow-300' : 'text-yellow-800'}`}>
                            ⚠️ 当前模式仅限调试作用，无问题情况下请勿打开
                          </p>
                        </div>
                      )}

                      {/* 调试面板子开关（开发者模式开启后显示） */}
                      {developerMode && (
                        <>
                          <div className="mt-3">
                            <VmpStatusCard
                              dark={playerTheme === 'dark'}
                              accent={accentColor}
                              borderColor={playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}
                            />
                          </div>
                          {/* 过渡调试：显示过渡用的引擎/策略/效果清单弹窗 */}
                          <label className="flex items-center justify-between py-1.5 cursor-pointer">
                            <span className={`text-xs ${textSecondary}`}>过渡调试（右上角显示过渡详情）</span>
                            <span className="relative inline-flex items-center">
                              <input
                                type="checkbox"
                                checked={transitionDebugEnabled}
                                onChange={(e) => handleTransitionDebugToggle(e.target.checked)}
                                className="sr-only peer"
                              />
                              <span className={`w-9 h-5 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all`} style={{ backgroundColor: transitionDebugEnabled ? accentColor : '' }}></span>
                            </span>
                          </label>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 缓存清理 */}
                  <div className="mt-8">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>缓存管理</h3>
                    
                    {/* 缓存清理按钮 */}
                    <button
                      onClick={() => setShowCacheClear(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all text-left`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div 
                            className="w-10 h-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: `${accentColor}20` }}
                          >
                            <Trash2 className="w-5 h-5" style={{ color: accentColor }} />
                          </div>
                          <div>
                            <div className={`${textPrimary} font-medium mb-1`}>缓存清理</div>
                            <div className={`${textSecondary} text-sm`}>
                              管理封面、歌单列表和错误日志缓存
                            </div>
                          </div>
                        </div>
                        <ChevronRight className={`w-5 h-5 ${textSecondary}`} />
                      </div>
                    </button>
                  </div>

                  {/* 看歌本地标记库 */}
                  <button
                    type="button"
                    onClick={() => {
                      setLocalMvMarks(getLocalMvMarks())
                      setShowLocalMvMarks(true)
                    }}
                    className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all text-left`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                          <FolderHeart className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>看歌本地标记库</div>
                          <div className={`${textSecondary} text-sm`}>查看/移除你手动标记的歌曲对应 MV（{getLocalMvMarks().length} 条）</div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textSecondary}`} />
                    </div>
                  </button>

                  {/* 清除 MV 匹配缓存 */}
                  <button
                    type="button"
                    onClick={() => {
                      if (!window.confirm('清除所有 MV 匹配缓存（24h 内存结果 + 手动标记 + 黑名单）？将重新搜索当前歌曲的 MV。')) return
                      clearAllMvMatchCache()
                      window.location.reload()
                    }}
                    className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all text-left`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                          <Trash2 className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>清除 MV 匹配缓存</div>
                          <div className={`${textSecondary} text-sm`}>MV 匹配结果不对/想换一个视频时使用（重搜当前歌曲）</div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textSecondary}`} />
                    </div>
                  </button>
                </div>
              )}

              {/* 关于标签页 */}
              {activeTab === 'about' && (
                <div className="space-y-4 pb-4">
                  <section className={`${bgCard} rounded-2xl border ${borderColor} overflow-hidden`}>
                    <div className="p-5">
                      <div className="flex items-start justify-between gap-4 mb-5">
                        <div>
                          <div className={`text-xs font-semibold tracking-[0.2em] uppercase ${textTertiary} mb-2`}>About</div>
                          <h2 className={`text-2xl font-bold ${textPrimary}`}>关于 HyperPlayer</h2>
                        </div>
                        <span className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${playerTheme === 'dark' ? 'bg-white/10 text-white/70' : 'bg-black/5 text-black/60'}`}>
                          {getVersionLabel(packageInfo.version)}
                        </span>
                      </div>

                      <div className={`rounded-xl border ${borderColor} p-4 relative`}>
                        <div className="flex items-center gap-4 pr-10">
                          <img src={appLogoUrl} alt="HyperPlayer" className="w-14 h-14 rounded-xl object-cover shadow-lg shrink-0" />
                          <div className="min-w-0">
                            <p className={`text-xs ${textTertiary} mb-1`}>开发者</p>
                            <p className={`text-lg font-semibold leading-6 ${textPrimary}`}>Yoshino / Castorice</p>
                            <p className={`text-lg font-semibold leading-6 ${textPrimary}`}>IceFire_Icer</p>
                            <p className={`text-sm leading-6 ${textSecondary} mt-1`} style={{ textWrap: 'pretty' }}>HyperPlayer的开发与维护</p>
                          </div>
                        </div>
                        <button
                          onClick={() => openExternal('https://www.afdian.com/a/Kirito666233')}
                          title="支持 HyperPlayer"
                          aria-label="支持 HyperPlayer"
                          className="absolute top-3 right-3 w-9 h-9 rounded-full flex items-center justify-center text-white transition-all hover:scale-110 hover:shadow-md"
                          style={{ background: `linear-gradient(135deg, ${accentColor}, #ff5b9d)`, boxShadow: `0 6px 16px ${accentColor}24` }}
                        >
                          <Heart className="w-4 h-4" fill="currentColor" />
                        </button>
                      </div>

                      <div className={`mt-4 pt-4 border-t ${borderColor}`}>
                        <div>
                          <p className={`font-medium ${textPrimary}`}>查看软件源代码</p>
                          <p className={`text-sm ${textSecondary} mt-1`}>前往 GitHub 仓库查看源码与更新</p>
                        </div>
                        <div className="mt-3 grid grid-cols-1 gap-3 w-full">
                          <button onClick={() => openExternal('https://github.com/SoundFieldLab/HyperPlayer')} className={`rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-4 py-3 flex items-center justify-center gap-2 transition-colors`}>
                            <Github className="w-4 h-4" /><span className="text-sm font-medium">GitHub</span><ExternalLink className="w-3.5 h-3.5 opacity-60" />
                          </button>
                        </div>
                      </div>

                      <div className={`mt-4 pt-4 border-t ${borderColor}`}>
                        {/* 更新渠道：正式版 / 每日构建 */}
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className={`text-sm font-medium ${textPrimary}`}>更新渠道</p>
                            <p className={`text-xs ${textTertiary} mt-0.5`}>
                              {updateChannel === 'nightly'
                                ? '接收每天自动构建的测试版，可能不稳定'
                                : '接收正式发布版本，最稳定'}
                            </p>
                          </div>
                          <div className={`flex shrink-0 rounded-xl p-1 ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/5'}`}>
                            {(['stable', 'nightly'] as const).map((channel) => (
                              <button
                                key={channel}
                                type="button"
                                onClick={() => {
                                  if (channel === updateChannel) return
                                  writeUpdateChannel(channel)
                                  setUpdateChannel(channel)
                                  // 切渠道后旧检查结果/跳过记录不适用，重置避免误导
                                  setUpdateCheck({ status: 'idle' })
                                  setSkippedVersion(null)
                                  localStorage.removeItem('skippedUpdateVersion')
                                }}
                                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${updateChannel === channel ? 'text-white' : textSecondary}`}
                                style={updateChannel === channel ? { backgroundColor: accentColor } : undefined}
                              >
                                {UPDATE_CHANNEL_LABEL[channel]}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* 检查新版本 + 版本历史 */}
                        <div className="mt-4 flex gap-3 w-full">
                          <button onClick={() => void checkForUpdates()} disabled={updateCheck.status === 'checking'} className={`flex-1 py-3 px-4 rounded-xl ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/15' : 'bg-black/5 hover:bg-black/10'} ${textPrimary} font-medium transition-colors disabled:opacity-60`}>
                            {updateCheck.status === 'checking' ? '正在检查新版本…' : '检查新版本'}
                          </button>
                          <button onClick={() => setShowVersionHistory(true)} className={`py-3 px-4 rounded-xl border ${borderColor} ${textPrimary} text-sm font-medium transition-colors ${hoverBg}`}>版本历史</button>
                        </div>

                        {/* 检查结果：有更新 → 当前/新版本 + 查看详情；无更新 → 当前为最新 */}
                        {updateCheck.message && (
                          <div className="mt-3">
                            {updateCheck.status === 'available' ? (
                              <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-3" style={{ background: `${accentColor}12`, border: `1px solid ${accentColor}33` }}>
                                <span className={`text-sm ${textPrimary}`}>{updateCheck.message}</span>
                                <button onClick={openUpdateDetails} className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-white" style={{ backgroundColor: accentColor }}>查看详情</button>
                              </div>
                            ) : (
                              <p className={`${updateCheck.status === 'error' ? 'text-red-400' : textSecondary} text-center text-sm`}>{updateCheck.message}</p>
                            )}
                          </div>
                        )}

                        {/* 待应用更新常驻提示（上次「稍后」/ 已下载完成，重启即生效） */}
                        {pendingUpdate?.version && (
                          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl px-4 py-3" style={{ background: `${accentColor}12`, border: `1px solid ${accentColor}33` }}>
                            <span className={`text-sm ${textPrimary}`}>新版本 {getVersionDisplay(pendingUpdate.version)} 已就绪，重启软件生效</span>
                            <button onClick={() => void handleRestartForUpdate()} className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-white" style={{ backgroundColor: accentColor }}>立即重启</button>
                          </div>
                        )}

                        {/* 自动检测新版本（可关闭） */}
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className={`text-sm font-medium ${textPrimary}`}>自动检测新版本</p>
                            <p className={`text-xs ${textTertiary} mt-0.5`}>每次启动时后台检测，发现新版本仅提示</p>
                          </div>
                          <label className="relative inline-flex flex-shrink-0 items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={autoCheckUpdate}
                              onChange={(e) => {
                                setAutoCheckUpdate(e.target.checked)
                                localStorage.setItem('autoCheckUpdate', JSON.stringify(e.target.checked))
                              }}
                              className="sr-only peer"
                            />
                            <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: autoCheckUpdate ? accentColor : '' }} />
                          </label>
                        </div>

                        {/* 跳过此版本：自动检测不再提示该版本，手动检查仍可更新 */}
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className={`text-sm font-medium ${textPrimary}`}>跳过此版本</p>
                            <p className={`text-xs ${textTertiary} mt-0.5`}>
                              {skippedVersion
                                ? `已跳过版本 ${getVersionDisplay(skippedVersion)} 的更新提示，您仍可手动检查新版本进行更新`
                                : '当前版本不再提示更新，但是您仍可手动检查新版本进行更新'}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={skippedVersion ? handleUnskipVersion : () => void handleSkipVersion()}
                            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${skippedVersion ? `${textSecondary} border ${borderColor} hover:bg-white/5` : 'text-white'}`}
                            style={skippedVersion ? undefined : { backgroundColor: accentColor }}
                          >
                            {skippedVersion ? '取消跳过' : '跳过此版本'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className={`${bgCard} rounded-2xl border ${borderColor} p-5`}>
                    <div className="flex items-start gap-4">
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}><Users className="w-5 h-5" /></div>
                      <div>
                        <h3 className={`text-lg font-semibold ${textPrimary}`}>特别鸣谢 / 粉丝开发者</h3>
                        <p className={`mt-3 font-medium ${textPrimary}`}>HyperPlayer群的各位</p>
                        <p className={`mt-1.5 text-sm leading-6 ${textSecondary}`}>感谢各位朋友们对软件的喜爱与鼓励。</p>
                      </div>
                    </div>
                  </section>

                  {/* 法律声明 / 用户协议入口（条款含免责声明，对外分发必需） */}
                  <section className={`${bgCard} rounded-2xl border ${borderColor} overflow-hidden`}>
                    <button
                      type="button"
                      onClick={() => setShowLegalModal(true)}
                      className={`w-full p-5 flex items-center justify-between gap-4 text-left ${hoverBg} transition-colors`}
                    >
                      <div className="flex items-start gap-4">
                        <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}><Info className="w-5 h-5" /></div>
                        <div>
                          <h3 className={`text-lg font-semibold ${textPrimary}`}>法律声明 / 用户协议</h3>
                          <p className={`mt-1.5 text-sm leading-6 ${textSecondary}`}>查看完整条款，含版权、免责声明与责任限制</p>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 shrink-0 ${textTertiary}`} />
                    </button>
                  </section>

                  <div className="flex items-center justify-center px-1">
                    <p className={`${textTertiary} text-xs`}>© 2026 HyperPlayer. All rights reserved.</p>
                  </div>
                </div>
              )}
                        </div>
</div> {/* 关闭内容层 div from line 144 */}
          </motion.div>
        </React.Fragment>
      )}
      
      {/* 首页自定义弹窗 */}
      <HomeCustomizeModal 
        key="home-customize-modal"
        show={showHomeCustomize}
        onClose={() => setShowHomeCustomize(false)}
        playerTheme={playerTheme}
        onBlurAdjustOpen={() => {
          // 当打开模糊度调整时，关闭设置面板
          onClose()
        }}
        onReopenRequest={() => {
          // 重新打开首页自定义面板
          setShowHomeCustomize(true)
        }}
      />
      
      {/* 播放轮盘设置弹窗 */}
      <PlaybackRadialMenuCustomizeModal
        show={showPlaybackRadialCustomize}
        onClose={() => setShowPlaybackRadialCustomize(false)}
        playerTheme={playerTheme}
        accentColor={accentColor}
      />

      {/* 缓存清理弹窗 */}
      {/* 播放音质弹窗 */}
      <AudioQualitySettingsModal
        key="audio-quality-settings-modal"
        show={showAudioQuality}
        onClose={() => setShowAudioQuality(false)}
        playerTheme={playerTheme}
        neteaseVip={neteaseVip}
        qqVip={qqVip}
        neteaseLoggedIn={neteaseLoggedIn}
        qqLoggedIn={qqLoggedIn}
        spotifyLoggedIn={spotifyLoggedIn}
        appleLoggedIn={appleLoggedIn}
      />

      {/* 远程遥控器设置弹窗已随减配移除 */}

      <CacheClearModal 
        key="cache-clear-modal"
        show={showCacheClear}
        onClose={() => setShowCacheClear(false)}
        playerTheme={playerTheme}
      />
      

      {/* 哔哩哔哩「看歌」扫码登录弹窗 */}
      {showBiliProfile && (
        <BilibiliProfileModal onClose={() => setShowBiliProfile(false)} playerTheme={playerTheme} />
      )}

      {/* 看歌本地标记库弹窗 */}
      {showLocalMvMarks && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 sm:p-10"
          onClick={() => setShowLocalMvMarks(false)}
        >
          <motion.div
            initial={{ scale: 0.96, y: 14 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 14 }}
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-xl max-h-[80vh] rounded-2xl border overflow-hidden flex flex-col shadow-2xl ${playerTheme === 'dark' ? 'bg-[#0c0e1a]/[0.98] border-white/10' : 'bg-white/[0.98] border-black/10'}`}
          >
            <div className={`flex items-center justify-between px-5 py-4 border-b ${borderColor}`}>
              <div>
                <h3 className={`text-base font-bold ${textPrimary}`}>看歌本地标记库</h3>
                <p className={`text-xs mt-0.5 ${textSecondary}`}>手动标记的歌曲对应的 MV（仅保存在本机，移除后恢复自动匹配）</p>
              </div>
              <button type="button" onClick={() => setShowLocalMvMarks(false)} className={`p-1.5 rounded-lg ${playerTheme === 'dark' ? 'hover:bg-white/10 text-white/60' : 'hover:bg-black/5 text-black/50'}`}>
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {localMvMarks.length === 0 ? (
                <p className={`text-center text-sm py-10 ${textTertiary}`}>还没有标记记录。在看歌搜索失败时手动选择一个视频播放，15 秒后会询问是否标记为该歌曲的 MV。</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {localMvMarks.map((m) => (
                    <div key={m.songKey} className={`flex items-center gap-3 rounded-xl p-2.5 ${bgCard}`}>
                      <div className="w-20 h-12 rounded-lg overflow-hidden bg-white/10 flex-shrink-0">
                        {m.pic ? (
                          <img src={resolveBiliPic(m.pic)} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />
                        ) : null}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`truncate text-sm font-medium ${textPrimary}`}>{m.songTitle} <span className={`text-xs font-normal ${textTertiary}`}>· {m.artist}</span></p>
                        <p className={`truncate text-xs mt-0.5 ${textTertiary}`}>{m.videoTitle}</p>
                        <p className={`text-[11px] mt-0.5 ${textTertiary}`}>标记于 {new Date(m.markedAt).toLocaleDateString()}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          removeLocalMvMark(m.songKey)
                          setLocalMvMarks(getLocalMvMarks())
                        }}
                        className="p-2 rounded-lg text-red-400/80 hover:bg-red-500/15 hover:text-red-400 transition-colors flex-shrink-0"
                        title="移除标记"
                      >
                        <Trash size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}

      {showBiliLogin && (
        <BilibiliLoginPanel
          onClose={() => setShowBiliLogin(false)}
          onLoginSuccess={() => {
            setShowBiliLogin(false)
            refreshBiliAuth()
          }}
        />
      )}

      {/* 版本历史弹窗 */}
      {showVersionHistory && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[300] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}
          onClick={() => setShowVersionHistory(false)}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md overflow-hidden rounded-3xl shadow-2xl relative"
          >
            <div className="absolute inset-0 rounded-3xl overflow-hidden">
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(30,30,45,0.96) 0%, rgba(20,20,30,0.98) 50%, rgba(12,12,20,0.98) 100%)', backdropFilter: 'blur(80px) saturate(200%)' }} />
              <div className="absolute inset-0 rounded-3xl" style={{ border: '1px solid rgba(255,255,255,0.14)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.12)', pointerEvents: 'none' }} />
            </div>
            <div className="relative z-10 p-5 border-b flex items-center justify-between" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <div>
                <h3 className="text-base font-semibold text-white">版本历史</h3>
                <p className="text-white/55 text-xs mt-0.5">HyperPlayer 各版本更新内容</p>
              </div>
              <button type="button" onClick={() => setShowVersionHistory(false)} className="p-2 rounded-full transition-colors hover:bg-white/15 -m-1">
                <X className="w-5 h-5 text-white/60" />
              </button>
            </div>
            <div className="relative z-10 max-h-[60vh] overflow-y-auto p-5 space-y-5">
              {VERSION_HISTORY.map((entry) => (
                <div key={entry.version} className="rounded-2xl p-4" style={entry.current ? { background: 'rgba(99,102,241,0.14)', border: '1px solid rgba(99,102,241,0.35)' } : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-semibold text-white">v{entry.version}</span>
                    <span className="text-xs text-white/40">{entry.date}</span>
                    {entry.current && <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full text-white" style={{ background: 'rgba(99,102,241,0.6)' }}>当前版本</span>}
                  </div>
                  <pre className="text-xs leading-relaxed whitespace-pre-wrap text-white/75 font-sans" style={{ margin: 0 }}>{entry.notes}</pre>
                </div>
              ))}
            </div>
            <div className="relative z-10 p-5 pt-0">
              <button type="button" onClick={() => setShowVersionHistory(false)} className="w-full py-2.5 px-4 rounded-xl font-medium text-white transition-colors hover:bg-white/10" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}>关闭</button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* 法律声明 / 用户协议弹窗（关于页入口；条款为简体中文单语，保留免责声明） */}
      {showLegalModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => setShowLegalModal(false)}
        >
          <motion.div
            initial={{ scale: 0.95, y: 16 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.97, y: 10 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className={`relative w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border ${borderColor}`}
            style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(18,18,20,0.98)' : 'rgba(255,255,255,0.98)' }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={`flex items-center justify-between gap-4 border-b ${borderColor} px-6 py-4`}>
              <h2 className={`text-xl font-bold ${textPrimary}`}>法律声明与用户协议</h2>
              <button
                type="button"
                onClick={() => setShowLegalModal(false)}
                aria-label="关闭"
                className={`rounded-full p-2 ${hoverBg} transition-colors`}
              >
                <X className={`w-5 h-5 ${textSecondary}`} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-8">
              <LegalAgreement theme={playerTheme} />
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* 灰色歌曲跨平台补全：开启前免责声明弹窗 */}
      {showFallbackDisclaimer && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => setShowFallbackDisclaimer(false)}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className={`${playerTheme === 'dark' ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-gray-200'} rounded-2xl border shadow-2xl max-w-lg w-full overflow-hidden flex flex-col`}
          >
            {/* 标题栏 */}
            <div className={`flex items-center justify-between px-6 py-4 border-b ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <h2 className={`text-lg font-bold ${textPrimary}`}>灰色歌曲跨平台补全 · 免责声明</h2>
              <button
                onClick={() => setShowFallbackDisclaimer(false)}
                className={`p-2 rounded-lg ${hoverBg} transition-colors`}
              >
                <X className={`w-5 h-5 ${textSecondary}`} />
              </button>
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className={`space-y-4 ${textSecondary} text-sm leading-relaxed`}>
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>开启前请仔细阅读</h3>
                  <p>
                    "灰色歌曲跨平台补全"会在网易云音乐官方未返回播放链接时，从其他公开音乐源匹配并播放同一首歌。开启该功能即表示您已知悉并同意以下内容：
                  </p>
                </section>
                <ul className={`list-disc pl-5 space-y-1.5`}>
                  <li>本功能属于第三方客户端的跨平台音源匹配，未获得各音乐平台的授权，可能违反相关平台的服务条款（如网易云音乐《服务条款》第 8.5 条、QQ音乐《服务许可协议》第 5.1.1 条等），可能导致账号风控、功能受限或账号封禁；</li>
                  <li>匹配到的音源可能与原曲在版本、歌手、音质、歌词等方面存在差异，仅供个人非商业性试听，其版权归原权利人所有；</li>
                  <li>本功能仅补全免费但受版权或地区影响的歌曲，不会绕过 VIP、付费专辑等平台付费权限；</li>
                  <li>因使用本功能产生的账号风险与相关纠纷，均由您自行与相关平台解决，软件开发者不承担任何责任。</li>
                </ul>
                <div className={`rounded-lg p-3 text-xs ${playerTheme === 'dark' ? 'bg-zinc-800/50' : 'bg-gray-100'} ${textTertiary}`}>
                  请仔细阅读以上内容。确认开启后，本软件将在本地保存您的选择；您可随时在设置中关闭该功能。
                </div>
              </div>
            </div>

            {/* 底部按钮 */}
            <div className={`flex items-center justify-end gap-3 px-6 py-4 border-t ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <button
                onClick={() => setShowFallbackDisclaimer(false)}
                className={`px-5 py-2.5 rounded-xl ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/15' : 'bg-black/5 hover:bg-black/10'} ${textPrimary} text-sm font-medium transition-colors`}
              >
                取消
              </button>
              <button
                onClick={confirmFallbackEnable}
                disabled={fallbackCountdown > 0}
                className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${fallbackCountdown > 0 ? 'opacity-50 cursor-not-allowed' : 'hover:-translate-y-0.5 hover:shadow-lg'}`}
                style={{ backgroundColor: accentColor, boxShadow: fallbackCountdown > 0 ? undefined : `0 10px 28px ${accentColor}24` }}
              >
                确定{fallbackCountdown > 0 ? `（${fallbackCountdown}）` : ''}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// 常驻挂载（保活首页自定义/模糊度子弹窗链路），播放中 App 约 1Hz 重渲染时
// props 稳定则跳过整棵子树重渲染，保留内部全部 hooks 与状态。
export default memo(SettingsPanel)

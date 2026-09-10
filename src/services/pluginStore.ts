/**
 * 插件系统数据层：安装清单 / 开关状态 / 使用须知标记 的持久化，
 * 以及插件弹窗的全局宿主状态（谁打开、开哪个）——非 React 单例，组件用
 * useSyncExternalStore 订阅，任意位置可直接调用 open/close（如三个模式的入口按钮）。
 */

import { useSyncExternalStore } from 'react'
import type { PluginManifest } from '../plugins/types'

const PLUGINS_KEY = 'wf_plugins'
const PLUGIN_FLAGS_KEY = 'wf_plugin_flags'

export const PLUGIN_STATE_EVENT = 'pluginStateChanged'

/* ---------------------------------- 通用小工具 ---------------------------------- */

const safeGet = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const safeSet = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 存储不可用时静默失败 */
  }
}

function parseStored<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

/* ---------------------------------- 插件状态 ---------------------------------- */

interface PluginStates {
  [id: string]: { enabled: boolean }
}

export interface PluginFlagsMap {
  [id: string]: { detailViewed?: boolean; consent?: boolean }
}

const INSTALLED_KEY = 'wf_installed_plugins'

/** 读取已安装的导入插件 manifest 列表（内置插件不在此列）。 */
export function getImportedPluginManifests(): PluginManifest[] {
  try {
    const raw = safeGet(INSTALLED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function installImportedPlugin(manifest: PluginManifest): { ok: true } | { ok: false; error: string } {
  const list = getImportedPluginManifests()
  if (list.some(p => p.id === manifest.id)) {
    return { ok: false, error: `插件「${manifest.name}」已安装` }
  }
  setPluginStates({
    ...getPluginStates(),
    [manifest.id]: { enabled: false },
  })
  safeSet(INSTALLED_KEY, JSON.stringify([...list, { ...manifest, source: 'imported', installedAt: Date.now() }]))
  notifyState()
  return { ok: true }
}

export function uninstallImportedPlugin(id: string) {
  safeSet(INSTALLED_KEY, JSON.stringify(getImportedPluginManifests().filter(p => p.id !== id)))
  const states = getPluginStates()
  delete states[id]
  setPluginStates(states)
  const flags = getPluginFlags()
  delete flags[id]
  setPluginFlags(flags)
  notifyState()
}

const EMPTY_STATES: PluginStates = {}
const EMPTY_FLAGS: PluginFlagsMap = {}

function getPluginStates(): PluginStates {
  return parseStored<PluginStates>(safeGet(PLUGINS_KEY), EMPTY_STATES)
}

function setPluginStates(states: PluginStates) {
  safeSet(PLUGINS_KEY, JSON.stringify(states))
}

function getPluginFlags(): PluginFlagsMap {
  return parseStored<PluginFlagsMap>(safeGet(PLUGIN_FLAGS_KEY), EMPTY_FLAGS)
}

function setPluginFlags(flags: PluginFlagsMap) {
  safeSet(PLUGIN_FLAGS_KEY, JSON.stringify(flags))
}

function notifyState() {
  window.dispatchEvent(new CustomEvent(PLUGIN_STATE_EVENT))
}

/** 插件是否已启用（默认全关，用户手动开启后记住）。 */
export function isPluginEnabled(id: string): boolean {
  return Boolean(getPluginStates()[id]?.enabled)
}

export function setPluginEnabled(id: string, enabled: boolean) {
  const states = getPluginStates()
  states[id] = { ...states[id], enabled }
  setPluginStates(states)
  notifyState()
}

export function hasViewedDetail(id: string): boolean {
  return Boolean(getPluginFlags()[id]?.detailViewed)
}

export function markDetailViewed(id: string) {
  const flags = getPluginFlags()
  flags[id] = { ...flags[id], detailViewed: true }
  setPluginFlags(flags)
  notifyState()
}

export function hasPluginConsent(id: string): boolean {
  return Boolean(getPluginFlags()[id]?.consent)
}

export function setPluginConsent(id: string, consent: boolean) {
  const flags = getPluginFlags()
  flags[id] = { ...flags[id], consent }
  setPluginFlags(flags)
  notifyState()
}

/* ---------------------------------- 宿主状态（弹窗开关） ---------------------------------- */

export type NoticeKind = 'view' | 'consent'

export interface PluginNoticeState {
  pluginId: string
  kind: NoticeKind
  /** view：进入详情前的使用须知；consent：首次开启功能前的确认。 */
  onResolve: (ok: boolean) => void
}

export interface PluginHostState {
  centerOpen: boolean
  detailPluginId: string | null
  importOpen: boolean
  chromaConsoleOpen: boolean
  activeConsolePluginId: string | null
  notice: PluginNoticeState | null
}

const EMPTY_HOST: PluginHostState = {
  centerOpen: false,
  detailPluginId: null,
  importOpen: false,
  chromaConsoleOpen: false,
  activeConsolePluginId: null,
  notice: null,
}

function createHostStore() {
  let snapshot: PluginHostState = EMPTY_HOST
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (patch: Partial<PluginHostState>) => {
      snapshot = { ...snapshot, ...patch }
      listeners.forEach(l => l())
    },
  }
}

const hostStore = createHostStore()

export function getPluginHostState(): PluginHostState {
  return hostStore.getSnapshot()
}

export function usePluginHostState(): PluginHostState {
  return useSyncExternalStore(hostStore.subscribe, hostStore.getSnapshot, hostStore.getSnapshot)
}

/* ------------------------------ 宿主操作（入口按钮/卡片共用） ------------------------------ */

export function openPluginCenter() {
  hostStore.set({ centerOpen: true })
}

export function closePluginCenter() {
  hostStore.set({ centerOpen: false, detailPluginId: null, importOpen: false })
}

export function openPluginDetail(id: string) {
  hostStore.set({ detailPluginId: id })
}

export function closePluginDetail() {
  hostStore.set({ detailPluginId: null, notice: null })
}

export function openPluginImport() {
  hostStore.set({ importOpen: true })
}

export function closePluginImport() {
  hostStore.set({ importOpen: false })
}

export function openPluginConsole(pluginId: string) {
  hostStore.set({ activeConsolePluginId: pluginId })
}

export function closePluginConsole(pluginId?: string) {
  const active = hostStore.getSnapshot().activeConsolePluginId
  if (!pluginId || active === pluginId) hostStore.set({ activeConsolePluginId: null })
}

export function openChromaConsole() {
  hostStore.set({ chromaConsoleOpen: true })
}

export function closeChromaConsole() {
  hostStore.set({ chromaConsoleOpen: false })
}

/** 弹出使用须知；resolve(true) = 用户确认。 */
export function requestNotice(notice: PluginNoticeState) {
  hostStore.set({ notice })
}

export function resolveNotice(ok: boolean) {
  const current = hostStore.getSnapshot().notice
  hostStore.set({ notice: null })
  if (current) current.onResolve(ok)
}
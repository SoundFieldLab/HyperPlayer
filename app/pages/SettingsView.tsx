import { useEffect, useState } from "react";
import { CheckCircle, Keyboard, LockKey, SlidersHorizontal, UserCircle, WarningCircle } from "@phosphor-icons/react";
import type { AppSettingsDto, BackendNeteaseStatusDto, CacheStatsDto, LibraryOverviewDto, UpdaterStatusDto, UpdateCheckDto } from "../bridge/contracts";
import { bridge } from "../bridge";
import { useAppStore } from "../store";
import { Segmented, SettingRow, Toggle } from "../components/ui";

const GIB = 1024 * 1024 * 1024;
const CACHE_CAPACITY_MIN_GIB = 2;
const CACHE_CAPACITY_MAX_GIB = 100;
const CACHE_CAPACITY_OPTIONS = [2, 5, 10, 20, 50, 100] as const;

function cacheCapacityGiB(bytes: number): number {
  return Math.round(bytes / GIB);
}

function formatGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(bytes >= GIB ? 0 : 1)} GB`;
}

const categories = [
  ["appearance", "外观"], ["playback", "播放"], ["audio", "音频与 DSP"],
  ["library", "曲库"], ["cache", "缓存"], ["account", "网易云账号"],
  ["shortcuts", "导航与快捷键"], ["system", "系统集成"], ["privacy", "隐私"], ["about", "关于"],
] as const;

/** 各状态源独立加载超时：任一 promise 挂起（如网易云网络请求、Rust 命令无响应）只降级自身分区 */
export const STATUS_TIMEOUT_MS = 8_000;

type Remote<T> = { data: T | null; error: string | null; loading: boolean };
const remote = <T,>(): Remote<T> => ({ data: null, error: null, loading: true });

/** 读取态统一文案：有数据渲染数据，失败显示「暂不可用」，其余显示「读取中」 */
function readout<T>(state: Remote<T>, render: (data: T) => string): string {
  if (state.data !== null) return render(state.data);
  return state.error ? "暂不可用" : "读取中";
}

function ReadonlyRow({ title, detail, value }: { title: string; detail: string; value: string }): React.JSX.Element {
  return <SettingRow title={title} detail={detail}><span className="mono">{value}</span></SettingRow>;
}

export function SettingsView(): React.JSX.Element | null {
  const { settings, setSettings, rerunOnboarding, navigate, playback, tasks } = useAppStore();
  const [category, setCategory] = useState<(typeof categories)[number][0]>("appearance");
  const [library, setLibrary] = useState(() => remote<LibraryOverviewDto>());
  const [cache, setCache] = useState(() => remote<CacheStatsDto>());
  const [account, setAccount] = useState(() => remote<BackendNeteaseStatusDto>());
  const [updater, setUpdater] = useState(() => remote<UpdaterStatusDto>());
  const [version, setVersion] = useState<UpdateCheckDto | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // 各状态源独立加载、独立落定：曾经单个 allSettled 聚合导致一个 promise 挂起即全部「读取中」。
    // 超时兜底把挂起转为失败，失败显示「暂不可用」而不是永久「读取中」。
    const withTimeout = <T,>(request: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("状态读取超时")), STATUS_TIMEOUT_MS);
      request.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
    const load = async <T,>(request: Promise<T>, apply: (next: Remote<T>) => void, fallback: string) => {
      try {
        const data = await withTimeout(request);
        if (active) apply({ data, error: null, loading: false });
      } catch {
        if (active) apply({ data: null, error: fallback, loading: false });
      }
    };
    void load(bridge.libraryOverview(), setLibrary, "曲库概览暂不可用");
    void load(bridge.cacheStats(), setCache, "缓存统计暂不可用");
    void load(bridge.neteaseStatus(), setAccount, "网易云状态暂不可用");
    void load(bridge.updaterStatus(), setUpdater, "更新器状态暂不可用");
    return () => { active = false; };
  }, []);

  if (!settings) return null;
  const heading = categories.find(([id]) => id === category)?.[1];
  const updateCache = async () => { try { await bridge.cacheClear(); setCacheMessage("已提交清理请求，状态将在后台任务中更新"); } catch { setCacheMessage("缓存清理当前不可用"); } };
  const checkVersion = async () => {
    setUpdateBusy(true);
    setUpdateMessage(null);
    try {
      setVersion(await bridge.updaterCheck());
    } catch {
      setVersion(null);
      setUpdateMessage("检查更新失败");
    } finally {
      setUpdateBusy(false);
    }
  };
  const installUpdate = async () => {
    setUpdateBusy(true);
    setUpdateMessage(null);
    try {
      const expectedVersion = version?.version;
      if (!expectedVersion) return;
      const installed = await bridge.updaterUpdate(expectedVersion);
      if (!installed) {
        setVersion((current) => current ? { ...current, available: false, version: null, notes: null } : current);
        setUpdateMessage("当前已是最新版本");
      }
    } catch {
      setUpdateMessage("更新安装失败");
    } finally {
      setUpdateBusy(false);
    }
  };
  const errorText = (state: Remote<unknown>) => state.error ? <div className="notice"><WarningCircle />{state.error}</div> : null;

  let content: React.JSX.Element;
  if (category === "appearance") content = <>
    <SettingRow title="主题" detail="即时切换完整明亮或深石墨主题"><Segmented value={settings.theme} options={[["light", "明亮"], ["dark", "暗色"], ["system", "系统"]]} onChange={(theme) => void setSettings({ theme: theme as AppSettingsDto["theme"] })} /></SettingRow>
    <SettingRow title="材质方向" detail="A 强调纯净表面，B 增强封面氛围"><Segmented value={settings.material} options={[["clean", "A 纯净"], ["atmosphere", "B 氛围"]]} onChange={(material) => void setSettings({ material: material as AppSettingsDto["material"] })} /></SettingRow>
    <SettingRow title="封面动态色" detail="仅用于首页主推荐与展开播放层"><Toggle checked={settings.dynamicColor} onChange={(dynamicColor) => void setSettings({ dynamicColor })} /></SettingRow>
    <SettingRow title="减少动效" detail="取消位移、共享元素与惯性滚动"><Toggle checked={settings.reduceMotion} onChange={(reduceMotion) => void setSettings({ reduceMotion })} /></SettingRow>
    <SettingRow title="降低透明度" detail="所有玻璃表面退化为高不透明实色"><Toggle checked={settings.reduceTransparency} onChange={(reduceTransparency) => void setSettings({ reduceTransparency })} /></SettingRow>
  </>;
  else if (category === "playback") content = <>
    <SettingRow title="恢复播放队列" detail="启动后恢复曲目与进度，但保持暂停"><Toggle checked={settings.restoreQueue} onChange={(value) => void setSettings({ restoreQueue: value })} /></SettingRow>
    <SettingRow title="启动后继续播放" detail="设备变化或异常退出后永远不会自动播放"><Toggle checked={settings.autoPlayOnLaunch} onChange={(value) => void setSettings({ autoPlayOnLaunch: value })} /></SettingRow>
    <ReadonlyRow title="当前播放状态" detail="来自 WebView 播放链（Web Audio + HSE AudioWorklet）的实时快照" value={playback?.current ? `${playback.current.title} · ${playback.status}` : "暂无曲目"} />
    <ReadonlyRow title="队列" detail="当前上下文与接下来播放由播放坞管理" value={`${(playback?.queue.length ?? 0) + (playback?.nextUp.length ?? 0)} 首`} />
  </>;
  else if (category === "audio") content = <><div className="dsp-status-summary"><SlidersHorizontal /><div><h3>HSE TS 实时处理链已接通</h3><p>shared/hypersoundengine（HSE v1.5.1）在 WebView 内以 AudioWorklet 构成实时 DSP 处理链；参数调整经宿主交叉淡变平滑生效，播放不中断。</p><span>AudioWorklet · HSE v1.5.1</span></div></div><ReadonlyRow title="处理权威" detail="DSP 权威为 HSE TypeScript 实现（core + worklet + browser + ui），随播放链运行在 WebView；Rust 侧无 DSP" value="HSE TS（WebView）" /><ReadonlyRow title="安全状态" detail="处理故障时宿主播放链自动 safe bypass 并提示，播放继续不中断" value="自动 safe bypass" /><ReadonlyRow title="调参入口" detail="参数、预设与 HSE2 分享码在「音效」工作台页配置" value="音效工作台" /><ReadonlyRow title="输出设备" detail="WebView2 走系统默认输出设备（系统共享混音），跟随系统音量与设备切换" value="系统默认 · 共享混音" /></>;
  else if (category === "library") content = <>
    {errorText(library)}<ReadonlyRow title="曲目" detail="来自本地曲库索引" value={readout(library, (data) => `${data.trackCount} 首`)} /><ReadonlyRow title="专辑与艺术家" detail="当前索引中的实体数量" value={readout(library, (data) => `${data.albumCount} 张专辑 · ${data.artistCount} 位艺术家`)} /><ReadonlyRow title="扫描状态" detail="扫描进度在状态中心持续报告" value={library.data?.scanActive ? "扫描中" : tasks.some((task) => task.kind === "scan") ? "后台任务进行中" : "空闲"} /><SettingRow title="初始化向导" detail="重新检查外观、账号、目录与输出设备"><button className="button secondary" onClick={rerunOnboarding}>重新运行</button></SettingRow>
  </>;
  else if (category === "cache") content = <>
    {errorText(cache)}<SettingRow title="缓存容量上限" detail="缓存达到该上限后自动清理至目标水位（2–100 GiB，默认 10 GiB）"><select aria-label="缓存容量上限" className="select" value={String(cacheCapacityGiB(settings.cacheCapacityBytes))} onChange={(event) => void setSettings({ cacheCapacityBytes: Number(event.target.value) * GIB })}>{CACHE_CAPACITY_OPTIONS.map((value) => <option key={value} value={String(value)}>{value} GiB</option>)}</select></SettingRow><ReadonlyRow title="清理水位" detail="达到上限后清理至该比例（固定 90%）" value={`${settings.cacheTrimPercent}%${cache.data ? ` · 约 ${formatGb(Math.round(cache.data.bytesUsed / settings.cacheTrimPercent * 100))}` : ""}`} /><ReadonlyRow title="最近曲目保护" detail="清理时保留最近播放的曲目（固定 100 首）" value={`${settings.cacheRecentTrackLimit} 首`} /><ReadonlyRow title="缓存占用" detail="应用私有缓存（OPFS），不提供文件导出" value={readout(cache, (data) => `${(data.bytesUsed / 1024 / 1024).toFixed(1)} MB`)} /><ReadonlyRow title="缓存条目" detail="包含受账号权益保护的条目" value={readout(cache, (data) => `${data.entryCount} 个 · ${data.lockedEntries} 个受保护`)} /><ReadonlyRow title="后台任务" detail="预取与缓存状态由状态中心报告" value={readout(cache, (data) => `${data.activeTasks} 个活动任务`)} /><SettingRow title="专辑背景补齐" detail="同一专辑达成高频后，系统空闲时整专补齐缓存"><Toggle checked={settings.albumFillEnabled} onChange={(albumFillEnabled) => void setSettings({ albumFillEnabled })} /></SettingRow><SettingRow title="补齐音质" detail="专辑补齐时使用的音质等级"><select aria-label="补齐音质" className="select" value={settings.albumFillQuality} onChange={(event) => void setSettings({ albumFillQuality: event.target.value })}><option value="standard">标准</option><option value="higher">较高</option><option value="exhigh">极高</option><option value="lossless">无损</option><option value="hires">Hi-Res</option></select></SettingRow><SettingRow title="清理应用缓存" detail="仅提交后端清理请求，不导出或暴露音乐文件"><button className="button secondary" onClick={() => void updateCache()}>清理缓存</button></SettingRow>{cacheMessage && <div className="notice"><CheckCircle />{cacheMessage}</div>}
  </>;
  else if (category === "account") content = <><div className="account-signed-in"><UserCircle /><div><b>{account.data?.authenticated ? account.data.displayName || "已登录网易云" : "未登录网易云"}</b><small>{account.data?.authenticated ? `账号 ${account.data.userId ?? "未知"}` : "需要账号能力时可前往网易云账号页登录"}</small></div><button className="button secondary" onClick={() => navigate("account")}>{account.data?.authenticated ? "管理账号" : "去登录"}</button></div><SettingRow title="网易云内容域" detail="可整体禁用，完全不影响本地播放器"><Toggle checked={settings.neteaseEnabled} onChange={(value) => void setSettings({ neteaseEnabled: value })} /></SettingRow>{errorText(account)}</>;
  else if (category === "shortcuts") content = <><div className="disabled-dsp"><Keyboard /><h3>桌面快捷键</h3><p>已支持的快捷键由应用全局命令处理，当前没有可编辑的快捷键映射设置。</p></div><ReadonlyRow title="统一搜索" detail="全局命令入口" value="Ctrl+K · 已启用" /><ReadonlyRow title="播放控制" detail="播放坞与系统媒体键操作" value="由播放核心处理" /></>;
  else if (category === "privacy") content = <><div className="disabled-dsp"><LockKey /><h3>隐私与数据</h3><p>网易云 Cookie、设备会话和协议数据仅由 Tauri/Rust bridge 处理，不进入页面状态。</p></div><ReadonlyRow title="音乐文件" detail="播放器不提供下载或导出能力" value="不可用" /><ReadonlyRow title="缓存文件" detail="仅应用私有缓存，播放权限由服务端权益校验决定" value="不可导出" /></>;
  else if (category === "system") content = <><ReadonlyRow title="窗口与托盘" detail="系统集成由 Tauri 窗口层管理" value="由应用运行时处理" /><ReadonlyRow title="媒体控制" detail="Windows 系统媒体键经 SMTC 桥接：WebView 播放链为权威，Rust 壳纯桥转发按键事件" value="由应用运行时处理" /></>;
  else content = <><ReadonlyRow title="版本" detail="由更新器返回当前版本" value={version?.currentVersion ?? "尚未查询"} />{errorText(updater)}<ReadonlyRow title="更新器" detail={updater.error ? "更新器状态暂不可用" : updater.data ? (updater.data.enabled ? "签名更新通道已配置，可检查并安装" : "更新通道未配置（将在后续版本启用）") : "检查状态中"} value={updater.data?.enabled ? "可用" : updater.data ? "未配置" : "暂不可用"} /><SettingRow title="检查更新" detail="检查签名更新，不会在未确认时安装；更新通道未配置时不可用"><button className="button secondary" disabled={!updater.data?.enabled || updateBusy} onClick={() => void checkVersion()}>{updateBusy ? "处理中" : "检查更新"}</button></SettingRow>{version?.available && <SettingRow title="可用更新" detail={version.notes ?? `版本 ${version.version ?? "未知"}`}><button className="button primary" disabled={updateBusy} onClick={() => void installUpdate()}>下载并安装</button></SettingRow>}{version && <div className="notice">{version.available ? `发现新版本 ${version.version}` : `当前已是最新版本 ${version.currentVersion}`}</div>}{updateMessage && <div className="notice"><WarningCircle />{updateMessage}</div>}<ReadonlyRow title="HRTF 数据资产" detail="MIT KEMAR 人工头 HRTF（SOFA 转换版），Copyright 1994 MIT Media Laboratory，使用时须引用：Gardner, B., & Martin, K. (1994). HRTF measurements of a KEMAR dummy-head microphone. MIT Media Lab Perceptual Computing Technical Report #280" value="MIT KEMAR" /><ReadonlyRow title="第三方声明" detail="随发行包分发的完整第三方许可与数据声明" value="THIRD_PARTY_NOTICES.md" /></>;

  return <div className="settings-page"><aside><h1>设置</h1>{categories.map(([id, label]) => <button type="button" key={id} className={category === id ? "active" : ""} onClick={() => setCategory(id)}>{label}</button>)}</aside><section><h2>{heading}</h2>{content}</section></div>;
}

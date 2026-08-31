import { useEffect, useState } from "react";
import { CheckCircle, Keyboard, LockKey, SlidersHorizontal, UserCircle, WarningCircle } from "@phosphor-icons/react";
import type { AppSettingsDto, BackendNeteaseStatusDto, CacheStatsDto, LibraryOverviewDto, UpdaterStatusDto, UpdateCheckDto } from "../bridge/contracts";
import { bridge } from "../bridge";
import { useAppStore } from "../store";
import { Segmented, SettingRow, Toggle } from "../components/ui";

const categories = [
  ["appearance", "外观"], ["playback", "播放"], ["audio", "音频与 DSP"],
  ["library", "曲库"], ["cache", "缓存"], ["account", "网易云账号"],
  ["shortcuts", "导航与快捷键"], ["system", "系统集成"], ["privacy", "隐私"], ["about", "关于"],
] as const;

type Remote<T> = { data: T | null; error: string | null };
const remote = <T,>(): Remote<T> => ({ data: null, error: null });

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
    void Promise.allSettled([bridge.libraryOverview(), bridge.cacheStats(), bridge.neteaseStatus(), bridge.updaterStatus()]).then((results) => {
      if (!active) return;
      const [libraryResult, cacheResult, accountResult, updaterResult] = results;
      if (libraryResult.status === "fulfilled") setLibrary({ data: libraryResult.value, error: null }); else setLibrary({ data: null, error: "曲库概览暂不可用" });
      if (cacheResult.status === "fulfilled") setCache({ data: cacheResult.value, error: null }); else setCache({ data: null, error: "缓存统计暂不可用" });
      if (accountResult.status === "fulfilled") setAccount({ data: accountResult.value, error: null }); else setAccount({ data: null, error: "网易云状态暂不可用" });
      if (updaterResult.status === "fulfilled") setUpdater({ data: updaterResult.value, error: null }); else setUpdater({ data: null, error: "更新器状态暂不可用" });
    });
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
    <ReadonlyRow title="当前播放状态" detail="来自 Rust 音频引擎的实时快照" value={playback?.current ? `${playback.current.title} · ${playback.status}` : "暂无曲目"} />
    <ReadonlyRow title="队列" detail="当前上下文与接下来播放由播放坞管理" value={`${(playback?.queue.length ?? 0) + (playback?.nextUp.length ?? 0)} 首`} />
  </>;
  else if (category === "audio") content = <><div className="disabled-dsp"><SlidersHorizontal /><h3>DSP 规格待接入</h3><p>音频管线已保留旁路契约。在真实效果清单、参数模型和链路约束确定前，不提供虚构效果器。</p><button className="button secondary" disabled>打开音效工作台</button></div><ReadonlyRow title="输出设备" detail="播放时由 Rust 音频引擎验证 Windows 默认设备" value="自动选择 · 只读" /></>;
  else if (category === "library") content = <>
    {errorText(library)}<ReadonlyRow title="曲目" detail="来自本地曲库索引" value={library.data ? `${library.data.trackCount} 首` : "读取中"} /><ReadonlyRow title="专辑与艺术家" detail="当前索引中的实体数量" value={library.data ? `${library.data.albumCount} 张专辑 · ${library.data.artistCount} 位艺术家` : "读取中"} /><ReadonlyRow title="扫描状态" detail="扫描进度在状态中心持续报告" value={library.data?.scanActive ? "扫描中" : tasks.some((task) => task.kind === "scan") ? "后台任务进行中" : "空闲"} /><SettingRow title="初始化向导" detail="重新检查外观、账号、目录与输出设备"><button className="button secondary" onClick={rerunOnboarding}>重新运行</button></SettingRow>
  </>;
  else if (category === "cache") content = <>
    {errorText(cache)}<ReadonlyRow title="缓存占用" detail="应用私有缓存，不提供文件导出" value={cache.data ? `${(cache.data.bytesUsed / 1024 / 1024).toFixed(1)} MB` : "读取中"} /><ReadonlyRow title="缓存条目" detail="包含受账号权益保护的条目" value={cache.data ? `${cache.data.entryCount} 个 · ${cache.data.lockedEntries} 个受保护` : "读取中"} /><ReadonlyRow title="后台任务" detail="预取与缓存状态由状态中心报告" value={cache.data ? `${cache.data.activeTasks} 个活动任务` : "读取中"} /><SettingRow title="清理应用缓存" detail="仅提交后端清理请求，不导出或暴露音乐文件"><button className="button secondary" onClick={() => void updateCache()}>清理缓存</button></SettingRow>{cacheMessage && <div className="notice"><CheckCircle />{cacheMessage}</div>}
  </>;
  else if (category === "account") content = <><div className="account-signed-in"><UserCircle /><div><b>{account.data?.authenticated ? account.data.displayName || "已登录网易云" : "未登录网易云"}</b><small>{account.data?.authenticated ? `账号 ${account.data.userId ?? "未知"}` : "需要账号能力时可前往网易云账号页登录"}</small></div><button className="button secondary" onClick={() => navigate("account")}>{account.data?.authenticated ? "管理账号" : "去登录"}</button></div><SettingRow title="网易云内容域" detail="可整体禁用，完全不影响本地播放器"><Toggle checked={settings.neteaseEnabled} onChange={(value) => void setSettings({ neteaseEnabled: value })} /></SettingRow>{errorText(account)}</>;
  else if (category === "shortcuts") content = <><div className="disabled-dsp"><Keyboard /><h3>桌面快捷键</h3><p>已支持的快捷键由应用全局命令处理，当前没有可编辑的快捷键映射设置。</p></div><ReadonlyRow title="统一搜索" detail="全局命令入口" value="Ctrl+K · 已启用" /><ReadonlyRow title="播放控制" detail="播放坞与系统媒体键操作" value="由播放核心处理" /></>;
  else if (category === "privacy") content = <><div className="disabled-dsp"><LockKey /><h3>隐私与数据</h3><p>网易云 Cookie、设备会话和协议数据仅由 Tauri/Rust bridge 处理，不进入页面状态。</p></div><ReadonlyRow title="音乐文件" detail="播放器不提供下载或导出能力" value="不可用" /><ReadonlyRow title="缓存文件" detail="仅应用私有缓存，播放权限由服务端权益校验决定" value="不可导出" /></>;
  else if (category === "system") content = <><ReadonlyRow title="窗口与托盘" detail="系统集成由 Tauri 窗口层管理" value="由应用运行时处理" /><ReadonlyRow title="媒体控制" detail="Windows 系统媒体键能力" value="由应用运行时处理" /><ReadonlyRow title="系统独占输出" detail="当前没有可配置的设备契约" value="不可用" /></>;
  else content = <><ReadonlyRow title="版本" detail="由更新器返回当前版本" value={version?.currentVersion ?? "尚未查询"} />{errorText(updater)}<ReadonlyRow title="更新器" detail={updater.data?.reason ?? (updater.error ? "状态读取失败" : "检查状态中")} value={updater.data?.enabled ? "可用" : "不可用"} /><SettingRow title="检查更新" detail="检查签名更新，不会在未确认时安装"><button className="button secondary" disabled={!updater.data?.enabled || updateBusy} onClick={() => void checkVersion()}>{updateBusy ? "处理中" : "检查更新"}</button></SettingRow>{version?.available && <SettingRow title="可用更新" detail={version.notes ?? `版本 ${version.version ?? "未知"}`}><button className="button primary" disabled={updateBusy} onClick={() => void installUpdate()}>下载并安装</button></SettingRow>}{version && <div className="notice">{version.available ? `发现新版本 ${version.version}` : `当前已是最新版本 ${version.currentVersion}`}</div>}{updateMessage && <div className="notice"><WarningCircle />{updateMessage}</div>}</>;

  return <div className="settings-page"><aside><h1>设置</h1>{categories.map(([id, label]) => <button type="button" key={id} className={category === id ? "active" : ""} onClick={() => setCategory(id)}>{label}</button>)}</aside><section><h2>{heading}</h2>{content}</section></div>;
}

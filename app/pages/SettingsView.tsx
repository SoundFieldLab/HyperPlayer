import { useState } from "react";
import { CaretDown, SlidersHorizontal } from "@phosphor-icons/react";
import type { AppSettingsDto } from "../bridge/contracts";
import { useAppStore } from "../store";
import { Segmented, SettingRow, Toggle } from "../components/ui";

const categories = [
  ["appearance", "外观"], ["playback", "播放"], ["audio", "音频与 DSP"],
  ["library", "曲库"], ["cache", "缓存"], ["account", "网易云账号"],
  ["shortcuts", "导航与快捷键"], ["system", "系统集成"], ["about", "关于"],
] as const;

export function SettingsView(): React.JSX.Element | null {
  const { settings, setSettings, rerunOnboarding } = useAppStore();
  const [category, setCategory] = useState("appearance");
  if (!settings) return null;

  return <div className="settings-page"><aside><h1>设置</h1>{categories.map(([id, label]) => <button key={id} className={category === id ? "active" : ""} onClick={() => setCategory(id)}>{label}</button>)}</aside><section><h2>{categories.find(([id]) => id === category)?.[1]}</h2>{category === "appearance" ? <>
    <SettingRow title="主题" detail="即时切换完整明亮或深石墨主题"><Segmented value={settings.theme} options={[["light", "明亮"], ["dark", "暗色"], ["system", "系统"]]} onChange={(theme) => setSettings({ theme: theme as AppSettingsDto["theme"] })}/></SettingRow>
    <SettingRow title="材质方向" detail="A 强调纯净表面，B 增强封面氛围"><Segmented value={settings.material} options={[["clean", "A 纯净"], ["atmosphere", "B 氛围"]]} onChange={(material) => setSettings({ material: material as AppSettingsDto["material"] })}/></SettingRow>
    <SettingRow title="封面动态色" detail="仅用于首页主推荐与展开播放层"><Toggle checked={settings.dynamicColor} onChange={(dynamicColor) => setSettings({ dynamicColor })}/></SettingRow>
    <SettingRow title="减少动效" detail="取消位移、共享元素与惯性滚动"><Toggle checked={settings.reduceMotion} onChange={(reduceMotion) => setSettings({ reduceMotion })}/></SettingRow>
    <SettingRow title="降低透明度" detail="所有玻璃表面退化为高不透明实色"><Toggle checked={settings.reduceTransparency} onChange={(reduceTransparency) => setSettings({ reduceTransparency })}/></SettingRow>
  </> : category === "audio" ? <><div className="disabled-dsp"><SlidersHorizontal/><h3>DSP 规格待接入</h3><p>音频管线已保留旁路契约。在真实效果清单、参数模型和链路约束确定前，不提供虚构效果器。</p><button className="button secondary" disabled>打开音效工作台</button></div><SettingRow title="输出设备" detail="播放时由 Rust 音频引擎验证 Windows 默认设备"><button className="select-button" disabled>自动选择<CaretDown/></button></SettingRow></> : <>
    <SettingRow title="恢复播放队列" detail="启动后恢复曲目与进度，但保持暂停"><Toggle checked={settings.restoreQueue} onChange={(restoreQueue) => setSettings({ restoreQueue })}/></SettingRow>
    <SettingRow title="启动后继续播放" detail="设备变化或异常退出后永远不会自动播放"><Toggle checked={settings.autoPlayOnLaunch} onChange={(autoPlayOnLaunch) => setSettings({ autoPlayOnLaunch })}/></SettingRow>
    <SettingRow title="网易云内容域" detail="可整体禁用，完全不影响本地播放器"><Toggle checked={settings.neteaseEnabled} onChange={(neteaseEnabled) => setSettings({ neteaseEnabled })}/></SettingRow>
    <SettingRow title="初始化向导" detail="重新检查外观、账号、目录与输出设备"><button className="button secondary" onClick={rerunOnboarding}>重新运行</button></SettingRow>
  </>}</section></div>;
}

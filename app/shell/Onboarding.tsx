import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretRight, Check, FolderOpen, Info, Monitor, SlidersHorizontal, SpeakerHigh, Sun, Moon, User } from "@phosphor-icons/react";
import { bridge } from "../bridge";
import type { AppSettingsDto } from "../bridge/contracts";
import { Brand, Segmented } from "../components/ui";
import { useAppStore } from "../store";

export function Onboarding(): React.JSX.Element {
  const finish = useAppStore((state) => state.finishOnboarding);
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const [step, setStep] = useState(0);
  const [folderStatus, setFolderStatus] = useState<string>("尚未选择音乐文件夹");
  const steps = ["外观", "网易云账号", "本地音乐", "音频输出", "完成"];
  async function chooseFolder(): Promise<void> {
    try {
      const selection = await bridge.libraryPickLocation();
      if (!selection.selected || !selection.selectionTicket) return;
      const location = await bridge.libraryRegisterLocation(selection.selectionTicket);
      await bridge.libraryStartScan([location.id]);
      setFolderStatus(`正在扫描 ${location.path}`);
    } catch (error) {
      useAppStore.getState().notifyError(error, "无法添加音乐文件夹");
    }
  }
  return <main className="onboarding">
    <div className="onboarding-brand"><Brand/><span>初始设置</span></div>
    <div className="step-track" aria-label="设置进度">{steps.map((name, index) => <div className={`step-dot ${index <= step ? "done" : ""}`} key={name}><span>{index < step ? <Check/> : index + 1}</span><small>{name}</small></div>)}</div>
    <AnimatePresence mode="wait"><motion.section key={step} className="onboarding-panel" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
      {step === 0 && <><p className="eyebrow">外观</p><h1>选择舒适的界面</h1><p className="lead">之后可随时在设置中调整主题与材质。</p><div className="choice-grid">
        <button className={`visual-choice ${settings?.theme === "light" ? "selected" : ""}`} onClick={() => setSettings({ theme: "light" })}><Sun/><b>明亮</b><span>柔和灰白表面</span></button>
        <button className={`visual-choice ${settings?.theme === "dark" ? "selected" : ""}`} onClick={() => setSettings({ theme: "dark" })}><Moon/><b>深石墨</b><span>低眩光完整暗色</span></button>
        <button className={`visual-choice ${settings?.theme === "system" ? "selected" : ""}`} onClick={() => setSettings({ theme: "system" })}><Monitor/><b>跟随 Windows</b><span>响应系统主题</span></button>
      </div><div className="material-row"><span><b>材质方向</b><small>A 明亮纯净 / B 封面氛围</small></span><Segmented value={settings?.material ?? "clean"} options={[["clean", "A 纯净"], ["atmosphere", "B 氛围"]]} onChange={(material) => setSettings({ material: material as AppSettingsDto["material"] })}/></div></>}
      {step === 1 && <><p className="eyebrow">网易云账号</p><h1>公开内容无需登录</h1><p className="lead">登录后可同步喜欢、歌单与账号权益。凭据仅由 Rust 后端安全管理，不会显示在界面中。</p><div className="notice"><Info/>完成向导后，请在网易云账号页获取真实二维码。</div></>}
      {step === 2 && <><p className="eyebrow">本地音乐</p><h1>添加音乐文件夹</h1><p className="lead">曲库扫描会在后台运行，不影响在线浏览与播放。</p><button className="folder-picker" onClick={() => void chooseFolder()}><FolderOpen size={26}/><span><b>选择音乐文件夹</b><small>{folderStatus}</small></span><CaretRight/></button></>}
      {step === 3 && <><p className="eyebrow">音频输出</p><h1>音频输出</h1><p className="lead">Rust 音频核心已接入首批效果与参数均衡，完整参数桥仍在实施。</p><div className="notice"><Info/>播放器将在首次播放时验证 Windows 默认音频设备。</div><div className="notice"><SlidersHorizontal/> 当前默认参数保持直通；处理器故障时自动恢复原始 PCM。</div></>}
      {step === 4 && <><p className="eyebrow">设置完成</p><h1>开始聆听</h1><p className="lead">将进入我的喜欢。队列会恢复，但启动时不会自动出声。</p><div className="summary-list"><span><Moon/>深石墨主题</span><span><User/>匿名浏览</span><span><FolderOpen/>本地目录可稍后添加</span><span><SpeakerHigh/>系统默认输出</span></div></>}
      <footer><button className="button ghost" onClick={() => step ? setStep(step - 1) : finish()}>{step ? "返回" : "稍后设置"}</button><button className="button primary" onClick={() => step === steps.length - 1 ? finish() : setStep(step + 1)}>{step === steps.length - 1 ? "进入 HyperPlayer" : "继续"}<CaretRight/></button></footer>
    </motion.section></AnimatePresence>
  </main>;
}

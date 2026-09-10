import { useEffect, useState, type ReactNode } from 'react';
import type { DspSnapshot } from '../../domains/dsp/DspService';
import type { AppSettings } from '../../services/SettingsService';
import type { CenterTask, CenterTaskAction } from '../../services/TaskCenter';
import { useAppStore } from '../../stores/store';
import { useTasksStore } from '../../stores/slices/tasks';
import { useLibraryStore } from '../../stores/slices/library';
import { useServices } from '../../app/providers/ServicesProvider';
import './system.css';

function PageFrame({ eyebrow, title, children, actions }: { eyebrow: string; title: string; children: ReactNode; actions?: ReactNode }) {
  return <main className="system-page"><header className="system-header"><div><p className="system-eyebrow">{eyebrow}</p><h1>{title}</h1></div>{actions}</header>{children}</main>;
}

function ActionButton({ children, onClick, disabled = false, secondary = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; secondary?: boolean }) {
  return <button className={`system-button${secondary ? ' system-button--secondary' : ''}`} type="button" onClick={onClick} disabled={disabled}>{children}</button>;
}

function ErrorText({ message }: { message: string | null }) { return message ? <p className="system-error" role="alert">{message}</p> : null; }

export function DspPage() {
  const { dsp } = useServices();
  const [snapshot, setSnapshot] = useState<DspSnapshot>(() => dsp.snapshot);
  const [shareCode, setShareCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const run = async (action: () => Promise<void>, success?: string) => { setMessage(null); try { await action(); setSnapshot(dsp.snapshot); if (success) setMessage(success); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } };
  const scenes = dsp.listScenes();
  return <PageFrame eyebrow="DSP WORKSPACE" title="音效工作台"><div className="system-status-strip"><span className="system-status-dot" data-active={!snapshot.bypassed} /><strong>{snapshot.bypassed ? '旁路中' : snapshot.sceneName ?? '自定义参数'}</strong><span>{snapshot.customized ? '已自定义' : '内置场景'}</span></div><section className="system-section"><div className="system-section-heading"><div><p className="system-kicker">场景</p><h2>选择聆听方式</h2></div><div className="system-actions"><ActionButton secondary onClick={() => void run(() => snapshot.bypassed ? dsp.restore() : dsp.bypass(), snapshot.bypassed ? '已恢复 DSP' : '已旁路 DSP')}>{snapshot.bypassed ? '恢复 DSP' : '旁路 DSP'}</ActionButton><ActionButton onClick={() => void run(() => dsp.saveToA(), '已保存到 A')}>保存 A</ActionButton><ActionButton onClick={() => void run(() => dsp.saveToB(), '已保存到 B')}>保存 B</ActionButton></div></div><div className="system-scene-grid">{scenes.map((scene) => <button className={`system-scene${snapshot.sceneId === scene.id ? ' is-active' : ''}`} type="button" key={scene.id} onClick={() => void run(() => dsp.setScene(scene.id))}><strong>{scene.name}</strong><span>{scene.description ?? '内置场景'}</span></button>)}</div></section><section className="system-section"><div className="system-section-heading"><div><p className="system-kicker">A/B 比较</p><h2>快速对照参数</h2></div><span className="system-caption">当前：{snapshot.activeSlot ? snapshot.activeSlot.toUpperCase() : '未选择'}</span></div><div className="system-ab-grid"><ActionButton disabled={!snapshot.ab.a} onClick={() => void run(() => dsp.loadFromA(), '已加载 A')}>加载 A {snapshot.ab.a ? '· 有快照' : '· 空'}</ActionButton><ActionButton disabled={!snapshot.ab.b} onClick={() => void run(() => dsp.loadFromB(), '已加载 B')}>加载 B {snapshot.ab.b ? '· 有快照' : '· 空'}</ActionButton></div></section><section className="system-section"><div className="system-section-heading"><div><p className="system-kicker">分享串</p><h2>导入或复制当前调音</h2></div><ActionButton secondary onClick={() => { setShareCode(dsp.encodeShare()); setMessage('已生成当前分享串'); }}>生成分享串</ActionButton></div><div className="system-inline-form"><input value={shareCode} onChange={(event) => setShareCode(event.target.value)} aria-label="DSP 分享串" placeholder="粘贴分享串" /><ActionButton disabled={!shareCode.trim()} onClick={() => void run(async () => { if (!(await dsp.applyShare(shareCode.trim()))) throw new Error('分享串无效'); }, '已导入分享串')}>导入</ActionButton></div></section><ErrorText message={message} /></PageFrame>;
}

export function SettingsPage() {
  const services = useServices();
  const [settings, setSettings] = useState<AppSettings>(services.settings.snapshot);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { let active = true; void services.settings.load().then((next) => { if (active) setSettings(next); }); const unsubscribe = services.settings.subscribe((next) => setSettings(next)); return () => { active = false; unsubscribe(); }; }, [services]);
  const update = async (patch: Partial<AppSettings>) => { setMessage(null); try { const next = await services.settings.update(patch); setSettings(next); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } };
  const setAutostart = async (enabled: boolean) => { setMessage(null); try { const ok = await services.autostart.setAutostart(enabled); setMessage(ok ? '开机自启已更新' : '系统未接受开机自启设置'); setSettings(services.settings.snapshot); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } };
  const shortcuts = services.shortcut.getSnapshot();
  const addLibraryFolder = async () => {
    setMessage(null);
    try {
      const selected = await services.dialog.pickDirectory({ title: '选择音乐文件夹' });
      if (!selected) return;
      const libraryFolders = Array.from(new Set([...settings.libraryFolders, selected]));
      await update({ libraryFolders });
      useLibraryStore.getState().setFolders(libraryFolders);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <PageFrame eyebrow="PREFERENCES" title="设置"><section className="system-settings-grid"><div className="system-section"><SettingRow label="主题" detail="应用外观跟随系统或固定主题"><select value={settings.theme} onChange={(event) => void update({ theme: event.target.value as AppSettings['theme'] })} aria-label="主题"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></SettingRow><SettingRow label="启动页面" detail="下次启动时打开的稳定页面"><select value={settings.startupPage} onChange={(event) => void update({ startupPage: event.target.value as AppSettings['startupPage'] })} aria-label="启动页面"><option value="netease-home">网易云首页</option><option value="local-home">本地首页</option><option value="last-page">上次页面</option></select></SettingRow><SettingRow label="关闭行为" detail="关闭主窗口时执行的动作"><select value={settings.closeBehavior} onChange={(event) => void update({ closeBehavior: event.target.value as AppSettings['closeBehavior'] })} aria-label="关闭行为"><option value="ask">每次询问</option><option value="minimize">最小化到托盘</option><option value="quit">退出应用</option></select></SettingRow><SettingRow label="切歌通知" detail="播放下一首时发送系统通知"><input type="checkbox" checked={settings.notifyOnTrackChange} onChange={(event) => void update({ notifyOnTrackChange: event.target.checked })} aria-label="切歌通知" /></SettingRow><SettingRow label="开机自启" detail="由系统服务确认并写入偏好"><input type="checkbox" checked={settings.autostart} onChange={(event) => void setAutostart(event.target.checked)} aria-label="开机自启" /></SettingRow></div><div className="system-section"><p className="system-kicker">播放设置</p><h2>启动与队列</h2><SettingRow label="恢复上次队列" detail="启动时恢复退出前的队列"><input type="checkbox" checked={settings.restoreQueue} onChange={(event) => void update({ restoreQueue: event.target.checked })} aria-label="恢复上次队列" /></SettingRow><SettingRow label="启动后继续播放" detail="当前没有正常退出标记，无法安全区分崩溃恢复，因此暂不可用"><input type="checkbox" checked={false} disabled aria-label="启动后继续播放" /></SettingRow><SettingRow label="错误自动跳过" detail="播放失败时继续下一首"><input type="checkbox" checked={settings.autoSkipOnError} onChange={(event) => void update({ autoSkipOnError: event.target.checked })} aria-label="错误自动跳过" /></SettingRow><SettingRow label="保留临时区" detail="切换上下文时保留 Up Next"><input type="checkbox" checked={settings.keepUpNextOnContextSwitch} onChange={(event) => void update({ keepUpNextOnContextSwitch: event.target.checked })} aria-label="保留临时区" /></SettingRow><SettingRow label="歌词偏移" detail="正值让歌词提前，单位毫秒"><input className="system-number" type="number" min={-5000} max={5000} step={50} value={settings.lyricOffsetMs} onChange={(event) => void update({ lyricOffsetMs: Number(event.target.value) })} aria-label="歌词偏移" /></SettingRow></div><div className="system-section"><p className="system-kicker">曲库与缓存</p><h2>本地数据</h2><SettingRow label="缓存容量" detail="公共播放缓存容量"><select value={String(settings.cacheCapacityBytes)} onChange={(event) => void update({ cacheCapacityBytes: Number(event.target.value) })} aria-label="缓存容量"><option value={String(1024 ** 3)}>1 GB</option><option value={String(5 * 1024 ** 3)}>5 GB</option><option value={String(10 * 1024 ** 3)}>10 GB</option><option value={String(20 * 1024 ** 3)}>20 GB</option></select></SettingRow><div className="system-folder-heading"><strong>音乐文件夹</strong><ActionButton secondary onClick={() => void addLibraryFolder()}>添加文件夹</ActionButton></div>{settings.libraryFolders.length ? <ul className="system-folder-list">{settings.libraryFolders.map((folder) => <li key={folder}><span>{folder}</span><button type="button" aria-label={`移除 ${folder}`} onClick={() => void update({ libraryFolders: settings.libraryFolders.filter((item) => item !== folder) })}>移除</button></li>)}</ul> : <p className="system-caption">尚未配置音乐文件夹。</p>}</div><div className="system-section"><p className="system-kicker">全局快捷键</p><h2>当前生效绑定</h2>{Object.entries(shortcuts.bindings).map(([action, shortcut]) => <div className="system-key-row" key={action}><span>{action === 'playPause' ? '播放 / 暂停' : action === 'next' ? '下一首' : '上一首'}</span><code>{shortcut ?? '未注册'}</code></div>)}{shortcuts.conflicts.length > 0 && <p className="system-warning">冲突：{shortcuts.conflicts.join(', ')}</p>}<p className="system-caption">快捷键由系统服务注册；页面只展示真实生效状态。</p></div></section><ErrorText message={message} /></PageFrame>;
}

function SettingRow({ label, detail, children }: { label: string; detail: string; children: ReactNode }) { return <label className="system-setting-row"><span><strong>{label}</strong><small>{detail}</small></span>{children}</label>; }

function useTasks() {
  return useTasksStore((state) => state.tasks);
}

export function StatusCenterPage() {
  const services = useServices(); const tasks = useTasks(); const navigate = useAppStore((state) => state.navigate); const [message, setMessage] = useState<string | null>(null); const [checking, setChecking] = useState(false);
  const checkUpdate = async () => { setChecking(true); setMessage(null); try { const update = await services.updater.checkUpdate(); setMessage(update ? `发现新版本 ${update.version}` : '已是最新版本'); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setChecking(false); } };
  const exportDiagnostics = async () => { setMessage(null); try { const path = await services.diagnostics.exportDiagnostics(); setMessage(`诊断包已导出：${path}`); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } };
  const runTaskAction = async (task: CenterTask, action: CenterTaskAction) => {
    setMessage(null);
    try {
      if (task.kind === 'scan') {
        if (action === 'pause') services.scanMachine.pause();
        else if (action === 'cancel') services.scanMachine.cancel();
        else if (action === 'retry') await services.scanMachine.resume();
        else navigate('local', { routeId: 'local-folders' });
        return;
      }
      if (task.kind === 'app-update') {
        if (action === 'retry') await services.updater.retry();
        else if (action === 'view') navigate('netease', { routeId: 'settings' });
        return;
      }
      if (action === 'view') navigate(task.kind === 'netease-sync' ? 'netease' : 'local', { routeId: task.kind === 'netease-sync' ? 'netease-library' : 'local-home' });
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <PageFrame eyebrow="STATUS CENTER" title="状态中心" actions={<ActionButton onClick={() => void checkUpdate()} disabled={checking}>{checking ? '检查中…' : '检查更新'}</ActionButton>}><section className="system-section"><div className="system-section-heading"><div><p className="system-kicker">任务</p><h2>后台活动</h2></div><span className="system-caption">{tasks.length} 项</span></div>{tasks.length ? <div className="system-task-list">{tasks.map((task) => <div className="system-task" key={task.id}><div className="system-task-main"><strong>{task.title}</strong><span>{task.detail ?? task.state}</span></div><div className="system-task-progress"><span style={{ width: `${Math.round(task.progress * 100)}%` }} /></div><code>{task.state}</code><div className="system-task-actions">{task.actions.map((action) => <button type="button" key={action} aria-label={`${taskActionLabel(action)}${task.title}`} onClick={() => void runTaskAction(task, action)}>{taskActionLabel(action)}</button>)}</div></div>)}</div> : <p className="system-empty">当前没有后台任务。</p>}</section><section className="system-section"><p className="system-kicker">诊断</p><h2>导出运行信息</h2><p className="system-caption">导出内容由诊断服务脱敏并写入应用数据目录。</p><ActionButton secondary onClick={() => void exportDiagnostics()}>导出诊断包</ActionButton></section><ErrorText message={message} /></PageFrame>;
}

function taskActionLabel(action: CenterTaskAction): string {
  return { pause: '暂停', cancel: '取消', retry: '重试', view: '查看' }[action];
}

export function OnboardingPage() {
  const services = useServices(); const [settings, setSettings] = useState(services.settings.snapshot); const [message, setMessage] = useState<string | null>(null); const [syncing, setSyncing] = useState(false);
  useEffect(() => { void services.settings.load().then(setSettings); }, [services]);
  const complete = async (step: string) => { const completedSteps = Array.from(new Set([...settings.onboarding.completedSteps, step])); const next = await services.settings.update({ onboarding: { ...settings.onboarding, started: true, completedSteps, completedAt: completedSteps.length >= 3 ? Date.now() : null } }); setSettings(next); };
  const sync = async () => { setSyncing(true); setMessage(null); try { const result = await services.cloudPlaylistSync.syncAll(); setMessage(`已同步 ${result.playlists} 个云歌单，${result.tracks} 首歌曲`); await complete('cloud'); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setSyncing(false); } };
  const chooseFolder = async () => { setMessage(null); try { const selected = await services.dialog.pickDirectory({ title: '选择音乐文件夹' }); if (!selected) return; const libraryFolders = Array.from(new Set([...settings.libraryFolders, selected])); const next = await services.settings.update({ libraryFolders }); setSettings(next); useLibraryStore.getState().setFolders(libraryFolders); await services.scanMachine.scan([selected]); await complete('folders'); } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } };
  const done = settings.onboarding.completedSteps;
  return <PageFrame eyebrow="WELCOME" title="开始使用"><section className="system-onboarding"><Step number="01" title="确认偏好" complete={done.includes('preferences')} onComplete={() => void complete('preferences')}>主题与播放设置可在设置页随时调整。</Step><Step number="02" title="同步云歌单" complete={done.includes('cloud')} action={<ActionButton disabled={syncing} onClick={() => void sync()}>{syncing ? '同步中…' : '同步云歌单'}</ActionButton>}>仅在已登录网易云账号时执行真实同步；未登录时服务会跳过。</Step><Step number="03" title="本地文件夹" complete={done.includes('folders')} action={<ActionButton secondary onClick={() => void chooseFolder()}>选择并扫描</ActionButton>}>选择音乐目录后立即持久化并扫描；取消选择不会更改设置。</Step></section><ErrorText message={message} /></PageFrame>;
}

function Step({ number, title, complete, children, action, onComplete }: { number: string; title: string; complete: boolean; children: ReactNode; action?: ReactNode; onComplete?: () => void }) { return <article className={`system-step${complete ? ' is-complete' : ''}`}><span className="system-step-number">{number}</span><div><h2>{title}</h2><p>{children}</p>{!complete && (action ?? onComplete ? <div className="system-step-action">{action ?? <ActionButton secondary onClick={onComplete as () => void}>完成</ActionButton>}</div> : null)}{complete && <span className="system-complete">已完成</span>}</div></article>; }

export function DiagnosticsPage() { return <StatusCenterPage />; }

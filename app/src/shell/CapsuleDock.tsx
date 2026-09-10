import { useEffect, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, SpeakerHigh, SpeakerSlash, CaretUp } from '@phosphor-icons/react';
import type { Services } from '../app/wiring';
import { useAppStore } from '../stores/store';
import { useSessionStore } from '../stores/slices/session';
import { CoverImage } from './CoverImage';

interface CapsuleDockProps { services: Services; onOpenPlayer: () => void }

export function CapsuleDock({ services, onOpenPlayer }: CapsuleDockProps) {
  const track = useAppStore((state) => state.track);
  const status = useAppStore((state) => state.status);
  const position = useAppStore((state) => state.position);
  const duration = useAppStore((state) => state.duration);
  const volume = useAppStore((state) => state.volume);
  const muted = useAppStore((state) => state.muted);
  const outputDevice = useAppStore((state) => state.outputDevice);
  const upNext = useAppStore((state) => state.upNext);
  const context = useAppStore((state) => state.context);
  const setVolume = useAppStore((state) => state.setVolume);
  const setMuted = useAppStore((state) => state.setMuted);
  const [showVolume, setShowVolume] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [switchingDevice, setSwitchingDevice] = useState(false);

  useEffect(() => {
    void services.audio.listOutputDevices().then(setDevices).catch(() => setDevices([]));
  }, [services]);

  const togglePlayback = async () => {
    // track 为 null（如重启恢复队列后）也允许播放：play() 会加载队列当前曲
    if (busy) return;
    setBusy(true);
    try {
      if (status === 'playing') await services.player.pause();
      else await services.player.play();
    } finally { setBusy(false); }
  };

  const changeVolume = (value: number) => {
    const next = Math.min(1, Math.max(0, value));
    setVolume(next);
    services.audio.setOutputVolume(next);
    void services.settings.update({ volume: next, muted: next === 0, lastNonZeroVolume: next > 0 ? next : volume });
  };

  const chooseDevice = async (deviceId: string) => {
    if (switchingDevice) return;
    setSwitchingDevice(true);
    const session = useSessionStore.getState();
    if (session.notice?.startsWith('切换输出设备失败')) session.setSessionNotice(null);
    try {
      const changed = await services.audio.setSinkId(deviceId);
      if (!changed) return;
      useAppStore.getState().setOutputDevice(deviceId || null);
      await services.settings.update({ outputDevice: deviceId || null });
    } catch {
      useSessionStore.getState().setSessionNotice('切换输出设备失败，请检查设备连接后重试。');
    } finally {
      setSwitchingDevice(false);
    }
  };

  const seek = (value: number) => {
    void services.player.seek(value);
  };

  return (
    <section className="capsule-dock" aria-label="播放控制">
      <button type="button" className="capsule-dock__cover" aria-label="打开播放层" onClick={onOpenPlayer} disabled={!track}>{track ? <CoverImage services={services} track={track} className="capsule-cover-image" /> : <span>♪</span>}</button>
      <div className="capsule-dock__track"><strong>{track?.title ?? '尚未播放'}</strong><span>{track?.artist ?? '从曲库选择一首歌开始'}</span></div>
      <div className="capsule-dock__transport">
        <button type="button" className="icon-button" aria-label="上一首" onClick={() => void services.player.prev()} disabled={!track}><SkipBack size={18} weight="fill" /></button>
        <button type="button" className="transport-button" aria-label={status === 'playing' ? '暂停' : '播放'} onClick={() => void togglePlayback()} disabled={busy || (!track && upNext.length === 0 && context.length === 0)}>{status === 'playing' ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}</button>
        <button type="button" className="icon-button" aria-label="下一首" onClick={() => void services.player.next()} disabled={!track}><SkipForward size={18} weight="fill" /></button>
      </div>
      <div className="capsule-dock__progress"><input aria-label="播放进度" type="range" min="0" max={Math.max(duration, 0)} step="0.1" value={Math.min(position, duration || 0)} onChange={(event) => seek(Number(event.target.value))} /></div>
      <div className="capsule-dock__volume">
        <button type="button" className="icon-button" aria-label="音量" aria-expanded={showVolume} onClick={() => setShowVolume((open) => !open)}>{muted || volume === 0 ? <SpeakerSlash size={19} /> : <SpeakerHigh size={19} />}</button>
        {showVolume && <div className="volume-popover" role="dialog" aria-label="音量与输出设备"><input aria-label="音量滑杆" type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume} onChange={(event) => changeVolume(Number(event.target.value))} /><button type="button" className="hp-button" onClick={() => { const nextMuted = !muted; setMuted(nextMuted); changeVolume(nextMuted ? 0 : useAppStore.getState().lastNonZeroVolume); }}>{muted ? '取消静音' : '静音'}</button><select aria-label="输出设备" value={outputDevice ?? ''} disabled={switchingDevice} onChange={(event) => void chooseDevice(event.target.value)}><option value="">系统默认设备</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || '系统设备'}</option>)}</select></div>}
      </div>
      <button type="button" className="icon-button capsule-dock__queue" aria-label={`打开播放队列，接下来 ${upNext.length} 首`} aria-haspopup="dialog" onClick={onOpenPlayer}><CaretUp size={18} /><span>{upNext.length + context.length}</span></button>
    </section>
  );
}

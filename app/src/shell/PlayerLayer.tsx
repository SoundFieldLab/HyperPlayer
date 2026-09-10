import { useEffect } from 'react';
import { X } from '@phosphor-icons/react';
import { useAppStore } from '../stores/store';
import { useServices } from '../app/providers/ServicesProvider';
import { LyricsPanel, AnalyzerPanel } from './player/MediaPanels';
import { PlayerTransport } from './player/PlayerTransport';
import { QueuePanel } from './player/QueuePanel';
import { CoverImage } from './CoverImage';
import './shell.css';
import './player/player.css';

export function PlayerLayer() {
  const services = useServices();
  const overlay = useAppStore((state) => state.overlay);
  const clearOverlay = useAppStore((state) => state.clearOverlay);
  const track = useAppStore((state) => state.track);
  const status = useAppStore((state) => state.status);
  const mode = useAppStore((state) => state.mode);
  const upNext = useAppStore((state) => state.upNext);
  const context = useAppStore((state) => state.context);
  const open = overlay.kind === 'modal' && overlay.id === 'player-layer';

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearOverlay();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearOverlay, open]);

  if (!open) return null;

  return (
    <div className="player-layer" role="dialog" aria-modal="true" aria-labelledby="player-layer-title">
      <div className="player-layer__content">
        <header className="player-layer__header">
          <h1 id="player-layer-title">正在聆听</h1>
          <button type="button" className="icon-button" aria-label="收起播放层" onClick={clearOverlay}><X size={22} /></button>
        </header>
        <div className="player-layer__main">
          <div className="player-layer__art-column">
            <div className="player-layer__cover" aria-label="专辑封面">{track ? <CoverImage services={services} track={track} className="player-cover-image" /> : <span className="track-cover player-cover-image" aria-hidden="true">♪</span>}</div>
            <section className="player-layer__details" aria-label="当前曲目信息">
              <p className="hp-caption">{status === 'playing' ? '正在播放' : status === 'idle' ? '播放器空闲' : '播放已暂停'}</p>
              <h2>{track?.title ?? '尚未播放'}</h2>
              <p>{track ? `${track.artist || '未知艺术家'}${track.album ? ` · ${track.album}` : ''}` : '选择一首歌曲开始聆听'}</p>
              <PlayerTransport player={services.player} track={track} status={status} mode={mode} onCycleMode={() => services.queue.cycleMode()} />
            </section>
          </div>
          <div className="player-layer__right">
            <LyricsPanel timeline={services.lyrics} />
            <AnalyzerPanel telemetry={services.telemetry} />
            <QueuePanel current={track} upNext={upNext} context={context} queue={services.queue} player={services.player} />
          </div>
        </div>
      </div>
    </div>
  );
}

import { Pause, Play, SkipBack, SkipForward, Repeat, Shuffle, ArrowClockwise } from '@phosphor-icons/react';
import type { PlayerController } from '../../services/PlayerController';
import type { QueueItem, PlayMode } from '../../domains/player/types';

const modeLabels: Record<PlayMode, string> = {
  sequence: '顺序播放',
  loop: '列表循环',
  single: '单曲循环',
  shuffle: '随机播放',
};

interface TransportProps {
  player: PlayerController;
  track: QueueItem | null;
  status: string;
  mode: PlayMode;
  onCycleMode: () => void;
}

export function PlayerTransport({ player, track, status, mode, onCycleMode }: TransportProps) {
  const playing = status === 'playing';
  return (
    <div className="player-transport" aria-label="播放控制">
      <button type="button" className="player-icon-button" aria-label="上一首" onClick={() => void player.prev()} disabled={!track}>
        <SkipBack size={20} weight="bold" />
      </button>
      <button type="button" className="player-play-button" aria-label={playing ? '暂停' : '播放'} onClick={() => void (playing ? player.pause() : player.play())} disabled={!track}>
        {playing ? <Pause size={22} weight="fill" /> : <Play size={22} weight="fill" />}
      </button>
      <button type="button" className="player-icon-button" aria-label="下一首" onClick={() => void player.next()} disabled={!track}>
        <SkipForward size={20} weight="bold" />
      </button>
      <button type="button" className="player-mode-button" aria-label={`播放模式：${modeLabels[mode]}`} title={modeLabels[mode]} onClick={onCycleMode}>
        {mode === 'shuffle' ? <Shuffle size={18} /> : <Repeat size={18} />}
        <span>{modeLabels[mode]}</span>
      </button>
      <button type="button" className="player-icon-button" aria-label="重试当前歌曲" onClick={() => void player.retry()} disabled={!track}>
        <ArrowClockwise size={18} />
      </button>
    </div>
  );
}

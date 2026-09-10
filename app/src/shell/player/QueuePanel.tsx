import { useState } from 'react';
import { Play, SkipForward, Trash, X } from '@phosphor-icons/react';
import type { QueueItem } from '../../domains/player/types';
import type { QueueController } from '../../domains/player/QueueController';
import type { PlayerController } from '../../services/PlayerController';

interface QueueActions {
  queue: QueueController;
  player: PlayerController;
}

function QueueRow({ item, current, actions }: { item: QueueItem; current?: boolean; actions: QueueActions }) {
  return (
    <li className={`player-queue-row${current ? ' is-current' : ''}`}>
      <button
        type="button"
        className="player-queue-select"
        aria-label={current ? `当前播放 ${item.title}` : `播放 ${item.title}`}
        aria-current={current ? 'true' : undefined}
        disabled={current}
        onClick={() => void actions.player.selectQueueItem(item.id)}
      >
        <span className="player-queue-index" aria-hidden="true">{current ? <Play size={12} weight="fill" /> : <SkipForward size={13} />}</span>
        <span className="player-queue-meta"><strong>{item.title}</strong><span>{item.artist || '未知艺术家'}{item.album ? ` · ${item.album}` : ''}</span></span>
        {item.duration ? <time>{formatTime(item.duration)}</time> : null}
      </button>
      {!current ? <button type="button" className="player-queue-remove" aria-label={`从队列移除 ${item.title}`} title="从队列移除" onClick={() => actions.queue.remove(item.id)}><X size={15} /></button> : null}
    </li>
  );
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

export function QueuePanel({ current, upNext, context, queue, player }: { current: QueueItem | null; upNext: QueueItem[]; context: QueueItem[]; queue: QueueController; player: PlayerController }) {
  const [confirmingClear, setConfirmingClear] = useState<'next' | 'all' | null>(null);
  const count = upNext.length + context.length;
  const clearNext = () => {
    queue.clearNext();
    setConfirmingClear(null);
  };
  const clearAll = async () => {
    await player.clearAll();
    setConfirmingClear(null);
  };

  return (
    <aside className="player-queue" aria-label="播放队列">
      <div className="player-queue-toolbar">
        <div><strong>播放队列</strong><span>{count} 首</span></div>
        <div className="player-queue-toolbar-actions">
          {upNext.length > 0 ? <button type="button" className="player-queue-clear" aria-label="清空接下来播放" title="清空接下来播放" onClick={() => setConfirmingClear('next')}><Trash size={16} /></button> : null}
          {count > 0 ? <button type="button" className="player-queue-clear-all" onClick={() => setConfirmingClear('all')}>停止并清空全部</button> : null}
        </div>
      </div>
      {confirmingClear ? (
        <div className="player-queue-confirm" role="alertdialog" aria-label={confirmingClear === 'all' ? '确认停止并清空全部' : '确认清空接下来播放'}>
          <p>{confirmingClear === 'all' ? '停止当前播放并清空整个队列？' : `清空接下来播放的 ${upNext.length} 首歌曲？`}</p>
          <div><button type="button" onClick={() => setConfirmingClear(null)}>取消</button><button type="button" className="is-danger" onClick={() => void (confirmingClear === 'all' ? clearAll() : clearNext())}>清空</button></div>
        </div>
      ) : null}
      <div className="player-queue-columns">
        <div className="player-queue-section">
          <div className="player-section-heading"><h2>接下来播放</h2><span>{upNext.length}</span></div>
          {upNext.length > 0 ? <ol className="player-queue-list">{upNext.map((item) => <QueueRow key={item.id} item={item} actions={{ queue, player }} />)}</ol> : <p className="player-queue-empty">队列为空</p>}
        </div>
        <div className="player-queue-section">
          <div className="player-section-heading"><h2>当前上下文</h2><span>{context.length}</span></div>
          {context.length > 0 ? <ol className="player-queue-list">{context.map((item) => <QueueRow key={item.id} item={item} current={item.id === current?.id} actions={{ queue, player }} />)}</ol> : <p className="player-queue-empty">没有上下文歌曲</p>}
        </div>
      </div>
    </aside>
  );
}

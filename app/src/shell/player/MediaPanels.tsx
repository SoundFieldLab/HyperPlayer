import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LyricsTimeline, LyricsSnapshot } from '../../domains/player/LyricsTimeline';
import type { LyricLine } from '../../domains/player/lyrics/lyricsTypes';
import type { TelemetryTap } from '../../domains/player/TelemetryTap';

const EMPTY_LYRICS: LyricsSnapshot = {
  status: 'idle',
  lines: [],
  timingLevel: null,
  currentLineIndex: -1,
  currentWordIndex: -1,
  error: null,
};

function wordOffset(lines: readonly LyricLine[], lineIndex: number): number {
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    const line = lines[index];
    offset += line?.words?.length ?? 1;
  }
  return offset;
}

function LyricText({ line, active, activeWord }: { line: LyricLine; active: boolean; activeWord: number }) {
  if (!line.words?.length) return <span>{line.text}</span>;
  return (
    <span>
      {line.words.map((word, index) => (
        <span className={active && index <= activeWord ? 'is-highlighted' : undefined} key={`${word.startTime}-${index}`}>
          {word.word}
        </span>
      ))}
    </span>
  );
}

export function LyricsPanel({ timeline }: { timeline?: LyricsTimeline }) {
  const snapshot = useSyncExternalStore(
    timeline?.subscribe ?? (() => () => {}),
    () => timeline?.snapshot ?? EMPTY_LYRICS,
    () => EMPTY_LYRICS,
  );
  const activeWord = useMemo(() => {
    if (snapshot.timingLevel !== 'word' || snapshot.currentLineIndex < 0) return -1;
    return snapshot.currentWordIndex - wordOffset(snapshot.lines, snapshot.currentLineIndex);
  }, [snapshot]);
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [snapshot.currentLineIndex]);

  let content;
  if (snapshot.status === 'loading') content = <p className="player-lyrics-empty" role="status">正在加载歌词</p>;
  else if (snapshot.status === 'error') content = <p className="player-lyrics-empty is-error" role="alert">歌词加载失败{snapshot.error ? `：${snapshot.error}` : ''}</p>;
  else if (snapshot.status === 'empty') content = <p className="player-lyrics-empty">当前曲目没有可用歌词</p>;
  else if (snapshot.status !== 'ready' || snapshot.lines.length === 0) content = <p className="player-lyrics-empty">当前曲目未加载歌词</p>;
  else content = (
    <ol className="player-lyrics-content" aria-live="polite">
      {snapshot.lines.map((line, index) => {
        const active = index === snapshot.currentLineIndex;
        return (
          <li className={active ? 'is-current' : undefined} key={`${line.time}-${index}`} ref={active ? activeRef : undefined} aria-current={active ? 'true' : undefined}>
            <p className="player-lyric-original">
              <LyricText line={line} active={active && snapshot.timingLevel === 'word'} activeWord={activeWord} />
            </p>
            {line.translation ? <p className="player-lyric-translation">{line.translation}</p> : null}
            {line.roman ? <p className="player-lyric-roman">{line.roman}</p> : null}
          </li>
        );
      })}
    </ol>
  );

  return (
    <section className="player-lyrics" aria-label="歌词">
      <div className="player-section-heading"><h2>歌词</h2><span>{snapshot.timingLevel === 'word' ? '逐字' : '实时'}</span></div>
      {content}
    </section>
  );
}

const DRAW_INTERVAL_MS = 1000 / 30;

function drawTelemetry(canvas: HTMLCanvasElement, tap: TelemetryTap): boolean {
  const frame = tap.latestFrame;
  if (!frame) return false;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const spectrum = frame.spectrum;
  const barWidth = width / Math.max(1, spectrum.length);
  context.fillStyle = '#2878ff';
  for (let index = 0; index < spectrum.length; index += 1) {
    const level = Math.max(0, Math.min(1, spectrum[index] ?? 0));
    const barHeight = Math.max(1, level * height * 0.76);
    context.fillRect(index * barWidth, height - barHeight, Math.max(1, barWidth - 1), barHeight);
  }

  const wave = frame.wave;
  if (wave.length >= 2) {
    context.strokeStyle = 'rgba(255, 255, 255, 0.86)';
    context.lineWidth = 1.25;
    context.beginPath();
    for (let index = 0; index < wave.length; index += 2) {
      const x = (index / Math.max(2, wave.length - 2)) * width;
      const y = height * (0.5 - (wave[index + 1] ?? 0) * 0.34);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }
  return true;
}

export function AnalyzerPanel({ telemetry }: { telemetry?: TelemetryTap }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readyRef = useRef(false);
  const [state, setState] = useState<'waiting' | 'ready' | 'error'>('waiting');

  useEffect(() => {
    if (!telemetry) return undefined;
    let frameRequest = 0;
    let lastDraw = 0;
    let stopped = false;
    const draw = (now: number) => {
      if (stopped) return;
      if (now - lastDraw >= DRAW_INTERVAL_MS && canvasRef.current) {
        lastDraw = now;
        try {
          if (drawTelemetry(canvasRef.current, telemetry) && !readyRef.current) {
            readyRef.current = true;
            setState('ready');
          }
        } catch {
          setState('error');
          stopped = true;
          return;
        }
      }
      frameRequest = window.requestAnimationFrame(draw);
    };
    frameRequest = window.requestAnimationFrame(draw);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frameRequest);
    };
  }, [telemetry]);

  return (
    <section className="player-analyzer" aria-label="音频分析">
      <div className="player-section-heading"><h2>音频分析</h2><span>实时</span></div>
      <div className="player-analyzer-content">
        <canvas ref={canvasRef} aria-label="实时频谱与波形" className={state === 'ready' ? 'is-visible' : undefined} />
        {state === 'waiting' ? <p className="player-lyrics-empty">等待分析数据</p> : null}
        {state === 'error' ? <p className="player-lyrics-empty is-error" role="status">音频分析暂不可用</p> : null}
      </div>
    </section>
  );
}

import { useEffect, useState } from 'react';
import type { Services } from '../app/wiring';
import type { QueueItem } from '../domains/player/types';
import type { TrackRecord } from '../domains/library/ScanMachine';
import { albumKeyFor } from '../services/CoverService';
import { toAssetUrl } from '../infra/assetUrl';

type CoverTrack = QueueItem | TrackRecord;
type CoverContract = CoverTrack & { coverUrl?: string | null; albumArtist?: string | null };

function isQueueItem(track: CoverTrack): track is QueueItem {
  return 'source' in track;
}

async function resolveCoverUrl(services: Services, track: CoverContract): Promise<string | null> {
  if (track.coverUrl) return track.coverUrl;

  let albumArtist = track.albumArtist ?? ('album_artist' in track ? track.album_artist : null);
  if (isQueueItem(track) && track.source === 'local') {
    const record = await services.library.getTrack(track.id);
    albumArtist = record?.album_artist ?? albumArtist;
  }

  const path = await services.covers.getCoverPath(albumKeyFor(track.album, albumArtist));
  return path ? toAssetUrl(path) : null;
}

export function CoverImage({ services, track, className = '' }: { services: Services; track: CoverContract; className?: string }) {
  const [cover, setCover] = useState<{ trackId: string; url: string | null }>({ trackId: track.id, url: null });

  useEffect(() => {
    let active = true;
    void resolveCoverUrl(services, track)
      .then((nextUrl) => { if (active) setCover({ trackId: track.id, url: nextUrl }); })
      .catch(() => { if (active) setCover({ trackId: track.id, url: null }); });
    return () => { active = false; };
  }, [services, track]);

  const url = cover.trackId === track.id ? cover.url : null;
  const classes = ['track-cover', className].filter(Boolean).join(' ');
  const label = `${track.album || track.title} 封面`;
  return url
    ? <img className={classes} src={url} alt={label} />
    : <span className={classes} role="img" aria-label={label}>{track.title.slice(0, 1) || '♪'}</span>;
}

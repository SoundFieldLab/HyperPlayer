/**
 * metadataWorker —— Web Worker 内 music-metadata 解析（架构基线.md §7：
 * 解析与遍历在 Worker 中执行，不阻塞 UI）。
 * 由 LibraryService 经 workerFactory 注入；测试环境注入 inline 解析器。
 */

/// <reference lib="webworker" />

import { parseBlob } from 'music-metadata';

export interface MetadataWorkerRequest {
  id: number;
  path: string;
  bytes: ArrayBuffer;
}

export interface MetadataWorkerResponse {
  id: number;
  path: string;
  ok: boolean;
  metadata?: {
    title: string | null;
    artist: string | null;
    album: string | null;
    albumArtist: string | null;
    duration: number | null;
    format: string | null;
    bitrate: number | null;
  };
  error?: string;
}

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (event: MessageEvent<MetadataWorkerRequest>) => {
  const { id, path, bytes } = event.data;
  try {
    const meta = await parseBlob(new Blob([bytes]), { duration: true });
    const response: MetadataWorkerResponse = {
      id,
      path,
      ok: true,
      metadata: {
        title: meta.common.title ?? null,
        artist: meta.common.artist ?? null,
        album: meta.common.album ?? null,
        albumArtist: meta.common.albumartist ?? null,
        duration: meta.format.duration ?? null,
        format: meta.format.container ?? null,
        bitrate: meta.format.bitrate ?? null,
      },
    };
    self.postMessage(response);
  } catch (error) {
    const response: MetadataWorkerResponse = {
      id,
      path,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

/**
 * metadataWorkerFactory —— Web Worker 解析器工厂（架构基线.md §7：
 * 解析与遍历在 Worker 中执行，不阻塞 UI）。
 *
 * 真实路径：vite 打包 metadataWorker（new URL worker），逐文件字节投递解析；
 * 测试路径：ScanMachine 直接注入 fake 解析器，不依赖 Worker。
 */
import type { MetadataParser, TrackMetadata } from './ScanMachine';

interface PendingRequest {
  resolve(value: TrackMetadata | null): void;
  reject(error: Error): void;
}

export function createMetadataWorkerParser(): MetadataParser {
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<number, PendingRequest>();

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    worker = new Worker(new URL('./metadataWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent) => {
      const response = event.data as { id: number; ok: boolean; metadata?: TrackMetadata; error?: string };
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.ok) {
        request.resolve(response.metadata ?? null);
      } else {
        request.reject(new Error(response.error ?? 'metadata parse failed'));
      }
    };
    worker.onerror = (event) => {
      // Worker 全局错误：拒绝所有挂起请求
      for (const request of pending.values()) request.reject(new Error(event.message ?? 'metadata worker crashed'));
      pending.clear();
    };
    return worker;
  };

  return (path: string, bytes: Uint8Array) => {
    const id = ++nextId;
    return new Promise<TrackMetadata | null>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // 传输 buffer 到 worker（transferable，避免拷贝）
      ensureWorker().postMessage({ id, path, bytes: bytes.buffer as ArrayBuffer });
    });
  };
}

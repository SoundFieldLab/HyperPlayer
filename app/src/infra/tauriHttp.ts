/**
 * infra tauriHttp —— tauri-plugin-http 薄封装（绕过 CORS，流式拉取）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export interface HttpFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** 超时（ms）；缺省由调用方（NeteaseService 重试包装）控制。 */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
}

export interface TauriHttp {
  /** 通用请求：返回可读流响应体。 */
  fetch(url: string, options?: HttpFetchOptions): Promise<HttpResponse>;
}

export function createTauriHttp(): TauriHttp {
  return {
    fetch: async (url, options): Promise<HttpResponse> => {
      const controller = new AbortController();
      const timer =
        options?.timeoutMs !== undefined
          ? setTimeout(() => controller.abort(), options.timeoutMs)
          : undefined;
      try {
        const response = await tauriFetch(url, {
          method: options?.method ?? 'GET',
          headers: options?.headers,
          body: options?.body,
          signal: controller.signal,
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return {
          status: response.status,
          headers,
          body: response.body as ReadableStream<Uint8Array>,
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

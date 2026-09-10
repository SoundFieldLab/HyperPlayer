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
  /** set-cookie 保留为数组（多个 Set-Cookie 头不能合并，否则扫码登录会丢 MUSIC_U）。 */
  headers: Record<string, string | string[]>;
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
        const headers: Record<string, string | string[]> = {};
        const rawSetCookie: string[] = [];
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() === 'set-cookie') {
            rawSetCookie.push(value);
            return;
          }
          headers[key] = value;
        });
        // plugin-http 用原生 Headers 承载响应头：getSetCookie() 优先（逐条、不失真）；
        // 缺失时回退 forEach 合并值（需要按 name= 边界拆分，Expires 内逗号安全）。
        const headersWithGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] };
        let setCookie: string[] = [];
        try {
          setCookie = headersWithGetSetCookie.getSetCookie?.() ?? [];
        } catch {
          setCookie = [];
        }
        if (setCookie.length === 0 && rawSetCookie.length > 0) {
          setCookie = splitSetCookie(rawSetCookie.join(', '));
        }
        if (setCookie.length > 0) headers['set-cookie'] = setCookie;
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

/** 兜底：把合并后的 set-cookie 头按 "name=" 边界拆回单条（Expires 内逗号安全）。 */
function splitSetCookie(joined: string | null): string[] {
  if (!joined) return [];
  return joined
    .split(/,(?=\s*[A-Za-z0-9_!#$%&'*+\-.^`|~]+=)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

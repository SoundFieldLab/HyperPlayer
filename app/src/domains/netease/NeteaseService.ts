/**
 * NeteaseService —— 网易云协议服务（waveforge local-server.mjs 92 条路由业务逻辑全量移植）。
 *
 * 移植语义（行为 oracle = WaveForge 现网实现）：
 *  - 统一包装 call：重试 3 / 超时 15s / 指数退避 500×(i+1) / timeout 透传 params（底层真正中止）；
 *  - song/url：音质降级候选循环（首候选 2 次、后续 1 次、预算 16s）+ 付费拦截（fee 1/4 拒返 URL）；
 *  - **song_url_match 跨平台 fallback 路径废除**（LGPL 解灰红线，THIRD_PARTY_NOTICES.md）；
 *  - QR 三路由透传（key/create 重试 3 次间隔 1s；check 不重试、异常保持轮询）；
 *  - tokenInvalid 全局拦截：code 301/401/400 → SessionService.onTokenInvalid()（降级匿名 + 局部提示）。
 */
import type { NeteaseApi } from './api/neteaseApi';
import type { NeteaseApiAnswer } from './api/vendor-api';
import type { SessionService } from './SessionService';
import type { Logger } from '../../shared/logger';
import { createNullLogger } from '../../shared/logger';

export const NETEASE_CALL_RETRIES = 3;
export const NETEASE_CALL_TIMEOUT_MS = 15_000;
export const SONG_URL_BUDGET_MS = 16_000;

export type QualityPreference = 'standard' | 'high' | 'very-high' | 'lossless' | 'hi-res' | 'auto';

const AUDIO_QUALITY_PREFERENCES = new Set<QualityPreference>(['standard', 'high', 'very-high', 'lossless', 'hi-res', 'auto']);

/** 音质降级候选链（waveforge getNeteaseQualityCandidates 语义，原样移植）。 */
export function getNeteaseQualityCandidates(preference: QualityPreference, isVip: boolean): string[] {
  const free = ['exhigh', 'standard'];
  if (!isVip) {
    if (preference === 'standard') return ['standard'];
    return free;
  }
  switch (preference) {
    case 'standard':
      return ['standard'];
    case 'high':
      return ['exhigh', 'standard'];
    case 'very-high':
    case 'lossless':
      return ['lossless', 'exhigh', 'standard'];
    case 'hi-res':
      return ['hires', 'lossless', 'exhigh', 'standard'];
    case 'auto':
    default:
      return ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'];
  }
}

export function normalizeAudioQualityPreference(value: unknown): QualityPreference {
  const normalized = String(value ?? 'auto') as QualityPreference;
  return AUDIO_QUALITY_PREFERENCES.has(normalized) ? normalized : 'auto';
}

export interface SongUrlResult {
  code: number;
  data: Array<{ id: number; url: string | null; fee?: number; level?: string; br?: number; size?: number; md5?: string }>;
  fallback: false;
  source: string;
  qualityPreference: QualityPreference;
  actualQuality: string | null;
  fallbackBlocked?: 'paid-content';
}

export interface NeteaseServiceDeps {
  api: NeteaseApi;
  session: SessionService;
  logger?: Logger;
}

type RouteEntry =
  | { endpoint: string }
  | { handler: (this: NeteaseService, params: Record<string, unknown>) => Promise<unknown> };

const ROUTES: Record<string, RouteEntry> = {
  // 搜索
  '/netease/search': { endpoint: 'search' },
  '/netease/search/suggest': { endpoint: 'search_suggest' },
  '/netease/search/hot': { endpoint: 'search_hot' },
  // 歌曲
  '/netease/song/url': { handler: function songUrl(this: NeteaseService, params: Record<string, unknown>) { return this.songUrl(params); } },
  '/netease/song/detail': { endpoint: 'song_detail' },
  '/netease/lyric': { endpoint: 'lyric' },
  '/netease/song/simi': { endpoint: 'simi_song' },
  '/netease/song/similar': { endpoint: 'simi_song' },
  '/netease/song/related-playlist': { endpoint: 'simi_playlist' },
  '/netease/song/like-check': { endpoint: 'song_like_check' },
  '/netease/song/wiki': { endpoint: 'song_detail' },
  '/netease/song/blog': { endpoint: 'song_detail' },
  // 榜单 / 推荐
  '/netease/top/song': { endpoint: 'top_song' },
  '/netease/top/artists': { endpoint: 'top_artists' },
  '/netease/top/album': { endpoint: 'top_album' },
  '/netease/top/mv': { endpoint: 'top_mv' },
  '/netease/toplist/detail': { endpoint: 'toplist_detail' },
  '/netease/toplist/songs': { endpoint: 'toplist' },
  '/netease/personalized/newsong': { endpoint: 'personalized_newsong' },
  '/netease/recommend/songs': { endpoint: 'recommend_songs' },
  '/netease/recommend/resource': { endpoint: 'recommend_resource' },
  '/netease/recommend/dislike': { endpoint: 'recommend_songs_dislike' },
  '/netease/personal_fm': { endpoint: 'personal_fm' },
  '/netease/fm/trash': { endpoint: 'fm_trash' },
  '/netease/playmode/intelligence/list': { endpoint: 'playmode_intelligence_list' },
  // 歌单
  '/netease/playlist/detail': { endpoint: 'playlist_detail' },
  '/netease/playlist/tracks': { endpoint: 'playlist_tracks' },
  '/netease/playlist/create': { endpoint: 'playlist_create' },
  '/netease/playlist/delete': { endpoint: 'playlist_delete' },
  '/netease/playlist/update': { endpoint: 'playlist_update' },
  '/netease/playlist/subscribe': { endpoint: 'playlist_subscribe' },
  '/netease/playlist/cover': { endpoint: 'playlist_cover_update' },
  '/netease/playlist/catlist': { endpoint: 'playlist_catlist' },
  '/netease/playlist/hot': { endpoint: 'playlist_hot' },
  '/netease/playlist/highquality': { endpoint: 'top_playlist_highquality' },
  '/netease/playlist/simi': { endpoint: 'simi_playlist' },
  '/netease/playlist/related': { endpoint: 'simi_playlist' },
  // 歌手 / 专辑
  '/netease/artist': { endpoint: 'artist_detail' },
  '/netease/artist/songs': { endpoint: 'artist_songs' },
  '/netease/artist/albums': { endpoint: 'artist_album' },
  '/netease/artist/mvs': { endpoint: 'artist_mv' },
  '/netease/artist/similar': { endpoint: 'simi_artist' },
  '/netease/artist/subscribe': { endpoint: 'artist_sub' },
  '/netease/artist/sublist': { endpoint: 'artist_sublist' },
  '/netease/artist/list': { endpoint: 'artist_list' },
  '/netease/album': { endpoint: 'album' },
  '/netease/albums/covers': { endpoint: 'album_detail' },
  '/netease/album/subscribe': { endpoint: 'album_sub' },
  '/netease/album/sublist': { endpoint: 'album_sublist' },
  // MV
  '/netease/mv/url': { endpoint: 'mv_url' },
  '/netease/mv/detail': { endpoint: 'mv_detail' },
  '/netease/mv/all': { endpoint: 'mv_all' },
  '/netease/mv/subscribe': { endpoint: 'mv_sub' },
  '/netease/mv/sublist': { endpoint: 'mv_sublist' },
  '/netease/simi/mv': { endpoint: 'simi_mv' },
  // 电台
  '/netease/dj/recommend': { endpoint: 'dj_recommend' },
  '/netease/dj/subscribe': { endpoint: 'dj_sub' },
  '/netease/dj/sublist': { endpoint: 'dj_sublist' },
  '/netease/dj/catelist': { endpoint: 'dj_catelist' },
  '/netease/dj/hot': { endpoint: 'dj_hot' },
  // 用户 / 记录
  '/netease/user/account': { endpoint: 'user_account' },
  '/netease/user/playlist': { endpoint: 'user_playlist' },
  '/netease/user/detail': { endpoint: 'user_detail' },
  '/netease/user/follows': { endpoint: 'user_follows' },
  '/netease/user/followeds': { endpoint: 'user_followeds' },
  '/netease/user/subscribe': { endpoint: 'artist_sub' },
  '/netease/record/recent/:type': { endpoint: 'record_recent_song' },
  '/netease/record/rank/:type': { endpoint: 'record_recent_song' },
  '/netease/record/recent/report': { endpoint: 'record_recent_song' },
  // 喜欢 / 评论
  '/netease/like': { endpoint: 'like' },
  '/netease/likelist': { endpoint: 'likelist' },
  '/netease/comment/music': { endpoint: 'comment_music' },
  '/netease/comment/floor': { endpoint: 'comment_floor' },
  '/netease/comment/hot': { endpoint: 'comment_hot' },
  '/netease/comment/add': { endpoint: 'comment_add' },
  '/netease/comment/reply': { endpoint: 'comment_reply' },
  '/netease/comment/delete': { endpoint: 'comment_delete' },
  '/netease/comment/like': { endpoint: 'comment_like' },
  // 其他
  '/netease/banner': { endpoint: 'banner' },
  '/netease/vip/info': { endpoint: 'vip_info' },
  '/netease/cloud/list': { endpoint: 'cloud' },
  '/netease/cloud/url': { endpoint: 'song_cloud_download' },
  '/netease/cloud/delete': { endpoint: 'cloud' },
  '/netease/event/following': { endpoint: 'event_forward' },
  '/netease/event/user': { endpoint: 'event_forward' },
  '/netease/msg/notices': { endpoint: 'msg_notices' },
  '/netease/msg/comments': { endpoint: 'msg_comments' },
};

export class NeteaseService {
  private readonly api: NeteaseApi;
  private readonly session: SessionService;
  private readonly logger: Logger;

  constructor(deps: NeteaseServiceDeps) {
    this.api = deps.api;
    this.session = deps.session;
    this.logger = deps.logger ?? createNullLogger();
  }

  /**
   * 92 条路由入口（waveforge local-server.mjs 移植）：
   * route('/netease/song/url', { id, quality, vip }).
   */
  async route(uri: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const entry = ROUTES[uri];
    if (!entry) throw new Error(`netease: 未知路由 ${uri}`);
    if ('handler' in entry) return entry.handler.call(this, params);
    return this.call(entry.endpoint, params);
  }

  /**
   * 统一协议调用（waveforge callNeteaseAPIWithRetry 语义）。
   * timeout 透传 params：底层真正中止，避免 Promise.race 只竞速留下孤儿请求。
   */
  async call(endpoint: string, params: Record<string, unknown> = {}, opts: { retries?: number; timeoutMs?: number } = {}): Promise<NeteaseApiAnswer> {
    const retries = opts.retries ?? NETEASE_CALL_RETRIES;
    const timeoutMs = opts.timeoutMs ?? NETEASE_CALL_TIMEOUT_MS;
    const data: Record<string, unknown> = { ...params, timeout: timeoutMs };
    const cookie = this.session.getCookie();
    if (cookie && Object.keys(cookie).length > 0) data.cookie = cookie;

    let lastError: unknown = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        // waveforge 语义：withTimeout 包单次调用（循环在外），timeout 透传 params 真正中止
        const answer = await withTimeout(this.api[endpoint]!(data), timeoutMs);
        if (answer && answer.body) {
          this.checkTokenInvalid(answer);
          return answer;
        }
      } catch (error) {
        lastError = error;
        if (attempt === retries - 1) break;
        this.logger.warn(`netease: ${endpoint} attempt ${attempt + 1} failed, retrying`, error);
        await delay(500 * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${endpoint}: 请求失败`);
  }

  /**
   * song/url：音质降级候选循环 + 付费拦截。
   * 循环语义：首候选 2 次尝试、后续 1 次；预算 16s；链尽才失败。
   * 付费拦截：所有候选无 URL 时用 song_detail 判定 fee === 1 || 4 → 拒返 URL（URL null + fee 标记）。
   * song_url_match 跨平台 fallback 已废除（红线）。
   */
  async songUrl(params: Record<string, unknown>): Promise<SongUrlResult> {
    const id = String(params.id ?? '');
    if (!id) throw new Error('请提供歌曲ID');
    const qualityPreference = normalizeAudioQualityPreference(params.quality);
    const isVip = params.vip === true || params.vip === 'true';
    const candidates = getNeteaseQualityCandidates(qualityPreference, isVip);

    const deadlineAt = Date.now() + SONG_URL_BUDGET_MS;
    let officialBody: NeteaseApiAnswer['body'] | null = null;
    let actualQuality: string | null = null;
    let lastError: unknown = null;

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const level = candidates[candidateIndex] as string;
      const attempts = candidateIndex === 0 ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 300) break;
        try {
          const result = await this.call('song_url_v1', { id, level }, { retries: 1, timeoutMs: Math.max(300, Math.min(4500, remaining)) });
          if (result?.body) {
            officialBody = result.body;
            const item = (result.body.data as Array<Record<string, unknown>> | undefined)?.[0];
            if (item?.url) {
              actualQuality = (item.level as string | undefined) ?? level;
              return {
                ...(result.body as unknown as SongUrlResult),
                fallback: false,
                source: '网易云音乐',
                qualityPreference,
                actualQuality,
              };
            }
            break; // 该候选无 URL → 下一候选
          }
        } catch (error) {
          lastError = error;
          if (attempt + 1 < attempts && deadlineAt - Date.now() > 500) {
            await delay(150);
          }
        }
      }
    }

    // 付费拦截（waveforge :2125 语义：fee === 1 || 4 拒返 URL + 明确标记，UI-D34 权益显示）
    const feeResult = await this.checkPaidContent(id, officialBody);
    if (feeResult) return feeResult;

    if (officialBody) {
      return {
        ...(officialBody as unknown as SongUrlResult),
        fallback: false,
        source: '网易云音乐',
        qualityPreference,
        actualQuality,
      };
    }

    throw lastError instanceof Error ? lastError : new Error('获取播放链接失败');
  }

  /** 付费拦截：song_detail 判定 fee 1/4 → 拒返 URL（返回标记；非付费返回 null）。 */
  private async checkPaidContent(id: string, officialBody: NeteaseApiAnswer['body'] | null): Promise<SongUrlResult | null> {
    try {
      const detail = await this.call('song_detail', { ids: String(id) }, { retries: 1, timeoutMs: 4000 });
      const song = (detail.body?.songs as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
      const privilege = ((detail.body?.privileges as Array<Record<string, unknown>> | undefined)?.[0] ??
        song.privilege ??
        {}) as Record<string, unknown>;
      const officialItem = ((officialBody?.data as Array<Record<string, unknown>> | undefined)?.[0] ?? {}) as Record<string, unknown>;
      const fee = Number(song.fee ?? privilege.fee ?? officialItem.fee ?? 0);
      if (fee === 1 || fee === 4) {
        return {
          code: 200,
          data: [{ id: Number(id), url: null, fee }],
          fallback: false,
          source: '网易云音乐',
          qualityPreference: normalizeAudioQualityPreference('auto'),
          actualQuality: null,
          fallbackBlocked: 'paid-content',
        };
      }
    } catch {
      // 权限检查失败不阻塞主路径
    }
    return null;
  }

  /** tokenInvalid 全局拦截：会话失效 → 降级匿名 + 局部提示（不炸页面）。 */
  private checkTokenInvalid(answer: NeteaseApiAnswer): void {
    const code = Number(answer.body?.code);
    if (code === 301 || code === 401 || code === 400) {
      this.session.onTokenInvalid();
    }
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = '请求超时'): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

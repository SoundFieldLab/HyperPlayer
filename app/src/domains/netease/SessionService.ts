/**
 * SessionService —— 网易云会话状态机（播放器架构.md §3.3）。
 *
 * 状态：anonymous ⇄ qrWaiting ⇄ qrScanned ⇄ loggedIn。
 *  - tokenInvalid 全局拦截：任意协议调用发现会话失效 → 统一事件 → 降级匿名 + 局部提示；
 *  - QR 轮询无次数终止（轮询永不主动断，800 过期自动重取码），仅用户取消或登录成功停止；
 *  - Cookie/凭据只在 stronghold（infra vault）；UI 永不显示/编辑原始 Cookie（UI-D32）。
 */
import type { NeteaseApi } from './api/neteaseApi';
import type { Vault } from '../../infra/vault';
import type { Logger } from '../../shared/logger';
import { createNullLogger } from '../../shared/logger';

export type SessionState = 'anonymous' | 'qrWaiting' | 'qrScanned' | 'loggedIn';

export const QR_POLL_INTERVAL_MS = 1500;
export const QR_EXPIRED_CODE = 800;
export const QR_RETRY_COUNT = 3;
export const QR_RETRY_DELAY_MS = 1000;

export interface QrLoginSession {
  key: string;
  qrimg: string;
}

export interface SessionServiceDeps {
  api: NeteaseApi;
  vault: Vault;
  onStateChange?: (state: SessionState) => void;
  /** 局部提示（tokenInvalid 降级匿名、网络错误等）。 */
  onNotice?: (message: string) => void;
  logger?: Logger;
}

export class SessionService {
  private state: SessionState = 'anonymous';
  private cookie: Record<string, string> | null = null;
  private qrKey: string | null = null;
  private polling = false;
  private readonly api: NeteaseApi;
  private readonly vault: Vault;
  private readonly onStateChange: ((state: SessionState) => void) | undefined;
  private readonly onNotice: ((message: string) => void) | undefined;
  private readonly logger: Logger;

  constructor(deps: SessionServiceDeps) {
    this.api = deps.api;
    this.vault = deps.vault;
    this.onStateChange = deps.onStateChange;
    this.onNotice = deps.onNotice;
    this.logger = deps.logger ?? createNullLogger();
  }

  get snapshot(): SessionState {
    return this.state;
  }

  get isLoggedIn(): boolean {
    return this.state === 'loggedIn';
  }

  /** 启动时恢复 vault 中的凭据（安全默认：恢复为 loggedIn 但由 UI-D76 控制自动出声）。 */
  async restoreSession(): Promise<SessionState> {
    const raw = await this.vault.getSecret('netease', 'cookie');
    if (raw) {
      try {
        this.cookie = JSON.parse(raw) as Record<string, string>;
        this.setState('loggedIn');
      } catch {
        await this.vault.deleteSecret('netease', 'cookie');
      }
    }
    return this.state;
  }

  /** 发起扫码登录：qrKey + qrCreate（各重试 3 次、间隔 1s，waveforge 透传语义）。 */
  async startQrLogin(): Promise<QrLoginSession> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < QR_RETRY_COUNT; attempt += 1) {
      try {
        const keyAnswer = await this.api.login_qr_key!({});
        const key = (keyAnswer.body?.data as Record<string, unknown> | undefined)?.unikey as string | undefined;
        if (!key) throw new Error('qr key 缺失');
        const createAnswer = await this.api.login_qr_create!({ key, qrimg: true });
        const qrimg = (createAnswer.body?.data as Record<string, unknown> | undefined)?.qrimg as string | undefined;
        if (!qrimg) throw new Error('qr image 缺失');
        this.qrKey = key;
        this.setState('qrWaiting');
        return { key, qrimg };
      } catch (error) {
        lastError = error;
        this.logger.warn(`session: qr create attempt ${attempt + 1} failed`, error);
        await delay(QR_RETRY_DELAY_MS);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('扫码登录初始化失败');
  }

  /** 单次轮询检查（不重试；800 过期自动重取码，永不主动断）。 */
  async pollQrOnce(): Promise<SessionState> {
    if (!this.qrKey) return this.state;
    try {
      const answer = await this.api.login_qr_check!({ key: this.qrKey });
      const code = Number(answer.body?.code);
      if (code === 803) {
        // 登录成功：凭据只进 vault，UI 永不见原始 Cookie
        this.cookie = this.collectCookie(answer.cookie);
        await this.vault.setSecret('netease', 'cookie', JSON.stringify(this.cookie));
        this.setState('loggedIn');
        return 'loggedIn';
      }
      if (code === 802) this.setState('qrScanned');
      else if (code === 801) this.setState('qrWaiting');
      else if (code === QR_EXPIRED_CODE) {
        await this.refreshQr();
      }
      return this.state;
    } catch (error) {
      // 网络异常：保持当前状态，局部提示（不中断轮询）
      this.logger.warn('session: qr check failed', error);
      this.onNotice?.('二维码状态检查失败，重试中…');
      return this.state;
    }
  }

  /** 轮询直到登录成功或用户取消（startQrPolling 返回 loggedIn 或取消时当前状态）。 */
  async startQrPolling(intervalMs: number = QR_POLL_INTERVAL_MS): Promise<SessionState> {
    this.polling = true;
    try {
      while (this.polling) {
        const state = await this.pollQrOnce();
        if (state === 'loggedIn') return state;
        await delay(intervalMs);
      }
    } finally {
      this.polling = false;
    }
    return this.state;
  }

  /** 用户取消轮询（仅用户取消或登录成功停止）。 */
  stopQrPolling(): void {
    this.polling = false;
  }

  /** tokenInvalid 全局拦截：降级匿名 + 局部提示（不炸页面，UI-D31/D32）。 */
  onTokenInvalid(): void {
    if (this.state === 'anonymous') return;
    this.cookie = null;
    this.qrKey = null;
    void this.vault.deleteSecret('netease', 'cookie').catch(() => {});
    this.setState('anonymous');
    this.onNotice?.('登录已失效，已降级为匿名模式');
  }

  /** 显式退出登录。 */
  async logout(): Promise<void> {
    this.cookie = null;
    this.qrKey = null;
    this.polling = false;
    await this.vault.deleteSecret('netease', 'cookie');
    this.setState('anonymous');
  }

  /** 供协议层注入 cookie（内部使用，不暴露给 UI）。 */
  getCookie(): Record<string, string> | null {
    return this.cookie;
  }

  private async refreshQr(): Promise<void> {
    try {
      await this.startQrLogin();
    } catch (error) {
      this.logger.warn('session: qr refresh failed', error);
    }
  }

  private collectCookie(setCookie: string[]): Record<string, string> {
    const cookie: Record<string, string> = {};
    for (const raw of setCookie ?? []) {
      const [pair] = raw.split(';');
      if (!pair) continue;
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const key = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (key) {
        try {
          cookie[key] = decodeURIComponent(value);
        } catch {
          cookie[key] = value; // 非法 % 序列：原样保留（不阻断登录成功）
        }
      }
    }
    return cookie;
  }

  private setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

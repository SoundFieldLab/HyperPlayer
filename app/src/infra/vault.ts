/**
 * infra vault —— tauri-plugin-stronghold 薄封装（网易云凭据/Cookie 加密存储）。
 * 凭据只在 stronghold；UI 永不显示/编辑原始 Cookie（UI-D32/播放器架构.md §3.3）。
 * 真实接线在 P4 SessionService 落地时实现；本层先定接口。
 */
export interface Vault {
  getSecret(namespace: string, key: string): Promise<string | null>;
  setSecret(namespace: string, key: string, value: string): Promise<void>;
  deleteSecret(namespace: string, key: string): Promise<void>;
}

/**
 * 创建 stronghold vault 实例。
 * 注意：P4 接线需插件 Builder 提供的 key 派生与 client 句柄；当前为骨架，
 * 抛错提示尚未接线（调用方应在 P4 前仅注入 fake）。
 */
export async function createVault(): Promise<Vault> {
  throw new Error('vault: stronghold 接线将在 P4 SessionService 阶段落地');
}

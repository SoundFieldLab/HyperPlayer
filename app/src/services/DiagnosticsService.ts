/**
 * DiagnosticsService —— 诊断包导出（后端补充规划 #46）。
 *
 * 汇总 app 版本 / settings 快照（脱敏）/ 全量文件日志 → 单个 JSON 写入
 * $APPDATA/diagnostics/（fs scope 内，无权限风险）；返回文件路径供 UI 展示。
 */
import type { TauriFs } from '../infra/tauriFs';
import type { FileLogger } from '../shared/fileLogger';
import { redactJson } from '../shared/fileLogger';
import type { SettingsService } from './SettingsService';

export interface DiagnosticsServiceDeps {
  fs: TauriFs;
  logger: FileLogger;
  settings: SettingsService;
  /** 诊断包输出目录（appData/diagnostics）。 */
  dir: string;
  /** 应用版本（wiring 注入 getVersion()，失败 'unknown'）。 */
  appVersion: string;
  now?: () => number;
}

export class DiagnosticsService {
  private readonly deps: DiagnosticsServiceDeps;
  private readonly now: () => number;

  constructor(deps: DiagnosticsServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** 导出诊断包；返回文件路径。 */
  async exportDiagnostics(): Promise<string> {
    await this.deps.fs.mkdir(this.deps.dir);
    const bundle = {
      exportedAt: this.now(),
      app: { version: this.deps.appVersion },
      settings: redactJson(this.deps.settings.snapshot),
      logs: await this.deps.logger.readAll(),
    };
    const path = `${this.deps.dir}/hyperplayer-diagnostics-${this.now()}.json`;
    await this.deps.fs.writeFile(path, new TextEncoder().encode(JSON.stringify(bundle, null, 2)));
    return path;
  }
}

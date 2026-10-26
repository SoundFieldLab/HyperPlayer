/** 版本展示统一使用版本号本身，不附加代号或渠道标识。 */
export function getVersionDisplay(version: string): string {
  return String(version).replace(/^v/i, '')
}

/** 关于页与其他版本展示共用同一格式，版本号由 package.json 提供。 */
export function getVersionLabel(version: string): string {
  return getVersionDisplay(version)
}

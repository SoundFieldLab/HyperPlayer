'use strict'

const path = require('node:path')

/**
 * 解析 HyperPlayer 的 userData 目录（配置 / 登录态 / 缓存 / Chromium profile 的根）。
 *
 * 隔离原则：**HyperPlayer 与 WaveForge（及其他 Electron 应用）绝不共用任何配置目录**。
 *
 *   - 打包版：固定 `%APPDATA%/HyperPlayer`。忽略一切 override，避免用户被外部环境变量
 *     引导到别的产品目录（也可能被恶意构造的 env 指向共享位置）。
 *   - 开发版：同样固定 `%APPDATA%/HyperPlayer`，仅在显式传入绝对路径 override 时启用
 *     （供测试 / 多 profile 调试使用）。
 *
 * 历史说明：开发版早期因首次 `getPath('userData')` 时机过早，曾长期落在 Electron 的
 * **公共默认目录** `%APPDATA%/Electron` —— 那是所有 Electron 应用共享的位置（本机实测
 * 存在 WaveForge 等其他项目的键）。旧实现靠探测 `config.json` + 某个产品文件 + 开发源
 * IndexedDB 三个标记来「认领」该目录，但随着功能减配（`remote-settings.json` 所属的
 * 远程遥控已移除、不再创建），该判定对新建环境恒为 false，既不可靠、也把两个产品绑在了
 * 同一个公共目录上。现在彻底切断：不再探测、不再回退。
 *
 * 注意：本函数**只解析路径**，不复制/迁移/删除任何数据；切换目录后旧目录的数据仍留在磁盘上。
 */
function selectHyperPlayerUserData({ appDataRoot, isPackaged, overridePath }) {
  const stable = path.resolve(appDataRoot, 'HyperPlayer')
  if (isPackaged) return stable
  if (overridePath && path.isAbsolute(overridePath)) return path.resolve(overridePath)
  return stable
}

module.exports = { selectHyperPlayerUserData }

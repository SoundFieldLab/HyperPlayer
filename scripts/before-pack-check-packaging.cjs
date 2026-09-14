/**
 * electron-builder `beforePack` 钩子 —— 打包体积闸门的「最后一层」防护。
 *
 * 为什么需要这一层
 * ----------------
 * 体积约束本身写死在 `package.json`（依赖分区 + `build.files` 排除规则），是本仓
 * 真正的持久机制；`npm run build:electron:dir` 也已在打包前后各跑一次闸门。
 * 但那只覆盖「按脚本走」的路径：若有人绕过 npm script 直接调
 * `npx electron-builder --win dir`（排查问题时常这么干），闸门就被跳过了。
 *
 * `beforePack` 是 electron-builder 自身在**真正开始拷贝文件之前**触发的事件
 * （`app-builder-lib/out/platformPackager.js` 的 `doPack()` 里 `emitBeforePack`），
 * 与调用方式无关；在此抛错即中断打包。所以它能把「绕过脚本」这条路也堵上。
 *
 * ⚠️ 已知边界：`--prepackaged` 时 `doPack()` 会**提前 return**，本钩子不会触发。
 * 这是合理的——那条路径（`build:electron` 打 NSIS）打包的是**已经过闸门的**
 * `release/win-unpacked`，不重新解析 node_modules。
 *
 * 注意：这里跑的是 `--config-only`（只看依赖分区与排除规则，1~2 秒），
 * 不检查已构建产物——产物校验放在打包之后（见 build:electron:dir 末尾）。
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function checkPackagingBeforePack() {
  const root = path.resolve(__dirname, '..')
  try {
    execFileSync(
      process.execPath,
      [path.join(root, 'scripts', 'check-packaging.mjs'), '--config-only'],
      { stdio: 'inherit', cwd: root },
    )
  } catch {
    // 闸门自己已打印了详细的违规说明；这里点明是打包被拦下
    throw new Error(
      '打包体积闸门未通过（前端库须在 devDependencies / build.files 排除规则须齐全），已中止打包。'
      + ' 详见上方 [check-packaging] 输出与 AGENTS.md「依赖分区约束」。',
    )
  }
}

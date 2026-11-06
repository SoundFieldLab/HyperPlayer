/**
 * 把仓库的 git hooks 指向 .githooks/（提交前闸门）。
 *
 * 为什么用 `core.hooksPath` 而不是 husky：本仓库没有 ESLint / Prettier，
 * 引入 lint-staged 会无谓地重排大量文件；`core.hooksPath` 零新依赖、零格式翻修，
 * 且 hook 是普通 shell 脚本，可被直接阅读。
 *
 * 幂等：重复执行只是重设同一个值。在 CI（`npm ci --ignore-scripts`）不会运行；
 * 即使运行了，非 git 环境下也只打印提示并退出 0，不阻塞安装。
 */
import { execFileSync } from 'node:child_process'

const HOOKS_PATH = '.githooks'

const run = (args) => execFileSync('git', args, { stdio: 'pipe', encoding: 'utf8' })

try {
  run(['rev-parse', '--git-dir'])
} catch {
  console.log('[git-hooks] 当前目录不是 git 仓库，跳过 hooks 安装')
  process.exit(0)
}

try {
  const current = run(['config', '--get', 'core.hooksPath']).trim()
  if (current === HOOKS_PATH) {
    console.log(`[git-hooks] core.hooksPath 已是 ${HOOKS_PATH}`)
    process.exit(0)
  }
  run(['config', 'core.hooksPath', HOOKS_PATH])
  console.log(`[git-hooks] 已设置 core.hooksPath=${HOOKS_PATH}（提交前跑 lint / test:wiring / test:equivalence）`)
} catch (error) {
  console.warn('[git-hooks] 设置 core.hooksPath 失败（不阻塞安装）:', error?.message || error)
}

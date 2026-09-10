const { spawnSync } = require('node:child_process')

/** 发布构建要求的 VMP 最低剩余有效期（低于此值会重新签名） */
const MIN_RELEASE_VMP_DAYS = 30

/** 探测 Python 是否带 castlabs_evs 的超时（快速失败，避免卡住构建） */
const PROBE_TIMEOUT_MS = 30 * 1000
/**
 * 单次 EVS 命令超时上限。
 * 实测：222.6MB 的 Electron 二进制在 0.6 MB/s 下上传耗时约 402s；慢网/重试会显著更久。
 * 取 90 分钟（含失败后刷新授权并重试一次的总预算），避免中途误杀签名进程。
 */
const RUN_TIMEOUT_MS = 90 * 60 * 1000

/**
 * Python 解释器候选。按序探测，第一个能 `import castlabs_evs` 的胜出。
 *
 * 不硬编码机器专属路径（历史版本写死了 D:\Python\python.exe，换机即失效）；
 * 需要指定时用环境变量 HYPERPLAYER_EVS_PYTHON 或 EVS_PYTHON。
 */
function pythonCandidates() {
  return [
    process.env.HYPERPLAYER_EVS_PYTHON,
    process.env.EVS_PYTHON,
    process.env.PYTHON,
    'python',
    'python3',
    'py',
  ].filter(Boolean)
}

/** 解析候选可执行文件与其前缀参数（Windows 的 `py` 启动器需要 -3） */
function candidateArgs(candidate) {
  const isPyLauncher = /(^|[\\/])py(\.exe)?$/i.test(candidate)
  return isPyLauncher ? ['-3', '-c', 'import castlabs_evs'] : ['-c', 'import castlabs_evs']
}

function prefixOf(candidate) {
  return /(^|[\\/])py(\.exe)?$/i.test(candidate) ? ['-3'] : []
}

function findPython() {
  for (const candidate of pythonCandidates()) {
    const result = spawnSync(candidate, candidateArgs(candidate), {
      stdio: 'ignore',
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
    })
    if (result.status === 0) return { exe: candidate, prefix: prefixOf(candidate) }
  }
  return null
}

/**
 * 是否具备签名凭据。
 *
 * EVS 客户端可直接用两种凭据来源：
 *   1. 环境变量 EVS_ACCOUNT_NAME + EVS_PASSWD（CI / 无人值守场景）
 *   2. 已缓存的登录令牌 ~/.config/evs/config.json（本机注册并登录过一次后即存在）
 * 任一可用即可签名——只查环境变量会把本机开发流程误拦。
 */
function evsConfigPath() {
  return process.env.EVS_CONFIG_FILE
    || require('node:path').join(require('node:os').homedir(), '.config', 'evs', 'config.json')
}

function hasCredentials() {
  if (process.env.EVS_ACCOUNT_NAME && process.env.EVS_PASSWD) return true
  try {
    const raw = require('node:fs').readFileSync(evsConfigPath(), 'utf8')
    const auth = JSON.parse(raw)?.Auth
    // 缓存的刷新令牌足以换取新的访问令牌；访问令牌本身会过期，不能作为判据
    return Boolean(auth?.RefreshToken && (auth?.AccountName || process.env.EVS_ACCOUNT_NAME))
  } catch {
    return false
  }
}

function runEvs(command, packageDir, { required = false } = {}) {
  const python = findPython()
  if (!python) {
    const message = '[EVS/VMP] castlabs-evs 未安装或 Python 不可用'
      + '（安装：python -m pip install castlabs-evs；或用 HYPERPLAYER_EVS_PYTHON 指定解释器）'
    if (required) throw new Error(message)
    console.warn(message + '，跳过非发布构建签名')
    return false
  }

  if (command === 'sign-pkg' && !hasCredentials()) {
    const message = '[EVS/VMP] 缺少 EVS_ACCOUNT_NAME / EVS_PASSWD，无法签名'
      + '（EVS 账号免费注册：https://github.com/castlabs/electron-releases/wiki/EVS）'
    if (required) throw new Error(message)
    console.warn(message + '，跳过签名')
    return false
  }

  const args = [...python.prefix, '-m', 'castlabs_evs.vmp', command, '--streaming',
    '--min-days', String(MIN_RELEASE_VMP_DAYS),
    ...(command === 'sign-pkg' ? ['--multipart-part-size', '20', '--multipart-max-concurrency', '4', '--multipart-retries', '5'] : []),
    packageDir]
  const env = { ...process.env, EVS_NO_ASK: process.env.EVS_NO_ASK || '1' }
  const execute = () => spawnSync(python.exe, args, {
    stdio: 'inherit',
    windowsHide: true,
    env,
    timeout: RUN_TIMEOUT_MS,
  })
  console.log(`[EVS/VMP] ${command}: ${packageDir}`)
  let result = execute()
  if (result.error && result.error.code === 'ETIMEDOUT') {
    console.warn(`[EVS/VMP] ${command} 超过 ${RUN_TIMEOUT_MS / 60000} 分钟未完成`)
  }
  // 令牌过期/上传槽失效时，刷新账户授权后重试一次
  if (result.status !== 0 && command === 'sign-pkg') {
    console.warn('[EVS/VMP] 首次签名失败，刷新账户授权并重新获取上传槽后重试一次')
    spawnSync(python.exe, [...python.prefix, '-m', 'castlabs_evs.account', '-n', 'refresh'], {
      stdio: 'inherit', windowsHide: true, env, timeout: RUN_TIMEOUT_MS,
    })
    result = execute()
  }
  if (result.status !== 0) {
    const message = `[EVS/VMP] ${command} 失败（exit=${result.status}${result.error ? `, ${result.error.code || result.error.message}` : ''}）`
    if (required) throw new Error(message)
    console.warn(message)
    return false
  }
  return true
}

// EVS/VMP 命令 helper。正式构建采用明确的两阶段流程：
// electron-builder --win dir → sign-pkg/verify-pkg → electron-builder --prepackaged ... nsis。
// 不依赖 electron-builder afterSign（无 Authenticode 时该 hook 会被跳过）。
exports.MIN_RELEASE_VMP_DAYS = MIN_RELEASE_VMP_DAYS
exports.findPython = findPython
exports.hasCredentials = hasCredentials
exports.runEvs = runEvs

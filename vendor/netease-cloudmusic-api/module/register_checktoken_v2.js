// 易盾反作弊 Token 注册端点
// 调用后获取实时 token 并存入共享存储，供后续带 checkToken 的请求使用
//
// GET  /register/checktoken        → 返回当前 token（尚无则自动获取）
// POST /register/checktoken        → 强制刷新 token
// GET  /register/checktoken?refresh=1 → 强制刷新
//
// HyperPlayer adaptations: 浏览器传输
const axios = require('../util/browserHttp')
const { APP_CONF } = require('../util/config.json')

const URL = APP_CONF.dunDomainV2 + '/v2/config/js?pn=YD00000558929251'
let _token = ''

async function fetch() {
  const res = await axios.get(URL, { timeout: 10000 })
  const data = res.data
  if (data && data.code === 200 && data.result && data.result.conf) {
    return data.result.conf
  }
  throw new Error('易盾返回异常: ' + JSON.stringify(data).substring(0, 200))
}

// 端点处理
module.exports = async (query) => {
  const refresh = query.refresh === '1' || query.refresh === 'true'
  let token = refresh ? null : _token
  if (!token) {
    token = await // HyperPlayer adaptations: 启动拉取失败静默（token 为空由 request.js 兜底）
fetch().catch(() => {})
    _token = token
  }
  return {
    status: 200,
    body: { code: 200, token, registered: !!token },
  }
}

// HyperPlayer adaptations: 移除模块加载时的自动预取——本模块在 boot 阶段即被
// request.js 顶层 require，此时浏览器传输尚未注入，预取必然失败且拖慢启动；
// token 一律在真实请求触发 getToken() 时懒加载。
module.exports.getToken = () => {
  if (!_token) {
    // 如果 Token 为空，异步触发获取
    // HyperPlayer adaptations: 拉取失败静默（token 为空由 request.js 兜底）
fetch().catch(() => {})
      .then((token) => {
        _token = token
      })
      .catch(() => {})
  }
  return _token
}

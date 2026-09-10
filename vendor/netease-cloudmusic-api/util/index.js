// HyperPlayer adaptations: 浏览器环境通用工具。伪造中国 IP 的 randomCNIP/realIP 逻辑已移除——
// 网易云匿名/登录访问无需伪装地域，匿名态由 anonymous_token(MUSIC_A) 承担。

module.exports = {
  toBoolean(val) {
    if (typeof val === 'boolean') return val
    if (val === '') return val
    return val === 'true' || val == '1'
  },

  cookieToJson(cookie) {
    if (!cookie) return {}
    let cookieArr = cookie.split(';')
    let obj = {}

    for (let i = 0, len = cookieArr.length; i < len; i++) {
      let item = cookieArr[i]
      let arr = item.split('=')
      if (arr.length === 2) {
        obj[arr[0].trim()] = arr[1].trim()
      }
    }
    return obj
  },

  cookieObjToString(cookie) {
    const keys = Object.keys(cookie)
    const result = []

    for (let i = 0, len = keys.length; i < len; i++) {
      const key = keys[i]
      result[i] = `${encodeURIComponent(key)}=${encodeURIComponent(cookie[key])}`
    }

    return result.join('; ')
  },

  // 生成chainId的函数
  generateChainId(cookie) {
    const version = 'v1'
    const randomNum = Math.floor(Math.random() * 1e6)
    const deviceId =
      getCookieValue(cookie, 'sDeviceId') || 'unknown-' + randomNum
    const platform = 'web'
    const action = 'login'
    const timestamp = Date.now()

    return `${version}_${deviceId}_${platform}_${action}_${timestamp}`
  },

  generateDeviceId() {
    const hexChars = '0123456789ABCDEF'
    const chars = []
    for (let i = 0; i < 52; i++) {
      const randomIndex = Math.floor(Math.random() * hexChars.length)
      chars.push(hexChars[randomIndex])
    }
    return chars.join('')
  },
}

// 用于从cookie字符串中获取指定值的辅助函数
function getCookieValue(cookieStr, name) {
  if (!cookieStr) return ''

  const cookies = '; ' + cookieStr
  const parts = cookies.split('; ' + name + '=')
  if (parts.length === 2) return parts.pop().split(';').shift()
  return ''
}

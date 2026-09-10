const QRCode = require('qrcode')
const { generateChainId } = require('../util/index')

module.exports = async (query) => {
  const platform = query.platform || 'pc'
  const cookie = query.cookie || ''

  // 构建基础URL
  let url = `https://music.163.com/login?codekey=${query.key}`

  // 如果是web平台，则添加chainId参数
  if (platform === 'web') {
    const chainId = generateChainId(cookie)
    url += `&chainId=${chainId}`
  }

  // HyperPlayer adaptations: async executor 内的异常必须 reject，
  // 否则二维码生成失败会让扫码登录无限挂起。
  try {
    const qrimg = query.qrimg ? await QRCode.toDataURL(url) : ''
    return {
      code: 200,
      status: 200,
      body: {
        code: 200,
        data: {
          qrurl: url,
          qrimg,
        },
      },
    }
  } catch (error) {
    throw {
      status: 500,
      body: { code: 500, msg: '二维码生成失败: ' + String((error && error.message) || error) },
      cookie: [],
    }
  }
}

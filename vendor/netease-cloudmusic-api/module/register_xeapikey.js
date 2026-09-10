// HyperPlayer adaptations: 浏览器版 xeapi 公钥注册（axios → 注入传输；xeapiSign → WebCrypto async）。
const browserHttp = require('../util/browserHttp')
const encrypt = require('../util/crypto')
const { APP_CONF } = require('../util/config.json')

const generateNonce = () => {
  let nonce = ''
  for (let i = 0; i < 16; i++) {
    nonce += Math.floor(Math.random() * 10).toString()
  }
  return nonce
}

module.exports = async (query) => {
  const nonce = generateNonce()
  const timestamp = String(Date.now())
  const deviceId = query.deviceId || globalThis.deviceId || ''
  const currentKeyVersion = query.currentKeyVersion || ''

  const data = {
    appVersion: '9.1.65',
    currentKeyVersion,
    deviceId,
    nonce,
    os: 'android',
    requestType: 'active',
    signature: await encrypt.xeapiSign(timestamp, nonce),
    t1: '',
    t2: '',
    timestamp,
    uid: '',
  }

  const res = await browserHttp({
    method: 'POST',
    url: APP_CONF.apiDomain + '/api/gorilla/anti/crawler/security/key/get',
    headers: {
      'User-Agent':
        'NeteaseMusic/9.1.65.240927161425(9001065);Dalvik/2.1.0 (Linux; U; Android 14; 23013RK75C Build/UKQ1.230804.001)',
      Cookie: deviceId ? `deviceId=${encodeURIComponent(deviceId)}` : '',
    },
    data: new URLSearchParams(data).toString(),
  })

  const body = res.data
  if (
    !body ||
    body.code !== 200 ||
    !body.data ||
    !body.data.encryptedData
  ) {
    throw new Error('xeapi public key request failed')
  }
  if (
    !body.data.signature ||
    (await encrypt.xeapiSign(body.data.timestamp, nonce)) !==
      body.data.signature
  ) {
    throw new Error('xeapi public key response signature mismatch')
  }

  const publicKey = encrypt.xeapiDecryptPublicKey(body.data.encryptedData)
  if (!publicKey.sk) {
    throw new Error('xeapi public key response missing sk')
  }

  return {
    status: 200,
    body: {
      ...publicKey,
      deviceId,
    },
    cookie: [],
  }
}

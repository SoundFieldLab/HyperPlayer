// 获取游客cookie
// HyperPlayer adaptations: 浏览器版——去掉 node fs/path；X25519 加密链走 WebCrypto 移植。
const CryptoJS = require('crypto-js')
const logger = require('../util/logger.js')

const createOption = require('../util/option.js')
const { generateDeviceId } = require('../util/index')

const ID_XOR_KEY_1 = '3go8&$8*3*3h0k(2)2'

function cloudmusic_dll_encode_id(some_id) {
  let xoredString = ''
  for (let i = 0; i < some_id.length; i++) {
    const charCode =
      some_id.charCodeAt(i) ^ ID_XOR_KEY_1.charCodeAt(i % ID_XOR_KEY_1.length)
    xoredString += String.fromCharCode(charCode)
  }
  const wordArray = CryptoJS.enc.Utf8.parse(xoredString)
  const digest = CryptoJS.MD5(wordArray)
  return CryptoJS.enc.Base64.stringify(digest)
}

module.exports = async (query, request) => {
  const deviceId = generateDeviceId()
  logger.info(`Successfully registered anonimous token, deviceId: ${deviceId}`)
  globalThis.deviceId = deviceId
  const encodedId = CryptoJS.enc.Base64.stringify(
    CryptoJS.enc.Utf8.parse(
      `${deviceId} ${cloudmusic_dll_encode_id(deviceId)}`,
    ),
  )
  const data = {
    username: encodedId,
  }
  let result = await request(
    `/api/register/anonimous`,
    data,
    createOption(query, 'xeapi'),
  )
  if (result.body.code === 200) {
    result = {
      status: 200,
      body: {
        ...result.body,
        cookie: result.cookie.join(';'),
      },
      cookie: result.cookie,
    }
  }
  return result
}

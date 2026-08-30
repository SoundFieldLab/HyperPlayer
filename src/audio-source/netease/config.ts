/** 网易云协议常量（提炼自公开协议库行为，Cleanroom 重写）。 */

export const DOMAIN_WEAPI = 'https://music.163.com'
export const DOMAIN_API = 'https://interface.music.163.com'
export const DOMAIN_EAPI = 'https://interfacepc.music.163.com'
export const DOMAIN_XEAPI = 'https://interface3.music.163.com'
export const DOMAIN_CLIENTLOG = 'https://clientlog.music.163.com'
export const DOMAIN_NOS_UPLOAD = 'https://nosup-hz1.127.net'

/** 网易云网页端 RSA 公钥（weapi encSecKey 无填充加密），1024 位 */
export const RSA_WEAPI_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`
export const RSA_WEAPI_BLOCK_SIZE = 128

export const WEAPI_PRESET_KEY = '0CoJUm6Qyw8W8jud'
export const WEAPI_IV = '0102030405060708'
export const WEAPI_SECRET_POOL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
export const EAPI_KEY = 'e82ckenh8dichen8'

/** xeapi 静态密钥与签名密钥（安卓客户端协议） */
export const XEAPI_STATIC_KEY_HEX = 'ab1d5a430f6bb04a3f01e81ddd72bd916d5ce591248ac128714806d7f8fb1b84'
export const XEAPI_SIGN_KEY_BASE64 = 'mUHCwVNWJbunMqAHf5MImuirT6plvs6VSFW62MGHstFQxhBGdEoIhLItH3djc4+FB/OKty3+lL2rGeoFBpVe5g=='
export const XEAPI_APP_VERSION = '9.1.65'
export const XEAPI_OS = 'android'
export const XEAPI_OSVER = '16'
export const X25519_SPKI_PREFIX_HEX = '302a300506032b656e032100'

/** 匿名注册的设备指纹混淆键 */
export const ID_XOR_KEY = '3go8&$8*3*3h0k(2)2'

/** PC 客户端设备画像（cookie/header 信封用） */
export const DEVICE_OS = 'pc'
export const DEVICE_OSVER = 'Microsoft-Windows-10-Professional-build-19045-64bit'
export const DEVICE_APPVER = '3.1.17.204416'
export const DEVICE_CHANNEL = 'netease'

export const USER_AGENT_WEAPI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'
export const USER_AGENT_ANDROID =
  'NeteaseMusic/9.1.65.240927161425(9001065);Dalvik/2.1.0 (Linux; U; Android 14; 23013RK75C Build/UKQ1.230804.001)'
export const USER_AGENT_IOS = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)'

/** 这些响应码按「成功」放行（登录轮询/部分写操作的语义码） */
export const SPECIAL_OK_CODES = new Set([201, 302, 400, 502, 800, 801, 802, 803])

/** 评论资源类型前缀：0歌曲 1MV 2歌单 3专辑 4电台 5视频 6动态 7数字专辑 */
export const COMMENT_RESOURCE_TYPE: Record<number, string> = {
  0: 'R_SO_4_',
  1: 'R_MV_5_',
  2: 'A_PL_0_',
  3: 'R_AL_3_',
  4: 'A_DJ_1_',
  5: 'R_VI_62_',
  6: 'A_EV_2_',
  7: 'A_DR_14_',
}

/** 歌单收藏（t=1）所需的防作弊 token 获取地址（易盾配置） */
export const CHECKTOKEN_V2_URL = 'https://dun.163.com/v2/config/js?pn=YD00000558929251'

/** 官方榜单歌单 id（参考项目验证的热歌榜/飙升榜） */
export const RANK_PLAYLIST_IDS = { hot: 3778678, surge: 19723756 } as const

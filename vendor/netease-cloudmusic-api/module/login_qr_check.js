const createOption = require('../util/option.js')
module.exports = async (query, request) => {
  const data = {
    key: query.key,
    type: 3,
  }
  try {
    let result = await request(
      `/api/login/qrcode/client/login`,
      data,
      createOption(query),
    )
    result = {
      status: 200,
      body: {
        ...result.body,
        cookie: result.cookie.join(';'),
      },
      cookie: result.cookie,
    }
    return result
  } catch (error) {
    // 融合适配（HyperPlayer）：上游 catch 引用了未定义的 result（底层请求 reject 时
    // 抛 ReferenceError 掩盖原错误），改为返回空 cookie 保留原错误语义。
    return {
      status: 200,
      body: {},
      cookie: [],
    }
  }
}

const createOption = (query, crypto = '', checkToken = false) => {
  return {
    crypto: query.crypto || crypto || '',
    cookie: query.cookie,
    ua: query.ua || '',
    proxy: query.proxy,
    e_r: query.e_r || undefined,
    domain: query.domain || '',
    checkToken: query.checkToken || checkToken,
    headers: query.headers || {},
    timeout: query.timeout || 0,
  }
}
module.exports = createOption

use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum Error {
    #[error("输入无效：{0}")]
    Validation(String),
    #[error("网络请求失败：{0}")]
    Transport(String),
    #[error("HTTP 状态错误：{0}")]
    HttpStatus(u16),
    #[error("网易云接口返回 code={code}: {message}")]
    Api { code: i64, message: String },
    #[error("响应格式无效：{0}")]
    InvalidResponse(String),
    #[error("协议加密失败：{0}")]
    Crypto(String),
    #[error("请求超时")]
    Timeout,
    #[error("需要登录")]
    LoginRequired,
    #[error("VIP 缓存无播放授权")]
    EntitlementDenied,
}

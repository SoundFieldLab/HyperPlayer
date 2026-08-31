//! 网易云音源后端边界。Cookie 与设备会话只存在于请求层，不属于产品 DTO。

pub mod crypto;
mod domains;
pub mod dto;
pub mod error;
mod mapping;
mod mv;
pub mod route;
pub mod service;
pub mod session;
pub mod transport;

pub use dto::*;
pub use error::{Error, Result};
pub use mv::MvPlayback;
pub use route::{capability, routes, Capability, Channel, RouteSpec};
pub use service::{NeteaseService, ProductionConfig, Sleeper, StdSleeper};
pub use session::{Session, XeapiKeyState};
pub use transport::{
    HttpRequest, HttpResponse, Method, ReqwestTransport, Transport, TransportConfig,
};

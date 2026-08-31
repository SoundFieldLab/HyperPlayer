use async_trait::async_trait;
use reqwest::header::{HeaderName, HeaderValue};
use std::collections::BTreeMap;
use std::time::Duration;

use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: BTreeMap<String, Vec<String>>,
    pub body: Vec<u8>,
}

#[async_trait]
pub trait Transport: Send + Sync {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportConfig {
    pub connect_timeout: Duration,
}

impl Default for TransportConfig {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
        }
    }
}

#[derive(Clone)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new(config: TransportConfig) -> Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(config.connect_timeout)
            .build()
            .map_err(|_| Error::Transport("HTTP 客户端初始化失败".into()))?;
        Ok(Self { client })
    }
}

#[async_trait]
impl Transport for ReqwestTransport {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse> {
        let method = match request.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
        };
        let mut builder = self
            .client
            .request(method, &request.url)
            .timeout(request.timeout)
            .body(request.body);

        for (name, value) in request.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| Error::Validation("HTTP header 名称无效".into()))?;
            let value = HeaderValue::from_str(&value)
                .map_err(|_| Error::Validation("HTTP header 值无效".into()))?;
            builder = builder.header(name, value);
        }

        let response = builder.send().await.map_err(map_reqwest_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::HttpStatus(status.as_u16()));
        }

        let mut headers = BTreeMap::<String, Vec<String>>::new();
        for (name, value) in response.headers() {
            headers
                .entry(name.as_str().to_owned())
                .or_default()
                .push(String::from_utf8_lossy(value.as_bytes()).into_owned());
        }
        let body = response.bytes().await.map_err(map_reqwest_error)?.to_vec();

        Ok(HttpResponse {
            status: status.as_u16(),
            headers,
            body,
        })
    }
}

fn map_reqwest_error(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::Timeout
    } else if error.is_connect() {
        Error::Transport("HTTP 连接失败".into())
    } else if error.is_body() || error.is_decode() {
        Error::Transport("HTTP 响应读取失败".into())
    } else {
        Error::Transport("HTTP 请求失败".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        thread,
    };

    fn spawn_server(response: &'static [u8]) -> (String, thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            stream.write_all(response).unwrap();
            request
        });
        (format!("http://{address}"), handle)
    }

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let read = stream.read(&mut buffer).unwrap();
            request.extend_from_slice(&buffer[..read]);
            if let Some(header_end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    return request;
                }
            }
        }
    }

    fn request(method: Method, url: String) -> HttpRequest {
        HttpRequest {
            method,
            url,
            headers: BTreeMap::new(),
            body: Vec::new(),
            timeout: Duration::from_secs(2),
        }
    }

    #[tokio::test]
    async fn sends_get_and_collects_response_headers() {
        let (url, server) = spawn_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Test: one\r\nX-Test: two\r\nConnection: close\r\n\r\nok",
        );
        let transport = ReqwestTransport::new(TransportConfig::default()).unwrap();
        let response = transport
            .execute(request(Method::Get, format!("{url}/search?q=x")))
            .await
            .unwrap();

        let raw = String::from_utf8(server.join().unwrap()).unwrap();
        assert!(raw.starts_with("GET /search?q=x HTTP/1.1\r\n"));
        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"ok");
        assert_eq!(response.headers.get("x-test").unwrap(), &["one", "two"]);
    }

    #[tokio::test]
    async fn sends_post_headers_and_body() {
        let (url, server) = spawn_server(
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let transport = ReqwestTransport::new(TransportConfig::default()).unwrap();
        let mut request = request(Method::Post, format!("{url}/submit"));
        request.headers.insert("X-Test".into(), "value".into());
        request.body = b"payload".to_vec();
        transport.execute(request).await.unwrap();

        let raw = String::from_utf8(server.join().unwrap()).unwrap();
        assert!(raw.starts_with("POST /submit HTTP/1.1\r\n"));
        assert!(raw.to_ascii_lowercase().contains("x-test: value\r\n"));
        assert!(raw.ends_with("\r\n\r\npayload"));
    }

    #[tokio::test]
    async fn rejects_non_success_status_without_exposing_request_data() {
        let (url, server) = spawn_server(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret",
        );
        let transport = ReqwestTransport::new(TransportConfig::default()).unwrap();
        let mut request = request(Method::Get, format!("{url}/private-url"));
        request
            .headers
            .insert("Cookie".into(), "MUSIC_U=private-cookie".into());
        let error = transport.execute(request).await.unwrap_err();
        server.join().unwrap();

        assert_eq!(error, Error::HttpStatus(503));
        let message = error.to_string();
        assert!(!message.contains("private-url"));
        assert!(!message.contains("private-cookie"));
        assert!(!message.contains("secret"));
    }

    #[tokio::test]
    async fn enforces_per_request_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(250));
        });
        let transport = ReqwestTransport::new(TransportConfig::default()).unwrap();
        let mut request = request(Method::Get, format!("http://{address}/slow"));
        request.timeout = Duration::from_millis(50);

        assert_eq!(transport.execute(request).await, Err(Error::Timeout));
        server.join().unwrap();
    }
}

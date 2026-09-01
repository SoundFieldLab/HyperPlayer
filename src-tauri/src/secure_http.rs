use crate::error::AppError;
use futures_util::StreamExt;
use reqwest::{redirect::Policy, StatusCode};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::net::lookup_host;
use url::Url;

pub(crate) const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const DEFAULT_MAX_REDIRECTS: usize = 3;

pub(crate) fn validate_fixed_https_url(
    url: &Url,
    expected_host: &str,
    resource: &str,
) -> Result<(), AppError> {
    if url.scheme() != "https"
        || url.host_str() != Some(expected_host)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::Unavailable(format!(
            "{resource} endpoint is not allowed"
        )));
    }
    Ok(())
}

pub(crate) fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => {
            let [first, second, ..] = value.octets();
            !(value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_multicast()
                || value.is_broadcast()
                || value.is_documentation()
                || value.is_unspecified()
                || first == 0
                || (first == 100 && (64..=127).contains(&second))
                || (first == 192 && second == 0)
                || (first == 198 && (second == 18 || second == 19))
                || first >= 240)
        }
        IpAddr::V6(value) => {
            let segments = value.segments();
            !(value.is_loopback()
                || value.is_unspecified()
                || value.is_unique_local()
                || value.is_unicast_link_local()
                || value.is_multicast()
                || value.to_ipv4_mapped().is_some()
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] & 0xffc0) == 0xfec0)
        }
    }
}

pub(crate) fn validate_public_addresses(
    addresses: Vec<SocketAddr>,
    resource: &str,
) -> Result<Vec<SocketAddr>, AppError> {
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(AppError::Unavailable(format!(
            "{resource} host must resolve only to public addresses"
        )));
    }
    Ok(addresses)
}

async fn resolve_public_addresses(url: &Url, resource: &str) -> Result<Vec<SocketAddr>, AppError> {
    let host = url
        .host_str()
        .ok_or_else(|| AppError::Unavailable(format!("{resource} host is missing")))?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = lookup_host((host, port))
        .await
        .map_err(|_| AppError::Unavailable(format!("{resource} is unavailable")))?
        .collect::<Vec<_>>();
    validate_public_addresses(addresses, resource)
}

pub(crate) fn resolve_fixed_redirect(
    base: &Url,
    location: &str,
    expected_host: &str,
    resource: &str,
) -> Result<Url, AppError> {
    let redirect = base
        .join(location)
        .map_err(|_| AppError::Unavailable(format!("invalid {resource} redirect")))?;
    validate_fixed_https_url(&redirect, expected_host, resource)?;
    Ok(redirect)
}

fn append_bounded(
    bytes: &mut Vec<u8>,
    chunk: &[u8],
    max_bytes: usize,
    resource: &str,
) -> Result<(), AppError> {
    if bytes.len().saturating_add(chunk.len()) > max_bytes {
        return Err(AppError::Unavailable(format!(
            "{resource} response exceeds the size limit"
        )));
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

pub(crate) async fn get_fixed_json(
    endpoint: Url,
    expected_host: &str,
    resource: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    let mut url = endpoint;
    for redirect_count in 0..=DEFAULT_MAX_REDIRECTS {
        validate_fixed_https_url(&url, expected_host, resource)?;
        let host = url
            .host_str()
            .ok_or_else(|| AppError::Unavailable(format!("{resource} host is missing")))?
            .to_owned();
        let addresses = resolve_public_addresses(&url, resource).await?;
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .timeout(DEFAULT_TIMEOUT)
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|_| AppError::Unavailable(format!("{resource} is unavailable")))?;
        let response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| AppError::Unavailable(format!("{resource} is unavailable")))?;
        if response.status().is_redirection() {
            if redirect_count == DEFAULT_MAX_REDIRECTS {
                return Err(AppError::Unavailable(format!(
                    "too many {resource} redirects"
                )));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AppError::Unavailable(format!("invalid {resource} redirect")))?;
            url = resolve_fixed_redirect(&url, location, expected_host, resource)?;
            continue;
        }
        if response.status() != StatusCode::OK {
            return Err(AppError::Unavailable(format!("{resource} is unavailable")));
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(AppError::Unavailable(format!(
                "{resource} response exceeds the size limit"
            )));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| AppError::Unavailable(format!("{resource} is unavailable")))?;
            append_bounded(&mut bytes, &chunk, max_bytes, resource)?;
        }
        return Ok(bytes);
    }
    Err(AppError::Unavailable(format!("{resource} is unavailable")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn fixed_url_rejects_other_hosts_and_unsafe_components() {
        let host = "api.open-meteo.com";
        for value in [
            "http://api.open-meteo.com/v1/forecast",
            "https://user:secret@api.open-meteo.com/v1/forecast",
            "https://api.open-meteo.com.evil.test/v1/forecast",
            "https://api.open-meteo.com/v1/forecast#fragment",
        ] {
            assert!(
                validate_fixed_https_url(&Url::parse(value).unwrap(), host, "weather").is_err()
            );
        }
        assert!(validate_fixed_https_url(
            &Url::parse("https://api.open-meteo.com/v1/forecast").unwrap(),
            host,
            "weather"
        )
        .is_ok());
    }

    #[test]
    fn fixed_redirect_cannot_escape_the_allowlist() {
        let base = Url::parse("https://api.open-meteo.com/v1/forecast").unwrap();
        assert!(resolve_fixed_redirect(
            &base,
            "/v1/forecast?next=1",
            "api.open-meteo.com",
            "weather"
        )
        .is_ok());
        assert!(resolve_fixed_redirect(
            &base,
            "https://127.0.0.1/private",
            "api.open-meteo.com",
            "weather"
        )
        .is_err());
        assert!(resolve_fixed_redirect(
            &base,
            "https://example.com/",
            "api.open-meteo.com",
            "weather"
        )
        .is_err());
    }

    #[test]
    fn mixed_or_private_address_sets_are_rejected() {
        let public = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), 443);
        let private = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 443);
        assert!(validate_public_addresses(vec![public], "weather").is_ok());
        assert!(validate_public_addresses(vec![public, private], "weather").is_err());
        assert!(validate_public_addresses(Vec::new(), "weather").is_err());
        assert!(!is_public_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    #[test]
    fn bounded_response_rejects_overflow() {
        let mut bytes = vec![1, 2];
        assert!(append_bounded(&mut bytes, &[3, 4], 3, "weather").is_err());
        assert_eq!(bytes, vec![1, 2]);
    }
}

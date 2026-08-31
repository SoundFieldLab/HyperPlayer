use crate::{
    dto::{UpdateCheckDto, UpdaterStatusDto},
    error::{AppError, CommandResult},
};
use base64::Engine as _;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use reqwest::{redirect::Policy, StatusCode};
use std::{
    fs,
    io::{Cursor, Read},
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    process::Command,
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_updater::{RemoteRelease, RemoteReleaseInner};
use tokio::{net::lookup_host, sync::Mutex};
use url::Url;

const UPDATE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_UPDATE_BYTES: usize = 512 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 1024 * 1024;
const MAX_UPDATE_REDIRECTS: usize = 5;

#[derive(Clone, Debug)]
pub struct UpdaterConfig {
    public_key: Option<String>,
    endpoint: Option<Url>,
    endpoint_error: Option<String>,
    operation: Arc<Mutex<()>>,
}

impl UpdaterConfig {
    pub fn from_env() -> Self {
        Self::from_values(
            option_env!("HYPERPLAYER_UPDATER_PUBLIC_KEY"),
            option_env!("HYPERPLAYER_UPDATER_ENDPOINT"),
        )
    }

    fn from_values(public_key: Option<&str>, endpoint: Option<&str>) -> Self {
        let public_key = public_key.map(str::trim).filter(|value| !value.is_empty());
        let endpoint = endpoint.map(str::trim).filter(|value| !value.is_empty());
        let parsed_endpoint = endpoint.and_then(|value| Url::parse(value).ok());
        let endpoint_error = if endpoint.is_none() {
            Some("updater endpoint is not configured".into())
        } else if parsed_endpoint.as_ref().is_none_or(|value| {
            value.scheme() != "https"
                || value.host_str().is_none()
                || !value.username().is_empty()
                || value.password().is_some()
                || value.fragment().is_some()
        }) {
            Some(
                "updater endpoint must be a valid HTTPS URL without credentials or fragment".into(),
            )
        } else {
            None
        };
        Self {
            public_key: public_key.map(str::to_owned),
            endpoint: parsed_endpoint,
            endpoint_error,
            operation: Arc::new(Mutex::new(())),
        }
    }

    pub fn public_key(&self) -> Option<String> {
        self.enabled().then(|| self.public_key.clone()).flatten()
    }

    fn disabled_reason(&self) -> Option<String> {
        if self.public_key.is_none() {
            Some("updater is disabled: signing public key is not configured".into())
        } else {
            self.endpoint_error
                .as_ref()
                .map(|reason| format!("updater is disabled: {reason}"))
        }
    }

    fn enabled(&self) -> bool {
        self.disabled_reason().is_none() && self.endpoint.is_some()
    }

    fn status(&self) -> UpdaterStatusDto {
        UpdaterStatusDto {
            enabled: self.enabled(),
            reason: self.disabled_reason(),
        }
    }

    fn require_endpoint(&self) -> Result<Url, AppError> {
        if let Some(reason) = self.disabled_reason() {
            return Err(AppError::Unavailable(reason));
        }
        self.endpoint
            .clone()
            .ok_or_else(|| AppError::Unavailable("updater is disabled".into()))
    }
}

fn validate_https_url(url: &Url, resource: &str) -> Result<(), AppError> {
    let invalid_host = match url.host() {
        Some(url::Host::Ipv4(address)) => !is_public_ip(IpAddr::V4(address)),
        Some(url::Host::Ipv6(address)) => !is_public_ip(IpAddr::V6(address)),
        Some(url::Host::Domain(_)) => false,
        None => true,
    };
    if url.scheme() != "https"
        || invalid_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::Unavailable(format!(
            "{resource} URL must be HTTPS without credentials or fragment"
        )));
    }
    Ok(())
}

fn validate_update_url(url: &Url) -> Result<(), AppError> {
    validate_https_url(url, "update package")
}

fn is_newer_release(current: &tauri::PackageInfo, release: &RemoteRelease) -> bool {
    release.version > current.version
}

fn updater_bundle_name() -> &'static str {
    match tauri::utils::platform::bundle_type() {
        Some(tauri::utils::config::BundleType::Msi) => "msi",
        Some(tauri::utils::config::BundleType::Nsis) => "nsis",
        _ => "unknown",
    }
}

fn expand_endpoint(endpoint: &Url, current_version: &str) -> Result<Url, AppError> {
    let encoded_version = current_version.replace('+', "%2B");
    let replacements = [
        ("current_version", encoded_version.as_str()),
        ("target", "windows"),
        ("arch", std::env::consts::ARCH),
        ("bundle_type", updater_bundle_name()),
    ];
    let mut value = endpoint.to_string();
    for (name, replacement) in replacements {
        value = value
            .replace(&format!("%7B%7B{name}%7D%7D"), replacement)
            .replace(&format!("{{{{{name}}}}}"), replacement);
    }
    let expanded = Url::parse(&value)
        .map_err(|_| AppError::Updater("invalid update metadata endpoint".into()))?;
    validate_https_url(&expanded, "update metadata")?;
    Ok(expanded)
}

fn release_package_for(
    release: &RemoteRelease,
    bundle_type: Option<tauri::utils::config::BundleType>,
) -> Result<(Url, String), AppError> {
    match &release.data {
        RemoteReleaseInner::Dynamic(platform) => {
            Ok((platform.url.clone(), platform.signature.clone()))
        }
        RemoteReleaseInner::Static { platforms } => {
            let arch = match std::env::consts::ARCH {
                "x86_64" => "x86_64",
                "x86" => "i686",
                "aarch64" => "aarch64",
                other => other,
            };
            let installer = match bundle_type {
                Some(tauri::utils::config::BundleType::Msi) => "msi",
                _ => "nsis",
            };
            [
                format!("windows-{arch}-{installer}"),
                format!("windows-{arch}"),
            ]
            .into_iter()
            .find_map(|target| platforms.get(&target))
            .map(|platform| (platform.url.clone(), platform.signature.clone()))
            .ok_or_else(|| AppError::Updater("update target is unavailable".into()))
        }
    }
}

fn release_package(release: &RemoteRelease) -> Result<(Url, String), AppError> {
    release_package_for(release, tauri::utils::platform::bundle_type())
}

async fn check_update(
    app: &AppHandle,
    config: &UpdaterConfig,
) -> Result<Option<RemoteRelease>, AppError> {
    let endpoint = expand_endpoint(
        &config.require_endpoint()?,
        &app.package_info().version.to_string(),
    )?;
    let release = fetch_update_metadata(endpoint).await?;
    let Some(release) = release.filter(|release| is_newer_release(app.package_info(), release))
    else {
        return Ok(None);
    };
    let (download_url, _) = release_package(&release)?;
    validate_update_url(&download_url)?;
    Ok(Some(release))
}

fn is_public_ip(address: IpAddr) -> bool {
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

fn validate_resolved_addresses(
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

async fn validated_addresses(url: &Url, resource: &str) -> Result<Vec<SocketAddr>, AppError> {
    validate_https_url(url, resource)?;
    let host = url
        .host_str()
        .ok_or_else(|| AppError::Unavailable(format!("{resource} host is missing")))?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = lookup_host((host, port))
        .await
        .map_err(|_| AppError::Updater(format!("{resource} host lookup failed")))?
        .collect::<Vec<_>>();
    validate_resolved_addresses(addresses, resource)
}

async fn validated_update_addresses(url: &Url) -> Result<Vec<SocketAddr>, AppError> {
    validated_addresses(url, "update package").await
}

fn resolve_validated_redirect(base: &Url, location: &str, resource: &str) -> Result<Url, AppError> {
    let redirect = base
        .join(location)
        .map_err(|_| AppError::Updater(format!("invalid {resource} redirect")))?;
    validate_https_url(&redirect, resource)?;
    Ok(redirect)
}

fn append_metadata_chunk(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), AppError> {
    if bytes.len().saturating_add(chunk.len()) > MAX_METADATA_BYTES {
        return Err(AppError::Unavailable(
            "update metadata exceeds the size limit".into(),
        ));
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

fn parse_release_metadata(bytes: &[u8]) -> Result<RemoteRelease, AppError> {
    if bytes.len() > MAX_METADATA_BYTES {
        return Err(AppError::Unavailable(
            "update metadata exceeds the size limit".into(),
        ));
    }
    serde_json::from_slice(bytes).map_err(|_| AppError::Updater("invalid update metadata".into()))
}

async fn fetch_update_metadata_inner(endpoint: Url) -> Result<Option<RemoteRelease>, AppError> {
    let mut url = endpoint;
    for redirect_count in 0..=MAX_UPDATE_REDIRECTS {
        let host = url
            .host_str()
            .ok_or_else(|| AppError::Unavailable("update metadata host is missing".into()))?
            .to_owned();
        let addresses = validated_addresses(&url, "update metadata").await?;
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .timeout(UPDATE_TIMEOUT)
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|_| AppError::Updater("update metadata request failed".into()))?;
        let response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| AppError::Updater("update metadata request failed".into()))?;
        if response.status().is_redirection() {
            if redirect_count == MAX_UPDATE_REDIRECTS {
                return Err(AppError::Unavailable(
                    "too many update metadata redirects".into(),
                ));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AppError::Updater("invalid update metadata redirect".into()))?;
            url = resolve_validated_redirect(&url, location, "update metadata")?;
            continue;
        }
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if response.status() != StatusCode::OK {
            return Err(AppError::Updater("update metadata request failed".into()));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_METADATA_BYTES as u64)
        {
            return Err(AppError::Unavailable(
                "update metadata exceeds the size limit".into(),
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| AppError::Updater("update metadata request failed".into()))?;
            append_metadata_chunk(&mut bytes, &chunk)?;
        }
        return parse_release_metadata(&bytes).map(Some);
    }
    Err(AppError::Updater("update metadata request failed".into()))
}

async fn fetch_update_metadata(endpoint: Url) -> Result<Option<RemoteRelease>, AppError> {
    tokio::time::timeout(UPDATE_TIMEOUT, fetch_update_metadata_inner(endpoint))
        .await
        .map_err(|_| AppError::Updater("update metadata request timed out".into()))?
}

fn decode_signed_value(value: &str) -> Result<String, AppError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| AppError::Updater("invalid update signature encoding".into()))?;
    String::from_utf8(bytes)
        .map_err(|_| AppError::Updater("invalid update signature encoding".into()))
}

fn verify_update_package(bytes: &[u8], signature: &str, public_key: &str) -> Result<(), AppError> {
    let public_key = PublicKey::decode(&decode_signed_value(public_key)?)
        .map_err(|_| AppError::Updater("invalid update signing key".into()))?;
    let signature = Signature::decode(&decode_signed_value(signature)?)
        .map_err(|_| AppError::Updater("invalid update signature".into()))?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|_| AppError::Updater("update signature verification failed".into()))
}

async fn download_update_package_inner(download_url: &Url) -> Result<Vec<u8>, AppError> {
    let mut url = download_url.clone();
    for redirect_count in 0..=MAX_UPDATE_REDIRECTS {
        let host = url
            .host_str()
            .ok_or_else(|| AppError::Unavailable("update package host is missing".into()))?
            .to_owned();
        let addresses = validated_update_addresses(&url).await?;
        let mut client = reqwest::Client::builder()
            .redirect(Policy::none())
            .no_proxy();
        for address in addresses {
            client = client.resolve(&host, address);
        }
        let client = client
            .build()
            .map_err(|error| AppError::Updater(error.to_string()))?;
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| AppError::Updater(error.to_string()))?;
        if response.status().is_redirection() {
            if redirect_count == MAX_UPDATE_REDIRECTS {
                return Err(AppError::Unavailable("too many update redirects".into()));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AppError::Updater("invalid update redirect".into()))?;
            url = url
                .join(location)
                .map_err(|_| AppError::Updater("invalid update redirect".into()))?;
            continue;
        }
        if response.status() != StatusCode::OK {
            return Err(AppError::Updater("update download failed".into()));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_UPDATE_BYTES as u64)
        {
            return Err(AppError::Unavailable(
                "update package exceeds the size limit".into(),
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| AppError::Updater(error.to_string()))?;
            if bytes.len().saturating_add(chunk.len()) > MAX_UPDATE_BYTES {
                return Err(AppError::Unavailable(
                    "update package exceeds the size limit".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(bytes);
    }
    Err(AppError::Updater("update download failed".into()))
}

async fn download_update_package(download_url: &Url) -> Result<Vec<u8>, AppError> {
    tokio::time::timeout(UPDATE_TIMEOUT, download_update_package_inner(download_url))
        .await
        .map_err(|_| AppError::Updater("update package download timed out".into()))?
}

#[cfg(windows)]
fn installer_bytes(bytes: &[u8]) -> Result<(Vec<u8>, &'static str), AppError> {
    if bytes.starts_with(b"PK\x03\x04") {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|_| AppError::Updater("invalid update package".into()))?;
        for index in 0..archive.len() {
            let entry = archive
                .by_index(index)
                .map_err(|_| AppError::Updater("invalid update package".into()))?;
            if !entry.is_file() {
                continue;
            }
            let Some(name) = entry.enclosed_name() else {
                continue;
            };
            let extension = name.extension().and_then(|value| value.to_str());
            let suffix = match extension {
                Some(value) if value.eq_ignore_ascii_case("exe") => ".exe",
                Some(value) if value.eq_ignore_ascii_case("msi") => ".msi",
                _ => continue,
            };
            if entry.size() > MAX_UPDATE_BYTES as u64 {
                return Err(AppError::Unavailable(
                    "update package exceeds the size limit".into(),
                ));
            }
            let mut installer = Vec::with_capacity(entry.size() as usize);
            std::io::copy(&mut entry.take(MAX_UPDATE_BYTES as u64 + 1), &mut installer)
                .map_err(|_| AppError::Updater("invalid update package".into()))?;
            if installer.len() > MAX_UPDATE_BYTES {
                return Err(AppError::Unavailable(
                    "update package exceeds the size limit".into(),
                ));
            }
            return Ok((installer, suffix));
        }
        return Err(AppError::Updater("update installer was not found".into()));
    }
    if bytes.starts_with(b"MZ") {
        return Ok((bytes.to_vec(), ".exe"));
    }
    if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        return Ok((bytes.to_vec(), ".msi"));
    }
    Err(AppError::Updater("invalid update package".into()))
}

#[cfg(windows)]
fn persist_installer(bytes: &[u8], version: &str) -> Result<(PathBuf, &'static str), AppError> {
    let (installer, suffix) = installer_bytes(bytes)?;
    let directory = tempfile::Builder::new()
        .prefix(&format!("HyperPlayer-{version}-updater-"))
        .tempdir()
        .map_err(|_| AppError::Updater("could not prepare update installer".into()))?
        .keep();
    let path = directory.join(format!("HyperPlayer-{version}-installer{suffix}"));
    fs::write(&path, installer)
        .map_err(|_| AppError::Updater("could not prepare update installer".into()))?;
    Ok((path, suffix))
}

#[cfg(windows)]
fn launch_installer(app: &AppHandle, bytes: &[u8], version: &str) -> Result<(), AppError> {
    let (path, suffix) = persist_installer(bytes, version)?;
    app.cleanup_before_exit();
    let mut command = if suffix == ".msi" {
        let mut command = Command::new("msiexec.exe");
        command
            .arg("/i")
            .arg(&path)
            .arg("/passive")
            .arg("/promptrestart")
            .arg("AUTOLAUNCHAPP=True");
        command
    } else {
        let mut command = Command::new(&path);
        command.arg("/P").arg("/R").arg("/UPDATE");
        command
    };
    command
        .spawn()
        .map_err(|_| AppError::Updater("could not start update installer".into()))?;
    std::process::exit(0)
}

#[cfg(not(windows))]
fn launch_installer(_app: &AppHandle, _bytes: &[u8], _version: &str) -> Result<(), AppError> {
    Err(AppError::Unavailable(
        "updates are supported only on Windows".into(),
    ))
}

#[tauri::command]
pub fn updater_status(config: State<'_, UpdaterConfig>) -> UpdaterStatusDto {
    config.status()
}

#[tauri::command]
pub async fn updater_check(
    window: WebviewWindow,
    app: AppHandle,
    config: State<'_, UpdaterConfig>,
) -> CommandResult<UpdateCheckDto> {
    require_main_window(&window)?;
    let _operation = config.operation.try_lock().map_err(|_| {
        crate::error::ErrorDto::from(AppError::Unavailable(
            "another update operation is already running".into(),
        ))
    })?;
    let current_version = app.package_info().version.to_string();
    let update = check_update(&app, &config)
        .await
        .map_err(crate::error::ErrorDto::from)?;
    Ok(match update {
        Some(update) => UpdateCheckDto {
            available: true,
            version: Some(update.version.to_string()),
            current_version,
            notes: update.notes,
        },
        None => UpdateCheckDto {
            available: false,
            version: None,
            current_version,
            notes: None,
        },
    })
}

fn require_main_window(window: &WebviewWindow) -> Result<(), crate::error::ErrorDto> {
    if window.label() != "main" {
        return Err(
            AppError::Unavailable("command is restricted to the main window".into()).into(),
        );
    }
    Ok(())
}

async fn install_expected_update(
    app: &AppHandle,
    config: &UpdaterConfig,
    expected_version: &str,
) -> Result<bool, AppError> {
    let Some(update) = check_update(app, config).await? else {
        return Ok(false);
    };
    if update.version.to_string() != expected_version {
        return Err(AppError::Unavailable(
            "available update changed; check again before installing".into(),
        ));
    }
    let (download_url, signature) = release_package(&update)?;
    validate_update_url(&download_url)?;
    let bytes = download_update_package(&download_url).await?;
    let public_key = config
        .public_key
        .as_deref()
        .ok_or_else(|| AppError::Unavailable("updater signing key is not configured".into()))?;
    verify_update_package(&bytes, &signature, public_key)?;
    launch_installer(app, &bytes, expected_version)?;
    Ok(true)
}

/// Installs the expected signed update. The Windows installer owns process exit/relaunch.
#[tauri::command]
#[allow(dead_code)]
pub async fn updater_update(
    window: WebviewWindow,
    app: AppHandle,
    config: State<'_, UpdaterConfig>,
    expected_version: String,
) -> CommandResult<bool> {
    require_main_window(&window)?;
    let _operation = config.operation.try_lock().map_err(|_| {
        crate::error::ErrorDto::from(AppError::Unavailable(
            "another update operation is already running".into(),
        ))
    })?;
    install_expected_update(&app, &config, &expected_version)
        .await
        .map_err(crate::error::ErrorDto::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_is_disabled_without_signing_configuration() {
        let config = UpdaterConfig::from_values(None, None);
        assert!(!config.status().enabled);
        assert!(config.status().reason.unwrap().contains("disabled"));
        assert!(matches!(
            config.require_endpoint(),
            Err(AppError::Unavailable(_))
        ));
    }

    #[test]
    fn updater_rejects_invalid_endpoints() {
        for endpoint in [
            None,
            Some("http://example.test"),
            Some("https://"),
            Some("https://user:password@example.test/latest.json"),
            Some("https://example.test/latest.json#fragment"),
        ] {
            let config = UpdaterConfig::from_values(Some("public-key"), endpoint);
            assert!(!config.status().enabled);
            assert!(matches!(
                config.require_endpoint(),
                Err(AppError::Unavailable(_))
            ));
        }
    }

    #[test]
    fn updater_is_enabled_only_with_signing_key_and_https_endpoint() {
        let configured = UpdaterConfig::from_values(
            Some("public-key"),
            Some("https://example.test/latest.json"),
        );
        assert!(configured.status().enabled);
        assert!(configured.status().reason.is_none());
        assert!(configured.public_key().is_some());
        assert!(configured.require_endpoint().is_ok());
    }

    #[test]
    fn updater_rejects_unsafe_package_urls() {
        for url in [
            "http://example.test/update.zip",
            "https://user:password@example.test/update.zip",
            "https://example.test/update.zip#fragment",
        ] {
            assert!(matches!(
                validate_update_url(&Url::parse(url).unwrap()),
                Err(AppError::Unavailable(_))
            ));
        }
        assert!(
            validate_update_url(&Url::parse("https://example.test/update.zip").unwrap()).is_ok()
        );
    }

    #[test]
    fn updater_rejects_non_public_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.2",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "ff02::1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn updater_rejects_redirect_to_loopback() {
        let base = Url::parse("https://updates.example.test/latest.json").unwrap();
        assert!(matches!(
            resolve_validated_redirect(&base, "https://127.0.0.1/latest.json", "update metadata"),
            Err(AppError::Unavailable(_))
        ));
    }

    #[test]
    fn updater_rejects_private_and_mixed_address_sets() {
        let public = "8.8.8.8:443".parse().unwrap();
        let private = "10.0.0.1:443".parse().unwrap();
        assert!(validate_resolved_addresses(vec![public], "update metadata").is_ok());
        assert!(matches!(
            validate_resolved_addresses(vec![public, private], "update metadata"),
            Err(AppError::Unavailable(_))
        ));
        assert!(matches!(
            validate_resolved_addresses(vec![private], "update metadata"),
            Err(AppError::Unavailable(_))
        ));
    }

    #[test]
    fn updater_rejects_oversized_metadata() {
        let mut bytes = vec![b'x'; MAX_METADATA_BYTES];
        assert!(matches!(
            append_metadata_chunk(&mut bytes, b"x"),
            Err(AppError::Unavailable(_))
        ));
        assert!(matches!(
            parse_release_metadata(&vec![b'x'; MAX_METADATA_BYTES + 1]),
            Err(AppError::Unavailable(_))
        ));
    }

    #[test]
    fn updater_rejects_malformed_metadata() {
        for metadata in [
            b"not json".as_slice(),
            br#"{"version":"1.2.3"}"#.as_slice(),
            br#"{"version":"not-semver","url":"https://example.test/update.zip","signature":"sig"}"#
                .as_slice(),
        ] {
            assert!(matches!(
                parse_release_metadata(metadata),
                Err(AppError::Updater(_))
            ));
        }
    }

    #[test]
    fn updater_compares_versions_without_network() {
        let release = parse_release_metadata(
            br#"{"version":"1.2.3","notes":"release","url":"https://example.test/update.zip","signature":"sig"}"#,
        )
        .unwrap();
        let current = tauri::PackageInfo {
            name: "HyperPlayer".into(),
            version: "1.2.2".parse().unwrap(),
            authors: "",
            description: "",
            crate_name: "hyperplayer-app",
        };
        assert!(is_newer_release(&current, &release));

        let same = tauri::PackageInfo {
            version: "1.2.3".parse().unwrap(),
            ..current
        };
        assert!(!is_newer_release(&same, &release));
    }

    #[test]
    fn updater_selects_static_metadata_for_installed_bundle() {
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x86_64",
            "x86" => "i686",
            "aarch64" => "aarch64",
            other => other,
        };
        let metadata = format!(
            r#"{{"version":"1.2.3","platforms":{{"windows-{arch}-nsis":{{"url":"https://example.test/update.exe","signature":"nsis"}},"windows-{arch}-msi":{{"url":"https://example.test/update.msi","signature":"msi"}}}}}}"#
        );
        let release = parse_release_metadata(metadata.as_bytes()).unwrap();
        assert_eq!(
            release_package_for(&release, Some(tauri::utils::config::BundleType::Nsis))
                .unwrap()
                .1,
            "nsis"
        );
        assert_eq!(
            release_package_for(&release, Some(tauri::utils::config::BundleType::Msi))
                .unwrap()
                .1,
            "msi"
        );
    }

    #[test]
    fn updater_expands_endpoint_placeholders_without_weakening_https() {
        let endpoint = Url::parse(
            "https://updates.example.test/%7B%7Btarget%7D%7D/%7B%7Barch%7D%7D/{{current_version}}/{{bundle_type}}",
        )
        .unwrap();
        let expanded = expand_endpoint(&endpoint, "1.2.3+build").unwrap();
        assert!(expanded.as_str().contains("/windows/"));
        assert!(expanded.as_str().contains("/1.2.3%2Bbuild/"));
        assert_eq!(expanded.scheme(), "https");
    }

    #[test]
    fn updater_errors_are_sanitized_before_returning_to_callers() {
        let secret = "https://user:password@example.test/update.zip?token=secret";
        let dto = crate::error::ErrorDto::from(AppError::Updater(secret.into()));
        assert_eq!(dto.code, "updaterError");
        assert_eq!(dto.message, "update operation failed");
    }
}

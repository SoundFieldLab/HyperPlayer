use crate::{
    dto::ShenzhenWeatherDto,
    error::{AppError, CommandResult},
    secure_http::get_fixed_json,
};
use serde::Deserialize;
use std::{sync::OnceLock, time::Duration};
use tauri::WebviewWindow;
use tokio::{sync::Mutex, time::Instant};
use url::Url;

const WEATHER_HOST: &str = "api.open-meteo.com";
const WEATHER_RESOURCE: &str = "Shenzhen weather";
const MAX_WEATHER_BYTES: usize = 64 * 1024;
const WEATHER_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const WEATHER_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const SHENZHEN_LATITUDE: &str = "22.5431";
const SHENZHEN_LONGITUDE: &str = "114.0579";

#[derive(Clone)]
struct CachedWeather {
    fetched_at: Instant,
    value: ShenzhenWeatherDto,
}

static WEATHER_CACHE: OnceLock<Mutex<Option<CachedWeather>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
struct WeatherResponse {
    current: CurrentWeather,
}

#[derive(Debug, Deserialize)]
struct CurrentWeather {
    time: String,
    interval: u32,
    temperature_2m: f64,
    apparent_temperature: f64,
    relative_humidity_2m: u8,
    weather_code: u16,
    wind_speed_10m: f64,
    is_day: u8,
}

fn weather_endpoint() -> Url {
    let mut url = Url::parse("https://api.open-meteo.com/v1/forecast")
        .expect("the fixed weather endpoint must be valid");
    url.query_pairs_mut()
        .append_pair("latitude", SHENZHEN_LATITUDE)
        .append_pair("longitude", SHENZHEN_LONGITUDE)
        .append_pair(
            "current",
            "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
        )
        .append_pair("timezone", "Asia/Shanghai");
    url
}

fn condition_for(code: u16) -> &'static str {
    match code {
        0 => "晴",
        1..=3 => "多云",
        45 | 48 => "雾",
        51..=57 => "毛毛雨",
        61..=67 | 80..=82 => "雨",
        71..=77 | 85 | 86 => "雪",
        95..=99 => "雷雨",
        _ => "天气未知",
    }
}

fn parse_weather(bytes: &[u8]) -> Result<ShenzhenWeatherDto, AppError> {
    let payload: WeatherResponse = serde_json::from_slice(bytes)
        .map_err(|_| AppError::Unavailable("Shenzhen weather response is invalid".into()))?;
    if payload.current.interval == 0
        || payload.current.is_day > 1
        || !payload.current.temperature_2m.is_finite()
        || !payload.current.apparent_temperature.is_finite()
        || !payload.current.wind_speed_10m.is_finite()
        || payload.current.relative_humidity_2m > 100
    {
        return Err(AppError::Unavailable(
            "Shenzhen weather response is invalid".into(),
        ));
    }
    Ok(ShenzhenWeatherDto {
        location: "深圳".into(),
        observed_at: payload.current.time,
        temperature_c: payload.current.temperature_2m,
        apparent_temperature_c: payload.current.apparent_temperature,
        relative_humidity_percent: payload.current.relative_humidity_2m,
        weather_code: payload.current.weather_code,
        condition: condition_for(payload.current.weather_code).into(),
        wind_speed_kmh: payload.current.wind_speed_10m,
        is_day: payload.current.is_day == 1,
    })
}

async fn fetch_shenzhen_weather() -> Result<ShenzhenWeatherDto, AppError> {
    let bytes = tokio::time::timeout(
        WEATHER_REQUEST_TIMEOUT,
        get_fixed_json(
            weather_endpoint(),
            WEATHER_HOST,
            WEATHER_RESOURCE,
            MAX_WEATHER_BYTES,
        ),
    )
    .await
    .map_err(|_| AppError::Unavailable("Shenzhen weather request timed out".into()))??;
    parse_weather(&bytes)
}

async fn cached_shenzhen_weather() -> Result<ShenzhenWeatherDto, AppError> {
    let cache = WEATHER_CACHE.get_or_init(|| Mutex::new(None));
    let mut cached = cache.lock().await;
    if let Some(entry) = cached
        .as_ref()
        .filter(|entry| entry.fetched_at.elapsed() < WEATHER_CACHE_TTL)
    {
        return Ok(entry.value.clone());
    }
    let value = fetch_shenzhen_weather().await?;
    *cached = Some(CachedWeather {
        fetched_at: Instant::now(),
        value: value.clone(),
    });
    Ok(value)
}

#[tauri::command]
pub async fn shenzhen_weather(window: WebviewWindow) -> CommandResult<ShenzhenWeatherDto> {
    if window.label() != "main" {
        return Err(
            AppError::Unavailable("command is restricted to the main window".into()).into(),
        );
    }
    cached_shenzhen_weather().await.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_owns_shenzhen_location_and_query() {
        let url = weather_endpoint();
        assert_eq!(url.host_str(), Some(WEATHER_HOST));
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            query.get("latitude").map(|value| value.as_ref()),
            Some(SHENZHEN_LATITUDE)
        );
        assert_eq!(
            query.get("longitude").map(|value| value.as_ref()),
            Some(SHENZHEN_LONGITUDE)
        );
        assert_eq!(
            query.get("timezone").map(|value| value.as_ref()),
            Some("Asia/Shanghai")
        );
        assert!(query
            .get("current")
            .is_some_and(|value| value.contains("weather_code")));
    }

    #[test]
    fn parses_bounded_display_dto() {
        let dto = parse_weather(br#"{"current":{"time":"2026-09-01T12:30","interval":900,"temperature_2m":31.2,"apparent_temperature":35.7,"relative_humidity_2m":72,"weather_code":61,"wind_speed_10m":8.4,"is_day":1}}"#).unwrap();
        assert_eq!(dto.location, "深圳");
        assert_eq!(dto.condition, "雨");
        assert_eq!(dto.temperature_c, 31.2);
        assert!(dto.is_day);
    }

    #[test]
    fn rejects_invalid_measurements() {
        let invalid = br#"{"current":{"time":"2026-09-01T12:30","interval":0,"temperature_2m":31.2,"apparent_temperature":35.7,"relative_humidity_2m":101,"weather_code":0,"wind_speed_10m":8.4,"is_day":2}}"#;
        assert!(parse_weather(invalid).is_err());
    }

    #[test]
    fn cache_ttl_is_ten_minutes_and_new_entry_is_fresh() {
        assert_eq!(WEATHER_CACHE_TTL, Duration::from_secs(600));
        let value = ShenzhenWeatherDto {
            location: "深圳".into(),
            observed_at: "2026-09-01T12:30".into(),
            temperature_c: 31.2,
            apparent_temperature_c: 35.7,
            relative_humidity_percent: 72,
            weather_code: 61,
            condition: "雨".into(),
            wind_speed_kmh: 8.4,
            is_day: true,
        };
        let fresh = CachedWeather {
            fetched_at: Instant::now(),
            value,
        };
        assert!(fresh.fetched_at.elapsed() < WEATHER_CACHE_TTL);
    }

    #[test]
    fn maps_open_meteo_weather_codes() {
        assert_eq!(condition_for(0), "晴");
        assert_eq!(condition_for(2), "多云");
        assert_eq!(condition_for(61), "雨");
        assert_eq!(condition_for(95), "雷雨");
        assert_eq!(condition_for(500), "天气未知");
    }
}

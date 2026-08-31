use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LyricsDocument {
    pub source: LyricsSource,
    pub metadata: LyricsMetadata,
    pub lines: Vec<LyricLine>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LyricsSource {
    #[default]
    Unknown,
    Lrc,
    Yrc,
    Ttml,
    Embedded,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LyricsMetadata {
    pub title: Option<String>,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub language: Option<String>,
    pub offset_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LyricLine {
    pub start_ms: u64,
    pub end_ms: Option<u64>,
    pub text: String,
    pub translation: Option<String>,
    pub romanization: Option<String>,
    pub words: Vec<LyricWord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LyricWord {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LyricsBundle<'a> {
    pub original: &'a str,
    pub translation: &'a str,
    pub romanization: &'a str,
    pub word_synced: &'a str,
    pub word_synced_translation: &'a str,
    pub ttml: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalLyrics {
    pub origin: LocalLyricsOrigin,
    pub document: LyricsDocument,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalLyricsOrigin {
    Sidecar(PathBuf),
    Embedded,
    None,
}

impl LyricsDocument {
    pub fn validate(&self) -> std::result::Result<(), LyricsValidationError> {
        let mut previous_start = 0;
        for (index, line) in self.lines.iter().enumerate() {
            if index > 0 && line.start_ms < previous_start {
                return Err(LyricsValidationError::UnsortedLines { index });
            }
            if line.end_ms.is_some_and(|end| end < line.start_ms) {
                return Err(LyricsValidationError::InvalidLineRange { index });
            }
            let mut previous_word_start = line.start_ms;
            for (word_index, word) in line.words.iter().enumerate() {
                if word.end_ms < word.start_ms
                    || word.start_ms < line.start_ms
                    || word.start_ms < previous_word_start
                    || line.end_ms.is_some_and(|end| word.end_ms > end)
                {
                    return Err(LyricsValidationError::InvalidWordRange { index, word_index });
                }
                previous_word_start = word.start_ms;
            }
            previous_start = line.start_ms;
        }
        Ok(())
    }

    pub fn line_at(&self, position_ms: u64) -> Option<&LyricLine> {
        let index = self
            .lines
            .partition_point(|line| line.start_ms <= position_ms)
            .checked_sub(1)?;
        let line = &self.lines[index];
        if line.end_ms.is_none_or(|end| position_ms < end) {
            Some(line)
        } else {
            None
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LyricsValidationError {
    UnsortedLines { index: usize },
    InvalidLineRange { index: usize },
    InvalidWordRange { index: usize, word_index: usize },
}

pub fn parse_lrc(input: &str) -> Option<LyricsDocument> {
    let mut metadata = LyricsMetadata::default();
    let mut entries = Vec::new();

    for raw_line in input.lines() {
        let line = raw_line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() {
            continue;
        }
        if parse_lrc_metadata(line, &mut metadata) {
            continue;
        }
        let (starts, text) = lrc_timestamps_and_text(line);
        for start_ms in starts {
            entries.push((start_ms, text.clone()));
        }
    }
    if entries.is_empty() {
        return None;
    }

    entries.sort_by_key(|(start, _)| *start);
    let mut lines = Vec::with_capacity(entries.len());
    for (index, (start_ms, text)) in entries.iter().enumerate() {
        let end_ms = entries.get(index + 1).map(|entry| entry.0);
        let word_end = end_ms.unwrap_or(*start_ms);
        lines.push(LyricLine {
            start_ms: *start_ms,
            end_ms,
            text: text.clone(),
            translation: None,
            romanization: None,
            words: vec![LyricWord {
                start_ms: *start_ms,
                end_ms: word_end,
                text: text.clone(),
            }],
        });
    }
    Some(LyricsDocument {
        source: LyricsSource::Lrc,
        metadata,
        lines,
    })
}

pub fn parse_yrc(input: &str) -> Option<LyricsDocument> {
    let mut lines = Vec::new();
    for raw_line in input.lines() {
        let line = raw_line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with('{') {
            continue;
        }
        let Some((header, body)) = take_delimited(line, '[', ']') else {
            continue;
        };
        let Some((start_ms, duration_ms)) = parse_pair(header) else {
            continue;
        };
        let Some(line_end) = start_ms.checked_add(duration_ms) else {
            continue;
        };
        let mut words = parse_yrc_words(body, start_ms);
        if words.is_empty() {
            continue;
        }
        infer_untimed_words(&mut words, start_ms, line_end);
        for word in &mut words {
            word.start_ms = word.start_ms.clamp(start_ms, line_end);
            word.end_ms = word.end_ms.clamp(word.start_ms, line_end);
        }
        let text = words.iter().map(|word| word.text.as_str()).collect();
        lines.push(LyricLine {
            start_ms,
            end_ms: Some(line_end),
            text,
            translation: None,
            romanization: None,
            words,
        });
    }
    finish_document(LyricsSource::Yrc, LyricsMetadata::default(), lines)
}

pub fn parse_ttml(input: &str) -> Option<LyricsDocument> {
    let language = attr_value(opening_tag(input, "tt").unwrap_or_default(), "xml:lang")
        .or_else(|| attr_value(opening_tag(input, "tt").unwrap_or_default(), "lang"));
    let leading_silence = element_text(input, "itunes:leadingSilence")
        .or_else(|| element_text(input, "leadingSilence"))
        .and_then(parse_leading_silence)
        .unwrap_or(0);
    let mut lines = Vec::new();
    let mut cursor = 0;

    while let Some((tag, inner, next)) = next_element(input, "p", cursor) {
        cursor = next;
        if matches!(
            attr_value(tag, "ttm:role").as_deref(),
            Some("x-translation" | "x-roman")
        ) {
            continue;
        }
        let Some(start_ms) = attr_value(tag, "begin").and_then(|value| parse_ttml_time(&value))
        else {
            continue;
        };
        let end_ms = attr_value(tag, "end")
            .and_then(|value| parse_ttml_time(&value))
            .or_else(|| {
                attr_value(tag, "dur")
                    .and_then(|value| parse_ttml_time(&value))
                    .and_then(|duration| start_ms.checked_add(duration))
            });
        let Some(end_ms) = end_ms.filter(|end| *end >= start_ms) else {
            continue;
        };

        let mut words = Vec::new();
        let mut translation = None;
        let mut romanization = None;
        let mut primary_text = String::new();
        parse_ttml_content(
            inner,
            start_ms,
            end_ms,
            &mut words,
            &mut primary_text,
            &mut translation,
            &mut romanization,
        );
        let primary_text = decode_xml_text(&strip_tags(&primary_text));
        if words.is_empty() && !primary_text.trim().is_empty() {
            let text = primary_text.trim().to_owned();
            words.push(LyricWord {
                start_ms,
                end_ms,
                text,
            });
        }
        words.sort_by_key(|word| word.start_ms);
        if words.is_empty() {
            continue;
        }
        let text = primary_text.trim().to_owned();
        lines.push(LyricLine {
            start_ms,
            end_ms: Some(end_ms),
            text,
            translation,
            romanization,
            words,
        });
    }

    finish_document(
        LyricsSource::Ttml,
        LyricsMetadata {
            language,
            offset_ms: leading_silence,
            ..LyricsMetadata::default()
        },
        lines,
    )
}

pub fn parse_lyrics_bundle(bundle: &LyricsBundle<'_>) -> LyricsDocument {
    let mut document = parse_yrc(bundle.word_synced)
        .or_else(|| parse_lrc(bundle.original))
        .or_else(|| parse_ttml(bundle.ttml))
        .unwrap_or_default();
    if document.lines.is_empty() {
        return document;
    }

    let word_translations = timed_text_map(bundle.word_synced_translation).unwrap_or_default();
    let translations = timed_text_map(bundle.translation).unwrap_or_default();
    let romanizations = timed_text_map(bundle.romanization).unwrap_or_default();
    for line in &mut document.lines {
        if line.translation.is_none() {
            line.translation = word_translations
                .get(&line.start_ms)
                .or_else(|| translations.get(&line.start_ms))
                .cloned();
        }
        if line.romanization.is_none() {
            line.romanization = romanizations.get(&line.start_ms).cloned();
        }
    }
    document
}

pub fn parse_embedded_lyrics(input: &str) -> Option<LyricsDocument> {
    let trimmed = input.trim().trim_start_matches('\u{feff}');
    if trimmed.is_empty() {
        return None;
    }
    if let Some(mut document) = parse_yrc(trimmed)
        .or_else(|| parse_lrc(trimmed))
        .or_else(|| parse_ttml(trimmed))
    {
        document.source = LyricsSource::Embedded;
        return Some(document);
    }
    Some(LyricsDocument {
        source: LyricsSource::Embedded,
        metadata: LyricsMetadata::default(),
        lines: vec![LyricLine {
            start_ms: 0,
            end_ms: None,
            text: trimmed.to_owned(),
            translation: None,
            romanization: None,
            words: Vec::new(),
        }],
    })
}

pub fn load_local_lyrics(audio_path: &Path, embedded: Option<&str>) -> io::Result<LocalLyrics> {
    for extension in ["yrc", "lrc", "ttml"] {
        let path = audio_path.with_extension(extension);
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let document = match extension {
            "yrc" => parse_yrc(&raw),
            "lrc" => parse_lrc(&raw),
            "ttml" => parse_ttml(&raw),
            _ => None,
        };
        if let Some(document) = document {
            return Ok(LocalLyrics {
                origin: LocalLyricsOrigin::Sidecar(path),
                document,
            });
        }
    }
    if let Some(document) = embedded.and_then(parse_embedded_lyrics) {
        return Ok(LocalLyrics {
            origin: LocalLyricsOrigin::Embedded,
            document,
        });
    }
    Ok(LocalLyrics {
        origin: LocalLyricsOrigin::None,
        document: LyricsDocument::default(),
    })
}

fn finish_document(
    source: LyricsSource,
    metadata: LyricsMetadata,
    mut lines: Vec<LyricLine>,
) -> Option<LyricsDocument> {
    if lines.is_empty() {
        return None;
    }
    lines.sort_by_key(|line| line.start_ms);
    Some(LyricsDocument {
        source,
        metadata,
        lines,
    })
}

fn parse_lrc_metadata(line: &str, metadata: &mut LyricsMetadata) -> bool {
    let Some((tag, value)) = line
        .strip_prefix('[')
        .and_then(|line| line.strip_suffix(']'))
        .and_then(|line| line.split_once(':'))
    else {
        return false;
    };
    match tag.trim().to_ascii_lowercase().as_str() {
        "ti" => metadata.title = nonempty(value),
        "ar" => {
            if let Some(artist) = nonempty(value) {
                metadata.artists.push(artist);
            }
        }
        "al" => metadata.album = nonempty(value),
        "offset" => metadata.offset_ms = value.trim().parse().unwrap_or(0),
        "language" | "lang" => metadata.language = nonempty(value),
        "by" | "kana" => {}
        _ => return false,
    }
    true
}

fn nonempty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn lrc_timestamps_and_text(line: &str) -> (Vec<u64>, String) {
    let mut starts = Vec::new();
    let mut rest = line;
    while let Some((tag, after)) = take_delimited(rest, '[', ']') {
        let Some(start) = parse_lrc_time(tag) else {
            break;
        };
        starts.push(start);
        rest = after;
    }
    (starts, rest.trim().to_owned())
}

fn parse_lrc_time(value: &str) -> Option<u64> {
    let (minutes, seconds) = value.split_once(':')?;
    let minutes = minutes.parse::<u64>().ok()?;
    let (seconds, fraction) = seconds
        .split_once(['.', ':'])
        .map_or((seconds, ""), |parts| parts);
    let seconds = seconds.parse::<u64>().ok()?;
    if seconds >= 60 || fraction.len() > 3 || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let fraction_value = if fraction.is_empty() {
        0
    } else {
        fraction.parse::<u64>().ok()? * 10_u64.pow(3 - fraction.len() as u32)
    };
    minutes
        .checked_mul(60_000)?
        .checked_add(seconds.checked_mul(1_000)?)?
        .checked_add(fraction_value)
}

fn parse_pair(value: &str) -> Option<(u64, u64)> {
    let (left, right) = value.split_once(',')?;
    Some((left.parse().ok()?, right.parse().ok()?))
}

fn parse_yrc_words(body: &str, line_start: u64) -> Vec<LyricWord> {
    let mut timestamps = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = body[cursor..].find('(') {
        let open = cursor + relative;
        let Some(close_relative) = body[open + 1..].find(')') else {
            break;
        };
        let close = open + 1 + close_relative;
        let fields = body[open + 1..close].split(',').collect::<Vec<_>>();
        if fields.len() >= 2 {
            if let (Ok(start), Ok(duration)) = (fields[0].parse::<u64>(), fields[1].parse::<u64>())
            {
                timestamps.push((open, close + 1, start, duration));
            }
        }
        cursor = close + 1;
    }
    if timestamps.is_empty() {
        return Vec::new();
    }

    let mut words = Vec::new();
    let prefix = body[..timestamps[0].0].trim();
    if !prefix.is_empty() && !is_label(prefix) && !is_timestamp_fragment(prefix) {
        words.push(LyricWord {
            start_ms: line_start,
            end_ms: timestamps[0].2,
            text: prefix.to_owned(),
        });
    }
    for (index, (_, text_start, start, duration)) in timestamps.iter().copied().enumerate() {
        let text_end = timestamps
            .get(index + 1)
            .map(|entry| entry.0)
            .unwrap_or(body.len());
        let text = &body[text_start..text_end];
        if text.trim().is_empty() || is_timestamp_fragment(text) {
            continue;
        }
        words.push(LyricWord {
            start_ms: start,
            end_ms: start.saturating_add(duration),
            text: text.to_owned(),
        });
    }
    words
}

fn is_label(value: &str) -> bool {
    let value = value.trim();
    let Some(label) = value.strip_suffix([':', '：']) else {
        return false;
    };
    !label.is_empty() && label.chars().all(|character| character.is_alphabetic())
}

fn is_timestamp_fragment(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.contains(',')
        && value.chars().any(|character| character.is_ascii_digit())
        && value.chars().all(|character| {
            character.is_ascii_digit()
                || matches!(character, '(' | ')' | ',' | ' ' | '\t' | '\r' | '\n')
        })
}

fn infer_untimed_words(words: &mut [LyricWord], line_start: u64, line_end: u64) {
    let mut index = 0;
    let mut previous_end = line_start;
    while index < words.len() {
        if words[index].text.trim().is_empty() {
            words[index].start_ms = previous_end;
            words[index].end_ms = previous_end;
            index += 1;
            continue;
        }
        if words[index].end_ms > words[index].start_ms {
            previous_end = previous_end.max(words[index].end_ms);
            index += 1;
            continue;
        }
        let run_start = index;
        while index < words.len()
            && !words[index].text.trim().is_empty()
            && words[index].end_ms == words[index].start_ms
        {
            index += 1;
        }
        let next_start = words
            .get(index)
            .filter(|word| word.start_ms > previous_end)
            .map(|word| word.start_ms);
        let total_chars = words[run_start..index]
            .iter()
            .map(|word| word.text.trim().chars().count())
            .sum::<usize>()
            .max(1) as u64;
        let available = next_start
            .map(|next| next.saturating_sub(previous_end))
            .unwrap_or_else(|| (total_chars * 180).clamp(280, 2_400))
            .min(line_end.saturating_sub(previous_end));
        let mut elapsed = 0;
        for word in &mut words[run_start..index] {
            let chars = word.text.trim().chars().count() as u64;
            let end_elapsed = elapsed + available.saturating_mul(chars) / total_chars;
            word.start_ms = previous_end.saturating_add(elapsed);
            word.end_ms = previous_end.saturating_add(end_elapsed);
            elapsed = end_elapsed;
        }
        previous_end = previous_end.saturating_add(available);
    }
}

fn parse_ttml_content(
    inner: &str,
    line_start: u64,
    line_end: u64,
    words: &mut Vec<LyricWord>,
    plain: &mut String,
    translation: &mut Option<String>,
    romanization: &mut Option<String>,
) {
    let mut cursor = 0;
    while let Some(relative) = inner[cursor..].find('<') {
        let open = cursor + relative;
        plain.push_str(&inner[cursor..open]);
        let Some(close_relative) = inner[open..].find('>') else {
            plain.push_str(&inner[open..]);
            return;
        };
        let tag_end = open + close_relative + 1;
        let tag = &inner[open..tag_end];
        if !tag_name_is(tag, "span") || tag.starts_with("</") {
            if tag_name_is(tag, "br") {
                plain.push('\n');
            }
            cursor = tag_end;
            continue;
        }
        let Some(content_end) = matching_element_end(inner, "span", tag_end) else {
            cursor = tag_end;
            continue;
        };
        let span_inner = &inner[tag_end..content_end];
        let text = decode_xml_text(&strip_tags(span_inner));
        match attr_value(tag, "ttm:role").as_deref() {
            Some("x-translation") => *translation = nonempty(&text),
            Some("x-roman") => *romanization = nonempty(&text),
            Some("x-bg") => parse_ttml_content(
                span_inner,
                line_start,
                line_end,
                words,
                plain,
                translation,
                romanization,
            ),
            _ => {
                plain.push_str(&text);
                let start = attr_value(tag, "begin").and_then(|value| parse_ttml_time(&value));
                let end = attr_value(tag, "end")
                    .and_then(|value| parse_ttml_time(&value))
                    .or_else(|| {
                        attr_value(tag, "dur")
                            .and_then(|value| parse_ttml_time(&value))
                            .and_then(|duration| start?.checked_add(duration))
                    });
                if let (Some(start_ms), Some(end_ms)) = (start, end) {
                    if !text.is_empty()
                        && start_ms >= line_start
                        && end_ms >= start_ms
                        && end_ms <= line_end
                    {
                        words.push(LyricWord {
                            start_ms,
                            end_ms,
                            text,
                        });
                    }
                }
            }
        }
        cursor = content_end + "</span>".len();
    }
    plain.push_str(&inner[cursor..]);
}

fn parse_ttml_time(value: &str) -> Option<u64> {
    let value = value.trim();
    if let Some(milliseconds) = value.strip_suffix("ms") {
        return parse_decimal_millis(milliseconds, 1.0);
    }
    if let Some(seconds) = value.strip_suffix('s') {
        return parse_decimal_millis(seconds, 1_000.0);
    }
    if let Some(minutes) = value.strip_suffix('m') {
        return parse_decimal_millis(minutes, 60_000.0);
    }
    if let Some(hours) = value.strip_suffix('h') {
        return parse_decimal_millis(hours, 3_600_000.0);
    }
    if value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b',')
        && value.contains(',')
    {
        let (seconds, milliseconds) = value.split_once(',')?;
        return seconds
            .parse::<u64>()
            .ok()?
            .checked_mul(1_000)?
            .checked_add(milliseconds.parse().ok()?);
    }
    let parts = value.split(':').collect::<Vec<_>>();
    match parts.as_slice() {
        [minutes, seconds] => parse_clock_time(0, minutes, seconds),
        [hours, minutes, seconds] => parse_clock_time(hours.parse().ok()?, minutes, seconds),
        [seconds] => parse_decimal_millis(seconds, 1_000.0),
        _ => None,
    }
}

fn parse_clock_time(hours: u64, minutes: &str, seconds: &str) -> Option<u64> {
    let minutes = minutes.parse::<u64>().ok()?;
    let seconds = seconds.parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds < 0.0 || minutes >= 60 || seconds >= 60.0 {
        return None;
    }
    let base = hours
        .checked_mul(3_600_000)?
        .checked_add(minutes.checked_mul(60_000)?)?;
    base.checked_add((seconds * 1_000.0).round() as u64)
}

fn parse_decimal_millis(value: &str, scale: f64) -> Option<u64> {
    let value = value.parse::<f64>().ok()?;
    let milliseconds = value * scale;
    (milliseconds.is_finite() && milliseconds >= 0.0 && milliseconds <= u64::MAX as f64)
        .then(|| milliseconds.round() as u64)
}

fn timed_text_map(input: &str) -> Option<BTreeMap<u64, String>> {
    let document = parse_yrc(input).or_else(|| parse_lrc(input))?;
    Some(
        document
            .lines
            .into_iter()
            .map(|line| (line.start_ms, line.text))
            .collect(),
    )
}

fn take_delimited(input: &str, open: char, close: char) -> Option<(&str, &str)> {
    let input = input.strip_prefix(open)?;
    let close_index = input.find(close)?;
    Some((
        &input[..close_index],
        &input[close_index + close.len_utf8()..],
    ))
}

fn opening_tag<'a>(input: &'a str, name: &str) -> Option<&'a str> {
    let start = find_open_tag(input, name, 0)?;
    let end = input[start..].find('>')? + start + 1;
    Some(&input[start..end])
}

fn element_text<'a>(input: &'a str, name: &str) -> Option<&'a str> {
    let (_, inner, _) = next_element(input, name, 0)?;
    Some(inner.trim())
}

fn parse_leading_silence(value: &str) -> Option<i64> {
    let value = value.trim();
    let number = value
        .strip_suffix("ms")
        .unwrap_or(value)
        .parse::<f64>()
        .ok()?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    let milliseconds = if value.ends_with("ms") || !value.contains('.') {
        number
    } else {
        number * 1_000.0
    };
    (milliseconds <= i64::MAX as f64).then(|| milliseconds.round() as i64)
}

fn next_element<'a>(input: &'a str, name: &str, from: usize) -> Option<(&'a str, &'a str, usize)> {
    let start = find_open_tag(input, name, from)?;
    let tag_end = input[start..].find('>')? + start + 1;
    let closing = format!("</{name}>");
    let content_end = input[tag_end..].find(&closing)? + tag_end;
    Some((
        &input[start..tag_end],
        &input[tag_end..content_end],
        content_end + closing.len(),
    ))
}

fn matching_element_end(input: &str, name: &str, content_start: usize) -> Option<usize> {
    let opening = format!("<{name}");
    let closing = format!("</{name}>");
    let mut depth = 1_usize;
    let mut cursor = content_start;
    while cursor < input.len() {
        let next_open = input[cursor..].find(&opening).map(|offset| cursor + offset);
        let next_close = input[cursor..].find(&closing).map(|offset| cursor + offset);
        match (next_open, next_close) {
            (Some(open), Some(close)) if open < close => {
                let boundary = input.as_bytes().get(open + opening.len()).copied();
                if boundary
                    .is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/'))
                {
                    depth += 1;
                }
                cursor = open + opening.len();
            }
            (_, Some(close)) => {
                depth -= 1;
                if depth == 0 {
                    return Some(close);
                }
                cursor = close + closing.len();
            }
            _ => return None,
        }
    }
    None
}

fn find_open_tag(input: &str, name: &str, mut from: usize) -> Option<usize> {
    let needle = format!("<{name}");
    while let Some(relative) = input[from..].find(&needle) {
        let start = from + relative;
        let boundary = input.as_bytes().get(start + needle.len()).copied();
        if boundary.is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/')) {
            return Some(start);
        }
        from = start + needle.len();
    }
    None
}

fn tag_name_is(tag: &str, name: &str) -> bool {
    let tag = tag.trim_start_matches('<').trim_start_matches('/');
    tag.strip_prefix(name)
        .and_then(|rest| rest.as_bytes().first().copied())
        .is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/'))
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let mut cursor = 0;
    while let Some(relative) = tag[cursor..].find(name) {
        let start = cursor + relative;
        let before_ok = start == 0
            || tag.as_bytes()[start - 1].is_ascii_whitespace()
            || tag.as_bytes()[start - 1] == b'<';
        let after_name = start + name.len();
        if before_ok && tag.get(after_name..)?.trim_start().starts_with('=') {
            let equals = tag[after_name..].find('=')? + after_name;
            let rest = tag[equals + 1..].trim_start();
            let quote = rest.chars().next()?;
            if quote != '"' && quote != '\'' {
                return None;
            }
            let value = &rest[quote.len_utf8()..];
            let end = value.find(quote)?;
            return Some(decode_xml_text(&value[..end]));
        }
        cursor = after_name;
    }
    None
}

fn strip_tags(input: &str) -> String {
    let mut result = String::new();
    let mut inside = false;
    for character in input.chars() {
        match character {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => result.push(character),
            _ => {}
        }
    }
    result
}

fn decode_xml_text(input: &str) -> String {
    input
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const LRC_FIXTURE: &str = include_str!("../tests/fixtures/oracle.lrc");
    const YRC_FIXTURE: &str = include_str!("../tests/fixtures/oracle.yrc");
    const TTML_FIXTURE: &str = include_str!("../tests/fixtures/oracle.ttml");

    #[test]
    fn validates_timeline_and_finds_active_line() {
        let document = LyricsDocument {
            source: LyricsSource::Yrc,
            metadata: LyricsMetadata::default(),
            lines: vec![
                LyricLine {
                    start_ms: 100,
                    end_ms: Some(200),
                    text: "first".into(),
                    translation: None,
                    romanization: None,
                    words: vec![LyricWord {
                        start_ms: 100,
                        end_ms: 150,
                        text: "first".into(),
                    }],
                },
                LyricLine {
                    start_ms: 250,
                    end_ms: None,
                    text: "second".into(),
                    translation: None,
                    romanization: None,
                    words: vec![],
                },
            ],
        };
        assert_eq!(document.validate(), Ok(()));
        assert_eq!(document.line_at(160).unwrap().text, "first");
        assert!(document.line_at(225).is_none());
    }

    #[test]
    fn parses_lrc_metadata_offset_and_multiple_timestamps() {
        let document = parse_lrc(LRC_FIXTURE).expect("fixture should parse");
        assert_eq!(document.metadata.title.as_deref(), Some("Oracle Song"));
        assert_eq!(document.metadata.artists, ["First Artist", "Second Artist"]);
        assert_eq!(document.metadata.album.as_deref(), Some("Oracle Album"));
        assert_eq!(document.metadata.offset_ms, 100);
        assert_eq!(document.lines.len(), 3);
        assert_eq!(document.lines[0].start_ms, 1_200);
        assert_eq!(document.lines[0].end_ms, Some(3_000));
        assert_eq!(document.lines[1].start_ms, 3_000);
        assert_eq!(document.lines[2].start_ms, 5_000);
    }

    #[test]
    fn parses_yrc_words_and_infers_zero_duration_runs() {
        let document = parse_yrc(YRC_FIXTURE).expect("fixture should parse");
        assert_eq!(document.lines.len(), 2);
        assert_eq!(document.lines[0].text, "未计时字 word");
        assert_eq!(document.lines[0].end_ms, Some(2_800));
        assert_eq!(document.lines[0].words[0].start_ms, 1_000);
        assert_eq!(document.lines[0].words[0].end_ms, 1_500);
        assert_eq!(document.lines[0].words[1].start_ms, 1_500);
        assert_eq!(document.lines[0].words[1].end_ms, 1_800);
        assert!(document.validate().is_ok());
    }

    #[test]
    fn parses_ttml_timing_words_and_alternates() {
        let document = parse_ttml(TTML_FIXTURE).expect("fixture should parse");
        assert_eq!(document.lines.len(), 3);
        assert_eq!(document.metadata.offset_ms, 1_250);
        assert_eq!(document.lines[0].start_ms, 1_500);
        assert_eq!(document.lines[0].end_ms, Some(4_000));
        assert_eq!(document.lines[0].text, "Hello world");
        assert_eq!(document.lines[0].translation.as_deref(), Some("你好世界"));
        assert_eq!(
            document.lines[0].romanization.as_deref(),
            Some("ni hao shi jie")
        );
        assert_eq!(document.lines[0].words[1].start_ms, 2_250);
        assert_eq!(document.lines[1].text, "Plain & final");
        assert_eq!(document.lines[1].end_ms, Some(5_500));
        assert_eq!(document.lines[2].text, "Background");
        assert_eq!(document.lines[2].words.len(), 2);
        assert!(document.validate().is_ok());
    }

    #[test]
    fn bundle_falls_back_by_parseability_and_attaches_alternate_text() {
        let document = parse_lyrics_bundle(&LyricsBundle {
            original: "[00:01.000]line\n[00:02.000]second",
            translation: "[00:01.000]翻译\n[00:02.000]第二行",
            romanization: "[00:01.000]luo ma",
            word_synced: "invalid yrc",
            word_synced_translation: "[1000,500](1000,500,0)逐字翻译",
            ttml: TTML_FIXTURE,
        });
        assert_eq!(document.source, LyricsSource::Lrc);
        assert_eq!(document.lines[0].translation.as_deref(), Some("逐字翻译"));
        assert_eq!(document.lines[1].translation.as_deref(), Some("第二行"));
        assert_eq!(document.lines[0].romanization.as_deref(), Some("luo ma"));

        let unknown = parse_lyrics_bundle(&LyricsBundle::default());
        assert_eq!(unknown.source, LyricsSource::Unknown);
        assert!(unknown.lines.is_empty());
    }

    #[test]
    fn local_sidecar_wins_then_embedded_and_unknown_are_used_as_fallbacks() {
        let root = tempdir().unwrap();
        let audio = root.path().join("song.flac");
        fs::write(&audio, b"not needed by lyric resolver").unwrap();
        fs::write(root.path().join("song.lrc"), "[00:01]sidecar").unwrap();

        let sidecar = load_local_lyrics(&audio, Some("[00:02]embedded")).unwrap();
        assert_eq!(
            sidecar.origin,
            LocalLyricsOrigin::Sidecar(root.path().join("song.lrc"))
        );
        assert_eq!(sidecar.document.lines[0].text, "sidecar");

        fs::remove_file(root.path().join("song.lrc")).unwrap();
        fs::write(root.path().join("song.yrc"), "broken").unwrap();
        let embedded = load_local_lyrics(&audio, Some("[00:02]embedded")).unwrap();
        assert_eq!(embedded.origin, LocalLyricsOrigin::Embedded);
        assert_eq!(embedded.document.source, LyricsSource::Embedded);
        assert_eq!(embedded.document.lines[0].text, "embedded");

        let missing = load_local_lyrics(&audio, Some("  ")).unwrap();
        assert_eq!(missing.origin, LocalLyricsOrigin::None);
        assert_eq!(missing.document.source, LyricsSource::Unknown);
        assert!(missing.document.lines.is_empty());
    }
}

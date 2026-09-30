//! Прокси HLS-потока для просмотра в вебвью.
//!
//! Нужен CDNVideoHub: его ссылки подписаны под User-Agent резолва, а вебвью
//! не может подставить свой UA в запросы hls.js. Вдобавок CDN пускает по CORS
//! только собственный плеер. Поэтому hls.js ходит не на CDN, а на схему
//! `stream`, и запрос за него делает Rust с нужными заголовками.
//!
//! Проксируется именно HLS, а не прямой MP4. hls.js складывает сегменты в
//! MediaSource, и кадр остаётся «своим» для канвы, так что апскейл Anime4K
//! работает без `crossOrigin`. Весь остальной механизм плеера (буфер, переролв
//! по 403, застой в конце серии) тоже остаётся прежним. Ответ схемы Tauri —
//! буфер целиком, а не поток, и сегмент в 2–8 МБ в это укладывается. С MP4
//! пришлось бы нарезать Range на куски самим.
//!
//! Адрес потока: `stream://localhost/<токен>/<высота>p.m3u8`. Сегменты в
//! переписанном плейлисте — относительные `s/<base64 исходного URI>`, так что
//! hls.js сам собирает их от адреса плейлиста, а форма схемы (на Windows это
//! `http://stream.localhost`) знает только [`base_url`].
//!
//! Подписанная ссылка в вебвью не попадает: там только токен, а таблица
//! токенов живёт здесь.

use std::collections::hash_map::RandomState;
use std::collections::VecDeque;
use std::hash::{BuildHasher, Hasher};
use std::sync::{Mutex, OnceLock};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::Url;
use tauri::http::{header, Method, Request, Response, StatusCode};

use crate::kodik::http_client;
use crate::resolver::Stream;

pub const SCHEME: &str = "stream";

/// Сколько потоков помнить. Каждая смена серии, качества и переролв
/// регистрирует новый; старые нужны разве что недогруженному сегменту.
const SESSION_LIMIT: usize = 16;

const PLAYLIST_TYPE: &str = "application/vnd.apple.mpegurl";

/// Что стоит за токеном.
struct Session {
    token: String,
    /// Локатор серии — по нему смена качества делает новый резолв.
    locator: String,
    stream: Stream,
}

static SESSIONS: OnceLock<Mutex<VecDeque<Session>>> = OnceLock::new();

fn sessions() -> std::sync::MutexGuard<'static, VecDeque<Session>> {
    SESSIONS
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Начало адреса схемы. На Windows (WebView2) и Android Tauri отдаёт
/// кастомные схемы как `http://<схема>.localhost`, на macOS и Linux — как
/// `<схема>://localhost`.
fn base_url() -> String {
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{SCHEME}.localhost")
    } else {
        format!("{SCHEME}://localhost")
    }
}

/// Регистрирует поток и возвращает адрес, который можно отдать hls.js.
pub fn register(locator: &str, stream: Stream) -> String {
    let token = new_token();
    let name = stream
        .height
        .map_or_else(|| "playlist.m3u8".to_string(), |height| format!("{height}p.m3u8"));
    let url = format!("{}/{token}/{name}", base_url());

    let mut all = sessions();
    if all.len() >= SESSION_LIMIT {
        all.pop_front();
    }
    all.push_back(Session {
        token,
        locator: locator.to_string(),
        stream,
    });

    url
}

/// Локатор серии по адресу прокси; `None` — адрес не наш или уже забыт.
pub fn locator_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix(&base_url())?.strip_prefix('/')?;
    let token = rest.split('/').next()?;

    sessions()
        .iter()
        .find(|session| session.token == token)
        .map(|session| session.locator.clone())
}

/// 128 бит из системного генератора, которым std сеет `RandomState`. Токен —
/// не секрет от пользователя, а защита от подбора адресов чужой страницей.
fn new_token() -> String {
    let half = || RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", half(), half())
}

/// Обработчик схемы. Асинхронный: запрос к CDN не должен держать поток
/// вебвью.
pub async fn handle(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == Method::OPTIONS {
        return respond(StatusCode::NO_CONTENT, None, Vec::new());
    }

    let path = request.uri().path().trim_start_matches('/');
    let Some((token, rest)) = path.split_once('/') else {
        return not_found();
    };

    let Some(stream) = sessions()
        .iter()
        .find(|session| session.token == token)
        .map(|session| session.stream.clone())
    else {
        // Токен вытеснен или приложение перезапущено. 403, а не 404: так
        // плеер перерезолвит поток, как на протухшей подписи.
        return respond(StatusCode::FORBIDDEN, None, Vec::new());
    };

    match rest.strip_prefix("s/") {
        Some(encoded) => segment(&stream, encoded).await,
        None => playlist(&stream).await,
    }
}

async fn playlist(stream: &Stream) -> Response<Vec<u8>> {
    match fetch(stream, &stream.url).await {
        Ok((_, body)) => {
            let text = String::from_utf8_lossy(&body);
            respond(
                StatusCode::OK,
                Some(PLAYLIST_TYPE),
                rewrite_playlist(&text).into_bytes(),
            )
        }
        Err(status) => respond(status, None, Vec::new()),
    }
}

async fn segment(stream: &Stream, encoded: &str) -> Response<Vec<u8>> {
    let Some(target) = URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|uri| Url::parse(&stream.url).ok()?.join(&uri).ok())
    else {
        return not_found();
    };

    match fetch(stream, target.as_str()).await {
        Ok((content_type, body)) => respond(StatusCode::OK, content_type.as_deref(), body),
        Err(status) => respond(status, None, Vec::new()),
    }
}

/// GET к CDN с заголовками потока. Ошибка — уже код для hls.js.
async fn fetch(stream: &Stream, url: &str) -> Result<(Option<String>, Vec<u8>), StatusCode> {
    let client = http_client().map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut request = client.get(url);

    if let Some(user_agent) = &stream.user_agent {
        request = request.header(header::USER_AGENT, user_agent);
    }
    if let Some(referer) = &stream.referer {
        request = request.header(header::REFERER, referer);
    }

    let response = request.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = response.status();

    if !status.is_success() {
        return Err(upstream_status(status.as_u16()));
    }

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?;

    Ok((content_type, body.to_vec()))
}

/// Отказ подписи у okcdn — 400 (чужой UA или IP) или 403 (истекла). Плееру
/// оба приходят как 403: на него он перерезолвит поток, а на 400 сдался бы.
/// 5xx уходят как есть — их hls.js сам повторит.
fn upstream_status(code: u16) -> StatusCode {
    match code {
        400 | 401 | 403 | 410 => StatusCode::FORBIDDEN,
        _ => StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY),
    }
}

/// Заменяет каждый URI плейлиста на относительный адрес прокси. Кроме строк
/// сегментов, URI бывают в атрибутах (`#EXT-X-KEY`, `#EXT-X-MAP`): у
/// CDNVideoHub их нет, но пропущенный там URI ушёл бы мимо прокси и молча
/// не загрузился.
fn rewrite_playlist(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);

    for line in text.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            out.push_str(line);
        } else if trimmed.starts_with('#') {
            out.push_str(&rewrite_uri_attribute(trimmed));
        } else {
            out.push_str(&proxied(trimmed));
        }
        out.push('\n');
    }

    out
}

fn rewrite_uri_attribute(tag: &str) -> String {
    const ATTRIBUTE: &str = "URI=\"";

    let Some(start) = tag.find(ATTRIBUTE).map(|at| at + ATTRIBUTE.len()) else {
        return tag.to_string();
    };
    let Some(length) = tag[start..].find('"') else {
        return tag.to_string();
    };

    format!(
        "{}{}{}",
        &tag[..start],
        proxied(&tag[start..start + length]),
        &tag[start + length..]
    )
}

fn proxied(uri: &str) -> String {
    format!("s/{}", URL_SAFE_NO_PAD.encode(uri))
}

/// CORS обязателен: страница живёт на `tauri://localhost`, схема — другой
/// origin. `*` достаточно, учётных данных hls.js не шлёт.
fn respond(status: StatusCode, content_type: Option<&str>, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header(header::CACHE_CONTROL, "no-store");

    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }

    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn not_found() -> Response<Vec<u8>> {
    respond(StatusCode::NOT_FOUND, None, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(url: &str, height: Option<u32>) -> Stream {
        Stream {
            url: url.into(),
            referer: None,
            user_agent: Some("UA".into()),
            height,
        }
    }

    #[test]
    fn rewrites_segments_and_uri_attributes_but_keeps_tags() {
        let playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:13\n#EXTINF:12.05,\nFULLHD00000.ts\n\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"1@0\"\n#EXT-X-ENDLIST\n";
        let rewritten = rewrite_playlist(playlist);
        let lines: Vec<&str> = rewritten.lines().collect();

        assert_eq!(lines[0], "#EXTM3U");
        assert_eq!(lines[2], "#EXTINF:12.05,");
        assert_eq!(lines[3], format!("s/{}", URL_SAFE_NO_PAD.encode("FULLHD00000.ts")));
        assert_eq!(
            lines[5],
            format!(
                "#EXT-X-MAP:URI=\"s/{}\",BYTERANGE=\"1@0\"",
                URL_SAFE_NO_PAD.encode("init.mp4")
            )
        );
        assert_eq!(lines[6], "#EXT-X-ENDLIST");
    }

    #[test]
    fn treats_rejected_signature_as_forbidden() {
        assert_eq!(upstream_status(400), StatusCode::FORBIDDEN);
        assert_eq!(upstream_status(403), StatusCode::FORBIDDEN);
        assert_eq!(upstream_status(404), StatusCode::NOT_FOUND);
        assert_eq!(upstream_status(503), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn names_playlist_by_height_and_finds_locator_back() {
        let url = register("cvh:42", stream("https://cdn.example/v/", Some(1080)));

        assert!(url.starts_with(&base_url()));
        assert!(url.ends_with("/1080p.m3u8"));
        assert_eq!(locator_of(&url).as_deref(), Some("cvh:42"));
        assert_eq!(locator_of("https://cdn.example/v/"), None);
    }

    /// Живой прогон через CDN: `cargo test --lib -- --ignored live`.
    /// Серия — «Код Гиас R2», 1 серия, AniLibria.
    #[test]
    #[ignore = "ходит в сеть"]
    fn live_proxies_playlist_and_segment() {
        tauri::async_runtime::block_on(async {
            let stream = crate::cvh::resolve("9956747926256", 1080).await.unwrap();
            let url = register("cvh:9956747926256", stream);
            let path = url.strip_prefix(&base_url()).unwrap().to_string();

            let get = |path: String| {
                handle(Request::get(format!("{}{path}", base_url())).body(Vec::new()).unwrap())
            };

            let playlist = get(path.clone()).await;
            assert_eq!(playlist.status(), StatusCode::OK);
            let text = String::from_utf8(playlist.body().clone()).unwrap();
            let first = text.lines().find(|line| line.starts_with("s/")).unwrap();

            let directory = &path[..path.rfind('/').unwrap() + 1];
            let segment = get(format!("{directory}{first}")).await;
            assert_eq!(segment.status(), StatusCode::OK);
            // MPEG-TS: пакет начинается с синхробайта 0x47.
            assert_eq!(segment.body()[0], 0x47);
            assert_eq!(
                segment.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                "*"
            );
            println!("сегмент {} байт", segment.body().len());
        });
    }

    #[test]
    fn tokens_do_not_repeat() {
        assert_ne!(new_token(), new_token());
    }
}

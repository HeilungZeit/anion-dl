//! Резолв манифеста Kodik обычными HTTP-запросами, без вебвью.
//!
//! Прежняя заметка «обфускация меняется с релизами, реверсить бессмысленно»
//! оказалась неверной: меняется не шифр, а адрес эндпойнта. Сам шифр — сдвиг
//! латинских букв на 18 плюс base64 — держится годами (той же схемой живёт
//! kodikwrapper).
//!
//! Порядок такой:
//!
//! 1. GET страницы плеера. В её разметке лежат `type`/`id`/`hash` серии и
//!    подписанные параметры домена (`d_sign`, `pd_sign`, `ref_sign`) — без них
//!    эндпойнт отвечает 500 с `Error code: rs`.
//! 2. POST на `/ftor` этими параметрами → JSON со ссылками по качествам.
//! 3. Каждый `src` расшифровывается сдвигом и base64 в готовый m3u8.
//!
//! Тракт с вебвью остаётся фолбэком: сменится эндпойнт или форма разметки —
//! загрузка станет медленной, а не сорвётся.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;

use crate::resolver::{quality_of, upgrade_quality};

/// Referer страницы плеера. Kodik выдаёт подписи именно под домен-владелец
/// вставки, и он же приезжает обратно в поле `d`.
const SITE_REFERER: &str = "https://anion.online/";

/// UA настоящего браузера. UA вебвью Tauri Kodik принимает, но повторять его в
/// HTTP-тракте незачем: обычный десктопный Chrome проверен и не привязан к
/// версии WebKit на машине пользователя.
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// Известный адрес выдачи ссылок. Пробуется первым; при отказе актуальный
/// достаётся из скрипта плеера.
const KNOWN_ENDPOINT: &str = "/ftor";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Сдвиг, которым Kodik шифрует `src`. Остальные перебираются следом — цена
/// перебора нулевая, а смена сдвига перестаёт быть отказом.
const DEFAULT_SHIFT: u8 = 18;

/// Достаёт URL манифеста нужного качества по URL плеера.
pub async fn resolve(iframe_url: &str, preferred: u32) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|error| format!("Не удалось создать HTTP-клиент: {error}"))?;

    let origin = origin_of(iframe_url)?;
    let page = fetch_page(&client, iframe_url).await?;
    let params = PlayerParams::parse(&page)?;

    let endpoint = format!("{origin}{KNOWN_ENDPOINT}");
    let payload = match request_links(&client, &endpoint, &origin, iframe_url, &params).await {
        Ok(payload) => payload,
        Err(first) => {
            let discovered = discover_endpoint(&client, &page, &origin)
                .await
                .filter(|found| *found != endpoint)
                .ok_or_else(|| format!("{first}. Другого эндпойнта в скрипте плеера нет"))?;

            request_links(&client, &discovered, &origin, iframe_url, &params).await?
        }
    };

    Ok(upgrade_quality(best_link(&payload)?, preferred).await)
}

async fn fetch_page(client: &reqwest::Client, iframe_url: &str) -> Result<String, String> {
    let response = client
        .get(iframe_url)
        .header("Referer", SITE_REFERER)
        .send()
        .await
        .map_err(|error| format!("Страница плеера не открылась: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Страница плеера ответила {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|error| format!("Страница плеера не прочиталась: {error}"))
}

/// Всё, что нужно передать эндпойнту, чтобы он отдал ссылки.
struct PlayerParams {
    domain: String,
    domain_sign: String,
    player_domain: String,
    player_domain_sign: String,
    referer: String,
    referer_sign: String,
    kind: String,
    id: String,
    hash: String,
}

impl PlayerParams {
    fn parse(page: &str) -> Result<Self, String> {
        // `vInfo` — то, что плеер реально отправляет; одноимённые `var` рядом
        // существуют, но у страницы сезона расходятся с ним: в адресе стоит
        // `season`, а серия внутри уже `seria` со своим id и хэшем.
        let field = |name: &str| {
            js_string(page, &format!("vInfo.{name}"))
                .or_else(|| js_string(page, &format!("var {name}")))
        };

        let missing = |name: &str| format!("В разметке плеера нет {name}");

        Ok(Self {
            domain: js_string(page, "var domain").ok_or_else(|| missing("domain"))?,
            domain_sign: js_string(page, "var d_sign").ok_or_else(|| missing("d_sign"))?,
            player_domain: js_string(page, "var pd").ok_or_else(|| missing("pd"))?,
            player_domain_sign: js_string(page, "var pd_sign").ok_or_else(|| missing("pd_sign"))?,
            // Именно `var ref`, а не одноимённое поле `urlParams`: там оно
            // хранится percent-кодированным, и подпись под него не подходит.
            referer: js_string(page, "var ref").ok_or_else(|| missing("ref"))?,
            referer_sign: js_string(page, "var ref_sign").ok_or_else(|| missing("ref_sign"))?,
            kind: field("type").ok_or_else(|| missing("type"))?,
            id: field("id").or_else(|| field("videoId")).ok_or_else(|| missing("id"))?,
            hash: field("hash").ok_or_else(|| missing("hash"))?,
        })
    }

    fn form(&self) -> [(&str, &str); 11] {
        [
            ("d", &self.domain),
            ("d_sign", &self.domain_sign),
            ("pd", &self.player_domain),
            ("pd_sign", &self.player_domain_sign),
            ("ref", &self.referer),
            ("ref_sign", &self.referer_sign),
            ("type", &self.kind),
            ("id", &self.id),
            ("hash", &self.hash),
            // Оба флага плеер шлёт всегда. Без них ответ тот же, но лишнее
            // отличие от настоящего запроса ничем не окупается.
            ("bad_user", "true"),
            ("cdn_is_working", "true"),
        ]
    }
}

#[derive(Deserialize)]
struct FtorPayload {
    links: HashMap<String, Vec<FtorLink>>,
}

#[derive(Deserialize)]
struct FtorLink {
    src: String,
}

async fn request_links(
    client: &reqwest::Client,
    endpoint: &str,
    origin: &str,
    page_url: &str,
    params: &PlayerParams,
) -> Result<FtorPayload, String> {
    let response = client
        .post(endpoint)
        .header("Referer", page_url)
        .header("Origin", origin)
        .header("X-Requested-With", "XMLHttpRequest")
        .form(&params.form())
        .send()
        .await
        .map_err(|error| format!("Запрос ссылок не прошёл: {error}"))?;

    let status = response.status();

    if !status.is_success() {
        // Тело здесь — HTML-заглушка Kodik, и в ней бывает код вида
        // `Error code: rs`. Он единственная зацепка, когда параметры приняты,
        // но не подошли, поэтому вытаскивается в текст ошибки.
        let reason = response
            .text()
            .await
            .ok()
            .and_then(|body| slice_between(&body, "Error code: ", "<").map(str::to_string))
            .map(|code| format!(" (код {code})"))
            .unwrap_or_default();

        return Err(format!("{endpoint} ответил {status}{reason}"));
    }

    response
        .json()
        .await
        .map_err(|error| format!("{endpoint} ответил не ссылками: {error}"))
}

/// Ищет актуальный адрес выдачи в скрипте плеера.
///
/// Kodik держит его в `atob("…")`, и меняет время от времени (`/ftor` → `/kor`
/// → …). Скрипт весит полтораста килобайт, поэтому качается только когда
/// известный адрес уже отказал.
async fn discover_endpoint(
    client: &reqwest::Client,
    page: &str,
    origin: &str,
) -> Option<String> {
    let script = find_script(page, "app.player_single")?;
    let url = format!("{origin}{script}");

    let body = client.get(&url).send().await.ok()?.text().await.ok()?;

    let mut rest = body.as_str();

    while let Some(at) = rest.find("atob(\"") {
        rest = &rest[at + "atob(\"".len()..];
        let Some(end) = rest.find('"') else { break };
        let (encoded, tail) = rest.split_at(end);
        rest = tail;

        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            continue;
        };
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };

        if is_endpoint_path(&text) {
            return Some(format!("{origin}{text}"));
        }
    }

    None
}

/// Похоже ли расшифрованное на адрес выдачи ссылок.
///
/// Эндпойнт — короткий абсолютный путь из одного сегмента (`/ftor`, `/kor`).
/// Соседние `atob` в том же файле прячут домен CDN (`//(?:get|cloud).kodik-cdn.com`)
/// и адрес статистики (`allvideometrika.com/kodikstats.php`) — точка и второй
/// слэш отсеивают оба.
fn is_endpoint_path(text: &str) -> bool {
    text.len() > 1 && text.len() < 32 && text.starts_with('/') && !text[1..].contains(['/', '.'])
}

/// Путь к скрипту плеера в разметке.
fn find_script(page: &str, name: &str) -> Option<String> {
    let at = page.find(name)?;
    let start = page[..at].rfind('"')? + 1;
    let end = at + page[at..].find('"')?;

    Some(page[start..end].to_string())
}

/// Лучшая из выданных ссылок.
///
/// Ключ качества в ответе доверия не заслуживает: у `links["720"]` наблюдался
/// URL с `480` в имени файла. Настоящее качество зашито в имя, по нему и
/// сравниваем, а добор до желаемого делает `upgrade_quality`.
fn best_link(payload: &FtorPayload) -> Result<String, String> {
    payload
        .links
        .values()
        .flatten()
        .filter_map(|link| decode_src(&link.src))
        .max_by_key(|url| quality_of(url).unwrap_or(0))
        .ok_or_else(|| "Ни одна ссылка плеера не расшифровалась".to_string())
}

/// Расшифровывает `src`: сдвиг латинских букв, затем base64.
fn decode_src(src: &str) -> Option<String> {
    std::iter::once(DEFAULT_SHIFT)
        .chain(0..26)
        .find_map(|shift| decode_with_shift(src, shift))
}

fn decode_with_shift(src: &str, shift: u8) -> Option<String> {
    let rotated: String = src.chars().map(|symbol| rotate(symbol, shift)).collect();
    let padded = format!("{rotated}{}", "=".repeat((4 - rotated.len() % 4) % 4));

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(padded)
        .ok()?;
    let text = String::from_utf8(bytes).ok()?;

    let url = match text.strip_prefix("//") {
        Some(rest) => format!("https://{rest}"),
        None => text,
    };

    // Проверка обязательна: неверный сдвиг иногда даёт валидный base64 и даже
    // валидный UTF-8, и без неё вернулся бы мусор вместо манифеста.
    (url.starts_with("https://") && url.contains(".m3u8")).then_some(url)
}

fn rotate(symbol: char, shift: u8) -> char {
    let base = match symbol {
        'a'..='z' => b'a',
        'A'..='Z' => b'A',
        _ => return symbol,
    };

    ((symbol as u8 - base + shift) % 26 + base) as char
}

/// Читает строковый литерал из разметки: `var ref = "…"`, `vInfo.hash = '…'`.
///
/// Регекспов в проекте нет, а тащить `regex` ради двух шаблонов дороже, чем
/// прочитать литерал вручную.
fn js_string(page: &str, binding: &str) -> Option<String> {
    let mut from = 0;

    while let Some(at) = page[from..].find(binding) {
        let after = from + at + binding.len();
        from = after;

        let rest = page[after..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();

        let Some(quote) = rest.chars().next().filter(|char| *char == '"' || *char == '\'') else {
            continue;
        };

        let body = &rest[quote.len_utf8()..];

        if let Some(end) = body.find(quote) {
            return Some(body[..end].to_string());
        }
    }

    None
}

fn slice_between<'a>(text: &'a str, after: &str, before: &str) -> Option<&'a str> {
    let start = text.find(after)? + after.len();
    let rest = &text[start..];

    Some(&rest[..rest.find(before)?])
}

fn origin_of(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("Некорректный URL плеера: {url}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("В URL плеера нет хоста: {url}"))?;

    Ok(format!("{}://{host}", parsed.scheme()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Настоящий `src` из ответа `/ftor` и то, во что он разворачивается.
    const SAMPLE_SRC: &str = "iPZ0kPU6Tg9hi3sck29aj2ZrHO4cG29bT2NciE1tkg80U2Q2WBY1VBHtVLChGrC1VhseGhNtHOUhWERtU2NqGrQhUOVuGuC4ThCfVOUfVuRuUOVtHrIeVOC0VhQ4GBYeUrM3UOMeVOHrWrQeUrGeWLMhULCdUrYeTu1eVLxwjPU6jENciEHtk3YcjBV1WI";

    #[test]
    fn decodes_real_src() {
        let url = decode_src(SAMPLE_SRC).expect("должен расшифроваться");

        assert!(url.starts_with("https://sky.solodcdn.com/animes/"));
        assert!(url.ends_with("/240.mp4:hls:manifest.m3u8"));
    }

    #[test]
    fn rejects_garbage_instead_of_guessing() {
        assert!(decode_src("не base64 и не ссылка").is_none());
    }

    #[test]
    fn reads_both_quote_styles() {
        let page = r#"var ref = "https://anion.online/"; vInfo.hash = 'abc123';"#;

        assert_eq!(
            js_string(page, "var ref").as_deref(),
            Some("https://anion.online/")
        );
        assert_eq!(js_string(page, "vInfo.hash").as_deref(), Some("abc123"));
    }

    /// Ключ качества в ответе — не качество. Здесь под ключом «720» лежит
    /// ссылка на 240p (ровно так живой Kodik и отвечает), а под «240» — на
    /// 480p; выиграть должна вторая.
    #[test]
    fn ranks_links_by_the_url_not_the_key() {
        let payload = FtorPayload {
            links: HashMap::from([
                (
                    "720".to_string(),
                    vec![FtorLink {
                        src: SAMPLE_SRC.into(),
                    }],
                ),
                (
                    "240".to_string(),
                    vec![FtorLink {
                        src: encode_quality(SAMPLE_SRC, 480),
                    }],
                ),
            ]),
        };

        let best = best_link(&payload).expect("ссылка есть");

        assert!(best.ends_with("/480.mp4:hls:manifest.m3u8"), "выбрано: {best}");
    }

    /// Обратная сборка `src` из готового URL — нужна только тесту, чтобы не
    /// хранить вторую портянку зашифрованной строки.
    fn encode_quality(src: &str, quality: u32) -> String {
        let url = decode_src(src).expect("образец расшифровывается");
        let (prefix, suffix) = crate::resolver::split_quality(&url).expect("образец разрезается");
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(format!("{prefix}{quality}{suffix}"));

        encoded
            .chars()
            .map(|symbol| rotate(symbol, 26 - DEFAULT_SHIFT))
            .collect()
    }

    #[test]
    fn takes_short_paths_and_skips_neighbours() {
        assert!(is_endpoint_path("/ftor"));
        assert!(is_endpoint_path("/kor"));
        assert!(!is_endpoint_path("//(?:get|cloud).kodik-cdn.com"));
        assert!(!is_endpoint_path("allvideometrika.com/kodikstats.php"));
    }
}

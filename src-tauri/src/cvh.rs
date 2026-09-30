//! CDNVideoHub — второй источник серий, рядом с Kodik.
//!
//! Этот плеер Shikimori встраивает на страницы `/watch`. Видео лежит на CDN
//! VK/OK (`*.okcdn.ru`), и там почти всегда есть 1080p, которого у Kodik нет.
//! Полный разбор источника — [docs/cvh-source.md](../../docs/cvh-source.md).
//!
//! Протокол — два обычных GET, без авторизации, Referer и обфускации:
//!
//! 1. `playlist?pub=…&aggr=mali&id=<MAL id>` — список серий по озвучкам;
//! 2. `video/<vkId>` — подписанные ссылки: HLS-мастер и прямые MP4.
//!
//! Подпись живёт сутки, но привязана к IP и к **классу User-Agent** (`srcAg`
//! в URL): ссылка, выданная Chrome, отвечает 400 на UA ffmpeg. Поэтому резолв
//! идёт общим клиентом с [`BROWSER_UA`], и тот же UA уезжает в ffmpeg вместе с
//! потоком (см. [`crate::resolver::Stream`]).

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::kodik::{http_client, BROWSER_UA};
use crate::resolver::Stream;

const API: &str = "https://plapi.cdnvideohub.com/api/v1/player/sv";

/// Обязательный параметр плейлиста: без него 400. Подходит любой; это номер
/// самого Shikimori — с ним API заведомо отдаёт то же, что видно на сайте.
const PUBLISHER: &str = "3058";

/// Префикс локатора серии этого источника: `cvh:<vkId>`.
///
/// Локатор живёт там же, где у Kodik URL плеера, — в задачах загрузок и
/// записях прогресса. Поэтому в нём нет ни версии API, ни хоста: они могут
/// смениться, а сохранённые задачи должны остаться валидными.
pub const LOCATOR_PREFIX: &str = "cvh:";

/// Серия плейлиста в том виде, в каком её ждёт UI.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub vk_id: String,
    /// Студия озвучки, а у субтитров и безымянных — тип озвучки.
    pub voice: String,
    pub episode: u32,
}

#[derive(Deserialize)]
struct Playlist {
    #[serde(default)]
    items: Vec<PlaylistItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistItem {
    vk_id: String,
    voice_studio: Option<String>,
    voice_type: Option<String>,
    /// У фильмов поля нет вовсе.
    episode: Option<u32>,
}

#[derive(Deserialize)]
struct VideoInfo {
    sources: Sources,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sources {
    #[serde(default)]
    hls_url: String,
}

/// Серии тайтла по MAL id. Пустой список — штатный ответ: тайтла в источнике
/// нет (правообладатели снимают целые сериалы).
#[tauri::command]
pub async fn cvh_playlist(mal_id: u64) -> Result<Vec<Track>, String> {
    let url = format!("{API}/playlist?pub={PUBLISHER}&aggr=mali&id={mal_id}");
    let playlist: Playlist = get_json(&url).await?;

    Ok(tracks(playlist.items))
}

fn tracks(items: Vec<PlaylistItem>) -> Vec<Track> {
    items
        .into_iter()
        .filter_map(|item| {
            let voice = item
                .voice_studio
                .or(item.voice_type)
                .filter(|name| !name.trim().is_empty())?;

            Some(Track {
                vk_id: item.vk_id,
                voice,
                episode: item.episode.unwrap_or(1),
            })
        })
        .collect()
}

/// Поток серии нужного качества: лучший вариант не выше желаемого.
///
/// Отдаётся вариант HLS, а не прямой MP4, хотя есть и он: вариант идёт тем же
/// ffmpeg-конвейером, что и Kodik, с его ретраями и проверкой длительности.
/// Мастер ffmpeg отдавать нельзя: первым в нём стоит 480p, и `-map 0:v:0`
/// взял бы именно его.
pub async fn resolve(vk_id: &str, preferred: u32) -> Result<Stream, String> {
    let info: VideoInfo = get_json(&format!("{API}/video/{vk_id}")).await?;
    let master_url = info.sources.hls_url;

    if master_url.is_empty() {
        return Err("CDNVideoHub не отдал поток этой серии".into());
    }

    let master = http_client()?
        .get(&master_url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Мастер-плейлист CDNVideoHub недоступен: {error}"))?
        .text()
        .await
        .map_err(|error| format!("Не удалось прочитать мастер-плейлист: {error}"))?;

    let (height, variant) = pick_variant(&master, preferred)
        .ok_or("В мастер-плейлисте CDNVideoHub нет ни одного варианта")?;
    let url = Url::parse(&master_url)
        .and_then(|base| base.join(variant))
        .map_err(|error| format!("Некорректная ссылка варианта: {error}"))?;

    Ok(Stream {
        url: url.into(),
        referer: None,
        user_agent: Some(BROWSER_UA.into()),
        height: Some(height),
    })
}

/// Высота и URI варианта: лучший не выше `preferred`, а если таких нет —
/// наименьший. Тот же откат вниз, что у Kodik.
fn pick_variant(master: &str, preferred: u32) -> Option<(u32, &str)> {
    let mut variants = Vec::new();
    let mut height = None;

    for line in master.lines().map(str::trim) {
        if let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            height = resolution_height(attributes);
        } else if !line.is_empty() && !line.starts_with('#') {
            if let Some(value) = height.take() {
                variants.push((value, line));
            }
        }
    }

    let fitting = variants.iter().filter(|(value, _)| *value <= preferred);

    fitting
        .max_by_key(|(value, _)| *value)
        .or_else(|| variants.iter().min_by_key(|(value, _)| *value))
        .copied()
}

/// Высота из `RESOLUTION=1920x1080`.
fn resolution_height(attributes: &str) -> Option<u32> {
    attributes
        .split(',')
        .find_map(|pair| pair.strip_prefix("RESOLUTION="))
        .and_then(|value| value.split_once('x'))
        .and_then(|(_, height)| height.parse().ok())
}

async fn get_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, String> {
    let response = http_client()?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("CDNVideoHub недоступен: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("CDNVideoHub ответил {status}"));
    }

    response
        .json()
        .await
        .map_err(|error| format!("CDNVideoHub прислал неожиданный ответ: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Сокращённый живой мастер: порядок вариантов у CDN не по качеству.
    const MASTER: &str = "#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1813157,QUALITY=sd,FRAME-RATE=24,RESOLUTION=852x480
/expires/1/type/2/video/
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=571230,QUALITY=lowest,FRAME-RATE=24,RESOLUTION=426x240
/expires/1/type/0/video/
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=3563226,QUALITY=hd,FRAME-RATE=24,RESOLUTION=1280x720
/expires/1/type/3/video/
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=6508934,QUALITY=full,FRAME-RATE=24,RESOLUTION=1920x1080
/expires/1/type/5/video/
";

    #[test]
    fn picks_best_variant_not_above_preferred() {
        assert_eq!(pick_variant(MASTER, 1080), Some((1080, "/expires/1/type/5/video/")));
        assert_eq!(pick_variant(MASTER, 720), Some((720, "/expires/1/type/3/video/")));
        assert_eq!(pick_variant(MASTER, 600), Some((480, "/expires/1/type/2/video/")));
    }

    #[test]
    fn falls_back_to_smallest_when_nothing_fits() {
        assert_eq!(pick_variant(MASTER, 144), Some((240, "/expires/1/type/0/video/")));
    }

    #[test]
    fn rejects_master_without_variants() {
        assert_eq!(pick_variant("#EXTM3U\n", 1080), None);
    }

    #[test]
    fn names_voice_by_studio_then_type_and_numbers_movies() {
        let items: Vec<PlaylistItem> = serde_json::from_str(
            r#"[
                {"vkId": "1", "voiceStudio": "AniDUB", "voiceType": "Неизвестный", "episode": 3},
                {"vkId": "2", "voiceType": "Субтитры", "episode": 3},
                {"vkId": "3", "voiceStudio": "AniLibria"}
            ]"#,
        )
        .unwrap();

        let voices: Vec<(String, u32)> = tracks(items)
            .into_iter()
            .map(|track| (track.voice, track.episode))
            .collect();

        assert_eq!(
            voices,
            [
                ("AniDUB".to_string(), 3),
                ("Субтитры".to_string(), 3),
                ("AniLibria".to_string(), 1),
            ]
        );
    }
}

//! Добыча URL HLS-манифеста из плеера Kodik.
//!
//! Основной путь — обычные HTTP-запросы, он живёт в [`crate::kodik`]. Здесь
//! лежит фолбэк: страница выполняется в скрытом вебвью, а мы подслушиваем её
//! сетевые запросы. Он медленнее на порядок (секунды против сотен миллисекунд,
//! до минуты при осечке), зато переживает смену эндпойнта и формы разметки —
//! ровно того, на чём HTTP-тракт и ломается.
//!
//! Канал передачи наружу — `document.title`, а не Tauri IPC. IPC на удалённом
//! origin требует включения remote-домена в capabilities, что заметно расширяет
//! поверхность доверия к чужой странице ради одной строки. Заголовок окна
//! читается снаружи без всяких прав и не даёт странице ничего взамен.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Префикс, по которому отличаем «наш» заголовок от настоящего title страницы.
const TITLE_PREFIX: &str = "__ANION_M3U8__";

/// Диагностический заголовок, пока манифест не найден.
const DEBUG_PREFIX: &str = "__ANION_DEBUG__";

const RESOLVER_LABEL: &str = "kodik-resolver";

const POLL_INTERVAL: Duration = Duration::from_millis(200);
const TIMEOUT: Duration = Duration::from_secs(60);

/// Скрипт выполняется до кода страницы во ВСЕХ фреймах и патчит оба способа,
/// которыми hls.js ходит за манифестом.
///
/// Работа во всех фреймах обязательна: страница Kodik держит настоящий плеер во
/// вложенном iframe, и в главном документе нет ни `<video>`, ни сетевых запросов
/// за видео — диагностика показала `video:false, frames:1, seen:2`.
///
/// Отсюда же и postMessage вместо прямой записи в document.title: заголовок
/// вложенного фрейма верхний документ не меняет, а колбэк Tauri слушает именно
/// заголовок верхнего. Поэтому фреймы шлют наверх, а верхний пишет заголовок.
const PROBE_SCRIPT: &str = r#"
(function () {
  var PREFIX = '__ANION_M3U8__';
  var DEBUG_PREFIX = '__ANION_DEBUG__';
  var isTop = window.top === window;
  var found = false;
  var seen = 0;

  function post(message) {
    try {
      window.top.postMessage(message, '*');
    } catch (e) {}
  }

  // Примета контентного манифеста Kodik: качество зашито в имя файла.
  // На неё же опирается подмена качества в upgrade_quality, так что манифест,
  // не подошедший под шаблон, всё равно годится лишь как запасной вариант.
  var CONTENT_SHAPE = /\.mp4:hls:manifest\.m3u8/;

  function report(url) {
    if (found || typeof url !== 'string') return;
    seen++;
    if (url.indexOf('.m3u8') === -1) return;

    if (CONTENT_SHAPE.test(url)) {
      found = true;
      post({ __anion: 'm3u8', url: url });
      return;
    }

    // Не похоже на серию — придержим. Реклама тоже раздаётся по HLS, и раньше
    // выигрывал просто первый пришедший манифест.
    post({ __anion: 'maybe', url: url });
  }

  if (isTop) {
    var best = null;
    var fallback = null;
    var fallbackAt = 0;
    // Состояния копятся по фреймам, а не перезаписываются: иначе в отчёт
    // попадает случайный последний фрейм (у нас так вылезала статистика
    // ls.kodikres.com), и настоящий плеерный фрейм не видно.
    var frames = {};

    function accept(url) {
      if (best) return;
      best = url;
      document.title = PREFIX + url;
    }

    window.addEventListener('message', function (event) {
      var data = event && event.data;
      if (!data || !data.__anion || best) return;

      if (data.__anion === 'm3u8') {
        accept(data.url);
        return;
      }

      if (data.__anion === 'maybe' && !fallback) {
        fallback = data.url;
        fallbackAt = Date.now();
        return;
      }

      if (data.__anion === 'debug') {
        frames[data.state.host] = data.state;
        document.title = DEBUG_PREFIX + JSON.stringify(frames);
      }
    });

    // Запасной манифест принимается, только если за GRACE_MS не пришёл
    // подходящий под шаблон. Так реклама не выигрывает гонку у серии, но и
    // смена формата URL у Kodik не оставляет нас ни с чем.
    var GRACE_MS = 8000;
    setInterval(function () {
      if (!best && fallback && Date.now() - fallbackAt > GRACE_MS) {
        accept(fallback);
      }
    }, 500);
  }

  // Ошибки страницы копим: если плеер падает на старте, без этого видно только
  // «нет video», а причина остаётся невидимой.
  var errors = [];
  window.addEventListener('error', function (e) {
    if (errors.length < 3) {
      errors.push(String((e && e.message) || e).slice(0, 120));
    }
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (errors.length < 3) {
      errors.push('rej: ' + String((e && e.reason) || '').slice(0, 120));
    }
  });

  // Пока манифест не найден, каждый фрейм рассказывает о себе — иначе таймаут
  // не отличить от «скрипт не выполнился».
  setInterval(function () {
    if (found) return;
    post({
      __anion: 'debug',
      state: {
        top: isTop,
        host: location.hostname,
        seen: seen,
        video: !!document.querySelector('video'),
        frames: document.querySelectorAll('iframe').length,
        ready: document.readyState,
        bodyLen: (document.body && document.body.innerHTML.length) || 0,
        players: Array.prototype.slice
          .call(document.querySelectorAll('[class*=play],[id*=play]'))
          .map(function (el) {
            return el.tagName + '.' + el.className + '#' + el.id;
          })
          .slice(0, 6),
        errors: errors
      }
    });
  }, 1000);

  var originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input) {
      report(typeof input === 'string' ? input : (input && input.url));
      return originalFetch.apply(this, arguments);
    };
  }

  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    report(url);
    return originalOpen.apply(this, arguments);
  };

  // Плеер не запрашивает манифест, пока не было жеста пользователя, поэтому
  // жмём play сами. Селекторы перебираем вслепую и повторяем: разметка Kodik
  // может измениться, а лишний клик по пустому месту ничего не ломает.
  var attempts = 0;
  var timer = setInterval(function () {
    if (found || ++attempts > 60) {
      clearInterval(timer);
      return;
    }

    try {
      // .play_button — это <a> на реальной странице Kodik, именно он запускает
      // плеер. Остальные селекторы оставлены на случай смены разметки.
      var target = document.querySelector(
        '.play_button, .play_background, .play-large, [data-plyr="play"], .vjs-big-play-button, video'
      );
      if (target && target.click) target.click();

      var video = document.querySelector('video');
      if (video && video.play) video.play().catch(function () {});
    } catch (e) {}
  }, 500);
})();
"#;

/// Качества, которые вообще встречаются у Kodik, от лучшего к худшему.
const QUALITY_LADDER: [u32; 4] = [1080, 720, 480, 360];

/// Referer, без которого CDN не отдаёт ни манифест, ни сегменты.
pub const CDN_REFERER: &str = "https://kodikplayer.com/";

/// Возвращает URL манифеста по URL плеера.
///
/// Сначала пробуется HTTP-тракт, при его отказе — вебвью. Порядок именно такой:
/// HTTP отвечает за доли секунды и падает сразу, так что цена неудачной попытки
/// заметно меньше, чем выигрыш в успешном случае.
///
/// `preferred_quality` — желаемая высота кадра. Ключи качеств у Kodik неточны, а
/// вебвью и вовсе ловит стартовые 360p, поэтому в обоих случаях нужное качество
/// добирается подменой числа в имени файла (см. [`upgrade_quality`]).
#[tauri::command]
pub async fn resolve_manifest(
    app: AppHandle,
    iframe_url: String,
    preferred_quality: Option<u32>,
) -> Result<String, String> {
    let quality = preferred_quality.unwrap_or(DEFAULT_QUALITY);

    let http_error = match crate::kodik::resolve(&iframe_url, quality).await {
        Ok(manifest) => return Ok(manifest),
        Err(error) => error,
    };

    let mut last = String::new();

    // Плеер срывается на старте не так уж редко (реклама не догрузилась, клик
    // пришёлся в пустоту), и одна такая осечка роняла всю серию. Повтор стоит
    // минуты ожидания, перекачка — двадцати.
    for _ in 0..RESOLVE_ATTEMPTS {
        match attempt_resolve(&app, &iframe_url, quality).await {
            Ok(manifest) => return Ok(manifest),
            Err(error) => last = error,
        }

        // Пауза перед повтором не нужна: страница загружается с нуля в новом
        // окне, а таймаут в 60 с сам по себе достаточная выдержка.
    }

    // Причина отказа HTTP-тракта нужна в тексте: без неё непонятно, сломался ли
    // он у всех разом (сменился эндпойнт) или спотыкается на одной серии.
    Err(format!("{last} Быстрый резолв до этого не удался: {http_error}"))
}

/// Качество по умолчанию, если UI ничего не попросил.
const DEFAULT_QUALITY: u32 = 720;

/// Сколько раз пробовать, прежде чем признать серию нерезолвящейся.
const RESOLVE_ATTEMPTS: u32 = 2;

async fn attempt_resolve(
    app: &AppHandle,
    iframe_url: &str,
    preferred_quality: u32,
) -> Result<String, String> {
    // Окно могло остаться от прерванной попытки — иначе build() упадёт на
    // конфликте label.
    if let Some(stale) = app.get_webview_window(RESOLVER_LABEL) {
        let _ = stale.destroy();
        wait_for_label_release(app).await;
    }

    let url = iframe_url
        .parse()
        .map_err(|_| format!("Некорректный URL плеера: {iframe_url}"))?;

    // Заголовок приходит push-колбэком, а не опросом window.title(): последний
    // отдаёт заголовок окна ОС, который Tauri к document.title не привязывает,
    // и опрос всегда видел исходный титул.
    let mailbox = Arc::new(Mutex::new(Mailbox::default()));
    let writer = Arc::clone(&mailbox);

    let window = WebviewWindowBuilder::new(app, RESOLVER_LABEL, WebviewUrl::External(url))
        .visible(false)
        .initialization_script_for_all_frames(PROBE_SCRIPT)
        .on_document_title_changed(move |_, title| {
            let mut slot = writer.lock().expect("mailbox отравлен");

            if let Some(manifest) = title.strip_prefix(TITLE_PREFIX) {
                slot.manifest = Some(manifest.to_string());
            } else if title.starts_with(DEBUG_PREFIX) {
                slot.diagnostics = title.replace(DEBUG_PREFIX, "");
            }
        })
        .build()
        .map_err(|error| format!("Не удалось открыть окно резолвера: {error}"))?;

    let outcome = poll_for_manifest(&mailbox).await;

    // Окно закрывается в любом случае, включая таймаут и ошибку: скрытое живое
    // окно продолжало бы грузить видео и жечь трафик.
    let _ = window.destroy();

    let manifest = outcome?;

    Ok(upgrade_quality(manifest, preferred_quality).await)
}

/// Сколько ждать, пока метка окна освободится.
const LABEL_RELEASE_TIMEOUT: Duration = Duration::from_secs(3);

/// Ждёт, пока Tauri действительно снимет окно с метки резолвера.
///
/// `destroy()` лишь просит цикл событий закрыть окно — метка держится ещё
/// какое-то время. Без ожидания повтор падал мгновенно с «a webview with label
/// `kodik-resolver` already exists», то есть `RESOLVE_ATTEMPTS` не работал
/// вовсе: вторая попытка не доходила даже до загрузки страницы. Проявилось это
/// только когда фолбэк начали прогонять целиком.
async fn wait_for_label_release(app: &AppHandle) {
    let deadline = std::time::Instant::now() + LABEL_RELEASE_TIMEOUT;

    while std::time::Instant::now() < deadline {
        if app.get_webview_window(RESOLVER_LABEL).is_none() {
            return;
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Подменяет качество в имени манифеста на лучшее доступное, не выше желаемого.
///
/// Манифест выглядит как `…/360.mp4:hls:manifest.m3u8`, и соседние качества
/// лежат по тому же пути. Существование проверяется запросом: 1080p есть далеко
/// не всегда (наблюдалось 404 при живых 720 и 480).
///
/// Любая неудача — возврат исходного URL: качество хуже ожидаемого лучше, чем
/// сорванная загрузка.
pub(crate) async fn upgrade_quality(manifest: String, preferred: u32) -> String {
    let Some((prefix, suffix)) = split_quality(&manifest) else {
        return manifest;
    };

    // Таймаут обязателен: у reqwest его по умолчанию нет, и зависший узел CDN
    // застопорил бы задачу бессрочно — дедлайн вебвью к этому моменту уже
    // позади, ограничивать проверку больше нечему.
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(_) => return manifest,
    };

    for quality in QUALITY_LADDER.iter().filter(|item| **item <= preferred) {
        let candidate = format!("{prefix}{quality}{suffix}");

        if is_playlist(&client, &candidate).await {
            return candidate;
        }
    }

    manifest
}

/// Отдаёт ли URL настоящий плейлист.
///
/// Кода 200 мало: заглушка CDN приходит с ним же, и ffmpeg получил бы HTML
/// вместо манифеста — ошибка при этом вылезла бы уже на этапе загрузки и
/// выглядела бы как «поток битый». Поэтому смотрим на тело: любой плейлист
/// HLS начинается с `#EXTM3U`.
async fn is_playlist(client: &reqwest::Client, url: &str) -> bool {
    let Ok(response) = client.get(url).header("Referer", CDN_REFERER).send().await else {
        return false;
    };

    if !response.status().is_success() {
        return false;
    }

    response
        .text()
        .await
        .map(|body| body.trim_start().starts_with("#EXTM3U"))
        .unwrap_or(false)
}

/// Качество, зашитое в имя манифеста. У Kodik это единственный честный
/// источник: ключи в ответе `/ftor` с содержимым расходятся.
pub(crate) fn quality_of(manifest: &str) -> Option<u32> {
    let (prefix, suffix) = split_quality(manifest)?;

    manifest[prefix.len()..manifest.len() - suffix.len()]
        .parse()
        .ok()
}

/// Разрезает URL вокруг числа качества: `…/` + `360` + `.mp4:hls:manifest.m3u8`.
pub(crate) fn split_quality(manifest: &str) -> Option<(&str, &str)> {
    let marker = ".mp4:hls:";
    let marker_at = manifest.find(marker)?;

    let digits_start = manifest[..marker_at]
        .rfind(|c: char| !c.is_ascii_digit())
        .map(|index| index + 1)?;

    if digits_start == marker_at {
        return None;
    }

    Some((&manifest[..digits_start], &manifest[marker_at..]))
}

#[cfg(test)]
mod tests {
    use super::split_quality;

    #[test]
    fn splits_around_quality() {
        let url =
            "https://cloud.solodcdn.com/useruploads/abc/def:2026080305/360.mp4:hls:manifest.m3u8";
        let (prefix, suffix) = split_quality(url).expect("должен разрезаться");

        assert_eq!(
            prefix,
            "https://cloud.solodcdn.com/useruploads/abc/def:2026080305/"
        );
        assert_eq!(suffix, ".mp4:hls:manifest.m3u8");
        assert_eq!(format!("{prefix}720{suffix}"), url.replace("360", "720"));
    }

    #[test]
    fn leaves_unknown_shapes_alone() {
        assert!(split_quality("https://example.com/master.m3u8").is_none());
    }
}

/// То, что страница успела сообщить о себе через заголовок.
#[derive(Default)]
struct Mailbox {
    manifest: Option<String>,
    diagnostics: String,
}

async fn poll_for_manifest(mailbox: &Arc<Mutex<Mailbox>>) -> Result<String, String> {
    let deadline = std::time::Instant::now() + TIMEOUT;

    while std::time::Instant::now() < deadline {
        {
            let slot = mailbox.lock().expect("mailbox отравлен");

            if let Some(manifest) = &slot.manifest {
                return Ok(manifest.clone());
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }

    // Диагностика в тексте ошибки: без неё таймаут не отличить от «скрипт не
    // выполнился вовсе».
    let slot = mailbox.lock().expect("mailbox отравлен");

    Err(format!(
        "Плеер не отдал манифест за 60 секунд. Состояние страницы: {}",
        if slot.diagnostics.is_empty() {
            "скрипт не отчитался — вероятно, initialization_script не выполнился"
        } else {
            &slot.diagnostics
        }
    ))
}

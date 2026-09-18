//! Что умеет вебвью на этой машине: WebGPU, MediaSource, Fullscreen API.
//!
//! Спрашиваем сам вебвью, а не документацию: у WKWebView часть возможностей
//! Safari выключена, и списки поддержки браузеров про встроенный вебвью врут.
//!
//! cargo run --example gpu_probe

use std::sync::{Arc, Mutex};

const PROBE: &str = r#"
(async () => {
  const report = {
    userAgent: navigator.userAgent.slice(0, 120),
    webgpu: !!navigator.gpu,
    adapter: null,
    mediaSource: typeof MediaSource !== 'undefined',
    managedMediaSource: typeof ManagedMediaSource !== 'undefined',
    fullscreenEnabled: !!document.fullscreenEnabled,
    requestFullscreen: typeof document.documentElement.requestFullscreen === 'function',
    videoFrameCallback:
      typeof HTMLVideoElement !== 'undefined' &&
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function',
    webgl2: false,
    videoEncoder: typeof VideoEncoder !== 'undefined',
    videoDecoder: typeof VideoDecoder !== 'undefined',
    videoFrame: typeof VideoFrame !== 'undefined',
    encodeAvc: null,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    captureStream:
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function',
  };

  if (typeof VideoEncoder !== 'undefined') {
    try {
      // Тот же профиль, что у скачанных файлов: H.264 High.
      const support = await VideoEncoder.isConfigSupported({
        codec: 'avc1.640028',
        width: 1920,
        height: 1080,
        bitrate: 8000000,
        framerate: 24,
      });
      report.encodeAvc = support.supported === true;
    } catch (e) {
      report.encodeAvc = 'ошибка: ' + e;
    }
  }

  try {
    const canvas = document.createElement('canvas');
    report.webgl2 = !!canvas.getContext('webgl2');
  } catch (e) {
    report.webgl2 = false;
  }

  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info || {};
        report.adapter = {
          vendor: info.vendor || '?',
          architecture: info.architecture || '?',
          maxTextureDimension2D: adapter.limits?.maxTextureDimension2D ?? null,
        };
      } else {
        report.adapter = 'requestAdapter вернул null';
      }
    } catch (e) {
      report.adapter = 'ошибка: ' + e;
    }
  }

  // Скрипт выполняется в начале документа, и разобранный далее <title>
  // страницы затирает наш. Поэтому ставим заголовок после загрузки и
  // повторяем — Rust читает первое же сообщение со своим префиксом.
  const publish = () => {
    document.title = '__PROBE__' + JSON.stringify(report);
  };

  if (document.readyState === 'complete') {
    publish();
  } else {
    window.addEventListener('load', publish);
  }

  for (let i = 1; i <= 6; i += 1) {
    setTimeout(publish, i * 300);
  }
})();
"#;

fn main() {
    let mailbox: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let sink = mailbox.clone();

    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();

            // Грузим обычную https-страницу и внедряем скрипт — ровно как
            // делает резолвер. WKWebView не принимает ни about:blank (скрипт
            // не отрабатывает), ни data: для верхнеуровневой навигации.
            let _window = tauri::WebviewWindowBuilder::new(
                app,
                "gpu-probe",
                tauri::WebviewUrl::External("https://example.com/".parse().unwrap()),
            )
            .initialization_script_for_all_frames(PROBE)
            .visible(false)
            .on_document_title_changed(move |_, title| {
                if let Some(json) = title.strip_prefix("__PROBE__") {
                    *sink.lock().unwrap() = Some(json.to_string());
                }
            })
            .build()?;

            let waiting = mailbox.clone();
            tauri::async_runtime::spawn(async move {
                for _ in 0..100 {
                    if let Some(json) = waiting.lock().unwrap().take() {
                        println!("{json}");
                        handle.exit(0);
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }

                eprintln!("вебвью не отчитался за 10 секунд");
                handle.exit(1);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить пробник");
}

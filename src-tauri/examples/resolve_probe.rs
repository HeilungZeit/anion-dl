//! Прогон резолвера из терминала, без кликов по окну приложения.
//!
//! Поднимает тот же Tauri-рантайм (вебвью нужен настоящий — в этом весь смысл
//! резолвера), дёргает resolve_manifest на переданном URL плеера, печатает
//! результат и выходит.
//!
//! cargo run --example resolve_probe -- "https://kodikplayer.com/season/…"

fn main() {
    let url = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("Использование: cargo run --example resolve_probe -- <URL плеера>");
        std::process::exit(2);
    });

    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                let started = std::time::Instant::now();

                let quality = std::env::args()
                    .nth(2)
                    .and_then(|value| value.parse().ok());

                match anion_dl_lib::resolver::resolve_manifest(handle.clone(), url, quality).await {
                    Ok(manifest) => {
                        println!("OK за {:?}", started.elapsed());
                        println!("MANIFEST: {manifest}");
                        handle.exit(0);
                    }
                    Err(error) => {
                        eprintln!("FAIL за {:?}: {error}", started.elapsed());
                        handle.exit(1);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить пробник");
}

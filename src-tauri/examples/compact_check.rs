//! Прогоняет сеть Compact на GPU в вебвью и сверяет результат с эталоном.
//!
//! Ошибка в ядре или в раскладке весов не видна глазом: картинка выходит
//! правдоподобной, просто не той. `scripts/compact-to-wgsl.py` доказывает
//! раскладку на CPU, а здесь проверяется уже сам WGSL — тот, что генерирует
//! `src/app/player/compact/shaders.ts`, без дублирования его в стенде.
//!
//! Подготовка (окружение одноразовое, см. шапку python-скрипта):
//!
//!     .venv/bin/python scripts/compact-to-wgsl.py fixture /tmp/fix
//!     bun run scripts/emit-compact-shaders.ts /tmp/fix/shaders
//!     cargo run --example compact_check -- /tmp/fix
//!
//! Транспорт отчёта повторяет `gpu_probe`: заголовок окна обрезается около
//! тысячи символов, поэтому JSON едет кусками по кругу.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine;

fn read(dir: &PathBuf, name: &str) -> Vec<u8> {
    let path = dir.join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("не читается {}: {e}", path.display()))
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn js_string(text: &str) -> String {
    serde_json::to_string(text).expect("строка не сериализуется")
}

fn build_script(dir: &PathBuf) -> String {
    let meta = String::from_utf8(read(dir, "model.json")).expect("model.json не UTF-8");

    let shaders = dir.join("shaders");
    let first = std::fs::read_to_string(shaders.join("first.wgsl")).expect("нет first.wgsl");
    let body = std::fs::read_to_string(shaders.join("body.wgsl")).expect("нет body.wgsl");
    let last = std::fs::read_to_string(shaders.join("last.wgsl")).expect("нет last.wgsl");
    let pre = std::fs::read_to_string(shaders.join("preprocess.wgsl")).expect("нет preprocess.wgsl");
    let show = std::fs::read_to_string(shaders.join("present.wgsl")).expect("нет present.wgsl");

    format!(
        r#"
(async () => {{
  const report = {{ done: false, stage: 'старт' }};

  // Тот же кусочный транспорт, что в gpu_probe: заголовок обрезается около
  // тысячи символов, а куски подряд вебвью может схлопнуть.
  const CHUNK = 600;
  let ticker = null;

  const publish = () => {{
    const json = JSON.stringify(report);
    const total = Math.ceil(json.length / CHUNK) || 1;
    let next = 0;

    if (ticker !== null) {{ clearInterval(ticker); }}

    const send = () => {{
      const index = next % total;
      next += 1;
      document.title =
        '__PROBE__' + index + '/' + total + ':' + json.slice(index * CHUNK, (index + 1) * CHUNK);
    }};

    send();
    ticker = setInterval(send, 80);
  }};

  if (document.readyState === 'complete') {{ publish(); }}
  else {{ window.addEventListener('load', publish); }}

  const meta = {meta};
  const shaders = {{
    first: {first}, body: {body}, last: {last},
    preprocess: {pre}, present: {show},
  }};

  const decode = (text) => {{
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {{ out[i] = raw.charCodeAt(i); }}
    return out;
  }};

  const weights = decode('{weights}');
  const input = decode('{input}');
  const expected = new Float32Array(decode('{expected}').buffer);

  try {{
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {{ throw new Error('адаптер не выдан'); }}

    // Лимиты берём у адаптера: без requiredLimits устройство получает
    // дефолты спеки, а не то, что железо умеет.
    const limits = {{}};
    for (const name of ['maxStorageBufferBindingSize', 'maxBufferSize',
                        'maxComputeWorkgroupStorageSize']) {{
      const value = adapter.limits?.[name];
      if (typeof value === 'number') {{ limits[name] = value; }}
    }}

    const device = await adapter.requestDevice({{
      requiredFeatures: ['shader-f16'],
      requiredLimits: limits,
    }});

    let uncaptured = null;
    device.addEventListener('uncapturederror', (e) => {{ uncaptured = String(e.error.message); }});

    const W = meta.fixture.width;
    const H = meta.fixture.height;
    const S = meta.scale;
    const featGroups = Math.ceil(meta.numFeat / 4);

    report.stage = 'буферы';
    publish();

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

    const blobBuf = device.createBuffer({{ size: weights.byteLength, usage: storage }});
    device.queue.writeBuffer(blobBuf, 0, weights);

    // Исходник служит и входом первой свёртки, и слагаемым skip в последней.
    const origBuf = device.createBuffer({{ size: input.byteLength, usage: storage }});
    device.queue.writeBuffer(origBuf, 0, input);

    const actBytes = W * H * featGroups * 8;
    const ping = device.createBuffer({{ size: actBytes, usage: storage }});
    const pong = device.createBuffer({{ size: actBytes, usage: storage }});

    const outBytes = W * S * H * S * 8;
    const outBuf = device.createBuffer({{ size: outBytes, usage: storage }});
    const staging = device.createBuffer({{
      size: outBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }});

    report.stage = 'пайплайны';
    publish();

    const make = async (code) => {{
      device.pushErrorScope('validation');
      const module = device.createShaderModule({{ code }});
      const pipeline = device.createComputePipeline({{
        layout: 'auto',
        compute: {{ module, entryPoint: 'main' }},
      }});
      const scoped = await device.popErrorScope();
      if (scoped) {{ throw new Error('пайплайн: ' + scoped.message); }}
      return pipeline;
    }};

    const pipes = {{
      first: await make(shaders.first),
      body: await make(shaders.body),
      last: await make(shaders.last),
    }};

    // Препроцесс и вывод в счёте не участвуют, но проверить их разбор надо
    // здесь: иначе опечатка обнаружится только кликом в плеере.
    await make(shaders.preprocess);

    device.pushErrorScope('validation');
    const presentModule = device.createShaderModule({{ code: shaders.present }});
    device.createRenderPipeline({{
      layout: 'auto',
      vertex: {{ module: presentModule, entryPoint: 'vs' }},
      fragment: {{
        module: presentModule,
        entryPoint: 'fs',
        targets: [{{ format: navigator.gpu.getPreferredCanvasFormat() }}],
      }},
      primitive: {{ topology: 'triangle-list' }},
    }});
    const presentError = await device.popErrorScope();
    if (presentError) {{ throw new Error('вывод: ' + presentError.message); }}

    report.auxShaders = 'ok';

    // Привязки собираются один раз на размер кадра: создавать их внутри
    // замера значит мерить работу CPU, а не GPU.
    const prepare = (W, H, orig, ping, pong, out) => {{
      let src = orig;
      let dst = ping;

      const passes = meta.layers.map((layer, index) => {{
        const isFirst = index === 0;
        const isLast = index === meta.layers.length - 1;
        const pipeline = isFirst ? pipes.first : (isLast ? pipes.last : pipes.body);

        // Смещения блоков внутри блоба — в vec4, а не в байтах: шейдер
        // адресует blob[] элементами по восемь байт.
        const wBase = layer.offset / 8;
        const biasBase = wBase + layer.out * 9 * layer.inGroups;
        const preluBase = biasBase + layer.outGroups;

        const dims = device.createBuffer({{
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }});
        device.queue.writeBuffer(
          dims, 0,
          new Uint32Array([W, H, wBase, biasBase, preluBase, 0, 0, 0])
        );

        const target = isLast ? out : dst;
        const entries = [
          {{ binding: 0, resource: {{ buffer: dims }} }},
          {{ binding: 1, resource: {{ buffer: src }} }},
          {{ binding: 2, resource: {{ buffer: target }} }},
          {{ binding: 3, resource: {{ buffer: blobBuf }} }},
        ];
        if (isLast) {{ entries.push({{ binding: 4, resource: {{ buffer: origBuf }} }}); }}

        const bind = device.createBindGroup({{
          layout: pipeline.getBindGroupLayout(0),
          entries,
        }});

        if (!isLast) {{
          // Первый слой читает исходник, дальше буферы качаются между собой.
          src = target;
          dst = target === ping ? pong : ping;
        }}

        return {{ pipeline, bind }};
      }});

      return {{ passes, groupsX: Math.ceil(W / 8), groupsY: Math.ceil(H / 8) }};
    }};

    const encodeNet = (encoder, prepared) => {{
      for (const step of prepared.passes) {{
        const pass = encoder.beginComputePass();
        pass.setPipeline(step.pipeline);
        pass.setBindGroup(0, step.bind);
        pass.dispatchWorkgroups(prepared.groupsX, prepared.groupsY);
        pass.end();
      }}
    }};

    report.stage = 'счёт';
    publish();

    const prepared = prepare(W, H, origBuf, ping, pong, outBuf);
    const encoder = device.createCommandEncoder();
    encodeNet(encoder, prepared);
    encoder.copyBufferToBuffer(outBuf, 0, staging, 0, outBytes);
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const got = new Uint16Array(staging.getMappedRange().slice(0));
    staging.unmap();

    if (uncaptured) {{ throw new Error('GPU: ' + uncaptured); }}

    // Распаковка half вручную: Float16Array есть не везде, а проверке нужна
    // предсказуемость, а не краткость.
    const half = (bits) => {{
      const sign = (bits & 0x8000) ? -1 : 1;
      const exp = (bits >> 10) & 0x1f;
      const frac = bits & 0x3ff;
      if (exp === 0) {{ return sign * frac * Math.pow(2, -24); }}
      if (exp === 31) {{ return frac ? NaN : sign * Infinity; }}
      return sign * (1 + frac / 1024) * Math.pow(2, exp - 15);
    }};

    let sum = 0;
    let count = 0;
    let peak = 0;
    let worst = 0;

    for (let i = 0; i < got.length; i += 1) {{
      // Четвёртая компонента — заполнитель, в эталоне её нет.
      if (i % 4 === 3) {{ continue; }}
      const want = expected[i];
      const diff = half(got[i]) - want;
      sum += diff * diff;
      peak = Math.max(peak, Math.abs(want));
      worst = Math.max(worst, Math.abs(diff));
      count += 1;
    }}

    const mse = sum / count;
    report.psnr = mse === 0 ? Infinity : Number((20 * Math.log10(Math.max(peak, 1e-6)) - 10 * Math.log10(mse)).toFixed(2));
    report.maxAbsDiff = Number(worst.toFixed(5));
    report.peak = Number(peak.toFixed(4));
    report.samples = count;
    report.layoutPsnrCpu = meta.fixture.layoutPsnr;
    report.stage = 'замер';
    publish();

    // Веса от размера кадра не зависят, поэтому та же сеть гоняется на
    // боевых разрешениях. Это и есть ответ на вопрос, влезает ли она в
    // бюджет кадра — оценка «слой × 10» его только приближала.
    const ITERS = 20;
    report.bench = {{ iters: ITERS }};

    for (const [label, bw, bh] of [['480p', 854, 480], ['720p', 1280, 720]]) {{
      try {{
        const pixels = bw * bh;
        const src = device.createBuffer({{ size: pixels * 8, usage: storage }});
        const a = device.createBuffer({{ size: pixels * featGroups * 8, usage: storage }});
        const b = device.createBuffer({{ size: pixels * featGroups * 8, usage: storage }});
        const o = device.createBuffer({{ size: pixels * S * S * 8, usage: storage }});

        const plan = prepare(bw, bh, src, a, b, o);

        const run = (times) => {{
          const enc = device.createCommandEncoder();
          for (let i = 0; i < times; i += 1) {{ encodeNet(enc, plan); }}
          device.queue.submit([enc.finish()]);
        }};

        run(2);
        await device.queue.onSubmittedWorkDone();

        const started = performance.now();
        run(ITERS);
        await device.queue.onSubmittedWorkDone();
        const elapsed = performance.now() - started;

        const perFrame = elapsed / ITERS;
        report.bench[label] = {{
          msPerFrame: Number(perFrame.toFixed(2)),
          fps: Number((1000 / perFrame).toFixed(1)),
          // Бюджет кадра на 24 к/с — 41.7 мс.
          fits24: perFrame <= 41.7,
        }};

        src.destroy(); a.destroy(); b.destroy(); o.destroy();
      }} catch (e) {{
        report.bench[label] = {{ error: (e && e.message) ? e.message : String(e) }};
      }}
    }}

    report.stage = 'готово';
  }} catch (e) {{
    report.error = (e && e.message) ? e.message : String(e);
    report.stage = 'ошибка';
  }}

  report.done = true;
  publish();
}})();
"#,
        meta = meta.trim(),
        first = js_string(&first),
        body = js_string(&body),
        last = js_string(&last),
        pre = js_string(&pre),
        show = js_string(&show),
        weights = b64(&read(dir, "weights.bin")),
        input = b64(&read(dir, "input.bin")),
        expected = b64(&read(dir, "expected.bin")),
    )
}

fn parse_chunk(payload: &str) -> Option<(usize, usize, String)> {
    let (header, body) = payload.split_once(':')?;
    let (index, total) = header.split_once('/')?;
    Some((index.parse().ok()?, total.parse().ok()?, body.to_string()))
}

fn main() {
    let dir: PathBuf = std::env::args()
        .nth(1)
        .unwrap_or_else(|| {
            eprintln!("использование: cargo run --example compact_check -- <каталог фикстуры>");
            std::process::exit(2);
        })
        .into();

    let script = build_script(&dir);
    eprintln!("скрипт стенда: {} КБ", script.len() / 1024);

    let mailbox: Arc<Mutex<BTreeMap<usize, String>>> = Arc::new(Mutex::new(BTreeMap::new()));
    let expected: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));

    let sink = mailbox.clone();
    let sink_total = expected.clone();

    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();

            let _window = tauri::WebviewWindowBuilder::new(
                app,
                "compact-check",
                tauri::WebviewUrl::External("https://example.com/".parse().unwrap()),
            )
            .initialization_script_for_all_frames(&script)
            .visible(false)
            .on_document_title_changed(move |_, title| {
                let Some(payload) = title.strip_prefix("__PROBE__") else {
                    return;
                };
                let Some((index, total, body)) = parse_chunk(payload) else {
                    return;
                };

                let mut parts = sink.lock().unwrap();
                let mut known = sink_total.lock().unwrap();

                if *known != total {
                    parts.clear();
                    *known = total;
                }

                parts.insert(index, body);
            })
            .build()?;

            let waiting = mailbox.clone();
            let waiting_total = expected.clone();

            tauri::async_runtime::spawn(async move {
                for _ in 0..600 {
                    {
                        let parts = waiting.lock().unwrap();
                        let total = *waiting_total.lock().unwrap();

                        if total > 0 && parts.len() == total {
                            let json: String = parts.values().cloned().collect();
                            if json.contains("\"done\":true") {
                                println!("{json}");
                                handle.exit(if json.contains("\"error\"") { 1 } else { 0 });
                                return;
                            }
                        }
                    }

                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }

                eprintln!("стенд не отчитался за минуту");
                handle.exit(1);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить стенд");
}

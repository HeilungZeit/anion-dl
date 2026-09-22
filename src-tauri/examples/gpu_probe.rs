//! Что умеет вебвью на этой машине: WebGPU, MediaSource, Fullscreen API,
//! fp16 в шейдерах и реальная пропускная способность свёртки.
//!
//! Спрашиваем сам вебвью, а не документацию: у WKWebView часть возможностей
//! Safari выключена, и списки поддержки браузеров про встроенный вебвью врут.
//!
//! Микробенч (Э16 в docs/compact-upscale.md) считает тот самый слой, из
//! которого состоит SRVGGNetCompact: свёртка 3×3, 24 канала на входе и 24 на
//! выходе, кадр 1280×720. Расчёт говорит, что вся сеть стоит 44 712 MAC на
//! пиксель источника и требует около 2 TFLOPS на 24 к/с; бенч показывает,
//! сколько из пиковых TFLOPS достаётся свёртке на самом деле.
//!
//! **Пять вариантов ядра здесь не мусор — не вычищать.** Четыре из них на
//! Apple GPU проиграли, и боевое ядро (`src/app/player/compact/shaders.ts`)
//! собрано по победителю. Но проигрыш у них местный: веса в общей памяти и
//! блокировка по пикселям режут заполняемость именно здесь, а на дискретной
//! видеокарте те же приёмы обычно выигрывают. Ради этого сравнения на второй
//! машине (Э16b) варианты и держатся — выбросив их, пришлось бы писать
//! заново.
//!
//! cargo run --example gpu_probe

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const PROBE: &str = r#"
(async () => {
  const report = {
    // Пока false, Rust ждёт именно завершённый отчёт: бенч идёт секунды, а
    // ранние публикации нужны только чтобы зависание не выглядело молчанием.
    done: false,
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
    // --- Э16 ---
    features: null,
    computeLimits: null,
    f16Device: null,
    triage: null,
    bench: null,
  };

  // Замерено на этом вебвью: заголовок обрезается примерно на 1000 символах —
  // прежний отчёт влезал, отчёт с бенчем уже нет. Поэтому JSON едет кусками, и
  // Rust собирает его обратно. Куски крутятся по кругу: подряд идущие
  // присваивания title вебвью может схлопнуть, и пропущенный кусок приедет на
  // следующем витке.
  const CHUNK = 600;
  let ticker = null;

  const publish = () => {
    const json = JSON.stringify(report);
    const total = Math.ceil(json.length / CHUNK) || 1;
    let next = 0;

    if (ticker !== null) {
      clearInterval(ticker);
    }

    const send = () => {
      const index = next % total;
      next += 1;
      document.title =
        '__PROBE__' + index + '/' + total + ':' + json.slice(index * CHUNK, (index + 1) * CHUNK);
    };

    send();
    ticker = setInterval(send, 80);
  };

  if (document.readyState === 'complete') {
    publish();
  } else {
    window.addEventListener('load', publish);
  }

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

  // --- Микробенч свёртки -----------------------------------------------

  const WIDTH = 1280;
  const HEIGHT = 720;
  const FEAT = 24;        // num_feat у SuperUltraCompact
  const F4 = FEAT / 4;    // каналы пакуются по четыре в vec4
  const TAPS = 9;         // ядро 3×3
  const TILE = 8;         // блок выходных пикселей на рабочую группу
  const HALO = TILE + 2;  // с каймой под ядро 3×3
  const WARMUP = 5;
  const ITERS = 100;

  /**
   * Тот же слой в двух точностях. Ради честного сравнения отличается только
   * тип: раскладка, тайлинг и порядок обхода одинаковые.
   *
   * Активации лежат в storage-буфере как NHWC с каналами, упакованными в
   * vec4 — так соседи по 3×3 читаются подряд. Текстурный путь потребовал бы
   * шести attachment'ов и лишних пересылок между слоями.
   */
  const source = (fp16) => `
${fp16 ? 'enable f16;' : ''}
alias S = ${fp16 ? 'f16' : 'f32'};
alias V = vec4<${fp16 ? 'f16' : 'f32'}>;

const F4: u32 = ${F4}u;
const TILE: u32 = ${TILE}u;
const HALO: u32 = ${HALO}u;

struct Dims { width: u32, height: u32 }

@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> src: array<V>;
@group(0) @binding(2) var<storage, read_write> dst: array<V>;
@group(0) @binding(3) var<storage, read> wts: array<V>;

// Входное окно блока целиком: каждый пиксель каймы читается девятью
// соседями, и без общей памяти это девять походов в глобальную.
var<workgroup> tile: array<V, ${HALO * HALO * F4}>;

@compute @workgroup_size(${TILE}, ${TILE}, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
) {
  let baseX = i32(wg.x * TILE) - 1;
  let baseY = i32(wg.y * TILE) - 1;

  for (var i = li; i < HALO * HALO; i = i + ${TILE * TILE}u) {
    let ty = i / HALO;
    let tx = i % HALO;
    // Границы кадра — clamp, а не ветка: дивергенция на краях дороже
    // лишнего чтения уже лежащей рядом строки.
    let gx = u32(clamp(baseX + i32(tx), 0, i32(dims.width) - 1));
    let gy = u32(clamp(baseY + i32(ty), 0, i32(dims.height) - 1));
    let s = (gy * dims.width + gx) * F4;
    let d = i * F4;
    for (var g = 0u; g < F4; g = g + 1u) {
      tile[d + g] = src[s + g];
    }
  }

  workgroupBarrier();

  let ox = wg.x * TILE + lid.x;
  let oy = wg.y * TILE + lid.y;
  // Выход за кадр отсеивается только после барьера: выйти раньше — значит
  // не дождаться загрузки тайла соседями.
  if (ox >= dims.width || oy >= dims.height) {
    return;
  }

  let outBase = (oy * dims.width + ox) * F4;

  for (var og = 0u; og < F4; og = og + 1u) {
    var accv = V(0.0);
    for (var sub = 0u; sub < 4u; sub = sub + 1u) {
      let o = og * 4u + sub;
      var acc: S = S(0.0);
      for (var tap = 0u; tap < 9u; tap = tap + 1u) {
        let p = ((lid.y + tap / 3u) * HALO + (lid.x + tap % 3u)) * F4;
        let wb = (o * 9u + tap) * F4;
        for (var g = 0u; g < F4; g = g + 1u) {
          acc = acc + dot(wts[wb + g], tile[p + g]);
        }
      }
      accv[sub] = acc;
    }
    dst[outBase + og] = accv;
  }
}
`;

  /**
   * Триаж: WebKit на отказ пайплайна отдаёт только «createComputePipeline
   * failed» без строки и без сообщений компиляции, поэтому виновную
   * конструкцию приходится искать перебором. Каждый вариант добавляет ровно
   * одну вещь к предыдущему.
   */
  const tryShader = async (device, code) => {
    device.pushErrorScope('validation');

    try {
      const module = device.createShaderModule({ code });
      device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      });
    } catch (e) {
      await device.popErrorScope();
      return 'исключение: ' + (e?.message || e);
    }

    const scoped = await device.popErrorScope();
    return scoped ? 'отказ: ' + scoped.message : 'ok';
  };

  const VARIANTS = {
    base: `
@group(0) @binding(0) var<storage, read_write> out: array<vec4<f32>>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  out[gid.x] = vec4<f32>(1.0);
}`,
    alias: `
alias V = vec4<f32>;
@group(0) @binding(0) var<storage, read_write> out: array<V>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  out[gid.x] = V(1.0);
}`,
    builtins: `
@group(0) @binding(0) var<storage, read_write> out: array<vec4<f32>>;
@compute @workgroup_size(8, 8, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
) {
  out[wg.x + lid.x + li] = vec4<f32>(1.0);
}`,
    workgroupArray: `
@group(0) @binding(0) var<storage, read_write> out: array<vec4<f32>>;
var<workgroup> tile: array<vec4<f32>, 600>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(local_invocation_index) li: u32) {
  tile[li] = vec4<f32>(1.0);
  workgroupBarrier();
  out[li] = tile[li];
}`,
    dynamicVectorWrite: `
@group(0) @binding(0) var<storage, read_write> out: array<vec4<f32>>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(local_invocation_index) li: u32) {
  var v = vec4<f32>(0.0);
  for (var i = 0u; i < 4u; i = i + 1u) {
    v[i] = f32(i);
  }
  out[li] = v;
}`,
    uniformStruct: `
struct Dims { width: u32, height: u32 }
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read_write> out: array<vec4<f32>>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(local_invocation_index) li: u32) {
  out[li] = vec4<f32>(f32(dims.width), f32(dims.height), 0.0, 0.0);
}`,
    f16Store: `
enable f16;
@group(0) @binding(0) var<storage, read_write> out: array<vec4<f16>>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(local_invocation_index) li: u32) {
  out[li] = vec4<f16>(1.0);
}`,
    f16Dot: `
enable f16;
@group(0) @binding(0) var<storage, read_write> out: array<vec4<f16>>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(local_invocation_index) li: u32) {
  var acc: f16 = f16(0.0);
  acc = acc + dot(out[li], out[li + 1u]);
  out[li] = vec4<f16>(acc);
}`,
    f16WorkgroupArray: `
enable f16;
@group(0) @binding(0) var<storage, read_write> out: array<vec4<f16>>;
var<workgroup> tile: array<vec4<f16>, 600>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(local_invocation_index) li: u32) {
  tile[li] = vec4<f16>(1.0);
  workgroupBarrier();
  out[li] = tile[li];
}`,
    f16DynamicVectorWrite: `
enable f16;
@group(0) @binding(0) var<storage, read_write> out: array<vec4<f16>>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(local_invocation_index) li: u32) {
  var v = vec4<f16>(0.0);
  for (var i = 0u; i < 4u; i = i + 1u) {
    v[i] = f16(i);
  }
  out[li] = v;
}`,
  };

  /**
   * Одно устройство на адаптер. Повторный requestDevice у того же адаптера
   * отдаёт **уже потерянное** устройство: исключения нет, создание буферов
   * проходит, а любой пайплайн падает с «createComputePipeline failed» или
   * «device or descriptor is not valid». Отлаживать это как ошибку в шейдере
   * можно очень долго — поэтому каждый раз берём адаптер заново.
   */
  const newDevice = async (fp16, limits) => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('requestAdapter вернул null');
    }

    const descriptor = {};
    if (fp16) {
      descriptor.requiredFeatures = ['shader-f16'];
    }

    // Устройство без requiredLimits получает **дефолтные** лимиты спеки, а не
    // максимумы адаптера: adapter.limits показывал 32768 общей памяти на
    // группу, а устройство молча давало 16384, и блочное ядро не проходило
    // валидацию. Просим ровно то, что отдаёт адаптер.
    if (limits) {
      const wanted = {};
      for (const name of limits) {
        const value = adapter.limits?.[name];
        if (typeof value === 'number') {
          wanted[name] = value;
        }
      }
      descriptor.requiredLimits = wanted;
    }

    return adapter.requestDevice(descriptor);
  };

  /**
   * Сначала выясняем, работает ли compute вообще: если падает пустое ядро без
   * единой привязки, виноват не шейдер, а вебвью.
   */
  const sanity = async (device) => {
    const out = {
      hasCreateComputePipeline: typeof device.createComputePipeline === 'function',
      hasComputePass: false,
    };

    const empty = '@compute @workgroup_size(1) fn main() {}';

    out.emptyAuto = await tryShader(device, empty);

    // Отдельно с явным layout: у части реализаций 'auto' для compute не
    // реализован, хотя для render работает.
    device.pushErrorScope('validation');
    try {
      const layout = device.createPipelineLayout({ bindGroupLayouts: [] });
      const module = device.createShaderModule({ code: empty });
      device.createComputePipeline({ layout, compute: { module, entryPoint: 'main' } });
      const scoped = await device.popErrorScope();
      out.emptyExplicit = scoped ? 'отказ: ' + scoped.message : 'ok';
    } catch (e) {
      await device.popErrorScope();
      out.emptyExplicit = 'исключение: ' + (e?.message || e);
    }

    // Без entryPoint: он необязателен, когда точка входа одна.
    device.pushErrorScope('validation');
    try {
      const module = device.createShaderModule({ code: empty });
      device.createComputePipeline({ layout: 'auto', compute: { module } });
      const scoped = await device.popErrorScope();
      out.emptyNoEntry = scoped ? 'отказ: ' + scoped.message : 'ok';
    } catch (e) {
      await device.popErrorScope();
      out.emptyNoEntry = 'исключение: ' + (e?.message || e);
    }

    // Тот же пустой шейдер, но как рендер-пайплайн: Anime4K живёт на них, и
    // если рендер проходит, а compute нет — это приговор именно compute.
    device.pushErrorScope('validation');
    try {
      const module = device.createShaderModule({
        code: `
@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }`,
      });
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      });
      const scoped = await device.popErrorScope();
      out.renderAuto = scoped ? 'отказ: ' + scoped.message : 'ok';
    } catch (e) {
      await device.popErrorScope();
      out.renderAuto = 'исключение: ' + (e?.message || e);
    }

    try {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.end();
      encoder.finish();
      out.hasComputePass = true;
    } catch (e) {
      out.hasComputePass = 'исключение: ' + (e?.message || e);
    }

    return out;
  };

  const triage = async (f16ok) => {
    const out = {};

    out.__sanity = await sanity(await newDevice(false));

    for (const [name, code] of Object.entries(VARIANTS)) {
      const needsF16 = code.includes('enable f16');
      if (needsF16 && !f16ok) {
        out[name] = 'пропущен';
        continue;
      }

      const device = await newDevice(needsF16);
      out[name] = await tryShader(device, code);
      device.destroy();
    }

    const plain = await newDevice(false);
    out.full32 = await tryShader(plain, source(false));
    plain.destroy();

    if (f16ok) {
      const device = await newDevice(true);
      out.full16 = await tryShader(device, source(true));
      device.destroy();
    }

    return out;
  };

  /**
   * Тот же слой, но с двумя приёмами, без которых свёртка упирается не в
   * счёт, а в память:
   *
   * 1. **Веса лежат в общей памяти группы**, а не читаются из глобальной на
   *    каждый пиксель. Их всего 1296 vec4 (10 КБ) — грузятся один раз на
   *    рабочую группу.
   * 2. **Один поток считает блок 2×2 пикселя.** Загруженный вес сразу идёт в
   *    четыре накопления, и обращений к памяти на MAC становится вчетверо
   *    меньше.
   *
   * Только fp16: в fp32 тайл с весами не влезает в 32 КБ общей памяти.
   */
  const sourceBlocked = () => `
enable f16;
alias V = vec4<f16>;

const F4: u32 = ${F4}u;
const FEAT: u32 = ${FEAT}u;
const BX: u32 = ${TILE * 2}u;
const BY: u32 = ${TILE * 2}u;
const HX: u32 = ${TILE * 2 + 2}u;
const HY: u32 = ${TILE * 2 + 2}u;

struct Dims { width: u32, height: u32 }

@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> src: array<V>;
@group(0) @binding(2) var<storage, read_write> dst: array<V>;
@group(0) @binding(3) var<storage, read> wts: array<V>;

var<workgroup> tile: array<V, ${(TILE * 2 + 2) * (TILE * 2 + 2) * F4}>;
var<workgroup> wt: array<V, ${FEAT * TAPS * F4}>;

@compute @workgroup_size(${TILE}, ${TILE}, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
) {
  let baseX = i32(wg.x * BX) - 1;
  let baseY = i32(wg.y * BY) - 1;

  for (var i = li; i < HX * HY; i = i + ${TILE * TILE}u) {
    let gx = u32(clamp(baseX + i32(i % HX), 0, i32(dims.width) - 1));
    let gy = u32(clamp(baseY + i32(i / HX), 0, i32(dims.height) - 1));
    let s = (gy * dims.width + gx) * F4;
    let d = i * F4;
    for (var g = 0u; g < F4; g = g + 1u) {
      tile[d + g] = src[s + g];
    }
  }

  for (var i = li; i < FEAT * 9u * F4; i = i + ${TILE * TILE}u) {
    wt[i] = wts[i];
  }

  workgroupBarrier();

  let lx = lid.x * 2u;
  let ly = lid.y * 2u;
  let px = wg.x * BX + lx;
  let py = wg.y * BY + ly;

  for (var og = 0u; og < F4; og = og + 1u) {
    var p0 = V(0.0);
    var p1 = V(0.0);
    var p2 = V(0.0);
    var p3 = V(0.0);

    for (var sub = 0u; sub < 4u; sub = sub + 1u) {
      var a0: f16 = f16(0.0);
      var a1: f16 = f16(0.0);
      var a2: f16 = f16(0.0);
      var a3: f16 = f16(0.0);

      let wo = ((og * 4u + sub) * 9u) * F4;

      for (var tap = 0u; tap < 9u; tap = tap + 1u) {
        // Левый верхний из четырёх; остальные три — сдвиги на пиксель
        // вправо, вниз и по диагонали, поэтому индексы считаются один раз.
        let b0 = ((ly + tap / 3u) * HX + (lx + tap % 3u)) * F4;
        let b1 = b0 + F4;
        let b2 = b0 + HX * F4;
        let b3 = b2 + F4;
        let wb = wo + tap * F4;

        for (var g = 0u; g < F4; g = g + 1u) {
          let w = wt[wb + g];
          a0 = a0 + dot(w, tile[b0 + g]);
          a1 = a1 + dot(w, tile[b1 + g]);
          a2 = a2 + dot(w, tile[b2 + g]);
          a3 = a3 + dot(w, tile[b3 + g]);
        }
      }

      p0[sub] = a0;
      p1[sub] = a1;
      p2[sub] = a2;
      p3[sub] = a3;
    }

    if (px < dims.width && py < dims.height) {
      dst[(py * dims.width + px) * F4 + og] = p0;
    }
    if (px + 1u < dims.width && py < dims.height) {
      dst[(py * dims.width + px + 1u) * F4 + og] = p1;
    }
    if (px < dims.width && py + 1u < dims.height) {
      dst[((py + 1u) * dims.width + px) * F4 + og] = p2;
    }
    if (px + 1u < dims.width && py + 1u < dims.height) {
      dst[((py + 1u) * dims.width + px + 1u) * F4 + og] = p3;
    }
  }
}
`;

  /**
   * Наивное ядро делало две вещи, за которые платят дорого:
   *
   * 1. **Динамическая запись в компонент вектора** (`accv[sub] = acc`).
   *    Формально законна, триаж её принимает, но компилятор на такой индекс
   *    перестаёт держать вектор в регистрах и уводит его в память.
   * 2. **Перечитывание активаций.** Отсчёт `tile[p + g]` читался заново для
   *    каждого из четырёх выходных каналов группы.
   *
   * Здесь четыре канала группы считаются одновременно четырьмя именованными
   * накопителями, активация читается один раз на четыре умножения, а vec4
   * собирается конструктором.
   */
  const sourceFast = (fp16) => `
${fp16 ? 'enable f16;' : ''}
alias S = ${fp16 ? 'f16' : 'f32'};
alias V = vec4<${fp16 ? 'f16' : 'f32'}>;

const F4: u32 = ${F4}u;
const TILE: u32 = ${TILE}u;
const HALO: u32 = ${HALO}u;

struct Dims { width: u32, height: u32 }

@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> src: array<V>;
@group(0) @binding(2) var<storage, read_write> dst: array<V>;
@group(0) @binding(3) var<storage, read> wts: array<V>;

var<workgroup> tile: array<V, ${HALO * HALO * F4}>;

@compute @workgroup_size(${TILE}, ${TILE}, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
) {
  let baseX = i32(wg.x * TILE) - 1;
  let baseY = i32(wg.y * TILE) - 1;

  for (var i = li; i < HALO * HALO; i = i + ${TILE * TILE}u) {
    let gx = u32(clamp(baseX + i32(i % HALO), 0, i32(dims.width) - 1));
    let gy = u32(clamp(baseY + i32(i / HALO), 0, i32(dims.height) - 1));
    let s = (gy * dims.width + gx) * F4;
    let d = i * F4;
    for (var g = 0u; g < F4; g = g + 1u) {
      tile[d + g] = src[s + g];
    }
  }

  workgroupBarrier();

  let ox = wg.x * TILE + lid.x;
  let oy = wg.y * TILE + lid.y;
  if (ox >= dims.width || oy >= dims.height) {
    return;
  }

  let outBase = (oy * dims.width + ox) * F4;

  for (var og = 0u; og < F4; og = og + 1u) {
    var a0: S = S(0.0);
    var a1: S = S(0.0);
    var a2: S = S(0.0);
    var a3: S = S(0.0);

    let w0 = ((og * 4u + 0u) * 9u) * F4;
    let w1 = ((og * 4u + 1u) * 9u) * F4;
    let w2 = ((og * 4u + 2u) * 9u) * F4;
    let w3 = ((og * 4u + 3u) * 9u) * F4;

    for (var tap = 0u; tap < 9u; tap = tap + 1u) {
      let p = ((lid.y + tap / 3u) * HALO + (lid.x + tap % 3u)) * F4;
      let t = tap * F4;

      for (var g = 0u; g < F4; g = g + 1u) {
        // Активация читается один раз и идёт сразу в четыре накопления.
        let x = tile[p + g];
        a0 = a0 + dot(wts[w0 + t + g], x);
        a1 = a1 + dot(wts[w1 + t + g], x);
        a2 = a2 + dot(wts[w2 + t + g], x);
        a3 = a3 + dot(wts[w3 + t + g], x);
      }
    }

    dst[outBase + og] = V(a0, a1, a2, a3);
  }
}
`;

  /**
   * Полоса по горизонтали: один поток считает PX соседних пикселей.
   *
   * Бьём по тому, что бенч назвал узким местом — чтению весов. Загруженный
   * вес идёт сразу в PX накоплений, и обращений за весами на пиксель
   * становится в PX раз меньше. Общей памяти нет вовсе: на Apple GPU она
   * оказалась дефицитом, режущим заполняемость, а перекрытие окон 3×3 у
   * соседних потоков и так ложится в кэш.
   *
   * Накопителей 4 × PX: четыре выходных канала группы на каждый пиксель.
   * Имена разворачиваются генератором — массив с динамическим индексом
   * компилятор увёл бы в память, чего мы как раз избегаем.
   */
  const sourceStrip = (fp16, PX) => {
    const decl = [];
    const madd = [];
    const cols = [];
    const xload = [];
    const wload = [];
    const store = [];

    for (let j = 0; j < 4; j += 1) {
      wload.push(`        let w${j} = wts[wb${j} + g];`);
    }

    for (let i = 0; i < PX; i += 1) {
      cols.push(
        `      let c${i} = u32(clamp(i32(px0) + ${i} + kx - 1, 0, i32(dims.width) - 1));`
      );
      xload.push(`        let x${i} = src[(row + c${i}) * F4 + g];`);
      store.push(
        `    if (px0 + ${i}u < dims.width) {\n` +
        `      dst[(py * dims.width + px0 + ${i}u) * F4 + og] =\n` +
        `        V(a0${i}, a1${i}, a2${i}, a3${i});\n` +
        `    }`
      );
    }

    for (let j = 0; j < 4; j += 1) {
      for (let i = 0; i < PX; i += 1) {
        decl.push(`    var a${j}${i}: S = S(0.0);`);
        madd.push(`        a${j}${i} = a${j}${i} + dot(w${j}, x${i});`);
      }
    }

    return `
${fp16 ? 'enable f16;' : ''}
alias S = ${fp16 ? 'f16' : 'f32'};
alias V = vec4<${fp16 ? 'f16' : 'f32'}>;

const F4: u32 = ${F4}u;

struct Dims { width: u32, height: u32 }

@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> src: array<V>;
@group(0) @binding(2) var<storage, read_write> dst: array<V>;
@group(0) @binding(3) var<storage, read> wts: array<V>;

@compute @workgroup_size(${TILE}, ${TILE}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let px0 = gid.x * ${PX}u;
  let py = gid.y;

  if (py >= dims.height || px0 >= dims.width) {
    return;
  }

  for (var og = 0u; og < F4; og = og + 1u) {
${decl.join('\n')}

    for (var tap = 0u; tap < 9u; tap = tap + 1u) {
      let sy = u32(clamp(i32(py) + i32(tap / 3u) - 1, 0, i32(dims.height) - 1));
      let row = sy * dims.width;
      let kx = i32(tap % 3u);
${cols.join('\n')}
      let wb0 = ((og * 4u + 0u) * 9u + tap) * F4;
      let wb1 = ((og * 4u + 1u) * 9u + tap) * F4;
      let wb2 = ((og * 4u + 2u) * 9u + tap) * F4;
      let wb3 = ((og * 4u + 3u) * 9u + tap) * F4;

      for (var g = 0u; g < F4; g = g + 1u) {
${xload.join('\n')}
${wload.join('\n')}
${madd.join('\n')}
      }
    }

${store.join('\n')}
  }
}
`;
  };

  /**
   * Активация читается один раз на все 24 выходных канала.
   *
   * Полосы показали, что узкое место не веса: PX-блокировка, которая режет
   * обращения за весами вчетверо, только ухудшила дело — упёрлись в регистры.
   * Зато `fast` с тайлом в общей памяти обошёл прямое чтение из глобальной
   * втрое. Значит платим за активации, и платим шесть раз: в `fast` цикл по
   * группам выходных каналов внешний, и один и тот же `tile[p + g]` читается
   * заново для каждой из шести групп.
   *
   * Здесь цикл по выходным каналам развёрнут внутрь: `x` читается один раз и
   * уходит в 24 накопления. Обращений к тайлу на пиксель становится 54 вместо
   * 324. Накопителей 24 — это много, но они скалярные и именованные.
   *
   * `inWorkgroup` дополнительно кладёт веса в общую память: 10368 байт плюс
   * 4800 под тайл, вместе 15 КБ — против 25.9 КБ у блочного ядра, которое на
   * этом и погорело.
   */
  const sourceFused = (fp16, inWorkgroup, PX) => {
    const decl = [];
    const wo = [];
    const madd = [];
    const store = [];
    const table = inWorkgroup ? 'wt' : 'wts';

    const xload = [];
    for (let i = 0; i < PX; i += 1) {
      xload.push(`      let x${i} = tile[p + ${i}u * F4 + g];`);
    }

    for (let o = 0; o < FEAT; o += 1) {
      wo.push(`    let wo${o} = (${o}u * 9u + tap) * F4;`);
      // Вес читается один раз и уходит во все PX пикселей: это и есть
      // единственный доступный способ переиспользовать веса.
      madd.push(`      let w${o} = ${table}[wo${o} + g];`);
      for (let i = 0; i < PX; i += 1) {
        decl.push(`  var a${o}_${i}: S = S(0.0);`);
        madd.push(`      a${o}_${i} = a${o}_${i} + dot(w${o}, x${i});`);
      }
    }

    for (let i = 0; i < PX; i += 1) {
      store.push(`  if (ox + ${i}u < dims.width) {`);
      for (let og = 0; og < F4; og += 1) {
        const c = [0, 1, 2, 3].map((k) => `a${og * 4 + k}_${i}`).join(', ');
        store.push(`    dst[(oy * dims.width + ox + ${i}u) * F4 + ${og}u] = V(${c});`);
      }
      store.push('  }');
    }

    return `
${fp16 ? 'enable f16;' : ''}
alias S = ${fp16 ? 'f16' : 'f32'};
alias V = vec4<${fp16 ? 'f16' : 'f32'}>;

const F4: u32 = ${F4}u;
const TILE: u32 = ${TILE}u;
const HX: u32 = ${TILE * PX + 2}u;
const HY: u32 = ${TILE + 2}u;

struct Dims { width: u32, height: u32 }

@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> src: array<V>;
@group(0) @binding(2) var<storage, read_write> dst: array<V>;
@group(0) @binding(3) var<storage, read> wts: array<V>;

var<workgroup> tile: array<V, ${(TILE * PX + 2) * (TILE + 2) * F4}>;
${inWorkgroup ? `var<workgroup> wt: array<V, ${FEAT * TAPS * F4}>;` : ''}

@compute @workgroup_size(${TILE}, ${TILE}, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
) {
  let baseX = i32(wg.x * TILE * ${PX}u) - 1;
  let baseY = i32(wg.y * TILE) - 1;

  for (var i = li; i < HX * HY; i = i + ${TILE * TILE}u) {
    let gx = u32(clamp(baseX + i32(i % HX), 0, i32(dims.width) - 1));
    let gy = u32(clamp(baseY + i32(i / HX), 0, i32(dims.height) - 1));
    let s = (gy * dims.width + gx) * F4;
    let d = i * F4;
    for (var g = 0u; g < F4; g = g + 1u) {
      tile[d + g] = src[s + g];
    }
  }
${inWorkgroup ? `
  for (var i = li; i < ${FEAT * TAPS * F4}u; i = i + ${TILE * TILE}u) {
    wt[i] = wts[i];
  }` : ''}

  workgroupBarrier();

  let ox = (wg.x * TILE + lid.x) * ${PX}u;
  let oy = wg.y * TILE + lid.y;
  if (ox >= dims.width || oy >= dims.height) {
    return;
  }

${decl.join('\n')}

  for (var tap = 0u; tap < 9u; tap = tap + 1u) {
    let p = ((lid.y + tap / 3u) * HX + (lid.x * ${PX}u + tap % 3u)) * F4;
${wo.join('\n')}

    for (var g = 0u; g < F4; g = g + 1u) {
${xload.join('\n')}
${madd.join('\n')}
    }
  }

${store.join('\n')}
}
`;
  };

  /**
   * Дождаться, пока GPU реально досчитает. Без этого замеряется время
   * постановки в очередь, а не работы: submit возвращается сразу.
   */
  const sync = async (device, staging, from) => {
    if (typeof device.queue.onSubmittedWorkDone === 'function') {
      await device.queue.onSubmittedWorkDone();
      return;
    }

    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(from, 0, staging, 0, 256);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    staging.unmap();
  };

  const bench = async (fp16, code, bx, by) => {
    const result = { precision: fp16 ? 'fp16' : 'fp32', block: `${bx}x${by}` };
    let device = null;

    try {
      device = await newDevice(fp16, ['maxComputeWorkgroupStorageSize', 'maxStorageBufferBindingSize', 'maxBufferSize']);
    } catch (e) {
      return { ...result, error: 'requestDevice: ' + e };
    }

    // Ошибки WebGPU асинхронные: без подписки битый шейдер выглядит как
    // подозрительно быстрый бенч.
    let uncaptured = null;
    device.addEventListener('uncapturederror', (event) => {
      uncaptured = String(event.error.message);
    });

    try {
      result.workgroupStorage = device.limits.maxComputeWorkgroupStorageSize;
      const stride = fp16 ? 8 : 16; // байт на vec4
      const size = WIDTH * HEIGHT * F4 * stride;
      const limit = device.limits.maxStorageBufferBindingSize;

      if (size > limit) {
        return { ...result, error: `буфер ${size} > лимита ${limit}` };
      }

      const module = device.createShaderModule({ code });

      if (typeof module.getCompilationInfo === 'function') {
        const info = await module.getCompilationInfo();
        // Берём все сообщения, а не только type === 'error': у части
        // реализаций разбор молчит, а падает уже createComputePipeline.
        if (info.messages.length > 0) {
          result.shaderMessages = info.messages
            .map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`)
            .slice(0, 4);
        }
      }

      // getCompilationInfo на этом вебвью возвращает пустой список даже когда
      // пайплайн не проходит валидацию, поэтому текст берём из error scope:
      // GPUPipelineError отдаёт только reason.
      device.pushErrorScope('validation');
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      });
      const scoped = await device.popErrorScope();

      if (scoped) {
        return { ...result, error: 'валидация: ' + scoped.message };
      }

      const src = device.createBuffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const dst = device.createBuffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const wts = device.createBuffer({
        size: FEAT * TAPS * F4 * stride,
        usage: GPUBufferUsage.STORAGE,
      });
      const dims = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const staging = device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      device.queue.writeBuffer(dims, 0, new Uint32Array([WIDTH, HEIGHT, 0, 0]));

      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: dims } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: dst } },
          { binding: 3, resource: { buffer: wts } },
        ],
      });

      const groupsX = Math.ceil(WIDTH / (TILE * bx));
      const groupsY = Math.ceil(HEIGHT / (TILE * by));

      const run = (times) => {
        // Все проходы одним энкодером: иначе меряется ещё и накладная
        // стоимость submit, а она к свёртке отношения не имеет.
        const encoder = device.createCommandEncoder();
        for (let i = 0; i < times; i += 1) {
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bind);
          pass.dispatchWorkgroups(groupsX, groupsY);
          pass.end();
        }
        device.queue.submit([encoder.finish()]);
      };

      run(WARMUP);
      await sync(device, staging, dst);

      const started = performance.now();
      run(ITERS);
      await sync(device, staging, dst);
      const elapsed = performance.now() - started;

      if (uncaptured) {
        return { ...result, error: 'GPU: ' + uncaptured };
      }

      // Умножений с накоплением на пиксель: каждый из 24 выходных каналов
      // собирается из 24 входных по девяти отсчётам ядра.
      const macPerPixel = FEAT * FEAT * TAPS;
      const flops = WIDTH * HEIGHT * macPerPixel * 2 * ITERS;
      const perLayerMs = elapsed / ITERS;

      return {
        ...result,
        layerMs: Number(perLayerMs.toFixed(3)),
        tflops: Number((flops / (elapsed / 1000) / 1e12).toFixed(2)),
        // Вся сеть — десять слоёв: conv_first, восемь в теле и conv_last.
        // Первый и последний дешевле, поэтому это оценка сверху.
        netMsEstimate: Number((perLayerMs * 10).toFixed(2)),
      };
    } catch (e) {
      // GPUPipelineError в String() даёт только имя класса; текст лежит в
      // message, причина — в reason.
      const detail = [e?.name, e?.reason, e?.message].filter(Boolean).join(' / ');
      return { ...result, error: detail || String(e) };
    } finally {
      device?.destroy();
    }
  };

  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info || {};
        const limits = adapter.limits || {};

        report.adapter = {
          vendor: info.vendor || '?',
          architecture: info.architecture || '?',
          maxTextureDimension2D: limits.maxTextureDimension2D ?? null,
        };

        report.features = [...(adapter.features || [])].sort();

        report.computeLimits = {
          shaderF16: !!adapter.features?.has('shader-f16'),
          timestampQuery: !!adapter.features?.has('timestamp-query'),
          maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize ?? null,
          maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup ?? null,
          maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX ?? null,
          maxComputeWorkgroupSizeY: limits.maxComputeWorkgroupSizeY ?? null,
          maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize ?? null,
          maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage ?? null,
          maxBufferSize: limits.maxBufferSize ?? null,
        };

        // Наличие фичи у адаптера и успешное создание устройства с ней —
        // разные вещи, и для плана важна вторая.
        try {
          const probe = await newDevice(true);
          report.f16Device = true;
          probe.destroy();
        } catch (e) {
          report.f16Device = 'отказ: ' + e;
        }

        publish();

        report.triage = await triage(report.f16Device === true);
        publish();

        report.bench = {
          frame: `${WIDTH}x${HEIGHT}`,
          layer: `conv3x3 ${FEAT}->${FEAT}`,
          iters: ITERS,
          // Наивное ядро — нижняя граница: веса читаются из глобальной
          // памяти на каждый пиксель. Блочное показывает, сколько даёт
          // оптимизация, ради которой и затевается Э18.
          fp16naive: report.f16Device === true ? await bench(true, source(true), 1, 1) : 'пропущен',
          fp16fast:
            report.f16Device === true ? await bench(true, sourceFast(true), 1, 1) : 'пропущен',
          // Полоса: PX пикселей на поток. Ряд 1-2-4 показывает, сколько даёт
          // именно переиспользование весов, отдельно от всего остального.
          fp16strip4:
            report.f16Device === true ? await bench(true, sourceStrip(true, 4), 4, 1) : 'пропущен',
          fp16fused:
            report.f16Device === true ? await bench(true, sourceFused(true, false, 1), 1, 1) : 'пропущен',
          fp16fused2:
            report.f16Device === true ? await bench(true, sourceFused(true, false, 2), 2, 1) : 'пропущен',
        };
      } else {
        report.adapter = 'requestAdapter вернул null';
      }
    } catch (e) {
      report.adapter = 'ошибка: ' + e;
    }
  }

  report.done = true;

  // Скрипт выполняется в начале документа, и разобранный далее <title>
  // страницы затирает наш. Поэтому публикуем после загрузки и повторяем по
  // кругу, пока Rust не соберёт все куски и не выйдет сам.
  publish();
})();
"#;

/// Разбирает `<index>/<total>:<кусок>` из заголовка.
fn parse_chunk(payload: &str) -> Option<(usize, usize, String)> {
    let (header, body) = payload.split_once(':')?;
    let (index, total) = header.split_once('/')?;
    Some((index.parse().ok()?, total.parse().ok()?, body.to_string()))
}

fn main() {
    // Куски приезжают вразнобой и повторяются по кругу, поэтому складываем их
    // по индексу и ждём, пока наберётся полный комплект.
    let mailbox: Arc<Mutex<BTreeMap<usize, String>>> = Arc::new(Mutex::new(BTreeMap::new()));
    let expected: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));

    let sink = mailbox.clone();
    let sink_total = expected.clone();

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
                let Some(payload) = title.strip_prefix("__PROBE__") else {
                    return;
                };

                let Some((index, total, body)) = parse_chunk(payload) else {
                    return;
                };

                let mut parts = sink.lock().unwrap();
                let mut known = sink_total.lock().unwrap();

                // Отчёт дописывается по ходу дела, и с каждым новым полем
                // кусков становится больше. Смена их числа означает, что
                // прежние собраны от старой версии и годятся только на выброс.
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
                // Минута, а не десять секунд: микробенч компилирует шейдеры и
                // гоняет две сотни проходов свёртки.
                for _ in 0..600 {
                    {
                        let parts = waiting.lock().unwrap();
                        let total = *waiting_total.lock().unwrap();

                        if total > 0 && parts.len() == total {
                            let json: String = parts.values().cloned().collect();

                            // Полный комплект кусков ещё не значит законченный
                            // отчёт: ранние публикации тоже собираются целиком.
                            if json.contains("\"done\":true") {
                                println!("{json}");
                                handle.exit(0);
                                return;
                            }
                        }
                    }

                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }

                let parts = waiting.lock().unwrap();
                let total = *waiting_total.lock().unwrap();

                if total > 0 && parts.len() == total {
                    eprintln!("вебвью не дошёл до конца за минуту, отчёт неполный:");
                    println!("{}", parts.values().cloned().collect::<String>());
                } else {
                    eprintln!(
                        "вебвью не отчитался за минуту (собрано {} из {total} кусков)",
                        parts.len()
                    );
                }

                handle.exit(1);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить пробник");
}

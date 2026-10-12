import type { Anime4KPipeline } from 'anime4k-webgpu';

/**
 * Апскейл кадра через Anime4K на WebGPU.
 *
 * Зачем свой цикл, а не `render()` из библиотеки: тот возвращает `Promise<void>`
 * и не даёт ручки для остановки — привязанный им цикл живёт до конца страницы.
 * Для переключаемой настройки это утечка: каждое включение вешало бы ещё один
 * цикл поверх прежнего, а смена серии или качества оставляла бы мёртвые.
 *
 * Проверено пробником `src-tauri/examples/gpu_probe.rs` на WKWebView macOS:
 * `navigator.gpu` есть, адаптер `apple`, `requestVideoFrameCallback` есть.
 * На Linux (WebKitGTK) WebGPU может отсутствовать — отсюда проверка поддержки
 * и режим «Выключен» по умолчанию.
 *
 * Пресеты — из форка HeilungZeit/anionWebGPU, общего с фронтом `anion`.
 * «Детали» (`compact`) идут на его ядре: собственный WGSL-рендерер anion-dl
 * переехал туда и там дальше ускорен и дообучен.
 */

/**
 * Только то, что тянет реальное время на обычной машине.
 *
 * Тяжёлые варианты (CNNx2UL, GANUUL, GANx3L) проверялись и убраны: на среднем
 * железе они не успевают за кадрами. Их место — офлайн-улучшение уже
 * скачанного файла, где время не ограничено.
 *
 * `b`/`bb` убраны по другой причине: они восстанавливают замыленный источник, а
 * у Kodik картинка не замылена, а пережата — эти режимы её только размазывали.
 */
export const UPSCALE_MODES = ['off', 'c', 'ca', 'compact'] as const;

export type UpscaleMode = (typeof UPSCALE_MODES)[number];

type ShaderMode = Exclude<UpscaleMode, 'off'>;

export interface UpscaleLabel {
  /** Коротко — и в пункте меню, и на кнопке. */
  title: string;
  /** Что пользователь получит и чем заплатит — без терминов Anime4K. */
  hint: string;
}

export const UPSCALE_LABELS: Record<UpscaleMode, UpscaleLabel> = {
  off: { title: 'Выключено', hint: 'Картинка как есть' },
  c: {
    title: 'Чёткость',
    hint: 'Повышает резкость, почти не нагружает',
  },
  ca: {
    title: 'Чёткость+',
    hint: 'Ещё и убирает артефакты сжатия, нагрузка чуть выше',
  },
  compact: {
    title: 'Детали',
    hint: 'Дорисовывает детали, а не только режет артефакты. Тяжёлый: на 720p может не успевать',
  },
};

export interface UpscaleHandle {
  /** Останавливает цикл и освобождает ресурсы GPU. */
  destroy(): void;
}

export interface UpscaleOptions {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  mode: Exclude<UpscaleMode, 'off'>;
  onStats?: (stats: UpscaleStats) => void;
  /** Ошибки конвейера асинхронные; без этого они пропадают молча. */
  onError?: (message: string) => void;
  /**
   * Идёт подготовка: загрузка пресета и компиляция шейдеров (в фоне, до
   * секунд на холодном кеше). Пока true, на канве нет готового кадра —
   * показывать обычное видео и сказать, что улучшение готовится.
   */
  onPreparing?: (preparing: boolean) => void;
}

/** Потолок вывода: пресеты Anime4K рассчитаны на двукратное увеличение. */
const MAX_SCALE = 2;

/** Что показать в диагностике: без неё «не работает» не отличить от «работает незаметно». */
export interface UpscaleStats {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  /** Кадров в секунду, которые реально прошли через конвейер. */
  fps: number;
  /**
   * Частота самого видео — по счётчику показанных кадров из
   * `requestVideoFrameCallback`.
   *
   * Без неё «мало кадров» не отличить от «ролик такой»: у Kodik попадается и
   * 23.976, и 30, а сравнивать с константой 24 значит то объявлять просадку
   * там, где её нет, то не замечать настоящую. Счётчик `presentedFrames`
   * растёт по показанным кадрам независимо от того, успел ли наш цикл, —
   * поэтому разрыв между ним и `fps` и есть мера отставания.
   */
  videoFps: number;
}

export function isWebGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

const BLIT_WGSL = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  // Один треугольник на весь экран дешевле двух: меньше вершин и нет шва.
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let corner = corners[index];

  var out: VertexOut;
  out.position = vec4f(corner, 0.0, 1.0);
  out.uv = vec2f((corner.x + 1.0) * 0.5, 1.0 - (corner.y + 1.0) * 0.5);
  return out;
}

@group(0) @binding(0) var frameSampler: sampler;
@group(0) @binding(1) var frameTexture: texture_2d<f32>;

// Упорядоченный дизеринг (Байер 4×4, ±0.5/255): кадр после конвейера точнее
// 8 бит канвы, и без шума на плавных градиентах (небо, тени) видны полосы.
const BAYER = array<f32, 16>(0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let color = textureSample(frameTexture, frameSampler, in.uv);
  let cell = vec2u(in.position.xy) % 4u;
  let noise = (BAYER[cell.y * 4u + cell.x] + 0.5) / 16.0 - 0.5;
  return vec4f(color.rgb + noise / 255.0, color.a);
}
`;

/**
 * Пресеты подгружаются на первом включении.
 *
 * Статический импорт тянул шейдеры Anime4K в чанк страницы тайтла, и их
 * разбирал каждый заход на аниме — даже с выключенным апскейлом. У форка
 * на каждый пресет своя точка входа: в чанк режима попадают только его
 * шейдеры, а не все 3,4 МБ пакета. Заодно ушла и разборка UMD-обёртки —
 * точки входа форка обычные ES-модули.
 */
interface BuildContext {
  device: GPUDevice;
  inputTexture: GPUTexture;
  nativeDimensions: { width: number; height: number };
  targetDimensions: { width: number; height: number };
}

/** Собирает пресет режима под размеры кадра. */
type PresetFactory = (ctx: BuildContext) => Anime4KPipeline;

/** Веса «Деталей» — `model.json` + `weights.bin` из `scripts/compact-to-wgsl.py`. */
type CompactModel = ConstructorParameters<
  typeof import('anime4k-webgpu/presets/ModeCompact').ModeCompact
>[0]['model'];

/**
 * Каталог весов «Деталей» в `src/assets/upscale`. `janai-v2-kodik-mix75` —
 * поэлементная смесь 0.75 · `janai-v2` + 0.25 · ink8 (AnimeJaNai V2 SUC,
 * дообученная под порчу Kodik с весом штриха; anionWebGPU, Э11, Э13, Э17):
 * ink8 гасит мошкару x264, но мажет фоновую текстуру — кирпичи, листву;
 * смесь возвращает текстуру почти как у исходной, а шума меньше. Исходная
 * `janai-v2` оставлена для отката. Те же веса — у фронта.
 */
const COMPACT_WEIGHTS = 'janai-v2-kodik-mix75';

/** Веса «Деталей» (~90 КБ) — из ассетов, на первом включении. */
async function loadCompactModel(): Promise<CompactModel> {
  const [metaResponse, weightsResponse] = await Promise.all([
    fetch(`/assets/upscale/${COMPACT_WEIGHTS}/model.json`),
    fetch(`/assets/upscale/${COMPACT_WEIGHTS}/weights.bin`),
  ]);
  if (!metaResponse.ok || !weightsResponse.ok) {
    throw new Error('Не удалось загрузить нейросеть для «Деталей»');
  }
  return {
    meta: (await metaResponse.json()) as CompactModel['meta'],
    weights: await weightsResponse.arrayBuffer(),
  };
}

// Повтор кадра (статичный план) цепочка не считает: на GPU он сравнивается
// с прошлым и пропускается, на канве остаётся прошлый результат. Порог 0 —
// только точные повторы, картинка та же.
//
// После x264 точных повторов почти нет: тот же рисунок отличается шумом
// сжатия до ~16 уровней. «Деталям» — порог 16: пропускается ~25% кадров
// Kodik; затемнения ворота сами не пропускают (средний сдвиг кадра).
// Цвет «Детали» берут не из сети, а из сглаженного кадра (по умолчанию
// пресета): сеть рисовала цветовые блоки сжатия 4:2:0 пятнами.
const COMPACT_UNCHANGED_THRESHOLD = 16;

/**
 * Ядро «Деталей» по движку вебвью. На macOS и Linux это WebKit (WKWebView,
 * WebKitGTK): там Winograd (`wino`) на 12% быстрее `fast`, а в Chromium
 * (WebView2 на Windows) — на 23% медленнее. Разрыв не в нашем коде: WebKit
 * исполняет то же ядро в 1.8 раза медленнее Chrome. Замеры — anionWebGPU,
 * docs/PLAN.md, этап Э18.
 */
function compactKernel(): 'wino' | 'fast' {
  const agent = navigator.userAgent;
  return /AppleWebKit/.test(agent) && !/Chrome|Chromium|Edg\//.test(agent)
    ? 'wino'
    : 'fast';
}

const PRESETS: Record<ShaderMode, () => Promise<PresetFactory>> = {
  c: async () => {
    const { ModeC } = await import('anime4k-webgpu/presets/ModeC');
    return (ctx) => new ModeC({ ...ctx, skipUnchanged: true });
  },
  ca: async () => {
    const { ModeCA } = await import('anime4k-webgpu/presets/ModeCA');
    return (ctx) => new ModeCA({ ...ctx, skipUnchanged: true });
  },
  compact: async () => {
    const [{ ModeCompact }, model] = await Promise.all([
      import('anime4k-webgpu/presets/ModeCompact'),
      loadCompactModel(),
    ]);
    return (ctx) =>
      new ModeCompact({
        ...ctx,
        model,
        kernel: compactKernel(),
        skipUnchanged: true,
        unchangedThreshold: COMPACT_UNCHANGED_THRESHOLD,
      });
  },
};

/**
 * Собирает цепочку конвейеров режима.
 *
 * Два разных вида: пресеты берут исходный и целевой размеры и сами решают,
 * как до него добраться, а одиночные конвейеры увеличивают на фиксированную
 * кратность и о цели ничего не знают. Поэтому размер канвы берётся не из
 * расчёта, а из выходной текстуры последнего звена — он единственный честный.
 */
function buildChain(build: PresetFactory, ctx: BuildContext): Anime4KPipeline[] {
  return [build(ctx)];
}

/**
 * Устройство под режим.
 *
 * Для сети нужны две вещи, которых шейдерам Anime4K не требуется:
 * half-точность (без неё сеть вдвое дороже и не влезает в кадр) и **явные
 * лимиты**. Второе неочевидно: `requestDevice` без `requiredLimits` выдаёт
 * дефолты спеки, а не максимумы адаптера — на этой машине 16 КБ общей памяти
 * на группу вместо 32, и конвейер не проходил валидацию.
 */
async function requestDevice(
  adapter: GPUAdapter,
  needsNetwork: boolean
): Promise<GPUDevice> {
  if (!needsNetwork) {
    return adapter.requestDevice();
  }

  if (!adapter.features.has('shader-f16')) {
    throw new Error('Видеокарта не поддерживает половинную точность в шейдерах');
  }

  const limits = adapter.limits as unknown as Record<string, number | undefined>;
  const wanted: Record<string, number> = {};

  for (const name of [
    'maxStorageBufferBindingSize',
    'maxBufferSize',
    'maxComputeWorkgroupStorageSize',
  ]) {
    const value = limits[name];
    if (typeof value === 'number') {
      wanted[name] = value;
    }
  }

  return adapter.requestDevice({
    requiredFeatures: ['shader-f16'],
    requiredLimits: wanted,
  });
}

/**
 * Запускает апскейл видео в канву. Кадры берутся по
 * `requestVideoFrameCallback`: он привязан к реальным кадрам, поэтому на паузе
 * цикл сам замирает, а на 24 к/с не крутится впустую 60 раз в секунду.
 */
export async function startUpscale({
  video,
  canvas,
  mode,
  onStats,
  onError,
  onPreparing,
}: UpscaleOptions): Promise<UpscaleHandle> {
  if (!isWebGpuAvailable()) {
    throw new Error('WebGPU недоступен в этом вебвью');
  }

  onPreparing?.(true);

  const build = await PRESETS[mode]();

  // На ноутбуках с двумя видеокартами — дискретная: встроенная Mode C
  // на 1080p+ не вытягивает.
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) {
    throw new Error('Видеокарта не отдала адаптер WebGPU');
  }

  const device = await requestDevice(adapter, mode === 'compact');
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Канва не отдала контекст WebGPU');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });

  const module = device.createShaderModule({ code: BLIT_WGSL });
  const blit = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  let frameHandle: number | null = null;
  let idleHandle: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /**
   * Прошлый кадр ещё считается на GPU. Новый тогда пропускается: иначе на
   * слабой видеокарте очередь растёт, картинка отстаёт от звука всё сильнее,
   * а getCurrentTexture блокирует основной поток — тормозит весь интерфейс.
   */
  let inFlight = false;
  /** Шейдеры текущей сборки скомпилированы; до этого кадры не рисуются. */
  let compiled = false;
  /** Номер сборки: ready прошлой сборки после пересборки не в счёт. */
  let buildId = 0;

  const fail = (message: string): void => {
    if (!disposed) {
      disposed = true;
      onError?.(message);
    }
  };

  // Ошибки WebGPU не бросаются в месте вызова, а приходят событием. Без
  // подписки неверный шейдер или битая привязка выглядели бы как «ничего не
  // происходит».
  device.addEventListener('uncapturederror', (event) => {
    fail(`GPU: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });

  void device.lost.then((info) => {
    if (info.reason !== 'destroyed') {
      fail(`Устройство GPU потеряно: ${info.message}`);
    }
  });

  let source: GPUTexture | null = null;
  let pipelines: Anime4KPipeline[] = [];
  let bindGroup: GPUBindGroup | null = null;
  let builtFor = '';
  /** Канва поменяла размер с последней сборки — цель надо пересчитать. */
  let sizeDirty = false;
  /** Кадр, уже лежащий на канве: на паузе его незачем гнать через GPU заново. */
  let drawnKey = '';
  let stats: UpscaleStats | null = null;
  let framesInWindow = 0;
  let windowStartedAt = performance.now();
  let reported = false;
  /** Счётчик показанных кадров на последнем обратном вызове. */
  let presented = 0;
  /** Он же на начало текущего окна измерения; null — окно ещё не началось. */
  let presentedAtWindowStart: number | null = null;

  const release = (): void => {
    source?.destroy();
    source = null;
    pipelines = [];
    bindGroup = null;
  };

  /**
   * Цель — сколько пикселей реально покажет канва, а не абстрактная доля
   * ширины экрана. Считать от screen.width было ошибкой: при небольшом окне
   * конвейер рисовал в текстуру заметно крупнее той, что видна, и лишние
   * пиксели тут же выбрасывались обратной свёрткой браузера.
   */
  const targetFor = (
    width: number,
    height: number
  ): { width: number; height: number } => {
    const shownWidth = Math.round(
      (canvas.clientWidth || width) * (window.devicePixelRatio || 1)
    );

    // Меньше исходника — апскейлить нечего; больше двукратного пресеты не дают.
    const scale = Math.min(MAX_SCALE, Math.max(1, shownWidth / width));
    return {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };
  };

  const rebuild = (width: number, height: number): void => {
    release();

    source = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const targetDimensions = targetFor(width, height);

    pipelines = buildChain(build, {
      device,
      inputTexture: source,
      nativeDimensions: { width, height },
      targetDimensions,
    });

    const output = pipelines[pipelines.length - 1].getOutputTexture();

    // Размер берётся у выходной текстуры, а не у расчётной цели: у цепочек с
    // фиксированной кратностью (x2, x3) он свой, и расчёт про него не знает.
    canvas.width = output.width;
    canvas.height = output.height;

    bindGroup = device.createBindGroup({
      layout: blit.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: output.createView() },
      ],
    });

    // Шейдеры компилируются в фоне; пока не готовы, кадры пропускаются, а
    // канва скрыта — под ней обычное видео.
    compiled = false;
    const id = ++buildId;
    onPreparing?.(true);
    void Promise.all(pipelines.map((pipeline) => pipeline.ready)).then(
      () => {
        if (id === buildId && !disposed) {
          compiled = true;
          onPreparing?.(false);
        }
      },
      (error: unknown) => {
        fail(
          `Шейдеры не скомпилировались: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    );

    builtFor = `${width}x${height}@${targetDimensions.width}x${targetDimensions.height}`;
    sizeDirty = false;
    stats = {
      sourceWidth: width,
      sourceHeight: height,
      targetWidth: output.width,
      targetHeight: output.height,
      fps: 0,
      videoFps: 0,
    };
  };

  const schedule = (): void => {
    if (disposed) {
      return;
    }

    // На паузе новых кадров не приходит, и requestVideoFrameCallback не
    // срабатывает вовсе — именно поэтому включение апскейла на остановленном
    // видео раньше висело в «Запускаю…». Там достаточно редкого опроса, чтобы
    // картинка на канве оставалась верной после перемотки.
    if (video.paused || video.ended) {
      idleHandle = setTimeout(step, 250);
      return;
    }

    frameHandle = video.requestVideoFrameCallback(step);
  };

  const draw = (): void => {
    const width = video.videoWidth;
    const height = video.videoHeight;

    // До первого декодированного кадра копировать нечего: при заходе на
    // страницу видео стоит на паузе с одними метаданными, и канва закрывала
    // бы постер чёрным.
    if (
      width === 0 ||
      height === 0 ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }

    // Пересборка — и при смене качества (текстуры от прошлого разрешения), и
    // при смене размера канвы. Без второго цель навсегда оставалась той, что
    // посчитали на первом кадре: апскейл стартует ещё в обычном окне на
    // странице тайтла, и после разворота на весь экран конвейер продолжал
    // рисовать маленькую картинку, которую браузер растягивал. Лечилось это
    // только выключением и включением режима.
    if (!builtFor.startsWith(`${width}x${height}@`)) {
      rebuild(width, height);
    } else if (sizeDirty) {
      const target = targetFor(width, height);
      sizeDirty = false;
      if (!builtFor.endsWith(`@${target.width}x${target.height}`)) {
        rebuild(width, height);
      }
    }

    if (!source || !stats) {
      return;
    }

    if (pipelines.length === 0 || !bindGroup || !compiled) {
      return;
    }

    // Опрос на паузе срабатывает четыре раза в секунду; тот же кадр в ту же
    // сборку перерисовывать незачем — нужно только после перемотки.
    const frameKey = `${builtFor}#${video.currentTime}`;
    if (video.paused && frameKey === drawnKey) {
      return;
    }

    // Кадр пропускается, а не копится в очередь. drawnKey не трогаем: на
    // паузе следующий опрос дорисует пропущенный кадр.
    if (inFlight) {
      return;
    }
    drawnKey = frameKey;

    device.queue.copyExternalImageToTexture(
      { source: video },
      { texture: source },
      [width, height]
    );

    const encoder = device.createCommandEncoder();

    // Звенья пишутся в один энкодер по порядку: выход предыдущего — вход
    // следующего, связано ещё при сборке цепочки.
    for (const stage of pipelines) {
      stage.pass(encoder);
    }

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(blit);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    device.queue.submit([encoder.finish()]);
    inFlight = true;
    const done = (): void => {
      inFlight = false;
    };
    void device.queue.onSubmittedWorkDone().then(done, done);

    framesInWindow += 1;

    // Первый же кадр отчитывается сразу: иначе «работает» и «умерло молча»
    // выглядят одинаково целую секунду, а при отказе — всегда.
    if (!reported) {
      reported = true;
      onStats?.(stats);
    }

    const now = performance.now();
    const elapsed = now - windowStartedAt;

    if (elapsed >= 1000) {
      // На паузе обратных вызовов нет, счётчик стоит — тогда считаем, что
      // видео идёт ровно столько, сколько мы отрисовали, и просадки нет.
      const shown =
        presentedAtWindowStart === null
          ? framesInWindow
          : presented - presentedAtWindowStart;

      stats = {
        ...stats,
        fps: Math.round((framesInWindow * 1000) / elapsed),
        videoFps: Math.round((Math.max(shown, framesInWindow) * 1000) / elapsed),
      };

      framesInWindow = 0;
      presentedAtWindowStart = presented;
      windowStartedAt = now;
      onStats?.(stats);
    }
  };

  const step = (_now?: number, metadata?: VideoFrameCallbackMetadata): void => {
    if (disposed) {
      return;
    }

    // Опрос на паузе метаданных не приносит — счётчик тогда просто не растёт.
    if (metadata) {
      presented = metadata.presentedFrames;
      presentedAtWindowStart ??= presented;
    }

    try {
      draw();
    } catch (error: unknown) {
      // Исключение внутри кадра раньше обрывало цепочку вызовов: следующий
      // requestVideoFrameCallback просто не выполнялся, и цикл умирал без следа.
      fail(error instanceof Error ? error.message : String(error));
      return;
    }

    schedule();
  };

  // Размер канвы меняют полноэкранный режим и ресайз окна. Пересборка
  // откладывается, пока размер не устоится: анимация разворота дала бы
  // десятки сборок конвейера подряд.
  let resizeHandle: ReturnType<typeof setTimeout> | null = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeHandle !== null) {
      clearTimeout(resizeHandle);
    }

    resizeHandle = setTimeout(() => {
      resizeHandle = null;
      sizeDirty = true;
      // На паузе новый кадр не придёт — перерисовываем под новый размер сразу.
      drawnKey = '';
    }, 200);
  });
  resizeObserver.observe(canvas);

  step();

  return {
    destroy(): void {
      disposed = true;
      resizeObserver.disconnect();

      if (resizeHandle !== null) {
        clearTimeout(resizeHandle);
        resizeHandle = null;
      }

      if (frameHandle !== null) {
        video.cancelVideoFrameCallback(frameHandle);
        frameHandle = null;
      }

      if (idleHandle !== null) {
        clearTimeout(idleHandle);
        idleHandle = null;
      }

      release();
      device.destroy();
    },
  };
}

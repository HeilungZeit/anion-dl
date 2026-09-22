import type { Anime4KPipeline } from 'anime4k-webgpu';

import {
  createCompactRenderer,
  fitsRealtime,
  type CompactHandle,
} from './compact/renderer';

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

/** Режимы на шейдерах Anime4K — в отличие от `compact` со своей сетью. */
type ShaderMode = Extract<UpscaleMode, 'c' | 'ca'>;

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

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(frameTexture, frameSampler, uv);
}
`;

/**
 * Пресеты подгружаются на первом включении.
 *
 * Статический импорт тянул шейдеры Anime4K (около 4 МБ) в чанк страницы
 * тайтла, и их разбирал каждый заход на аниме — даже с выключенным апскейлом.
 */
type PresetModules = typeof import('anime4k-webgpu');

let presets: PresetModules | null = null;

/**
 * Достаёт пресеты из пространства имён пакета.
 *
 * `anime4k-webgpu` собран UMD-обёрткой. Под Node её первая ветка кладёт всё в
 * `module.exports`, и `require(...).ModeA` работает — но в собранном бандле это
 * не так. Проверено чтением выходного чанка:
 *
 *     var chunk_..._default = q0();
 *     export { chunk_..._default as default };
 *
 * То есть наружу уходит **только `default`**, именованных экспортов на
 * пространстве имён нет вовсе — имена из минифицированного UMD статический
 * анализ не вытаскивает. Отсюда `new modules.ModeA(...)` и падало с «undefined
 * is not a constructor».
 *
 * Форма зависит от версии сборщика и выбранной ветки UMD, поэтому разбираем по
 * факту и с внятной ошибкой, если появится четвёртая.
 */
function unwrapPresets(loaded: unknown): PresetModules {
  const shapes: unknown[] = [
    loaded,
    (loaded as { default?: unknown })?.default,
    (loaded as Record<string, unknown> | null)?.['anime4k-webgpu'],
  ];

  for (const shape of shapes) {
    if (typeof (shape as PresetModules | undefined)?.ModeA === 'function') {
      return shape as PresetModules;
    }
  }

  throw new Error(
    'Пакет anime4k-webgpu не отдал пресеты: неожиданная форма UMD-обёртки'
  );
}

async function loadPresets(): Promise<PresetModules> {
  presets ??= unwrapPresets(await import('anime4k-webgpu'));
  return presets;
}

interface BuildContext {
  modules: PresetModules;
  device: GPUDevice;
  inputTexture: GPUTexture;
  nativeDimensions: { width: number; height: number };
  targetDimensions: { width: number; height: number };
}

/**
 * Собирает цепочку конвейеров режима.
 *
 * Два разных вида: пресеты берут исходный и целевой размеры и сами решают,
 * как до него добраться, а одиночные конвейеры увеличивают на фиксированную
 * кратность и о цели ничего не знают. Поэтому размер канвы берётся не из
 * расчёта, а из выходной текстуры последнего звена — он единственный честный.
 */
function buildChain(mode: ShaderMode, ctx: BuildContext): Anime4KPipeline[] {
  const { modules, device, inputTexture, nativeDimensions, targetDimensions } =
    ctx;
  const preset = { device, inputTexture, nativeDimensions, targetDimensions };

  switch (mode) {
    case 'c':
      return [new modules.ModeC(preset)];
    case 'ca':
      return [new modules.ModeCA(preset)];
  }
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
}: UpscaleOptions): Promise<UpscaleHandle> {
  if (!isWebGpuAvailable()) {
    throw new Error('WebGPU недоступен в этом вебвью');
  }

  const network = mode === 'compact';

  // Шейдеры Anime4K весят около 4 МБ и режиму сети не нужны вовсе.
  const modules = network ? null : await loadPresets();

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('Видеокарта не отдала адаптер WebGPU');
  }

  const device = await requestDevice(adapter, network);
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Канва не отдала контекст WebGPU');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  const compact: CompactHandle | null = network
    ? await createCompactRenderer(device, format)
    : null;
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

    if (compact) {
      // Кратность у сети фиксированная, и цель от размера окна не зависит:
      // растянуть готовый кадр дешевле, чем считать сеть на лишние пиксели.
      if (!fitsRealtime(width, height)) {
        throw new Error(
          `Кадр ${width}×${height} слишком велик для этого режима`
        );
      }

      compact.resize(width, height);
      canvas.width = width * compact.scale;
      canvas.height = height * compact.scale;

      builtFor = `${width}x${height}@${canvas.width}x${canvas.height}`;
      sizeDirty = false;
      stats = {
        sourceWidth: width,
        sourceHeight: height,
        targetWidth: canvas.width,
        targetHeight: canvas.height,
        fps: 0,
        videoFps: 0,
      };
      return;
    }

    const targetDimensions = targetFor(width, height);

    pipelines = buildChain(mode as ShaderMode, {
      modules: modules as PresetModules,
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

    // У сети своя цепочка проходов, цепочки Anime4K и привязки блита нет.
    if (!compact && (pipelines.length === 0 || !bindGroup)) {
      return;
    }

    // Опрос на паузе срабатывает четыре раза в секунду; тот же кадр в ту же
    // сборку перерисовывать незачем — нужно только после перемотки.
    const frameKey = `${builtFor}#${video.currentTime}`;
    if (video.paused && frameKey === drawnKey) {
      return;
    }
    drawnKey = frameKey;

    device.queue.copyExternalImageToTexture(
      { source: video },
      { texture: source },
      [width, height]
    );

    const encoder = device.createCommandEncoder();

    if (compact) {
      // Сеть сама доводит кадр до канвы: её выход лежит в буфере, а не в
      // текстуре, и общий блит для него не годится.
      compact.draw(encoder, source, context.getCurrentTexture().createView());
    } else if (bindGroup) {
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
    }

    device.queue.submit([encoder.finish()]);

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
      compact?.destroy();
      device.destroy();
    },
  };
}

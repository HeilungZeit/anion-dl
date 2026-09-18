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
 */

/**
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
export const UPSCALE_MODES = ['off', 'c', 'ca'] as const;

export type UpscaleMode = (typeof UPSCALE_MODES)[number];

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
function buildChain(
  mode: Exclude<UpscaleMode, 'off'>,
  ctx: BuildContext
): Anime4KPipeline[] {
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

  const modules = await loadPresets();

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('Видеокарта не отдала адаптер WebGPU');
  }

  const device = await adapter.requestDevice();
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
  let stats: UpscaleStats | null = null;
  let framesInWindow = 0;
  let windowStartedAt = performance.now();
  let reported = false;

  const release = (): void => {
    source?.destroy();
    source = null;
    pipelines = [];
    bindGroup = null;
  };

  const rebuild = (width: number, height: number): void => {
    release();

    // Цель — сколько пикселей реально покажет канва, а не абстрактная доля
    // ширины экрана. Считать от screen.width было ошибкой: при небольшом
    // окне конвейер рисовал в текстуру заметно крупнее той, что видна, и
    // лишние пиксели тут же выбрасывались обратной свёрткой браузера.
    const shownWidth = Math.round(
      (canvas.clientWidth || width) * (window.devicePixelRatio || 1)
    );

    // Меньше исходника — апскейлить нечего; больше двукратного пресеты не дают.
    const scale = Math.min(MAX_SCALE, Math.max(1, shownWidth / width));
    const targetDimensions = {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };

    source = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    pipelines = buildChain(mode, {
      modules,
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

    builtFor = `${width}x${height}`;
    stats = {
      sourceWidth: width,
      sourceHeight: height,
      targetWidth: output.width,
      targetHeight: output.height,
      fps: 0,
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

    if (width === 0 || height === 0) {
      return;
    }

    // Размер меняется при смене качества — конвейер пересобирается под него,
    // иначе текстуры остались бы от прошлого разрешения.
    if (builtFor !== `${width}x${height}`) {
      rebuild(width, height);
    }

    if (!source || pipelines.length === 0 || !bindGroup || !stats) {
      return;
    }

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
      stats = {
        ...stats,
        fps: Math.round((framesInWindow * 1000) / elapsed),
      };
      framesInWindow = 0;
      windowStartedAt = now;
      onStats?.(stats);
    }
  };

  const step = (): void => {
    if (disposed) {
      return;
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

  step();

  return {
    destroy(): void {
      disposed = true;

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

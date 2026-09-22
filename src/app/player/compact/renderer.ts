import {
  convShader,
  groups,
  PREPROCESS_WGSL,
  PRESENT_WGSL,
  WORKGROUP,
} from './shaders';

/**
 * Модель SRVGGNetCompact на WebGPU: свой конвейер вместо готового рантайма.
 *
 * Веса лежат в `src/assets/upscale/`, разложенные
 * `scripts/compact-to-wgsl.py` ровно в том порядке, в котором их читает
 * шейдер. Правильность связки шейдер + раскладка проверяется стендом
 * `src-tauri/examples/compact_check.rs`: он гоняет сеть на GPU и сверяет с
 * выходом onnxruntime. На настоящих весах расхождение — 72.6 дБ, то есть
 * меньше половины шага восьмибитного квантования.
 */

/** Описание слоя из `model.json`; смещение — в байтах от начала блоба. */
interface LayerMeta {
  name: string;
  offset: number;
  in: number;
  out: number;
  inGroups: number;
  outGroups: number;
  prelu: boolean;
}

interface ModelMeta {
  arch: string;
  license: string;
  source: string;
  numFeat: number;
  numConv: number;
  scale: number;
  bytes: number;
  layers: LayerMeta[];
}

/**
 * Выше этого режим не предлагается.
 *
 * Замер на M1 Pro: 480p — 26.5 мс на кадр, 720p — 58.5 мс при бюджете 41.7 мс
 * на 24 к/с. У Kodik максимум и так 720p, но предел стоит явно: на входе
 * крупнее сеть не подвиснет, а просто не включится.
 */
export const MAX_SOURCE_PIXELS = 1280 * 720;

/** Цена кадра растёт линейно по пикселям — этого хватает для прикидки. */
export function fitsRealtime(width: number, height: number): boolean {
  return width * height <= MAX_SOURCE_PIXELS;
}

export interface CompactHandle {
  /** Кратность увеличения, взятая из модели. */
  readonly scale: number;
  /** Лицензия весов — показывается в атрибуции. */
  readonly license: string;
  /** Пересобирает буферы под размер кадра. */
  resize(width: number, height: number): void;
  /** Кодирует кадр: из текстуры источника прямо в канву. */
  draw(encoder: GPUCommandEncoder, source: GPUTexture, target: GPUTextureView): void;
  destroy(): void;
}

/** Байт на `vec4<f16>` — единица адресации во всех буферах конвейера. */
const VEC4 = 8;

/** Минимальный размер uniform-буфера в WebGPU. */
const UNIFORM_BYTES = 16;

function dimsBuffer(device: GPUDevice, width: number, height: number): GPUBuffer {
  const buffer = device.createBuffer({
    size: UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, new Uint32Array([width, height, 0, 0]));
  return buffer;
}

/**
 * Смещения блоков слоя внутри общего блоба, в `vec4`.
 *
 * Шейдер адресует `blob[]` элементами по восемь байт, поэтому байтовое
 * смещение из `model.json` делится на восемь. Дальше по порядку упаковки:
 * веса, смещения, наклоны PReLU.
 */
function layerBases(layer: LayerMeta): { w: number; bias: number; prelu: number } {
  const w = layer.offset / VEC4;
  const bias = w + layer.out * 9 * layer.inGroups;
  return { w, bias, prelu: bias + layer.outGroups };
}

async function loadModel(): Promise<{ meta: ModelMeta; weights: ArrayBuffer }> {
  const [metaResponse, weightsResponse] = await Promise.all([
    // Путь от корня, а не относительный: плеер живёт на `/anime/:id`, и
    // `assets/...` разрешился бы в `/anime/assets/...`.
    fetch('/assets/upscale/model.json'),
    fetch('/assets/upscale/weights.bin'),
  ]);

  if (!metaResponse.ok || !weightsResponse.ok) {
    throw new Error('Веса модели не найдены в сборке');
  }

  const meta = (await metaResponse.json()) as ModelMeta;
  const weights = await weightsResponse.arrayBuffer();

  // Блоб и описание собираются одним запуском конвертера; рассогласование
  // означает, что в сборку попали файлы от разных прогонов, и дальше ошибка
  // вылезла бы уже картинкой, а не исключением.
  if (weights.byteLength !== meta.bytes) {
    throw new Error(
      `Веса ${weights.byteLength} Б против ${meta.bytes} Б в описании модели`
    );
  }

  return { meta, weights };
}

export async function createCompactRenderer(
  device: GPUDevice,
  format: GPUTextureFormat
): Promise<CompactHandle> {
  const { meta, weights } = await loadModel();

  if (meta.arch !== 'SRVGGNetCompact') {
    throw new Error(`Неподдерживаемая архитектура модели: ${meta.arch}`);
  }

  const storage =
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

  const blob = device.createBuffer({ size: weights.byteLength, usage: storage });
  device.queue.writeBuffer(blob, 0, new Uint8Array(weights));

  const compute = (code: string, entry = 'main'): GPUComputePipeline =>
    device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: entry },
    });

  const feat = meta.numFeat;
  const scale = meta.scale;

  // Три формы слоя на десять слоёв: восемь слоёв тела делят один пайплайн и
  // различаются только смещениями в uniform.
  const pipelines = {
    prepare: compute(PREPROCESS_WGSL),
    first: compute(convShader({ inChannels: 3, outChannels: feat, prelu: true })),
    body: compute(convShader({ inChannels: feat, outChannels: feat, prelu: true })),
    last: compute(
      convShader({
        inChannels: feat,
        outChannels: 3 * scale * scale,
        prelu: false,
        tail: { scale },
      })
    ),
  };

  const presentModule = device.createShaderModule({ code: PRESENT_WGSL });
  const present = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: presentModule, entryPoint: 'vs' },
    fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  interface Frame {
    groupsX: number;
    groupsY: number;
    /** Кадр после препроцесса: вход первой свёртки и слагаемое skip. */
    source: GPUBuffer;
    /** Размер источника для препроцесса. */
    dims: GPUBuffer;
    /** Всё, что нужно освободить при пересборке. */
    owned: GPUBuffer[];
    passes: { pipeline: GPUComputePipeline; bind: GPUBindGroup }[];
    present: GPUBindGroup;
  }

  let frame: Frame | null = null;

  const release = (): void => {
    frame?.owned.forEach((buffer) => buffer.destroy());
    frame = null;
  };

  return {
    scale,
    license: meta.license,

    resize(width: number, height: number): void {
      release();

      const pixels = width * height;
      const featGroups = groups(feat);

      const source = device.createBuffer({ size: pixels * VEC4, usage: storage });
      const ping = device.createBuffer({
        size: pixels * featGroups * VEC4,
        usage: storage,
      });
      const pong = device.createBuffer({
        size: pixels * featGroups * VEC4,
        usage: storage,
      });
      const output = device.createBuffer({
        size: pixels * scale * scale * VEC4,
        usage: storage,
      });

      const dims = dimsBuffer(device, width, height);
      const owned = [source, ping, pong, output, dims];

      let src = source;
      let dst = ping;

      const passes = meta.layers.map((layer, index) => {
        const isFirst = index === 0;
        const isLast = index === meta.layers.length - 1;
        const pipeline = isFirst
          ? pipelines.first
          : isLast
            ? pipelines.last
            : pipelines.body;

        const bases = layerBases(layer);
        const uniform = device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(
          uniform,
          0,
          new Uint32Array([width, height, bases.w, bases.bias, bases.prelu, 0, 0, 0])
        );
        owned.push(uniform);

        const target = isLast ? output : dst;
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: target } },
          { binding: 3, resource: { buffer: blob } },
        ];

        // Последний слой складывает выход с исходником по ближайшему соседу,
        // поэтому ему нужен ещё и кадр до сети.
        if (isLast) {
          entries.push({ binding: 4, resource: { buffer: source } });
        }

        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries,
        });

        if (!isLast) {
          // Первый слой читает кадр, дальше буферы качаются между собой.
          src = target;
          dst = target === ping ? pong : ping;
        }

        return { pipeline, bind };
      });

      const outDims = dimsBuffer(device, width * scale, height * scale);
      owned.push(outDims);

      frame = {
        groupsX: Math.ceil(width / WORKGROUP),
        groupsY: Math.ceil(height / WORKGROUP),
        source,
        dims,
        owned,
        passes,
        present: device.createBindGroup({
          layout: present.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: outDims } },
            { binding: 1, resource: { buffer: output } },
          ],
        }),
      };
    },

    draw(encoder, sourceTexture, target): void {
      if (!frame) {
        return;
      }

      // Привязка с видом текстуры собирается на кадр: источник пересоздаётся
      // при смене качества, и держать старый вид — верный способ рисовать
      // прошлое разрешение.
      const prepareBind = device.createBindGroup({
        layout: pipelines.prepare.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: frame.dims } },
          { binding: 1, resource: sourceTexture.createView() },
          { binding: 2, resource: { buffer: frame.source } },
        ],
      });

      const prepare = encoder.beginComputePass();
      prepare.setPipeline(pipelines.prepare);
      prepare.setBindGroup(0, prepareBind);
      prepare.dispatchWorkgroups(frame.groupsX, frame.groupsY);
      prepare.end();

      for (const step of frame.passes) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(step.pipeline);
        pass.setBindGroup(0, step.bind);
        pass.dispatchWorkgroups(frame.groupsX, frame.groupsY);
        pass.end();
      }

      const draw = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      draw.setPipeline(present);
      draw.setBindGroup(0, frame.present);
      draw.draw(3);
      draw.end();
    },

    destroy(): void {
      release();
      blob.destroy();
    },
  };
}

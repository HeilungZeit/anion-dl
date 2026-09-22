/**
 * Генератор WGSL для SRVGGNetCompact.
 *
 * Сеть — десяток свёрток 3×3 с PReLU, и ради неё незачем тащить в вебвью
 * целый рантайм вроде onnxruntime-web: он весит десятки мегабайт, генерирует
 * шейдеры под Dawn и не даёт ручек, когда не укладывается в кадр. Здесь ядро
 * написано руками под раскладку весов из `scripts/compact-to-wgsl.py`.
 *
 * **Раскладка ядра подобрана замерами, а не из общих соображений** — см.
 * `docs/compact-upscale.md`, Э16 «Что сработало, а что нет». Четыре варианта
 * проверены на Apple GPU, три оказались хуже. Не менять без нового прогона
 * `cargo run --example gpu_probe`:
 *
 * - маленький тайл активаций 10×10 в общей памяти группы — он даёт втрое
 *   против чтения из глобальной;
 * - цикл по выходным каналам развёрнут внутрь, активация читается один раз и
 *   уходит во все накопления сразу — это ещё вдвое;
 * - веса читаются из глобальной памяти: перенос их в общую замерен дважды и
 *   оба раза ухудшил вдвое, заполняемость важнее;
 * - накопители — именованные скаляры: запись в компонент вектора по
 *   вычисляемому индексу (`acc[i] = x`) стоит 2.6×, компилятор перестаёт
 *   держать вектор в регистрах;
 * - по пикселю на поток: блокировка 2×2 и полосы 1×4 замерены и деградируют.
 */

/** Рабочая группа: 8×8 потоков, по пикселю на каждый. */
const TILE = 8;

/** Тайл с каймой под ядро 3×3. */
const HALO = TILE + 2;

/** Каналы пакуются по четыре в vec4 — так соседи по окну читаются подряд. */
const PACK = 4;

export interface LayerShape {
  /**
   * Тип накопителя. `dot` на vec4 в любом случае считается в f16 — это
   * дёшево, — но сумма по 54 слагаемым на слой и по десяти слоям копит
   * ошибку. `f32` убирает её, оставляя умножения в половинной точности.
   */
  accumulate?: 'f16' | 'f32';
  inChannels: number;
  outChannels: number;
  /** У последнего слоя активации нет. */
  prelu: boolean;
  /**
   * Последний слой собирает выход: pixelshuffle и сложение с исходником.
   * Кратность нужна здесь же — она определяет, как раскладываются каналы.
   */
  tail?: { scale: number };
}

/** Сколько vec4 занимает столько каналов; хвост добит нулями при упаковке. */
export function groups(channels: number): number {
  return Math.ceil(channels / PACK);
}

/**
 * Размер рабочей группы в пикселях источника. Нужен снаружи, чтобы посчитать
 * число групп в диспетче.
 */
export const WORKGROUP = TILE;

function accumulators(count: number, type: string): string {
  return Array.from(
    { length: count },
    (_, o) => `  var a${o}: ${type} = ${type}(0.0);`
  ).join('\n');
}

function weightOffsets(count: number, inGroups: number): string {
  return Array.from(
    { length: count },
    (_, o) => `    let wo${o} = dims.wBase + (${o}u * 9u + tap) * ${inGroups}u;`
  ).join('\n');
}

function multiplyAdd(count: number, type: string): string {
  const wrap = (expr: string): string =>
    type === 'f16' ? expr : `${type}(${expr})`;

  return Array.from(
    { length: count },
    (_, o) => `      a${o} = a${o} + ${wrap(`dot(blob[wo${o} + g], x)`)};`
  ).join('\n');
}

function bias(count: number, type: string): string {
  // Индексы внутри vec4 — константы времени генерации: динамический доступ к
  // компоненте вектора здесь стоил бы ровно того же, что и в накопителях.
  return Array.from(
    { length: count },
    (_, o) =>
      `  a${o} = a${o} + ${type}(blob[dims.biasBase + ${Math.floor(o / PACK)}u][${o % PACK}]);`
  ).join('\n');
}

function activation(count: number, type: string): string {
  return Array.from({ length: count }, (_, o) => {
    const raw = `blob[dims.preluBase + ${Math.floor(o / PACK)}u][${o % PACK}]`;
    const slope = type === 'f16' ? raw : `${type}(${raw})`;
    return `  a${o} = select(${slope} * a${o}, a${o}, a${o} >= ${type}(0.0));`;
  }).join('\n');
}

function storePlanar(count: number): string {
  const lines = ['  let outBase = (oy * dims.width + ox) * ' + groups(count) + 'u;'];

  for (let og = 0; og < groups(count); og += 1) {
    const parts = Array.from({ length: PACK }, (_, k) => {
      const o = og * PACK + k;
      // Хвост по выходным каналам добивается нулями, чтобы следующий слой
      // читал их как обычный vec4 и не знал про неполную группу.
      return o < count ? `f16(a${o})` : 'f16(0.0)';
    });
    lines.push(`  dst[outBase + ${og}u] = V(${parts.join(', ')});`);
  }

  return lines.join('\n');
}

/**
 * Сборка выхода: pixelshuffle плюс исходник по ближайшему соседу.
 *
 * Порядок каналов — CRD, как у `pixel_shuffle` в PyTorch: канал источника это
 * `цвет · scale² + строка · scale + столбец`. Skip именно ближайшим соседом, а
 * не билинейным: в `srvgg_arch.py` стоит `F.interpolate(..., mode='nearest')`,
 * и подмена дала бы похожую, но другую картинку.
 */
function storeTail(scale: number): string {
  const lines = [
    '  let base = orig[oy * dims.width + ox];',
    `  let outWidth = dims.width * ${scale}u;`,
  ];

  for (let rh = 0; rh < scale; rh += 1) {
    for (let rw = 0; rw < scale; rw += 1) {
      const at = (colour: number): string =>
        `f16(a${colour * scale * scale + rh * scale + rw})`;

      lines.push(
        `  dst[(oy * ${scale}u + ${rh}u) * outWidth + ox * ${scale}u + ${rw}u] =`,
        `    V(${at(0)} + base.x, ${at(1)} + base.y, ${at(2)} + base.z, f16(1.0));`
      );
    }
  }

  return lines.join('\n');
}

/**
 * Один слой — один шейдер. Слои с одинаковой формой делят его и различаются
 * только смещениями в блобе, поэтому смещения лежат в uniform, а не в коде:
 * восемь слоёв тела SuperUltraCompact обслуживаются одним пайплайном.
 */
export function convShader(shape: LayerShape): string {
  const inGroups = groups(shape.inChannels);
  const out = shape.outChannels;
  const acc = shape.accumulate ?? 'f32';

  return `enable f16;
alias V = vec4<f16>;

const TILE: u32 = ${TILE}u;
const HALO: u32 = ${HALO}u;
const IN_G: u32 = ${inGroups}u;

struct Dims {
  width: u32,
  height: u32,
  // Смещения блоков слоя внутри общего блоба, в vec4.
  wBase: u32,
  biasBase: u32,
  preluBase: u32,
}

@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> src: array<V>;
@group(0) @binding(2) var<storage, read_write> dst: array<V>;
@group(0) @binding(3) var<storage, read> blob: array<V>;
${shape.tail ? '@group(0) @binding(4) var<storage, read> orig: array<V>;' : ''}

var<workgroup> tile: array<V, ${HALO * HALO * inGroups}>;

@compute @workgroup_size(${TILE}, ${TILE}, 1)
fn main(
  @builtin(workgroup_id) wg: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) li: u32,
) {
  let baseX = i32(wg.x * TILE) - 1;
  let baseY = i32(wg.y * TILE) - 1;

  for (var i = li; i < HALO * HALO; i = i + ${TILE * TILE}u) {
    let gx = baseX + i32(i % HALO);
    let gy = baseY + i32(i / HALO);
    let d = i * IN_G;

    // Дополнение **нулями**, а не повтором края: nn.Conv2d(padding=1)
    // дополняет нулями, и clamp разошёлся бы с моделью по всей рамке кадра.
    // Кайма зануляется здесь, при загрузке, чтобы в горячем цикле не было
    // ни ветки, ни проверки границ.
    if (gx < 0 || gy < 0 || gx >= i32(dims.width) || gy >= i32(dims.height)) {
      for (var g = 0u; g < IN_G; g = g + 1u) {
        tile[d + g] = V(0.0);
      }
    } else {
      let s = (u32(gy) * dims.width + u32(gx)) * IN_G;
      for (var g = 0u; g < IN_G; g = g + 1u) {
        tile[d + g] = src[s + g];
      }
    }
  }

  workgroupBarrier();

  let ox = wg.x * TILE + lid.x;
  let oy = wg.y * TILE + lid.y;
  // Проверка границ только после барьера: выйти раньше значит не дождаться
  // загрузки тайла соседями по группе.
  if (ox >= dims.width || oy >= dims.height) {
    return;
  }

${accumulators(out, acc)}

  for (var tap = 0u; tap < 9u; tap = tap + 1u) {
    let p = ((lid.y + tap / 3u) * HALO + (lid.x + tap % 3u)) * IN_G;
${weightOffsets(out, inGroups)}

    for (var g = 0u; g < IN_G; g = g + 1u) {
      let x = tile[p + g];
${multiplyAdd(out, acc)}
    }
  }

${bias(out, acc)}
${shape.prelu ? activation(out, acc) : ''}
${shape.tail ? storeTail(shape.tail.scale) : storePlanar(out)}
}
`;
}

/**
 * Кадр из текстуры в планарный буфер fp16.
 *
 * `copyExternalImageToTexture` умеет класть кадр только в текстуру, а свёртке
 * нужен storage-буфер: у текстуры нет способа отдать 24 канала, а в буфере
 * они лежат шестёрками vec4 подряд.
 *
 * Четвёртая компонента — ноль. У первой свёртки три входных канала, и вес в
 * четвёртом нулевой, так что значение не важно; ноль просто предсказуемее.
 */
export const PREPROCESS_WGSL = /* wgsl */ `enable f16;

struct Dims { width: u32, height: u32 }

@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var frame: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<vec4<f16>>;

@compute @workgroup_size(${TILE}, ${TILE}, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= dims.width || gid.y >= dims.height) {
    return;
  }

  let c = textureLoad(frame, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
  out[gid.y * dims.width + gid.x] = vec4<f16>(f16(c.r), f16(c.g), f16(c.b), f16(0.0));
}
`;

/**
 * Вывод буфера в канву.
 *
 * Фрагментный шейдер читает storage-буфер напрямую, без промежуточной
 * текстуры: лишний проход копирования тут не за что платить, а размер канвы
 * и так равен размеру выхода, поэтому `@builtin(position)` — это прямо
 * индекс пикселя.
 *
 * Выход сети может немного вылезать за 0..1; `rgba8unorm` зажмёт сам.
 */
export const PRESENT_WGSL = /* wgsl */ `enable f16;

struct Dims { width: u32, height: u32 }

@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> img: array<vec4<f16>>;

struct VertexOut {
  @builtin(position) position: vec4f,
}

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  // Один треугольник на весь экран дешевле двух: меньше вершин и нет шва.
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));

  var out: VertexOut;
  out.position = vec4f(corners[index], 0.0, 1.0);
  return out;
}

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let x = min(u32(position.x), dims.width - 1u);
  let y = min(u32(position.y), dims.height - 1u);
  let c = img[y * dims.width + x];
  return vec4f(f32(c.x), f32(c.y), f32(c.z), 1.0);
}
`;

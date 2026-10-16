/**
 * Огрублённое описание железа для статистики улучшения чёткости — тот же
 * контракт, что у сайта (`anion`, services/telemetry/hardware.ts). Точную
 * модель и полную строку рендерера не собираем: производителя, поколения
 * видеокарты и класса экрана хватает, чтобы понять, у кого улучшение включают
 * и тянет.
 */
let gpu: Promise<string> | undefined;

/** Видеокарта как `nvidia-ampere`, `apple-metal-3`; запрос адаптера — один на окно. */
export function gpuClass(): Promise<string> {
  gpu ??= readGpu();
  return gpu;
}

async function readGpu(): Promise<string> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return 'no-webgpu';
  }
  try {
    // Тот же запрос, что у апскейлера: на ноутбуке с двумя видеокартами важна
    // та, на которой улучшение будет работать.
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) {
      return 'no-adapter';
    }
    const { vendor, architecture } = adapter.info;
    return token(
      [vendor || 'unknown', architecture].filter(Boolean).join('-')
    );
  } catch {
    return 'unknown';
  }
}

/** Класс экрана по короткой стороне в физических пикселях — до неё апскейлер и растягивает кадр. */
export function screenClass(view: Window): string {
  const side =
    Math.min(view.screen.width, view.screen.height) * view.devicePixelRatio;
  if (side <= 800) return '720p';
  if (side <= 1200) return '1080p';
  if (side <= 1600) return '1440p';
  if (side <= 2400) return '4k';
  return '5k';
}

/**
 * Итог замера улучшения: режим, высота источника и успевал ли конвейер за
 * частотой видео — `ca-1080-smooth`. Порог 0.95: одиночный пропуск кадра
 * в окне не превращает плавное воспроизведение в «тормозит».
 */
export function upscalePerf(
  mode: string,
  sourceHeight: number,
  ratio: number
): string {
  const source =
    sourceHeight <= 540
      ? '480'
      : sourceHeight <= 900
        ? '720'
        : sourceHeight <= 1440
          ? '1080'
          : '4k';
  const verdict = ratio >= 0.95 ? 'smooth' : ratio >= 0.8 ? 'lag' : 'slow';
  return `${mode}-${source}-${verdict}`;
}

/** Сервер принимает только `[a-z0-9_-]{1,64}`. */
function token(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unknown'
  );
}

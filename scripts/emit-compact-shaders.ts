/**
 * Выгружает шейдеры слоёв в файлы — их читает стенд `compact_check`.
 *
 * Генератор живёт в приложении, а проверяется из Rust, и единственный
 * честный способ не разъехаться — брать шейдер из того же модуля, а не
 * повторять его в стенде.
 *
 *     bun run scripts/emit-compact-shaders.ts <каталог> [num_feat] [scale] [f16|f32]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  convShader,
  PREPROCESS_WGSL,
  PRESENT_WGSL,
} from '../src/app/player/compact/shaders';

const [dir, featArg, scaleArg, accArg] = process.argv.slice(2);

if (!dir) {
  console.error('нужен каталог назначения');
  process.exit(1);
}

const feat = Number(featArg ?? 24);
const scale = Number(scaleArg ?? 2);
const accumulate = (accArg ?? 'f32') as 'f16' | 'f32';

mkdirSync(dir, { recursive: true });

const shapes = {
  // Первая свёртка: три канала на входе, один vec4 с нулевым хвостом.
  first: { inChannels: 3, outChannels: feat, prelu: true, accumulate },
  // Тело: восемь одинаковых слоёв, один шейдер на все.
  body: { inChannels: feat, outChannels: feat, prelu: true, accumulate },
  // Последний: без активации, сразу pixelshuffle и сложение с исходником.
  last: {
    inChannels: feat,
    outChannels: 3 * scale * scale,
    prelu: false,
    accumulate,
    tail: { scale },
  },
} as const;

for (const [name, shape] of Object.entries(shapes)) {
  const code = convShader(shape);
  writeFileSync(join(dir, `${name}.wgsl`), code);
  console.log(`${name}.wgsl — ${code.split('\n').length} строк`);
}

// Препроцесс и вывод свёрток не касаются, но опечатка в них вылезла бы только
// при включении режима в плеере — поэтому стенд валидирует и их.
for (const [name, code] of [
  ['preprocess', PREPROCESS_WGSL],
  ['present', PRESENT_WGSL],
] as const) {
  writeFileSync(join(dir, `${name}.wgsl`), code);
  console.log(`${name}.wgsl — ${code.split('\n').length} строк`);
}

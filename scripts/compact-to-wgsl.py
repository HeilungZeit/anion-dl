#!/usr/bin/env python3
"""Перекладывает веса SRVGGNetCompact из ONNX в тот порядок, в котором их
читает шейдер, и проверяет раскладку без GPU.

Сеть простая — десяток свёрток 3×3 с PReLU, — поэтому тащить в вебвью целый
рантайм ради неё незачем: ядро пишется на WGSL руками, а весам нужен только
правильный порядок байтов. Ошибка в порядке не видна глазом: картинка
получается правдоподобной, просто не той. Поэтому здесь же лежит эмулятор,
который читает блоб ровно теми же индексами, что и шейдер, и сверяется с
onnxruntime.

Зависимости (окружение одноразовое, в репозиторий не ставится):

    python3 -m venv .venv && .venv/bin/pip install numpy onnx onnxruntime

Использование:

    compact-to-wgsl.py selftest
    compact-to-wgsl.py convert model.onnx src/assets/upscale/

`selftest` собирает синтетическую сеть той же архитектуры и гоняет её через
весь тракт. Он не требует скачанных весов и должен проходить всегда.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

# Каналы пакуются по четыре в vec4: так соседи по окну 3×3 читаются подряд.
PACK = 4
TAPS = 9


def groups(channels: int) -> int:
    """Сколько vec4 занимает столько каналов. Хвост добивается нулями."""
    return (channels + PACK - 1) // PACK


@dataclass
class Layer:
    """Один слой в терминах шейдера, а не ONNX."""

    name: str
    weight: np.ndarray  # (out, in, 3, 3)
    bias: np.ndarray  # (out,)
    prelu: np.ndarray | None  # (out,) или None у последнего слоя
    offset: int = 0  # байтовое смещение блока в блобе

    @property
    def out_channels(self) -> int:
        return int(self.weight.shape[0])

    @property
    def in_channels(self) -> int:
        return int(self.weight.shape[1])


@dataclass
class Arch:
    num_feat: int
    num_conv: int
    scale: int
    layers: list[Layer] = field(default_factory=list)


# --- Разбор ONNX ---------------------------------------------------------


def _initializers(model: onnx.ModelProto) -> dict[str, np.ndarray]:
    return {t.name: numpy_helper.to_array(t) for t in model.graph.initializer}


def parse(model: onnx.ModelProto) -> Arch:
    """Вытаскивает свёртки и PReLU в порядке графа и сверяет форму сети.

    Параметры берутся **из графа**, а не из имени файла или карточки модели:
    на OpenModelDB подписи не сходятся с содержимым — страница
    `2x AnimeJaNai v2 UltraCompact` помечена `64nf16nc`, то есть параметрами
    Compact, а не UltraCompact.
    """
    init = _initializers(model)
    convs: list[tuple[str, np.ndarray, np.ndarray]] = []
    prelus: list[np.ndarray] = []

    for node in model.graph.node:
        if node.op_type == "Conv":
            weight = init.get(node.input[1])
            if weight is None:
                raise SystemExit(f"свёртка {node.name}: веса не в инициализаторах")
            bias = (
                init.get(node.input[2])
                if len(node.input) > 2
                else np.zeros(weight.shape[0], dtype=np.float32)
            )
            if weight.shape[2:] != (3, 3):
                raise SystemExit(
                    f"свёртка {node.name}: ядро {weight.shape[2:]}, ожидалось 3×3"
                )
            convs.append((node.name or f"conv{len(convs)}", weight, bias))
        elif node.op_type == "PRelu":
            slope = init.get(node.input[1])
            if slope is None:
                raise SystemExit(f"PReLU {node.name}: наклон не в инициализаторах")
            prelus.append(slope.reshape(-1))

    if len(convs) < 3:
        raise SystemExit(f"свёрток {len(convs)}, для SRVGGNetCompact нужно хотя бы 3")

    if len(prelus) != len(convs) - 1:
        raise SystemExit(
            f"PReLU {len(prelus)} при {len(convs)} свёртках: "
            "ожидалась активация после каждой, кроме последней"
        )

    first, *body, last = convs
    num_feat = int(first[1].shape[0])
    num_conv = len(body)

    if int(first[1].shape[1]) != 3:
        raise SystemExit(f"первая свёртка берёт {first[1].shape[1]} каналов, ожидалось 3")

    for name, weight, _ in body:
        if weight.shape[0] != num_feat or weight.shape[1] != num_feat:
            raise SystemExit(
                f"свёртка {name}: {weight.shape[1]}→{weight.shape[0]}, "
                f"ожидалось {num_feat}→{num_feat}"
            )

    out = int(last[1].shape[0])
    if out % 3 != 0:
        raise SystemExit(f"последняя свёртка даёт {out} каналов, не кратно 3")

    scale_sq = out // 3
    scale = int(round(scale_sq**0.5))
    if scale * scale != scale_sq:
        raise SystemExit(f"{out} каналов на выходе — это не 3·scale²")

    layers = [
        Layer(name, w.astype(np.float32), b.astype(np.float32), p.astype(np.float32))
        for (name, w, b), p in zip(convs[:-1], prelus)
    ]
    layers.append(Layer(last[0], last[1].astype(np.float32), last[2].astype(np.float32), None))

    return Arch(num_feat=num_feat, num_conv=num_conv, scale=scale, layers=layers)


# --- Упаковка ------------------------------------------------------------


def pack(arch: Arch) -> bytes:
    """Складывает веса в порядке чтения шейдера.

    Плоский индекс веса — ((o · 9 + tap) · in_groups + g), элемент vec4 из
    четырёх входных каналов. Ровно так победившее ядро в `gpu_probe` адресует
    `wts[(o * 9u + tap) * F4 + g]`.

    Порядок внутри блока слоя: веса, затем смещения, затем наклоны PReLU;
    смещения и наклоны добиты до кратности четырём, чтобы читались тем же
    vec4, что и всё остальное.
    """
    blob = bytearray()

    for layer in arch.layers:
        layer.offset = len(blob)

        out_c = layer.out_channels
        in_g = groups(layer.in_channels)

        w = np.zeros((out_c, TAPS, in_g, PACK), dtype=np.float32)
        for tap in range(TAPS):
            ky, kx = divmod(tap, 3)
            # Хвост по входным каналам остаётся нулевым: у первой свёртки их
            # три, и четвёртая компонента vec4 не должна ни на что влиять.
            w[:, tap, :, :].reshape(out_c, -1)[:, : layer.in_channels] = layer.weight[
                :, :, ky, kx
            ]

        blob += w.astype(np.float16).tobytes()

        padded = groups(out_c) * PACK
        bias = np.zeros(padded, dtype=np.float32)
        bias[:out_c] = layer.bias
        blob += bias.astype(np.float16).tobytes()

        if layer.prelu is not None:
            slope = np.zeros(padded, dtype=np.float32)
            slope[:out_c] = layer.prelu
            blob += slope.astype(np.float16).tobytes()

    return bytes(blob)


def metadata(arch: Arch, blob: bytes, source: str, license_: str = "") -> dict:
    return {
        "arch": "SRVGGNetCompact",
        # Веса AnimeJaNai идут под CC-BY-NC-SA-4.0 и попадают в публичный DMG,
        # поэтому лицензия едет вместе с ними и показывается в атрибуции.
        "license": license_,
        "numFeat": arch.num_feat,
        "numConv": arch.num_conv,
        "scale": arch.scale,
        "pack": PACK,
        "dtype": "float16",
        "source": source,
        "sha256": hashlib.sha256(blob).hexdigest(),
        "bytes": len(blob),
        "layers": [
            {
                "name": layer.name,
                "offset": layer.offset,
                "in": layer.in_channels,
                "out": layer.out_channels,
                "inGroups": groups(layer.in_channels),
                "outGroups": groups(layer.out_channels),
                "prelu": layer.prelu is not None,
            }
            for layer in arch.layers
        ],
    }


# --- Эмулятор раскладки --------------------------------------------------


def unpack(blob: bytes, meta: dict) -> list[dict]:
    """Читает блоб теми же индексами, что и шейдер.

    Это и есть проверка: если порядок разъехался, эмулятор даст не то же
    самое, что onnxruntime, — и разойдутся они задолго до того, как появится
    хоть строка WGSL.
    """
    view = np.frombuffer(blob, dtype=np.float16)
    out = []

    for spec in meta["layers"]:
        base = spec["offset"] // 2  # смещение в элементах, не в байтах
        out_c, in_g = spec["out"], spec["inGroups"]
        padded = spec["outGroups"] * PACK

        count = out_c * TAPS * in_g * PACK
        flat = view[base : base + count].astype(np.float32)

        weight = np.zeros((out_c, in_g * PACK, 3, 3), dtype=np.float32)
        for o in range(out_c):
            for tap in range(TAPS):
                ky, kx = divmod(tap, 3)
                for g in range(in_g):
                    idx = ((o * TAPS + tap) * in_g + g) * PACK
                    weight[o, g * PACK : (g + 1) * PACK, ky, kx] = flat[idx : idx + PACK]

        cursor = base + count
        bias = view[cursor : cursor + padded].astype(np.float32)[:out_c]
        cursor += padded

        slope = None
        if spec["prelu"]:
            slope = view[cursor : cursor + padded].astype(np.float32)[:out_c]

        out.append(
            {"weight": weight[:, : spec["in"]], "bias": bias, "prelu": slope}
        )

    return out


def conv3x3(x: np.ndarray, weight: np.ndarray, bias: np.ndarray) -> np.ndarray:
    """Свёртка 3×3 с **нулевым** дополнением по краям.

    Именно нулевым: `nn.Conv2d(..., padding=1)` дополняет нулями, а не
    повторяет крайний пиксель. Микробенч в `gpu_probe` брал `clamp` ради
    скорости — для боевого ядра это разошлось бы с моделью по всей рамке
    кадра.
    """
    _, h, w = x.shape
    padded = np.zeros((x.shape[0], h + 2, w + 2), dtype=np.float32)
    padded[:, 1:-1, 1:-1] = x

    out = np.zeros((weight.shape[0], h, w), dtype=np.float32)
    for ky in range(3):
        for kx in range(3):
            window = padded[:, ky : ky + h, kx : kx + w]
            out += np.tensordot(weight[:, :, ky, kx], window, axes=([1], [0]))

    return out + bias[:, None, None]


def emulate(blob: bytes, meta: dict, image: np.ndarray) -> np.ndarray:
    """Прогон сети по распакованному блобу. Вход и выход — (3, H, W), 0..1."""
    layers = unpack(blob, meta)
    scale = meta["scale"]

    x = image
    for spec in layers:
        x = conv3x3(x, spec["weight"], spec["bias"])
        if spec["prelu"] is not None:
            slope = spec["prelu"][:, None, None]
            x = np.where(x >= 0, x, slope * x)

    # pixel_shuffle: канал источника — c·scale² + row·scale + col.
    c, h, w = x.shape
    out_c = c // (scale * scale)
    x = x.reshape(out_c, scale, scale, h, w).transpose(0, 3, 1, 4, 2)
    x = x.reshape(out_c, h * scale, w * scale)

    # Skip — ближайший сосед, не билинейный: в srvgg_arch.py стоит
    # F.interpolate(..., mode='nearest'), и подмена дала бы похожую, но
    # другую картинку.
    base = np.repeat(np.repeat(image, scale, axis=1), scale, axis=2)
    return x + base


# --- Синтетическая модель для самопроверки -------------------------------


def build_synthetic(num_feat: int, num_conv: int, scale: int, seed: int = 7):
    """Собирает граф той же формы, в какой его экспортирует PyTorch.

    Нужна, чтобы отлаживать конвертер и раскладку, не скачивая чужие веса:
    к моменту, когда появятся настоящие, тракт уже проверен.
    """
    rng = np.random.default_rng(seed)
    nodes, inits = [], []

    def add(name: str, array: np.ndarray) -> str:
        inits.append(numpy_helper.from_array(array.astype(np.float32), name))
        return name

    shapes = [(num_feat, 3)] + [(num_feat, num_feat)] * num_conv
    shapes.append((3 * scale * scale, num_feat))

    cursor = "input"
    for i, (out_c, in_c) in enumerate(shapes):
        last = i == len(shapes) - 1
        # Масштаб Хе: иначе на десяти слоях активации уходят в тысячи, и
        # сравнение упирается в диапазон float16, а не в раскладку.
        gain = np.sqrt(2.0 / (in_c * TAPS))
        w = add(f"w{i}", rng.standard_normal((out_c, in_c, 3, 3)) * gain)
        b = add(f"b{i}", rng.standard_normal(out_c) * 0.01)

        out = f"conv{i}"
        nodes.append(
            helper.make_node("Conv", [cursor, w, b], [out], name=f"conv{i}",
                             kernel_shape=[3, 3], pads=[1, 1, 1, 1], strides=[1, 1])
        )
        cursor = out

        if not last:
            # Форма (C, 1, 1), а не (C,): иначе ONNX выравнивает наклон по
            # последней оси и пытается броадкастить его на ширину кадра.
            s = add(f"s{i}", rng.uniform(0.0, 0.5, size=out_c).reshape(out_c, 1, 1))
            nodes.append(helper.make_node("PRelu", [cursor, s], [f"act{i}"], name=f"prelu{i}"))
            cursor = f"act{i}"

    nodes.append(
        helper.make_node("DepthToSpace", [cursor], ["shuffled"], blocksize=scale, mode="CRD")
    )

    sizes = add("sizes", np.array([1.0, 1.0, float(scale), float(scale)]))
    roi = add("roi", np.array([], dtype=np.float32))
    nodes.append(
        helper.make_node("Resize", ["input", roi, sizes], ["upsampled"], mode="nearest")
    )
    nodes.append(helper.make_node("Add", ["shuffled", "upsampled"], ["output"]))

    graph = helper.make_graph(
        nodes,
        "srvgg-synthetic",
        [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, None, None])],
        [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, None, None])],
        inits,
    )

    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 9
    onnx.checker.check_model(model)
    return model


# --- Команды -------------------------------------------------------------


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a - b) ** 2))
    if mse == 0:
        return float("inf")
    # Опорный размах — сам сигнал: активации сети не лежат в 0..1.
    peak = max(float(np.max(np.abs(a))), 1e-6)
    return 20 * np.log10(peak) - 10 * np.log10(mse)


def reference(model: onnx.ModelProto, image: np.ndarray) -> np.ndarray:
    import onnxruntime as ort

    session = ort.InferenceSession(
        model.SerializeToString(), providers=["CPUExecutionProvider"]
    )

    spec = session.get_inputs()[0]
    # Настоящие веса AnimeJaNai выложены уже в half, и граф принимает только
    # float16 — синтетические фикстуры при этом остаются float32. Тип входа
    # берём у самой модели, а не назначаем.
    dtype = np.float16 if "float16" in spec.type else np.float32

    out = session.run(None, {spec.name: image[None].astype(dtype)})[0]
    return out[0].astype(np.float32)


def check(
    model: onnx.ModelProto, image: np.ndarray, source: str, license_: str = ""
) -> tuple[bytes, dict, float, np.ndarray]:
    arch = parse(model)
    blob = pack(arch)
    meta = metadata(arch, blob, source, license_)

    got = emulate(blob, meta, image)
    want = reference(model, image)

    if got.shape != want.shape:
        raise SystemExit(f"форма разошлась: эмулятор {got.shape}, onnxruntime {want.shape}")

    return blob, meta, psnr(want, got), want


# Порог мягче, чем для самого шейдера: блоб уже в float16, и на десяти слоях
# накапливается именно ошибка округления, а не раскладки. Перепутанный порядок
# весов даёт единицы децибел, а не сорок — промахнуться невозможно.
THRESHOLD = 35.0


def mutate(blob: bytes, meta: dict) -> bytes:
    """Меняет местами два отсчёта ядра в первом слое.

    Нужна, чтобы проверить, что самопроверка вообще на что-то способна:
    зелёный тест, который не краснеет от подмены, ничего не доказывает.
    Подмена выбрана минимальной — переставлены всего два из девяти отсчётов
    одного слоя из десяти.
    """
    view = np.frombuffer(blob, dtype=np.float16).copy()
    spec = meta["layers"][0]
    base, in_g = spec["offset"] // 2, spec["inGroups"]

    for o in range(spec["out"]):
        a = base + ((o * TAPS + 0) * in_g) * PACK
        b = base + ((o * TAPS + 1) * in_g) * PACK
        span = in_g * PACK
        view[a : a + span], view[b : b + span] = (
            view[b : b + span].copy(),
            view[a : a + span].copy(),
        )

    return view.tobytes()


def cmd_selftest(args: argparse.Namespace) -> int:
    rng = np.random.default_rng(1)
    image = rng.random((3, 24, 32), dtype=np.float32)

    ok = True
    for num_feat, num_conv, scale in ((24, 8, 2), (64, 8, 2), (64, 16, 2), (24, 8, 4)):
        model = build_synthetic(num_feat, num_conv, scale)
        arch = parse(model)

        label = f"{num_feat}nf/{num_conv}nc/x{scale}"
        if (arch.num_feat, arch.num_conv, arch.scale) != (num_feat, num_conv, scale):
            print(f"  {label}: разбор дал {arch.num_feat}/{arch.num_conv}/x{arch.scale}")
            ok = False
            continue

        blob, meta, value, _ = check(model, image, f"синтетическая {label}")

        # Та же сверка на испорченном блобе: она обязана провалиться.
        broken = psnr(reference(model, image), emulate(mutate(blob, meta), meta, image))

        good = value >= THRESHOLD
        catches = broken < THRESHOLD
        verdict = "ok" if good and catches else ("РАСХОЖДЕНИЕ" if not good else "ТЕСТ СЛЕП")
        print(
            f"  {label:<16} {len(blob):>8} Б  "
            f"PSNR {value:6.1f} дБ, с подменой {broken:6.1f} дБ  {verdict}"
        )
        ok = ok and good and catches

    print("самопроверка пройдена" if ok else "самопроверка ПРОВАЛЕНА")
    return 0 if ok else 1


def cmd_convert(args: argparse.Namespace) -> int:
    model = onnx.load(args.model)
    arch = parse(model)

    print(f"архитектура из графа: num_feat={arch.num_feat} num_conv={arch.num_conv} scale={arch.scale}")

    rng = np.random.default_rng(1)
    image = rng.random((3, 24, 32), dtype=np.float32)
    blob, meta, value, want = check(model, image, Path(args.model).name, args.license)

    print(f"раскладка против onnxruntime: PSNR {value:.1f} дБ")
    if value < THRESHOLD:
        raise SystemExit("раскладка разошлась с моделью, файлы не записаны")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "weights.bin").write_bytes(blob)
    (out / "model.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")

    # Эталон для Э21: тот же кадр и тот же ожидаемый выход, с которыми будет
    # сверяться шейдер. Лежит рядом с весами, но в сборку не попадает — его
    # читает тест, а не приложение.
    ref = Path(args.reference) if args.reference else out / "reference.npz"
    ref.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(ref, input=image, expected=want)

    print(f"записано: {out / 'weights.bin'} ({len(blob)} Б), {out / 'model.json'}, {ref}")
    return 0


def cmd_fixture(args: argparse.Namespace) -> int:
    """Кладёт на диск всё, что нужно стенду `compact_check` для сверки шейдера.

    Формат нарочно примитивный — сырые fp16 без заголовков: стенд читает их из
    Rust и переливает в вебвью, и разбирать там контейнер было бы лишней
    поверхностью для ошибок. Размеры лежат в `model.json`.

    Раскладка совпадает с тем, что видит шейдер: по одному vec4 на пиксель,
    RGB плюс ноль в четвёртой компоненте. У первой свёртки три входных
    канала, вес в четвёртом нулевой — поэтому что лежит в альфе, неважно.
    """
    if args.model:
        model = onnx.load(args.model)
        source = Path(args.model).name
    else:
        model = build_synthetic(args.feat, args.conv, args.scale)
        source = f"синтетическая {args.feat}nf/{args.conv}nc"

    arch = parse(model)
    blob = pack(arch)
    meta = metadata(arch, blob, source, "")

    rng = np.random.default_rng(3)
    image = rng.random((3, args.height, args.width), dtype=np.float32)

    want = reference(model, image)
    got = emulate(blob, meta, image)
    value = psnr(want, got)
    if value < THRESHOLD:
        raise SystemExit(f"раскладка разошлась ещё до GPU: PSNR {value:.1f} дБ")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    planar = np.zeros((args.height, args.width, PACK), dtype=np.float32)
    planar[:, :, :3] = image.transpose(1, 2, 0)

    expected = np.zeros(
        (args.height * arch.scale, args.width * arch.scale, PACK), dtype=np.float32
    )
    expected[:, :, :3] = want.transpose(1, 2, 0)

    meta["fixture"] = {
        "width": args.width,
        "height": args.height,
        "layoutPsnr": round(value, 2),
    }

    (out / "weights.bin").write_bytes(blob)
    (out / "input.bin").write_bytes(planar.astype(np.float16).tobytes())
    (out / "expected.bin").write_bytes(expected.astype(np.float32).tobytes())
    (out / "model.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")

    print(
        f"фикстура {source}: {args.width}×{args.height} → "
        f"{args.width * arch.scale}×{args.height * arch.scale}, "
        f"раскладка на CPU: PSNR {value:.1f} дБ"
    )
    print(f"записано в {out}")
    return 0


def cmd_synth(args: argparse.Namespace) -> int:
    """Кладёт синтетическую сеть на диск — как фикстуру для отладки `convert`
    без скачанных весов."""
    model = build_synthetic(args.feat, args.conv, args.scale)
    onnx.save(model, args.out)
    print(f"записано: {args.out} ({args.feat}nf/{args.conv}nc/x{args.scale})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("selftest", help="синтетические сети, без скачанных весов")

    conv = sub.add_parser("convert", help="настоящая модель в блоб весов")
    conv.add_argument("model")
    conv.add_argument("out")
    conv.add_argument("--license", default="", help="лицензия весов, едет в model.json")
    conv.add_argument("--reference", default="", help="куда положить эталон для Э21")

    synth = sub.add_parser("synth", help="синтетическая сеть на диск, как фикстура")
    synth.add_argument("out")
    synth.add_argument("--feat", type=int, default=24)
    synth.add_argument("--conv", type=int, default=8)
    synth.add_argument("--scale", type=int, default=2)

    fix = sub.add_parser("fixture", help="данные для стенда compact_check")
    fix.add_argument("out")
    fix.add_argument("--feat", type=int, default=24)
    fix.add_argument("--conv", type=int, default=8)
    fix.add_argument("--scale", type=int, default=2)
    fix.add_argument("--width", type=int, default=64)
    fix.add_argument("--height", type=int, default=48)
    fix.add_argument("--model", default="", help="настоящая модель вместо синтетической")

    args = parser.parse_args()
    return {
        "selftest": cmd_selftest,
        "convert": cmd_convert,
        "synth": cmd_synth,
        "fixture": cmd_fixture,
    }[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())

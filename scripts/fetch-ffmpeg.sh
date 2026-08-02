#!/bin/sh
# Собирает минимальный LGPL ffmpeg-sidecar для целевой desktop-платформы.
# Исходники и SHA-256 запинены, готовый бинарь кладётся под именем, которое
# ожидает Tauri: ffmpeg-$TARGET_TRIPLE[.exe].
#
# Использование:
#   ./scripts/fetch-ffmpeg.sh
#   ./scripts/fetch-ffmpeg.sh x86_64-apple-darwin
#   ./scripts/fetch-ffmpeg.sh x86_64-unknown-linux-gnu /path/to/ffmpeg.tar.xz
#
# Windows-сборка запускается из MSYS2 MINGW64 shell.

set -eu

FFMPEG_VERSION="8.1.2"
FFMPEG_SHA256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
HOST_TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
TARGET_TRIPLE="${1:-$HOST_TRIPLE}"
SOURCE_ARCHIVE="${2:-}"
DEST_DIR="$SCRIPT_DIR/../src-tauri/binaries"
DEST_EXTENSION=""
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/anion-dl-ffmpeg.XXXXXX")"
ARCHIVE="$WORK_DIR/ffmpeg-$FFMPEG_VERSION.tar.xz"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT HUP INT TERM

case "$TARGET_TRIPLE" in
  aarch64-apple-darwin|x86_64-apple-darwin)
    TARGET_ARCH="${TARGET_TRIPLE%%-*}"
    set -- --target-os=darwin --arch="$TARGET_ARCH" --enable-securetransport
    if [ "$TARGET_TRIPLE" = "$HOST_TRIPLE" ]; then
      set -- "$@" --cc=clang
    else
      set -- "$@" --enable-cross-compile "--cc=clang -arch $TARGET_ARCH"
    fi
    if [ "$TARGET_ARCH" = "x86_64" ] && ! command -v nasm >/dev/null 2>&1; then
      set -- "$@" --disable-x86asm
    fi
    ;;
  x86_64-unknown-linux-gnu)
    if [ "$HOST_TRIPLE" != "$TARGET_TRIPLE" ]; then
      echo "Linux sidecar нужно собирать нативно на x86_64 Linux." >&2
      exit 1
    fi
    # OpenSSL даёт HTTPS на Linux. version3 сохраняет LGPL и совместим с
    # лицензией современных версий OpenSSL.
    set -- --target-os=linux --arch=x86_64 --cc=gcc --enable-openssl --enable-version3
    ;;
  x86_64-pc-windows-msvc)
    case "$(uname -s)" in
      MINGW*|MSYS*) ;;
      *)
        echo "Windows sidecar нужно собирать в MSYS2 MINGW64 shell." >&2
        exit 1
        ;;
    esac
    DEST_EXTENSION=".exe"
    # Бинарь собирается MinGW, но получает MSVC target suffix: это имя target,
    # под который Tauri собирает само приложение, а не ABI компилятора sidecar.
    set -- --target-os=mingw32 --arch=x86_64 --cc=gcc --enable-schannel --extra-ldflags=-static
    ;;
  *)
    echo "Неподдерживаемый target: $TARGET_TRIPLE" >&2
    exit 1
    ;;
esac

DEST="$DEST_DIR/ffmpeg-$TARGET_TRIPLE$DEST_EXTENSION"

if [ -n "$SOURCE_ARCHIVE" ]; then
  cp "$SOURCE_ARCHIVE" "$ARCHIVE"
else
  echo "Скачиваю FFmpeg $FFMPEG_VERSION из $FFMPEG_URL"
  curl -fL --retry 3 "$FFMPEG_URL" -o "$ARCHIVE"
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
else
  ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
fi

if [ "$ACTUAL_SHA256" != "$FFMPEG_SHA256" ]; then
  echo "SHA-256 архива не совпал." >&2
  echo "Ожидался: $FFMPEG_SHA256" >&2
  echo "Получен:  $ACTUAL_SHA256" >&2
  exit 1
fi

tar -xf "$ARCHIVE" -C "$WORK_DIR"
mkdir "$WORK_DIR/build"

JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || printf '4')"
cd "$WORK_DIR/build"
"../ffmpeg-$FFMPEG_VERSION/configure" \
  --prefix=/anion-dl/ffmpeg \
  --disable-everything \
  --disable-autodetect \
  --disable-doc \
  --disable-debug \
  --disable-programs \
  --enable-ffmpeg \
  --enable-small \
  --enable-static \
  --disable-shared \
  --enable-decoder=aac,h264 \
  --enable-demuxer=hls,mpegts \
  --enable-muxer=mp4 \
  --enable-protocol=file,http,https,tcp,tls,pipe \
  --enable-parser=aac,h264 \
  --enable-bsf=aac_adtstoasc \
  "$@"

make -j "$JOBS" ffmpeg

BUILT_FFMPEG="./ffmpeg$DEST_EXTENSION"
VERSION_OUTPUT="$($BUILT_FFMPEG -version 2>&1)"
if printf '%s\n' "$VERSION_OUTPUT" | grep -F -- '--enable-gpl' >/dev/null; then
  echo "Сборка неожиданно включает GPL." >&2
  exit 1
fi
if ! "$BUILT_FFMPEG" -L 2>&1 | grep -F 'GNU Lesser General Public' >/dev/null; then
  echo "Не удалось подтвердить LGPL-конфигурацию." >&2
  exit 1
fi

require_component() {
  LABEL="$1"
  PATTERN="$2"
  shift 2

  if ! "$@" 2>&1 | grep -E "$PATTERN" >/dev/null; then
    echo "В сборке отсутствует обязательный компонент: $LABEL" >&2
    exit 1
  fi
}

require_component "AAC decoder" '[[:space:]]aac[[:space:]]*$' "$BUILT_FFMPEG" -hide_banner -decoders
require_component "H.264 decoder" '[[:space:]]h264[[:space:]]*$' "$BUILT_FFMPEG" -hide_banner -decoders
require_component "HLS demuxer" '^[[:space:]]*D[[:space:]]+hls[[:space:]]*$' "$BUILT_FFMPEG" -hide_banner -demuxers
require_component "MPEG-TS demuxer" '^[[:space:]]*D[[:space:]]+mpegts[[:space:]]*$' "$BUILT_FFMPEG" -hide_banner -demuxers
require_component "MP4 muxer" '^[[:space:]]*E[[:space:]]+mp4[[:space:]]*$' "$BUILT_FFMPEG" -hide_banner -muxers
require_component "HTTPS protocol" '^[[:space:]]*https[[:space:]]*$' "$BUILT_FFMPEG" -hide_banner -protocols
require_component "pipe protocol" '^[[:space:]]*pipe[[:space:]]*$' "$BUILT_FFMPEG" -hide_banner -protocols
require_component "aac_adtstoasc BSF" '^aac_adtstoasc$' "$BUILT_FFMPEG" -hide_banner -bsfs

case "$TARGET_TRIPLE" in
  *-apple-darwin)
    NON_SYSTEM_DEPS="$(otool -L "$BUILT_FFMPEG" | awk 'NR > 1 {print $1}' | grep -Ev '^(/usr/lib/|/System/Library/)' || true)"
    if [ -n "$NON_SYSTEM_DEPS" ]; then
      echo "В бинаре обнаружены внешние динамические зависимости:" >&2
      printf '%s\n' "$NON_SYSTEM_DEPS" >&2
      exit 1
    fi
    ;;
  x86_64-pc-windows-msvc)
    MINGW_RUNTIME_DEPS="$(objdump -p "$BUILT_FFMPEG" | grep -Ei 'DLL Name: (libgcc|libstdc\+\+|libwinpthread)' || true)"
    if [ -n "$MINGW_RUNTIME_DEPS" ]; then
      echo "В Windows-бинаре обнаружены незабандленные MinGW runtime DLL:" >&2
      printf '%s\n' "$MINGW_RUNTIME_DEPS" >&2
      exit 1
    fi
    ;;
esac

mkdir -p "$DEST_DIR"
cp "$BUILT_FFMPEG" "$DEST.tmp"
chmod +x "$DEST.tmp"
mv "$DEST.tmp" "$DEST"

echo
echo "Готово: $DEST"
du -h "$DEST"
printf '%s\n' "$VERSION_OUTPUT" | sed -n '1,4p'

case "$TARGET_TRIPLE" in
  *-apple-darwin)
    echo "Динамические зависимости:"
    otool -L "$DEST"
    ;;
  x86_64-unknown-linux-gnu)
    echo "Динамические зависимости:"
    ldd "$DEST"
    ;;
  x86_64-pc-windows-msvc)
    echo "Импортируемые DLL:"
    objdump -p "$DEST" | grep 'DLL Name:' || true
    ;;
esac

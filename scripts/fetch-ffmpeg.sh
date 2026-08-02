#!/bin/sh
# Собирает минимальный LGPL ffmpeg для macOS и кладёт его туда, где sidecar
# ожидает Tauri. Исходники и SHA-256 запинены: повторный запуск не зависит от
# состава Homebrew и не может незаметно переключиться на другую версию.
#
# Использование:
#   ./scripts/fetch-ffmpeg.sh
#   ./scripts/fetch-ffmpeg.sh /path/to/ffmpeg-8.1.2.tar.xz  # без скачивания

set -eu

FFMPEG_VERSION="8.1.2"
FFMPEG_SHA256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
DEST_DIR="$SCRIPT_DIR/../src-tauri/binaries"
DEST="$DEST_DIR/ffmpeg-$TRIPLE"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/anion-dl-ffmpeg.XXXXXX")"
ARCHIVE="$WORK_DIR/ffmpeg-$FFMPEG_VERSION.tar.xz"
SOURCE_ARCHIVE="${1:-}"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT HUP INT TERM

case "$TRIPLE" in
  aarch64-apple-darwin|x86_64-apple-darwin) ;;
  *)
    echo "Этот скрипт собирает ffmpeg только для macOS, target: $TRIPLE" >&2
    exit 1
    ;;
esac

if [ -n "$SOURCE_ARCHIVE" ]; then
  cp "$SOURCE_ARCHIVE" "$ARCHIVE"
else
  echo "Скачиваю FFmpeg $FFMPEG_VERSION из $FFMPEG_URL"
  curl -fL "$FFMPEG_URL" -o "$ARCHIVE"
fi

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$FFMPEG_SHA256" ]; then
  echo "SHA-256 архива не совпал." >&2
  echo "Ожидался: $FFMPEG_SHA256" >&2
  echo "Получен:  $ACTUAL_SHA256" >&2
  exit 1
fi

tar -xf "$ARCHIVE" -C "$WORK_DIR"
mkdir "$WORK_DIR/build"

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || printf '4')"
set --
if [ "$TRIPLE" = "x86_64-apple-darwin" ] && ! command -v nasm >/dev/null 2>&1; then
  set -- --disable-x86asm
fi

cd "$WORK_DIR/build"
"../ffmpeg-$FFMPEG_VERSION/configure" \
  --prefix=/anion-dl/ffmpeg \
  --cc=clang \
  --disable-everything \
  --disable-autodetect \
  --disable-doc \
  --disable-debug \
  --disable-programs \
  --enable-ffmpeg \
  --enable-small \
  --enable-static \
  --disable-shared \
  --enable-securetransport \
  --enable-decoder=aac,h264 \
  --enable-demuxer=hls,mpegts \
  --enable-muxer=mp4 \
  --enable-protocol=file,http,https,tcp,tls,pipe \
  --enable-parser=aac,h264 \
  --enable-bsf=aac_adtstoasc \
  "$@"

make -j "$JOBS" ffmpeg

VERSION_OUTPUT="$(./ffmpeg -version 2>&1)"
if printf '%s\n' "$VERSION_OUTPUT" | grep -F -- '--enable-gpl' >/dev/null; then
  echo "Сборка неожиданно включает GPL." >&2
  exit 1
fi
if ! ./ffmpeg -L 2>&1 | grep -F 'GNU Lesser General Public' >/dev/null; then
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

require_component "AAC decoder" '[[:space:]]aac[[:space:]]*$' ./ffmpeg -hide_banner -decoders
require_component "H.264 decoder" '[[:space:]]h264[[:space:]]*$' ./ffmpeg -hide_banner -decoders
require_component "HLS demuxer" '^[[:space:]]*D[[:space:]]+hls[[:space:]]*$' ./ffmpeg -hide_banner -demuxers
require_component "MPEG-TS demuxer" '^[[:space:]]*D[[:space:]]+mpegts[[:space:]]*$' ./ffmpeg -hide_banner -demuxers
require_component "MP4 muxer" '^[[:space:]]*E[[:space:]]+mp4[[:space:]]*$' ./ffmpeg -hide_banner -muxers
require_component "HTTPS protocol" '^[[:space:]]*https[[:space:]]*$' ./ffmpeg -hide_banner -protocols
require_component "pipe protocol" '^[[:space:]]*pipe[[:space:]]*$' ./ffmpeg -hide_banner -protocols
require_component "aac_adtstoasc BSF" '^aac_adtstoasc$' ./ffmpeg -hide_banner -bsfs

NON_SYSTEM_DEPS="$(otool -L ./ffmpeg | awk 'NR > 1 {print $1}' | grep -Ev '^(/usr/lib/|/System/Library/)' || true)"
if [ -n "$NON_SYSTEM_DEPS" ]; then
  echo "В бинаре обнаружены внешние динамические зависимости:" >&2
  printf '%s\n' "$NON_SYSTEM_DEPS" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp ./ffmpeg "$DEST.tmp"
chmod +x "$DEST.tmp"
mv "$DEST.tmp" "$DEST"

echo
echo "Готово: $DEST"
du -h "$DEST"
printf '%s\n' "$VERSION_OUTPUT" | sed -n '1,4p'
echo "Динамические зависимости:"
otool -L "$DEST"

#!/usr/bin/env bash
# Rebuild src-tauri/icons/ from icon.svg and icon-small.svg.
#
# `tauri icon` makes the whole set from one picture. The 16 and 24px sizes
# are then redrawn from icon-small.svg, which is the icon simplified for
# them, and the .icns gets the margin macOS expects around an icon.
# Needs rsvg-convert (librsvg), magick (ImageMagick), python3 and macOS's
# iconutil — so it runs on a Mac.
set -euo pipefail

for tool in rsvg-convert magick python3 iconutil pnpm; do
  command -v "$tool" >/dev/null || {
    echo "make-icons: $tool not found; nothing changed" >&2
    exit 1
  }
done

cd "$(dirname "$0")/.."
icons=src-tauri/icons
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

rsvg-convert -w 1024 -h 1024 "$icons/icon.svg" -o "$work/icon.png"
pnpm exec tauri icon "$work/icon.png" --output "$icons"
# The phone sets aren't shipped, and nothing asks for the 64px PNG.
rm -rf "$icons/android" "$icons/ios" "$icons/64x64.png"

small() { rsvg-convert -w "$1" -h "$1" "$icons/icon-small.svg" -o "$2"; }
full() { rsvg-convert -w "$1" -h "$1" "$icons/icon.svg" -o "$2"; }
# The icon at 80% of the canvas, centred: the size macOS draws its own at.
# Full-bleed, it sits larger than its neighbours in the Dock.
padded() {
  local inner=$(($1 * 824 / 1024))
  rsvg-convert -w "$inner" -h "$inner" "$icons/icon.svg" -o "$work/inner.png"
  magick "$work/inner.png" -background none -gravity center \
    -extent "$1x$1" "PNG32:$2"
}

# icon.ico: PNG layers, 32px first, as `tauri icon` writes it.
small 16 "$work/16.png"
small 24 "$work/24.png"
for size in 32 48 64 256; do full "$size" "$work/$size.png"; done
python3 - "$icons/icon.ico" "$work" 32 16 24 48 64 256 <<'PY'
import struct, sys

out, work, sizes = sys.argv[1], sys.argv[2], [int(s) for s in sys.argv[3:]]
layers = [open(f"{work}/{size}.png", "rb").read() for size in sizes]
offset = 6 + 16 * len(sizes)
head = struct.pack("<HHH", 0, 1, len(sizes))
for size, png in zip(sizes, layers):
    # 256 is written as 0.
    head += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset)
    offset += len(png)
open(out, "wb").write(head + b"".join(layers))
PY

# icon.icns
iconset="$work/icon.iconset"
mkdir "$iconset"
small 16 "$iconset/icon_16x16.png"
padded 32 "$iconset/icon_16x16@2x.png"
for size in 32 128 256 512; do
  padded "$size" "$iconset/icon_${size}x${size}.png"
  padded "$((size * 2))" "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o "$icons/icon.icns"

# The browser tab, for `pnpm dev`.
cp "$icons/icon-small.svg" public/icon.svg

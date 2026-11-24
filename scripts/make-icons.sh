#!/usr/bin/env bash
# Rebuild src-tauri/icons/ from icon.svg and icon-small.svg.
#
# `tauri icon` makes the whole set from one picture. The 16 and 24px sizes
# are then redrawn from icon-small.svg, which is the icon simplified for
# them. Needs rsvg-convert (librsvg), magick (ImageMagick) and, for the
# .icns, macOS's iconutil.
set -euo pipefail

cd "$(dirname "$0")/.."
icons=src-tauri/icons
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

rsvg-convert -w 1024 -h 1024 "$icons/icon.svg" -o "$work/icon.png"
npx tauri icon "$work/icon.png" --output "$icons"
# The phone sets aren't shipped, and nothing asks for the 64px PNG.
rm -rf "$icons/android" "$icons/ios" "$icons/64x64.png"

small() { rsvg-convert -w "$1" -h "$1" "$icons/icon-small.svg" -o "$2"; }
full() { rsvg-convert -w "$1" -h "$1" "$icons/icon.svg" -o "$2"; }

# icon.ico: 32px first, as `tauri icon` orders it.
small 16 "$work/16.png"
small 24 "$work/24.png"
for size in 32 48 64 256; do full "$size" "$work/$size.png"; done
magick "$work/32.png" "$work/16.png" "$work/24.png" "$work/48.png" \
  "$work/64.png" "$work/256.png" "$icons/icon.ico"

# icon.icns
set="$work/icon.iconset"
mkdir "$set"
small 16 "$set/icon_16x16.png"
for size in 32 128 256 512; do
  full "$size" "$set/icon_${size}x${size}.png"
  full "$((size * 2))" "$set/icon_${size}x${size}@2x.png"
done
full 32 "$set/icon_16x16@2x.png"
iconutil -c icns "$set" -o "$icons/icon.icns"

# The browser tab, for `npm run dev`.
cp "$icons/icon-small.svg" public/icon.svg

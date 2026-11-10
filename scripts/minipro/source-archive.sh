#!/usr/bin/env bash
# Package the corresponding source for the minipro sidecar, for GPL-3.0 §6.
#
#   scripts/minipro/source-archive.sh <output dir> [<name suffix>]
#
# Writes <output dir>/minipro-sidecar-source_<suffix>.tar.gz and prints its
# path on stdout (the file list goes to stderr). The suffix defaults
# to the app version. It holds everything needed to rebuild the sidecar that
# ships in that release's installers:
#
#   minipro-<commit>.tar.gz   the vendor/minipro submodule at its pinned commit
#   libusb-<ver>.tar.bz2      the pinned upstream libusb release (+ .asc)
#   zlib-<ver>.tar.gz         the pinned upstream zlib release (+ .asc), Windows only
#   burnwright/               the build scripts and Windows compat shim
#   README.txt                what's what, and how to rebuild
#
# The release workflow attaches the archive to every GitHub release next to
# the installers.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=scripts/minipro/versions.sh
. "$here/versions.sh"

[ $# -ge 1 ] || { echo "usage: $0 <output dir> [<name suffix>]" >&2; exit 2; }
outdir="$(mkdir -p "$1" && cd "$1" && pwd)"
suffix="${2:-$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$root/src-tauri/tauri.conf.json" | head -1)}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
fetch() { # <url> <sha256> <dest dir>
  local file
  file="$3/${1##*/}"
  curl -fsSL --retry 3 -o "$file" "$1"
  [ "$(sha256 "$file")" = "$2" ] || { echo "hash mismatch for $1" >&2; exit 1; }
  curl -fsSL --retry 3 -o "$file.asc" "$1.asc"
}

name="minipro-sidecar-source_$suffix"
stage="$(mktemp -d)/$name"
trap 'rm -rf "$(dirname "$stage")"' EXIT
mkdir -p "$stage/burnwright/scripts" "$stage/burnwright/.github"

sub="$root/vendor/minipro"
commit="$(git -C "$sub" rev-parse HEAD)"
tag="$(git -C "$sub" describe --tags --exact-match HEAD 2>/dev/null || echo none)"
git -C "$sub" archive --format=tar.gz --prefix="minipro-$commit/" -o "$stage/minipro-$commit.tar.gz" HEAD
fetch "$LIBUSB_URL" "$LIBUSB_SHA256" "$stage"
fetch "$ZLIB_URL" "$ZLIB_SHA256" "$stage"
cp -R "$root/scripts/minipro" "$stage/burnwright/scripts/"
cp -R "$root/.github/minipro-windows" "$stage/burnwright/.github/"
burnwright_commit="$(git -C "$root" rev-parse HEAD)"

cat >"$stage/README.txt" <<EOF
Corresponding source for the minipro sidecar ("$SIDECAR_NAME") shipped in
burnwright $suffix's installers. burnwright's own source is in the GitHub
release's source archives and at
https://github.com/IamMrCupp/burnwright/tree/$burnwright_commit

minipro-$commit.tar.gz
  minipro (GPL-3.0-or-later), tag $tag, commit $commit,
  from $MINIPRO_UPSTREAM. Unmodified.
libusb-$LIBUSB_VERSION.tar.bz2 (+ .asc)
  libusb (LGPL-2.1-or-later), statically linked on every platform.
  SHA-256 $LIBUSB_SHA256. Unmodified.
zlib-$ZLIB_VERSION.tar.gz (+ .asc)
  zlib (zlib licence), statically linked into the Windows build only.
  SHA-256 $ZLIB_SHA256. Unmodified.
burnwright/scripts/minipro/
  build-sidecar.sh builds all of the above into the sidecar; versions.sh pins
  the third-party sources. The other scripts check and package the result.
burnwright/.github/minipro-windows/compat.h
  Force-included on Windows to supply stpcpy() (upstream MR !301).

To rebuild, check out burnwright at $burnwright_commit with
\`git submodule update --init\`, then run scripts/minipro/build-sidecar.sh
(on Windows, from an MSYS2 UCRT64 shell). The script downloads the same
libusb and zlib tarballs and checks their hashes.
EOF

tar -czf "$outdir/$name.tar.gz" -C "$(dirname "$stage")" "$name"
echo "$outdir/$name.tar.gz"
tar -tzf "$outdir/$name.tar.gz" | grep -v '/$' | sed 's/^/  /' >&2

#!/usr/bin/env bash
# Build the minipro sidecar that ships inside every burnwright installer.
#
#   scripts/minipro/build-sidecar.sh [--target <rust target triple>]
#
# Produces, for Tauri's externalBin / resources (see src-tauri/tauri.conf.json):
#
#   src-tauri/binaries/burnwright-minipro-<triple>[.exe]   the CLI
#   src-tauri/binaries/minipro/                             databases + licences
#
# minipro is built from the vendor/minipro submodule, unmodified: the source is
# exported with `git archive` into target/minipro-sidecar/ and built there, so
# the submodule's working tree is never touched. libusb is built from a pinned,
# hash-checked upstream release (scripts/minipro/versions.sh) and linked
# statically, so the binary needs nothing beyond what the OS ships:
#
#   macOS    libSystem, IOKit, CoreFoundation, Security, libz (all in the OS)
#   Linux    glibc, libz. libusb is built without udev (sysfs + netlink).
#   Windows  a fully static .exe (LDFLAGS=-static), built in MSYS2 UCRT64 with
#            the libusb backend (USB=src/usb_nix.o) and the compat.h shim from
#            #12 / #38 (see .github/workflows/minipro-windows.yml). zlib is
#            built from a pinned release too, so every library in the .exe
#            comes from source we can point at.
#
# Needs: git, make, a C compiler, pkg-config, curl, bzip2, tar, and zlib
# headers (macOS and Linux). On Windows, run it from an MSYS2 UCRT64 shell with
# git, make and mingw-w64-ucrt-x86_64-{gcc,pkgconf} installed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=scripts/minipro/versions.sh
. "$here/versions.sh"

triple=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) triple="$2"; shift 2 ;;
    --target=*) triple="${1#--target=}"; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$triple" ]; then
  if ! command -v rustc >/dev/null 2>&1; then
    echo "error: rustc not on PATH; pass --target <triple>" >&2
    exit 2
  fi
  triple="$(rustc -vV | sed -n 's/^host: //p')"
fi

log() { printf '\n==> %s\n' "$*" >&2; }
die() { echo "error: $*" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
exe=""
host_args=()
case "$triple" in
  *-apple-darwin)
    os=macos
    case "$triple" in
      aarch64-*) arch=arm64; export MACOSX_DEPLOYMENT_TARGET=11.0 ;;
      x86_64-*) arch=x86_64; export MACOSX_DEPLOYMENT_TARGET=10.13 ;;
      *) die "unsupported macOS target $triple" ;;
    esac
    cc="clang -arch $arch"
    [ "$arch" = "$(uname -m)" ] || cross_host="--host=$triple"
    host_args=(${cross_host:+"$cross_host"})
    ;;
  x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu)
    os=linux
    cc="${CC:-gcc}"
    [ "${triple%%-*}" = "$(uname -m)" ] || die "cross-compiling Linux targets isn't supported"
    ;;
  x86_64-pc-windows-msvc|x86_64-pc-windows-gnu)
    os=windows
    exe=.exe
    cc=gcc
    [ -n "${MSYSTEM:-}" ] || die "on Windows, run this from an MSYS2 UCRT64 shell"
    ;;
  *) die "unsupported target $triple" ;;
esac

work="$root/target/minipro-sidecar/$triple"
downloads="$root/target/minipro-sidecar/downloads"
out_bin_dir="$root/src-tauri/binaries"
out_res_dir="$out_bin_dir/minipro"
sidecar="$out_bin_dir/$SIDECAR_NAME-$triple$exe"

# Paths handed to the MinGW compiler must be Windows paths.
native_path() {
  if [ "$os" = windows ]; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

rm -rf "$work"
mkdir -p "$work" "$downloads" "$out_bin_dir"

# --- minipro source -----------------------------------------------------------
sub="$root/vendor/minipro"
git -C "$sub" rev-parse --verify -q HEAD >/dev/null \
  || die "vendor/minipro is empty; run: git submodule update --init vendor/minipro"
minipro_commit="$(git -C "$sub" rev-parse HEAD)"
minipro_date="$(git -C "$sub" show -s --format=%ci HEAD)"
minipro_version="$(sed -n 's/^VERSION *= *//p' "$sub/Makefile" | head -1)"
minipro_tag="$(git -C "$sub" describe --tags --exact-match HEAD 2>/dev/null || true)"
pinned="$(git -C "$root" rev-parse -q --verify "HEAD:vendor/minipro" 2>/dev/null || true)"
if [ -n "$pinned" ] && [ "$pinned" != "$minipro_commit" ]; then
  echo "warning: vendor/minipro is at $minipro_commit but the superproject pins $pinned" >&2
fi
if [ -n "$(git -C "$sub" status --porcelain --untracked-files=no)" ]; then
  echo "warning: vendor/minipro has local changes; building the committed HEAD only" >&2
fi

log "minipro $minipro_version ${minipro_tag:+(tag $minipro_tag) }@ $minipro_commit -> $triple"
mkdir -p "$work/minipro"
git -C "$sub" archive --format=tar HEAD | tar -x -C "$work/minipro"

# --- pinned third-party sources ---------------------------------------------
# fetch <url> <sha256> -> path of the verified tarball in $downloads
fetch() {
  local url="$1" want="$2" file="$downloads/${1##*/}"
  if [ ! -f "$file" ] || [ "$(sha256 "$file")" != "$want" ]; then
    log "download ${url##*/}"
    curl -fsSL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  local got
  got="$(sha256 "$file")"
  [ "$got" = "$want" ] || die "${url##*/}: hash mismatch: got $got, want $want"
  printf '%s' "$file"
}

# --- libusb (static) ----------------------------------------------------------
tarball="$(fetch "$LIBUSB_URL" "$LIBUSB_SHA256")"
log "build libusb $LIBUSB_VERSION (static)"
tar -xjf "$tarball" -C "$work"
prefix="$work/libusb-prefix"
libusb_args=(--prefix="$prefix" --disable-shared --enable-static)
case "$os" in
  linux) libusb_args+=(--disable-udev) ;;
  macos) libusb_args+=("${host_args[@]}") ;;
esac
(
  cd "$work/libusb-$LIBUSB_VERSION"
  CC="$cc" CFLAGS="-O2" ./configure "${libusb_args[@]}" >"$work/libusb-configure.log" 2>&1 \
    || { tail -40 "$work/libusb-configure.log"; exit 1; }
  make -j"$jobs" >"$work/libusb-make.log" 2>&1 || { tail -40 "$work/libusb-make.log"; exit 1; }
  make install >/dev/null
)
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
[ "$(pkg-config --modversion libusb-1.0)" = "$LIBUSB_VERSION" ] \
  || die "pkg-config doesn't see the libusb we just built"

# --- zlib (static, Windows only) ----------------------------------------------
if [ "$os" = windows ]; then
  log "build zlib $ZLIB_VERSION (static)"
  tar -xzf "$(fetch "$ZLIB_URL" "$ZLIB_SHA256")" -C "$work"
  zprefix="$work/zlib-prefix"
  make -C "$work/zlib-$ZLIB_VERSION" -f win32/Makefile.gcc -j"$jobs" libz.a \
    CC="$cc" CFLAGS="-O2 -Wall" >"$work/zlib-make.log" 2>&1 || { tail -40 "$work/zlib-make.log"; exit 1; }
  mkdir -p "$zprefix/include" "$zprefix/lib"
  cp "$work/zlib-$ZLIB_VERSION"/{zlib.h,zconf.h} "$zprefix/include/"
  cp "$work/zlib-$ZLIB_VERSION/libz.a" "$zprefix/lib/"
fi

# --- minipro ------------------------------------------------------------------
log "build minipro"
make_args=(
  -C "$work/minipro" -j"$jobs"
  CC="$cc"
  GIT_BRANCH="${minipro_tag:-detached}"
  GIT_HASH="$minipro_commit"
  GIT_DATE="$minipro_date"
)
libusb_static_libs="$(pkg-config --static --libs libusb-1.0)"
case "$os" in
  macos|linux)
    # The Makefile adds `pkg-config --libs libusb-1.0` (-L<prefix> -lusb-1.0,
    # which resolves to the static archive: the prefix has no shared lib).
    # EXTRA_LIBS lands after it and adds libusb's private deps.
    make_args+=(CFLAGS="-O2 -Wall" EXTRA_LIBS="$libusb_static_libs")
    ;;
  windows)
    # Same glue as .github/workflows/minipro-windows.yml (#38): force-include
    # compat.h via the environment (so the Makefile's CPPFLAGS += survives),
    # pick the libusb backend, link everything statically.
    CPPFLAGS="-include $(native_path "$root/.github/minipro-windows/compat.h")"
    export CPPFLAGS
    # Our zlib comes first on -I/-L, ahead of anything in the MSYS2 prefix.
    make_args+=(
      USB=src/usb_nix.o
      CFLAGS="-O2 -Wall -I$(native_path "$zprefix/include") $(pkg-config --cflags libusb-1.0)"
      LDFLAGS="-static -Wl,-Map=minipro.map"
      LIBS="-L$(native_path "$zprefix/lib") $libusb_static_libs"
    )
    ;;
esac
make "${make_args[@]}" >"$work/minipro-make.log" 2>&1 || { tail -60 "$work/minipro-make.log"; exit 1; }
built="$work/minipro/minipro$exe"
[ -x "$built" ] || die "make finished but $built is missing"
case "$os" in
  linux|windows) strip "$built" ;;
  # macOS: leave it alone. The linker ad-hoc signs arm64 binaries and strip
  # would invalidate that signature.
esac

# --- dependency check ---------------------------------------------------------
log "check runtime dependencies"
case "$os" in
  macos)
    otool -L "$built"
    if otool -L "$built" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)'; then
      die "sidecar links libraries outside /usr/lib and /System"
    fi
    ;;
  linux)
    readelf -d "$built" | grep NEEDED
    if readelf -d "$built" | grep NEEDED | grep -viE 'lib(c|z|m|pthread|dl|rt)\.so|ld-linux'; then
      die "sidecar needs a shared library beyond glibc and zlib"
    fi
    ;;
  windows)
    objdump -p "$built" | grep 'DLL Name'
    if objdump -p "$built" | grep 'DLL Name' | grep -iE 'libusb|libz|zlib|libwinpthread|libgcc|msys-'; then
      die "sidecar isn't fully static"
    fi
    ;;
esac

# --- outputs ------------------------------------------------------------------
log "stage $sidecar"
rm -f "$out_bin_dir/$SIDECAR_NAME-$triple" "$out_bin_dir/$SIDECAR_NAME-$triple.exe"
cp "$built" "$sidecar"
chmod 755 "$sidecar"

rm -rf "$out_res_dir"
mkdir -p "$out_res_dir"
cp "$work/minipro/infoic.xml" "$work/minipro/logicic.xml" "$out_res_dir/"
cp "$work/minipro/LICENSE" "$out_res_dir/LICENSE.minipro.txt"
cp "$work/libusb-$LIBUSB_VERSION/COPYING" "$out_res_dir/COPYING.libusb.txt"

windows_note=""
if [ "$os" = windows ]; then
  cp "$work/zlib-$ZLIB_VERSION/LICENSE" "$out_res_dir/LICENSE.zlib.txt"
  windows_note="
zlib $ZLIB_VERSION, statically linked (Windows build only).
  Licence:  zlib licence (LICENSE.zlib.txt)
  Source:   $ZLIB_URL
  SHA-256:  $ZLIB_SHA256

The MinGW-w64 C runtime and libgcc are linked under their runtime-library
exceptions."
  # winpthreads is MIT-licensed; ship its notice if the static link used it.
  if grep -qi winpthread "$work/minipro/minipro.map"; then
    lic="$(find "$MINGW_PREFIX/share/licenses" -ipath '*winpthread*' -type f | head -1)"
    [ -n "$lic" ] || die "minipro links winpthreads but its licence wasn't found"
    cp "$lic" "$out_res_dir/LICENSE.winpthreads.txt"
    windows_note="$windows_note
winpthreads (MinGW-w64), statically linked. Licence: LICENSE.winpthreads.txt."
  fi
fi

burnwright_commit="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
cat >"$out_res_dir/NOTICE.txt" <<EOF
burnwright bundles the minipro command-line tool as "$SIDECAR_NAME".

minipro $minipro_version, built from unmodified upstream source.
  Licence:  GNU General Public License v3.0 or later (LICENSE.minipro.txt)
  Upstream: $MINIPRO_UPSTREAM
  Tag:      ${minipro_tag:-none}
  Commit:   $minipro_commit ($minipro_date)
  Source:   $MINIPRO_UPSTREAM/-/tree/$minipro_commit

libusb $LIBUSB_VERSION, statically linked into minipro.
  Licence:  GNU Lesser General Public License v2.1 or later (COPYING.libusb.txt)
  Source:   $LIBUSB_URL
  SHA-256:  $LIBUSB_SHA256
$windows_note

Built for $triple from burnwright commit $burnwright_commit with the scripts in
https://github.com/IamMrCupp/burnwright/tree/$burnwright_commit/scripts/minipro

Corresponding source: every burnwright release on GitHub carries a
minipro-sidecar-source archive with the exact minipro and libusb sources and
build scripts used for its installers:
https://github.com/IamMrCupp/burnwright/releases

The infoic.xml and logicic.xml chip databases are part of minipro and are
covered by its licence. No XGecu firmware, drivers or algorithm files are
included.
EOF

# --- smoke test ---------------------------------------------------------------
if [ -z "${cross_host:-}" ]; then
  log "smoke test"
  "$sidecar" --infoic "$(native_path "$out_res_dir/infoic.xml")" \
    --logicic "$(native_path "$out_res_dir/logicic.xml")" --version 2>&1 | sed 's/^/  /'
fi

log "done: $sidecar"
ls -l "$sidecar" "$out_res_dir"

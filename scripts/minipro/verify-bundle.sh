#!/usr/bin/env bash
# Check that a built installer carries a working minipro sidecar, run from
# where an installed copy of burnwright would find it, not from the build tree.
#
#   scripts/minipro/verify-bundle.sh macos <burnwright.dmg>
#   scripts/minipro/verify-bundle.sh linux <burnwright.deb> <burnwright.AppImage>
#
# macOS: copies the .app out of the .dmg (as a drag-install would), lists the
#   sidecar's libraries with `otool -L` and rejects anything outside the OS.
# Linux: shows the .deb's control fields and contents (`dpkg-deb -I`/`-c`),
#   installs it with apt (needs sudo) and runs /usr/bin/burnwright-minipro;
#   then extracts the AppImage and runs the sidecar from inside it.
#
# Each sidecar must report its version and database counts, list more than a
# thousand chips, and say "No programmer found" (CI has no hardware). The
# databases are passed by their bundled path, with an empty PATH, from an
# unrelated working directory: nothing may come from the build tree or PATH.
# Windows has its own script: verify-bundle.ps1.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/minipro/versions.sh
. "$here/versions.sh"

die() { echo "FAIL: $*" >&2; exit 1; }
section() { printf '\n=== %s ===\n' "$*"; }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# check_sidecar <label> <sidecar binary> <bundled minipro resource dir>
check_sidecar() {
  local label="$1" bin="$2" res="$3" out
  section "$label: $bin"
  [ -x "$bin" ] || die "$label: no executable sidecar at $bin"
  for f in infoic.xml logicic.xml LICENSE.minipro.txt COPYING.libusb.txt NOTICE.txt; do
    [ -s "$res/$f" ] || die "$label: missing $res/$f"
  done
  grep -q "Commit:" "$res/NOTICE.txt" || die "$label: NOTICE.txt doesn't record the minipro commit"

  local db=(--infoic "$res/infoic.xml" --logicic "$res/logicic.xml")
  # Run from an empty directory with no PATH: minipro also looks for the
  # databases in the working directory, and must not find stray copies.
  run() { (cd "$scratch" && env -i HOME="$scratch" PATH=/nonexistent "$bin" "$@"); }

  out="$(run "${db[@]}" --version 2>&1)" || { echo "$out"; die "$label: --version failed"; }
  echo "$out"
  grep -q "minipro version" <<<"$out" || die "$label: --version didn't print a version"
  grep -qE "T48:[[:space:]]+[0-9]{4,} devices" <<<"$out" || die "$label: --version didn't count the T48 database"
  grep -qF "Using overridden database file $res/infoic.xml" <<<"$out" \
    || die "$label: didn't use the bundled infoic.xml"

  local n
  n="$(run "${db[@]}" -q tl866ii -l 2>/dev/null | wc -l | tr -d ' ')"
  echo "-q tl866ii -l: $n devices"
  [ "$n" -gt 1000 ] || die "$label: -l listed only $n devices"

  run "${db[@]}" -q t48 -d AT27C256@DIP28 >/dev/null 2>&1 || die "$label: -d AT27C256@DIP28 failed"

  out="$(run -k 2>&1 || true)"
  echo "-k: $out"
  grep -q "No programmer found" <<<"$out" || die "$label: -k gave unexpected output"
  echo "$label: OK"
}

verify_macos() {
  local dmg="$1" mnt="$scratch/mnt" apps="$scratch/Applications"
  [ -f "$dmg" ] || die "no such dmg: $dmg"
  section "install $(basename "$dmg")"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null
  mkdir -p "$apps"
  ditto "$mnt/burnwright.app" "$apps/burnwright.app"
  hdiutil detach "$mnt" >/dev/null
  local app="$apps/burnwright.app"
  find "$app" -type f | sed "s|^$apps/||"

  local bin="$app/Contents/MacOS/$SIDECAR_NAME"
  section "otool -L $SIDECAR_NAME"
  otool -L "$bin"
  if otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)'; then
    die "sidecar links a library that macOS doesn't ship (Homebrew, @rpath, ...)"
  fi
  lipo -info "$bin"
  check_sidecar "macOS .app" "$bin" "$app/Contents/Resources/minipro"
}

# check_libs <ELF>: every library resolves, and libusb isn't one of them.
check_libs() {
  local libs
  libs="$(ldd "$1")"
  echo "$libs"
  if grep -q "not found" <<<"$libs"; then die "$1 has unresolved libraries"; fi
  if grep -q libusb <<<"$libs"; then die "$1 links a shared libusb"; fi
}

verify_linux() {
  local deb="$1" appimage="$2"
  [ -f "$deb" ] || die "no such deb: $deb"
  [ -f "$appimage" ] || die "no such AppImage: $appimage"

  section "dpkg-deb -I $(basename "$deb")"
  dpkg-deb -I "$deb"
  # Capture listings before grepping them: `cmd | grep -q` under pipefail
  # fails when grep exits early and cmd dies of SIGPIPE.
  local listing
  section "dpkg-deb -c $(basename "$deb")"
  listing="$(dpkg-deb -c "$deb")"
  echo "$listing"
  grep -qE "(\./)?usr/bin/$SIDECAR_NAME\$" <<<"$listing" || die "deb lacks /usr/bin/$SIDECAR_NAME"
  grep -qE "(\./)?usr/lib/burnwright/minipro/infoic\.xml\$" <<<"$listing" \
    || die "deb lacks /usr/lib/burnwright/minipro/infoic.xml"
  grep -q zlib1g <<<"$(dpkg-deb -f "$deb" Depends)" || die "deb doesn't declare zlib1g"

  section "install the deb"
  sudo apt-get install -y --no-install-recommends "$(realpath "$deb")"
  check_libs "/usr/bin/$SIDECAR_NAME"
  check_sidecar ".deb (installed)" "/usr/bin/$SIDECAR_NAME" /usr/lib/burnwright/minipro

  section "extract $(basename "$appimage")"
  local x="$scratch/appimage"
  mkdir -p "$x"
  cp "$appimage" "$x/app.AppImage"
  chmod +x "$x/app.AppImage"
  (cd "$x" && ./app.AppImage --appimage-extract >/dev/null)
  local root="$x/squashfs-root"
  (cd "$root" && find . -path ./usr/share/icons -prune -o -type f -print | sort)
  local bin="$root/usr/bin/$SIDECAR_NAME"
  check_libs "$bin"
  check_sidecar "AppImage" "$bin" "$root/usr/lib/burnwright/minipro"
}

case "${1:-}" in
  macos) [ $# -eq 2 ] || die "usage: $0 macos <dmg>"; verify_macos "$2" ;;
  linux) [ $# -eq 3 ] || die "usage: $0 linux <deb> <AppImage>"; verify_linux "$2" "$3" ;;
  *) die "usage: $0 macos <dmg> | linux <deb> <AppImage>" ;;
esac
echo
echo "All sidecar checks passed."

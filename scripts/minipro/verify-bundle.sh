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
#   checks the udev rules and maintainer scripts the .deb ships, then removes
#   it again and checks the rules went with it; then extracts the AppImage and
#   runs the sidecar from inside it.
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

# check_sidecar <label> <sidecar binary> <bundled minipro resource dir> [t76]
# With "t76", the build must also count a T76 database.
check_sidecar() {
  local label="$1" bin="$2" res="$3" variant="${4:-stable}" out
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
  if [ "$variant" = t76 ]; then
    grep -qE "T76:[[:space:]]+[0-9]{4,} devices" <<<"$out" || die "$label: --version didn't count the T76 database"
  fi
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

  local name res variant bin
  for name in "$SIDECAR_NAME" "$T76_SIDECAR_NAME"; do
    res=minipro variant=stable
    [ "$name" = "$T76_SIDECAR_NAME" ] && res=minipro-t76 variant=t76
    bin="$app/Contents/MacOS/$name"
    section "otool -L $name"
    otool -L "$bin"
    if otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)'; then
      die "$name links a library that macOS doesn't ship (Homebrew, @rpath, ...)"
    fi
    lipo -info "$bin"
    check_sidecar "macOS .app ($variant)" "$bin" "$app/Contents/Resources/$res" "$variant"
  done
}

# check_libs <ELF>: every library resolves, and libusb isn't one of them.
check_libs() {
  local libs
  libs="$(ldd "$1")"
  echo "$libs"
  if grep -q "not found" <<<"$libs"; then die "$1 has unresolved libraries"; fi
  if grep -q libusb <<<"$libs"; then die "$1 links a shared libusb"; fi
}

UDEV_RULES=60-burnwright-minipro.rules
UDEV_RULES_PATH="/usr/lib/udev/rules.d/$UDEV_RULES"

# check_deb_scripts <deb>: the .deb carries the udev rules and a postinst and
# postrm that reload udev.
check_deb_scripts() {
  local deb="$1" listing="$2" ctl="$scratch/control"
  section "udev rules and maintainer scripts in $(basename "$deb")"
  grep -E "(\./)?${UDEV_RULES_PATH#/}\$" <<<"$listing" || die "deb lacks $UDEV_RULES_PATH"
  grep -E "^-rw-r--r-- (root/root|0/0) .*(\./)?${UDEV_RULES_PATH#/}\$" <<<"$listing" >/dev/null \
    || die "$UDEV_RULES_PATH isn't a 0644 root-owned file in the deb"
  dpkg-deb -e "$deb" "$ctl"
  for s in postinst postrm; do
    [ -x "$ctl/$s" ] || die "deb has no executable $s"
    grep -q "udevadm control --reload-rules" "$ctl/$s" || die "$s doesn't reload udev"
    sh -n "$ctl/$s" || die "$s isn't valid sh"
  done
}

# check_udev_rules <rules file>: the rules parse, and flag every programmer.
check_udev_rules() {
  local rules="$1" out
  section "udev rules: $rules"
  [ -f "$rules" ] || die "no udev rules at $rules"
  cat "$rules"
  cmp -s "$rules" "$here/../../packaging/linux/udev/$UDEV_RULES" \
    || die "installed $UDEV_RULES differs from packaging/linux/udev/$UDEV_RULES"
  local id
  for id in 04d8:e11c a466:0a53 a466:1a86; do
    grep -qE "ATTR\\{idVendor\\}==\"${id%:*}\", ATTR\\{idProduct\\}==\"${id#*:}\", ENV\\{ID_MINIPRO\\}=\"1\"" "$rules" \
      || die "udev rules don't flag $id"
  done
  grep -qE '^ENV\{ID_MINIPRO\}=="1", TAG\+="uaccess", MODE="0660", GROUP="plugdev"$' "$rules" \
    || die "udev rules don't grant uaccess/plugdev"
  # Every rule line is key/value pairs udev knows; anything else is a typo.
  if grep -vE '^[[:space:]]*(#|$)' "$rules" \
      | grep -vE '^(ACTION|SUBSYSTEM|ENV\{[A-Z_]+\}|ATTR\{[a-zA-Z]+\}|TAG|MODE|GROUP|LABEL)[!=+]'; then
    die "udev rules have a line that isn't a known rule"
  fi

  if udevadm verify --help >/dev/null 2>&1; then
    # systemd 253+ (Ubuntu 24.04 and later).
    out="$(udevadm verify "$rules" 2>&1)" || { echo "$out"; die "udevadm verify rejected $UDEV_RULES"; }
    echo "udevadm verify: $out"
  else
    # Older udev (Ubuntu 22.04) has no verify, but `udevadm test` parses every
    # rules file, logging any line it can't use with the file's name.
    out="$(sudo udevadm test --action=change /sys/class/mem/null 2>&1)" || true
    grep -F "$UDEV_RULES" <<<"$out" || true
    if grep -F "$UDEV_RULES" <<<"$out" | grep -iE "invalid|ignor|unknown|fail|error|warn|deprecat"; then
      die "udevadm test logged problems with $UDEV_RULES"
    fi
    grep -qF "$UDEV_RULES" <<<"$out" || echo "note: udevadm test didn't mention $UDEV_RULES (only syntax-grepped)"
  fi
}

# check_maintainer_script <pkg> <postinst|postrm> <arg>: the installed script
# exits 0 without udev and with a broken one, and reloads udev when it can.
check_maintainer_script() {
  local pkg="$1" name="$2" arg="$3" script="/var/lib/dpkg/info/$1.$2" stub="$scratch/stub-$2"
  section "$name $arg"
  [ -x "$script" ] || die "$script isn't installed"
  mkdir -p "$stub"

  sudo env -i PATH=/nonexistent /bin/sh "$script" "$arg" || die "$name $arg fails without udevadm"

  printf '#!/bin/sh\nexit 1\n' >"$stub/udevadm"
  chmod +x "$stub/udevadm"
  sudo env -i PATH="$stub" /bin/sh "$script" "$arg" || die "$name $arg fails when udevadm does"

  printf '#!/bin/sh\necho "$*" >>%s/calls\n' "$stub" >"$stub/udevadm"
  sudo env -i PATH="$stub" /bin/sh "$script" "$arg" || die "$name $arg failed"
  cat "$stub/calls"
  grep -qx "control --reload-rules" "$stub/calls" || die "$name $arg didn't reload the rules"
  local v
  for v in a466 04d8; do
    grep -qx -- "trigger --action=change --subsystem-match=usb --attr-match=idVendor=$v" "$stub/calls" \
      || die "$name $arg didn't trigger idVendor=$v"
  done
  echo "$name $arg: OK"
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
  local name res
  for name in "$SIDECAR_NAME" "$T76_SIDECAR_NAME"; do
    grep -qE "(\./)?usr/bin/$name\$" <<<"$listing" || die "deb lacks /usr/bin/$name"
  done
  for res in minipro minipro-t76; do
    grep -qE "(\./)?usr/lib/burnwright/$res/infoic\.xml\$" <<<"$listing" \
      || die "deb lacks /usr/lib/burnwright/$res/infoic.xml"
  done
  grep -q zlib1g <<<"$(dpkg-deb -f "$deb" Depends)" || die "deb doesn't declare zlib1g"
  check_deb_scripts "$deb" "$listing"

  local pkg status
  pkg="$(dpkg-deb -f "$deb" Package)"
  section "install the deb"
  # apt fails if the postinst does; the status shows it finished configuring.
  sudo apt-get install -y --no-install-recommends "$(realpath "$deb")"
  status="$(dpkg-query -W -f='${Status}' "$pkg")"
  echo "$pkg: $status"
  [ "$status" = "install ok installed" ] || die "$pkg isn't fully installed: $status"
  check_libs "/usr/bin/$SIDECAR_NAME"
  check_sidecar ".deb (installed)" "/usr/bin/$SIDECAR_NAME" /usr/lib/burnwright/minipro
  check_libs "/usr/bin/$T76_SIDECAR_NAME"
  check_sidecar ".deb (installed, t76)" "/usr/bin/$T76_SIDECAR_NAME" /usr/lib/burnwright/minipro-t76 t76
  check_udev_rules "$UDEV_RULES_PATH"
  check_maintainer_script "$pkg" postinst configure
  check_maintainer_script "$pkg" postrm remove

  section "remove the deb"
  sudo apt-get remove -y "$pkg"
  sudo apt-get purge -y "$pkg"
  status="$(dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null || true)"
  echo "$pkg: ${status:-unknown to dpkg}"
  case "$status" in *" installed"|*" config-files") die "$pkg is still on the system: $status" ;; esac
  [ ! -e "$UDEV_RULES_PATH" ] || die "apt remove left $UDEV_RULES_PATH behind"
  [ ! -e "/usr/bin/$SIDECAR_NAME" ] || die "apt remove left /usr/bin/$SIDECAR_NAME behind"
  [ ! -e "/usr/bin/$T76_SIDECAR_NAME" ] || die "apt remove left /usr/bin/$T76_SIDECAR_NAME behind"
  echo ".deb removed cleanly"

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
  bin="$root/usr/bin/$T76_SIDECAR_NAME"
  check_libs "$bin"
  check_sidecar "AppImage (t76)" "$bin" "$root/usr/lib/burnwright/minipro-t76" t76
}

case "${1:-}" in
  macos) [ $# -eq 2 ] || die "usage: $0 macos <dmg>"; verify_macos "$2" ;;
  linux) [ $# -eq 3 ] || die "usage: $0 linux <deb> <AppImage>"; verify_linux "$2" "$3" ;;
  *) die "usage: $0 macos <dmg> | linux <deb> <AppImage>" ;;
esac
echo
echo "All sidecar checks passed."

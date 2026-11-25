#!/usr/bin/env bash
# Check that a built installer carries a working minipro sidecar, run from
# where an installed copy of burnwright would find it, not from the build tree.
#
#   scripts/minipro/verify-bundle.sh macos <burnwright.dmg>
#   scripts/minipro/verify-bundle.sh linux <burnwright.deb> <burnwright.AppImage>
#
# macOS: copies the .app out of the .dmg (as a drag-install would), lists the
#   sidecar's libraries with `otool -L` and rejects anything outside the OS,
#   and rejects a sidecar with weak imports (`nm -m`).
# Linux: shows the .deb's control fields and contents (`dpkg-deb -I`/`-c`),
#   installs it with apt (needs sudo) and runs /usr/bin/burnwright-minipro;
#   checks the app's own binary finds its libraries and its menu entry runs
#   it; checks the udev rules and maintainer scripts the .deb ships, then
#   removes it again and checks the rules went with it; then extracts the
#   AppImage and runs the sidecar from inside it.
#   The bundles don't have to be built on the machine that checks them: CI
#   builds on Ubuntu 22.04 and runs this there and again on 24.04 and 26.04.
#
# Both: the app's own binary, started the way it starts itself to scan a dump
#   (`--inspect-worker`, #153), reads a dump from stdin and writes its report
#   to stdout, and links no compression library of its own: xz, zstd and
#   lzfse are compiled in, and a copy picked up from the build machine would
#   be missing on the user's.
#
#   And each bundle carries burnwright's own licence and the third-party
#   notices (#156), byte for byte the ones in this checkout.
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

# check_notices <label> <the bundle's resource folder>: burnwright's licence
# and the notices for what's compiled into it (#156) are in the bundle, and
# they're the files in this checkout, not older or emptier ones.
check_notices() {
  local label="$1" res="$2" pair installed source
  section "$label: licence and notices in $res"
  for pair in LICENSE.txt:LICENSE THIRD-PARTY-NOTICES.txt:THIRD-PARTY-NOTICES.txt; do
    installed="$res/${pair%%:*}" source="$here/../../${pair##*:}"
    [ -s "$installed" ] || die "$label: no $installed"
    cmp "$installed" "$source" || die "$label: $installed isn't the ${pair##*:} in this checkout"
    echo "${pair%%:*}: $(wc -c <"$installed" | tr -d ' ') bytes, same as the checkout's"
  done
}

# check_scan_worker <label> <the app's binary>: started as its own scan
# worker, the app reads a dump from stdin and writes one JSON report of it to
# stdout, with no display and next to nothing in its environment. The dump is
# made here: 4 KiB of erased flash, then a 74-byte gzip file holding one line
# of text (the bytes crates/inspect's tests use). No real firmware.
SCAN_GZIP_HEX=1f8b0800000000600003013300ccff6275726e77726967687420746573743a206e6f7468696e67206865726520697320616e796f6e652773206669726d776172650a68f5184b33000000
check_scan_worker() {
  local label="$1" bin="$2" dump="$scratch/dump.bin" report="$scratch/report.json" len pid waited=0
  section "$label: $bin --inspect-worker"
  [ -x "$bin" ] || die "$label: no app binary at $bin"
  {
    head -c 4096 /dev/zero | LC_ALL=C tr '\000' '\377'
    printf '%b' "$(sed 's/../\\x&/g' <<<"$SCAN_GZIP_HEX")"
  } >"$dump"
  len="$(wc -c <"$dump" | tr -d ' ')"
  # A binary that missed the argument would open a window and stay: give it
  # two minutes, not the rest of the job.
  env -i HOME="$scratch" PATH=/usr/bin:/bin "$bin" --inspect-worker <"$dump" >"$report" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge 120 ]; then
      kill -9 "$pid" 2>/dev/null || true
      die "$label: the scan worker was still running after two minutes"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" || die "$label: the scan worker exited $?"
  cat "$report"; echo
  grep -qF "\"len\":$len," "$report" || die "$label: the report isn't of all $len bytes"
  grep -qF '"offset":4096,"size":74,"kind":"gzip"' "$report" \
    || die "$label: the scan worker didn't find the gzip file at offset 4096"
  echo "$label: scan worker OK"
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

  local name res variant bin weak
  for name in "$SIDECAR_NAME" "$T76_SIDECAR_NAME"; do
    res=minipro variant=stable
    [ "$name" = "$T76_SIDECAR_NAME" ] && res=minipro-t76 variant=t76
    bin="$app/Contents/MacOS/$name"
    section "otool -L $name"
    otool -L "$bin"
    if otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)'; then
      die "$name links a library that macOS doesn't ship (Homebrew, @rpath, ...)"
    fi
    # No weak imports (#97): an undefined weak symbol is a function the build
    # SDK has and the deployment target doesn't. It's a null pointer on any
    # macOS older than the SDK, so the runs below can pass here and the same
    # sidecar still crash for a user. build-sidecar.sh checks this too; this
    # is the copy that ships.
    section "nm -m $name (weak imports)"
    weak="$(nm -m "$bin" | grep -F '(undefined) weak external' || true)"
    if [ -n "$weak" ]; then
      echo "$weak"
      die "$name weak-imports the symbols above; they're missing on older macOS and calling one crashes"
    fi
    echo "none"
    lipo -info "$bin"
    check_sidecar "macOS .app ($variant)" "$bin" "$app/Contents/Resources/$res" "$variant"
  done

  # The app itself. It compiles its compression code in (#153); a liblzma
  # from Homebrew on the build machine is the one this would catch.
  bin="$app/Contents/MacOS/burnwright"
  section "otool -L burnwright"
  otool -L "$bin"
  if otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)'; then
    die "burnwright links a library that macOS doesn't ship (Homebrew, @rpath, ...)"
  fi
  check_scan_worker "macOS .app" "$bin"
  check_notices "macOS .app" "$app/Contents/Resources"
}

# check_libs <ELF>: every library resolves, and libusb isn't one of them.
check_libs() {
  local libs
  libs="$(ldd "$1")"
  echo "$libs"
  if grep -q "not found" <<<"$libs"; then die "$1 has unresolved libraries"; fi
  if grep -q libusb <<<"$libs"; then die "$1 links a shared libusb"; fi
}

# check_app_links <ELF>: the app doesn't name a compression library among its
# own dependencies. Its scanner compiles xz, zstd and lzfse in (#153); one
# linked from the build machine instead would be a dependency no package
# declares. `ldd` can't show this: GTK and WebKit bring their own liblzma and
# libzstd along, so only the binary's direct NEEDED entries are looked at.
check_app_links() {
  local needed
  command -v objdump >/dev/null || die "no objdump here to read $1's dependencies with"
  needed="$(objdump -p "$1" | awk '$1 == "NEEDED" { print $2 }')"
  [ -n "$needed" ] || die "objdump found no dependencies in $1"
  echo "$needed"
  if grep -E 'lzma|zstd|lzfse|bz2' <<<"$needed"; then
    die "$1 links the compression library above instead of carrying it"
  fi
}

# check_app <package>: the app the .deb installed can start here, as far as
# that shows without a display. Its binary is there, every shared library it
# needs resolves on this system (they come from the distro, so this is where
# a .deb built on an older release shows it doesn't fit a newer one), and
# the menu entry runs that binary.
check_app() {
  local pkg="$1" bin=/usr/bin/burnwright libs files desktop cmd
  section "the installed app: $bin"
  [ -x "$bin" ] || die "the deb didn't install $bin"
  libs="$(ldd "$bin")"
  echo "$libs"
  if grep -q "not found" <<<"$libs"; then die "$bin has unresolved libraries on this system"; fi

  files="$(dpkg -L "$pkg")"
  desktop="$(grep -m1 -E '^/usr/share/applications/.*\.desktop$' <<<"$files" || true)"
  [ -n "$desktop" ] || die "the deb installed no menu entry"
  cat "$desktop"
  cmd="$(grep -m1 -E '^Exec=' "$desktop" || true)"
  cmd="${cmd#Exec=}"
  cmd="${cmd%% *}"
  [ -n "$cmd" ] || die "$desktop has no Exec line"
  [ "$(command -v "$cmd" || true)" = "$bin" ] || die "$desktop runs '$cmd', which isn't $bin"
}

# The rules files the .deb ships: one for the XGecu programmers minipro
# drives, one for the CH341A flashrom drives.
MINIPRO_RULES=60-burnwright-minipro.rules
FLASHROM_RULES=60-burnwright-flashrom.rules
UDEV_RULES_FILES=("$MINIPRO_RULES" "$FLASHROM_RULES")
UDEV_RULES_DIR=/usr/lib/udev/rules.d
# USB vendors the maintainer scripts re-trigger: XGecu, Microchip (TL866A/CS)
# and WCH (CH341A).
UDEV_VENDORS=(a466 04d8 1a86)
# What a rule has to grant: the seat's user (uaccess) and the plugdev group.
UDEV_GRANT='TAG\+="uaccess", MODE="0660", GROUP="plugdev"'

# check_deb_scripts <deb>: the .deb carries the udev rules and a postinst and
# postrm that reload udev.
check_deb_scripts() {
  local deb="$1" listing="$2" ctl="$scratch/control" f path
  section "udev rules and maintainer scripts in $(basename "$deb")"
  for f in "${UDEV_RULES_FILES[@]}"; do
    path="$UDEV_RULES_DIR/$f"
    grep -E "(\./)?${path#/}\$" <<<"$listing" || die "deb lacks $path"
    grep -E "^-rw-r--r-- (root/root|0/0) .*(\./)?${path#/}\$" <<<"$listing" >/dev/null \
      || die "$path isn't a 0644 root-owned file in the deb"
  done
  dpkg-deb -e "$deb" "$ctl"
  for s in postinst postrm; do
    [ -x "$ctl/$s" ] || die "deb has no executable $s"
    grep -q "udevadm control --reload-rules" "$ctl/$s" || die "$s doesn't reload udev"
    sh -n "$ctl/$s" || die "$s isn't valid sh"
  done
}

# check_udev_rules <rules file>: the installed file is the one in the repo, it
# parses, and it grants access to every programmer it's there for.
check_udev_rules() {
  local rules="$1" name out id
  name="$(basename "$rules")"
  section "udev rules: $rules"
  [ -f "$rules" ] || die "no udev rules at $rules"
  cat "$rules"
  cmp -s "$rules" "$here/../../packaging/linux/udev/$name" \
    || die "installed $name differs from packaging/linux/udev/$name"
  case "$name" in
    "$MINIPRO_RULES")
      for id in 04d8:e11c a466:0a53 a466:1a86; do
        grep -qE "ATTR\\{idVendor\\}==\"${id%:*}\", ATTR\\{idProduct\\}==\"${id#*:}\", ENV\\{ID_MINIPRO\\}=\"1\"" "$rules" \
          || die "$name doesn't flag $id"
      done
      grep -qE "^ENV\\{ID_MINIPRO\\}==\"1\", $UDEV_GRANT\$" "$rules" \
        || die "$name doesn't grant uaccess/plugdev"
      ;;
    "$FLASHROM_RULES")
      # The CH341A in SPI/I2C mode, and nothing else: its serial mode has
      # another product ID that flashrom can't use.
      id=1a86:5512
      grep -qE "^ATTR\\{idVendor\\}==\"${id%:*}\", ATTR\\{idProduct\\}==\"${id#*:}\", $UDEV_GRANT\$" "$rules" \
        || die "$name doesn't grant uaccess/plugdev to $id"
      [ "$(grep -vE '^[[:space:]]*(#|$)' "$rules" | grep -c 'idProduct')" -eq 1 ] \
        || die "$name lists a device other than $id"
      # A CH341A isn't a minipro device: a distro minipro's rules key on this.
      if grep -vE '^[[:space:]]*(#|$)' "$rules" | grep -q ID_MINIPRO; then
        die "$name tags a flashrom programmer as a minipro device"
      fi
      ;;
    *) die "no checks for $name" ;;
  esac
  # Every rule line is key/value pairs udev knows; anything else is a typo.
  if grep -vE '^[[:space:]]*(#|$)' "$rules" \
      | grep -vE '^(ACTION|SUBSYSTEM|ENV\{[A-Z_]+\}|ATTR\{[a-zA-Z]+\}|TAG|MODE|GROUP|LABEL)[!=+]'; then
    die "udev rules have a line that isn't a known rule"
  fi

  if udevadm verify --help >/dev/null 2>&1; then
    # systemd 253+ (Ubuntu 24.04 and later).
    out="$(udevadm verify "$rules" 2>&1)" || { echo "$out"; die "udevadm verify rejected $name"; }
    echo "udevadm verify: $out"
  else
    # Older udev (Ubuntu 22.04) has no verify, but `udevadm test` parses every
    # rules file, logging any line it can't use with the file's name.
    out="$(sudo udevadm test --action=change /sys/class/mem/null 2>&1)" || true
    grep -F "$name" <<<"$out" || true
    if grep -F "$name" <<<"$out" | grep -iE "invalid|ignor|unknown|fail|error|warn|deprecat"; then
      die "udevadm test logged problems with $name"
    fi
    grep -qF "$name" <<<"$out" || echo "note: udevadm test didn't mention $name (only syntax-grepped)"
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
  for v in "${UDEV_VENDORS[@]}"; do
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
  check_app "$pkg"
  section "the installed app's own dependencies"
  check_app_links /usr/bin/burnwright
  check_scan_worker ".deb (installed)" /usr/bin/burnwright
  check_notices ".deb (installed)" /usr/lib/burnwright
  check_libs "/usr/bin/$SIDECAR_NAME"
  check_sidecar ".deb (installed)" "/usr/bin/$SIDECAR_NAME" /usr/lib/burnwright/minipro
  check_libs "/usr/bin/$T76_SIDECAR_NAME"
  check_sidecar ".deb (installed, t76)" "/usr/bin/$T76_SIDECAR_NAME" /usr/lib/burnwright/minipro-t76 t76
  local rules
  for rules in "${UDEV_RULES_FILES[@]}"; do
    check_udev_rules "$UDEV_RULES_DIR/$rules"
  done
  check_maintainer_script "$pkg" postinst configure
  check_maintainer_script "$pkg" postrm remove

  section "remove the deb"
  sudo apt-get remove -y "$pkg"
  sudo apt-get purge -y "$pkg"
  status="$(dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null || true)"
  echo "$pkg: ${status:-unknown to dpkg}"
  case "$status" in *" installed"|*" config-files") die "$pkg is still on the system: $status" ;; esac
  for rules in "${UDEV_RULES_FILES[@]}"; do
    [ ! -e "$UDEV_RULES_DIR/$rules" ] || die "apt remove left $UDEV_RULES_DIR/$rules behind"
  done
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
  # The binary a running AppImage finds as its own, and so the one it starts
  # as its scan worker.
  section "the AppImage app's own dependencies"
  check_app_links "$root/usr/bin/burnwright"
  check_scan_worker "AppImage" "$root/usr/bin/burnwright"
  check_notices "AppImage" "$root/usr/lib/burnwright"
}

case "${1:-}" in
  macos) [ $# -eq 2 ] || die "usage: $0 macos <dmg>"; verify_macos "$2" ;;
  linux) [ $# -eq 3 ] || die "usage: $0 linux <deb> <AppImage>"; verify_linux "$2" "$3" ;;
  *) die "usage: $0 macos <dmg> | linux <deb> <AppImage>" ;;
esac
echo
echo "All bundle checks passed."

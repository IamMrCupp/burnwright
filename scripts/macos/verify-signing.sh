#!/usr/bin/env bash
# Check that a macOS build is signed with a Developer ID, notarized and
# stapled, the way Gatekeeper will judge it on a user's Mac.
#
#   scripts/macos/verify-signing.sh <burnwright.dmg>
#   scripts/macos/verify-signing.sh <burnwright.app>
#
# .dmg: its signature and stapled ticket, and Gatekeeper's verdict on opening
#   it; then the .app inside, copied out as a drag-install would.
# .app: `codesign --verify --deep --strict`, `spctl -a -t exec`, the stapled
#   ticket, and then every Mach-O file in the bundle on its own: Developer ID
#   signature, hardened runtime, secure timestamp, one team for all of them.
#   That includes the minipro sidecar in Contents/MacOS, which notarization
#   rejects if it's unsigned or not hardened.
#
# Only meaningful for a signed build. An unsigned or ad-hoc one fails, which is
# the point: CI runs this only when the signing secrets are set.
set -euo pipefail

die() { echo "FAIL: $*" >&2; exit 1; }
section() { printf '\n=== %s ===\n' "$*"; }

scratch="$(mktemp -d)"
mnt="$scratch/mnt"
trap 'hdiutil detach "$mnt" >/dev/null 2>&1 || true; rm -rf "$scratch"' EXIT

team=""

# check_signature <path> <runtime|no-runtime>: Developer ID chain, secure
# timestamp, same team as everything before it, and the hardened runtime
# where it applies (executables, not disk images).
check_signature() {
  local path="$1" want_runtime="$2" info this_team
  info="$(codesign -dvvv "$path" 2>&1)" || { echo "$info"; die "$path isn't signed"; }
  grep -E '^(Identifier=|CodeDirectory |Authority=|Timestamp=|Signed Time=|TeamIdentifier=|Signature=|Runtime Version=)' <<<"$info" || true
  grep -q '^Authority=Developer ID Application: ' <<<"$info" \
    || die "$path isn't signed with a Developer ID Application certificate"
  grep -q '^Authority=Apple Root CA$' <<<"$info" \
    || die "$path: the certificate chain doesn't reach Apple's root"
  # `Timestamp=` is Apple's timestamp service; a local clock shows `Signed Time=`.
  grep -q '^Timestamp=' <<<"$info" || die "$path has no secure timestamp"
  this_team="$(sed -n 's/^TeamIdentifier=//p' <<<"$info")"
  [ -n "$this_team" ] && [ "$this_team" != "not set" ] || die "$path has no team identifier"
  [ -z "$team" ] || [ "$team" = "$this_team" ] || die "$path is signed by team $this_team, not $team"
  team="$this_team"
  if [ "$want_runtime" = runtime ]; then
    grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\(([a-z-]+,)*runtime(,[a-z-]+)*\)' <<<"$info" \
      || die "$path isn't signed with the hardened runtime"
  fi
}

# gatekeeper <label> <spctl args...>: must be accepted as notarized.
gatekeeper() {
  local label="$1" out
  shift
  out="$(spctl "$@" 2>&1)" || { echo "$out"; die "Gatekeeper rejects the $label"; }
  echo "$out"
  grep -q 'source=Notarized Developer ID' <<<"$out" \
    || die "Gatekeeper accepts the $label, but not as notarized Developer ID software"
}

verify_app() {
  local app="$1"
  [ -d "$app/Contents/MacOS" ] || die "not an app bundle: $app"

  section "codesign --verify --deep --strict $(basename "$app")"
  codesign --verify --deep --strict --verbose=2 "$app"

  section "spctl -a -t exec $(basename "$app")"
  gatekeeper .app -a -t exec -vv "$app"

  section "stapler validate $(basename "$app")"
  xcrun stapler validate "$app"

  local f n=0 entitlements
  while IFS= read -r f; do
    case "$(file -b "$f")" in Mach-O*) ;; *) continue ;; esac
    section "Mach-O: ${f#"$app"/}"
    check_signature "$f" runtime
    entitlements="$(codesign -d --entitlements - "$f" 2>/dev/null || true)"
    echo "entitlements: ${entitlements:-none}"
    n=$((n + 1))
  done < <(find "$app" -type f)
  [ "$n" -ge 2 ] || die "expected the app and the minipro sidecar, found $n Mach-O file(s)"
  echo
  echo "$n Mach-O files, all signed by team $team with the hardened runtime."
}

verify_dmg() {
  local dmg="$1"
  [ -f "$dmg" ] || die "no such dmg: $dmg"

  section "codesign --verify $(basename "$dmg")"
  codesign --verify --strict --verbose=2 "$dmg"
  check_signature "$dmg" no-runtime

  section "stapler validate $(basename "$dmg")"
  xcrun stapler validate "$dmg"

  section "spctl -a -t open $(basename "$dmg")"
  gatekeeper .dmg -a -t open --context context:primary-signature -vv "$dmg"

  section "install $(basename "$dmg")"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null
  local found=("$mnt"/*.app)
  [ -d "${found[0]}" ] || die "no .app in the dmg"
  mkdir -p "$scratch/Applications"
  local app
  app="$scratch/Applications/$(basename "${found[0]}")"
  ditto "${found[0]}" "$app"
  hdiutil detach "$mnt" >/dev/null
  verify_app "$app"
}

[ $# -eq 1 ] || die "usage: $0 <dmg> | <app>"
case "$1" in
  *.dmg) verify_dmg "$1" ;;
  *.app | *.app/) verify_app "${1%/}" ;;
  *) die "usage: $0 <dmg> | <app>" ;;
esac
echo
echo "Signed, notarized and stapled."

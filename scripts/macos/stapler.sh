#!/usr/bin/env bash
# Run `xcrun stapler staple` or `xcrun stapler validate`, and try again when
# it fails.
#
#   scripts/macos/stapler.sh staple [stapler options] <dmg or app>
#   scripts/macos/stapler.sh validate [stapler options] <dmg or app>
#
# Both ask Apple's CloudKit for the notarization ticket: staple to fetch it,
# validate to compare it with the stapled one. That lookup fails now and then
# on a build Apple has just accepted. The connection drops ("The network
# connection was lost", error 68), or the ticket isn't there yet (error 65).
# Both pass, and a release shouldn't fail on them.
#
# Six tries, waiting 15, 30, 45, 60 and 75 seconds between them. One failure
# isn't retried: validate saying there's no ticket stapled at all. Asking
# again doesn't change that.
#
# shim/xcrun sends Tauri's own stapler call through here too.
set -euo pipefail

die() { echo "FAIL: $*" >&2; exit 1; }

usage="usage: $0 staple|validate [stapler options] <dmg or app>"
[ $# -ge 2 ] || die "$usage"
action="$1"
case "$action" in staple | validate) ;; *) die "$usage" ;; esac
target="${!#}"
[ -e "$target" ] || die "no such file: $target"

# The real xcrun: the first one on PATH that isn't the shim, which would send
# the call straight back here.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
xcrun=""
while IFS= read -r candidate; do
  [ "$candidate" -ef "$here/shim/xcrun" ] && continue
  xcrun="$candidate"
  break
done < <(type -ap xcrun)
[ -n "$xcrun" ] || die "no xcrun on PATH"

out="$(mktemp)"
trap 'rm -f "$out"' EXIT

tries=6
try=1
until "$xcrun" stapler "$@" 2>&1 | tee "$out"; [ "${PIPESTATUS[0]}" -eq 0 ]; do
  if grep -q 'does not have a ticket stapled to it' "$out"; then
    die "$(basename "$target") has no ticket stapled to it"
  fi
  [ "$try" -lt "$tries" ] || die "stapler $action failed $tries times on $(basename "$target")"
  wait=$((try * 15))
  echo "stapler $action failed (try $try of $tries). Trying again in ${wait}s..." >&2
  sleep "$wait"
  try=$((try + 1))
done

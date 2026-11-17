#!/usr/bin/env bash
# Run `xcrun stapler staple` or `xcrun stapler validate`, and try again when
# it fails.
#
#   scripts/macos/stapler.sh staple <dmg or app>
#   scripts/macos/stapler.sh validate <dmg or app>
#
# Both ask Apple's CloudKit for the notarization ticket: staple to fetch it,
# validate to compare it with the stapled one. That lookup fails now and then
# on a build Apple has just accepted. The connection drops ("The network
# connection was lost", error 68), or the ticket isn't there yet (error 65).
# Both pass, and a release shouldn't fail on them.
#
# Six tries, waiting 15, 30, 45, 60 and 75 seconds between them. A build that
# really has no ticket fails all six, a few minutes later than it used to.
set -euo pipefail

die() { echo "FAIL: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: $0 staple|validate <dmg or app>"
action="$1"
target="$2"
case "$action" in staple | validate) ;; *) die "usage: $0 staple|validate <dmg or app>" ;; esac
[ -e "$target" ] || die "no such file: $target"

tries=6
try=1
until xcrun stapler "$action" "$target"; do
  [ "$try" -lt "$tries" ] || die "stapler $action failed $tries times on $(basename "$target")"
  wait=$((try * 15))
  echo "stapler $action failed (try $try of $tries). Trying again in ${wait}s..." >&2
  sleep "$wait"
  try=$((try + 1))
done

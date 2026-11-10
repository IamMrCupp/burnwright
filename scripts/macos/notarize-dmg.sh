#!/usr/bin/env bash
# Notarize a signed .dmg with Apple and staple the ticket to it.
#
#   scripts/macos/notarize-dmg.sh <burnwright.dmg>
#
# Tauri's bundler notarizes and staples the .app, then builds the .dmg around
# it and signs the .dmg, but stops there. This does the last step, so the disk
# image itself passes Gatekeeper and carries its ticket for offline Macs.
#
# Authenticates with an App Store Connect API key, from the environment that
# signing-setup.sh exports: APPLE_API_KEY (key ID), APPLE_API_ISSUER and
# APPLE_API_KEY_PATH (the .p8 file).
set -euo pipefail

die() { echo "FAIL: $*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: $0 <dmg>"
dmg="$1"
[ -f "$dmg" ] || die "no such dmg: $dmg"
: "${APPLE_API_KEY:?}" "${APPLE_API_ISSUER:?}" "${APPLE_API_KEY_PATH:?}"
[ -s "$APPLE_API_KEY_PATH" ] || die "no API key at APPLE_API_KEY_PATH"

auth=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
result="$(mktemp)"
trap 'rm -f "$result"' EXIT

echo "Submitting $(basename "$dmg") to the Apple notary service..."
# Don't stop on a non-zero exit yet: when Apple rejects the upload, the log
# fetched below is what says which file and why.
rc=0
xcrun notarytool submit "$dmg" "${auth[@]}" --wait --timeout 45m --output-format json > "$result" || rc=$?
cat "$result"; echo

field() { plutil -extract "$1" raw -o - "$result" 2>/dev/null || true; }
id="$(field id)"
status="$(field status)"
if [ "$rc" -ne 0 ] || [ "$status" != "Accepted" ]; then
  [ -z "$id" ] || xcrun notarytool log "$id" "${auth[@]}" || true
  die "notarization failed (notarytool exit $rc, status \"${status:-unknown}\")"
fi

xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
echo "Notarized and stapled $(basename "$dmg") (submission $id)."

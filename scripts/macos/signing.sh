#!/usr/bin/env bash
# Get a macOS CI runner ready to sign and notarize, if the repo has the Apple
# secrets, and clean up afterwards. Called by
# .github/workflows/release-please.yml; see docs/releasing.md.
#
#   scripts/macos/signing.sh setup
#   scripts/macos/signing.sh cleanup
#
# setup reads five secrets from the environment:
#   APPLE_CERTIFICATE           base64 of the Developer ID Application .p12
#   APPLE_CERTIFICATE_PASSWORD  the .p12's export password
#   APPLE_API_KEY               App Store Connect API key ID
#   APPLE_API_ISSUER            App Store Connect issuer ID
#   APPLE_API_KEY_P8            contents of the AuthKey_<key id>.p8 file
#
# None set: says so, writes enabled=false to $GITHUB_OUTPUT and exits 0, so
#   forks and repos without the secrets keep building unsigned.
# Some set: fails. A half-configured repo must not quietly ship unsigned.
# All set: imports the certificate into a temporary keychain, writes the API
#   key to a file, and exports what Tauri's bundler and notarize-dmg.sh read
#   (APPLE_SIGNING_IDENTITY, APPLE_API_KEY, APPLE_API_ISSUER,
#   APPLE_API_KEY_PATH) through $GITHUB_ENV, then writes enabled=true.
#
# The variables go through $GITHUB_ENV rather than a step's `env:` because an
# empty APPLE_SIGNING_IDENTITY isn't the same as an unset one: Tauri would try
# to sign with the identity "".
#
# cleanup deletes the keychain and the key file. It's safe to run when setup
# made nothing or failed half way. Nothing here prints a secret.
set -euo pipefail

die() { echo "FAIL: $*" >&2; exit 1; }
summary() { echo "$*"; echo "$*" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"; }

tmp="${RUNNER_TEMP:?RUNNER_TEMP is not set (not a GitHub Actions runner?)}"
keychain="$tmp/burnwright-signing.keychain-db"
api_key="$tmp/burnwright-AuthKey.p8"
p12="$tmp/burnwright-signing.p12"

setup() {
  : "${GITHUB_OUTPUT:?not running under GitHub Actions}" "${GITHUB_ENV:?}"

  local required=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_P8)
  local name missing="" present=0
  for name in "${required[@]}"; do
    if [ -n "${!name:-}" ]; then present=$((present + 1)); else missing="$missing $name"; fi
  done

  if [ "$present" -eq 0 ]; then
    summary "macOS: no Apple signing secrets, building an unsigned dmg."
    echo "enabled=false" >> "$GITHUB_OUTPUT"
    return 0
  fi
  [ -z "$missing" ] || die "Apple signing is half set up. Missing secrets:$missing (see docs/releasing.md)"

  umask 077
  trap 'rm -f "$p12"' EXIT
  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$p12" \
    || die "APPLE_CERTIFICATE isn't valid base64"
  [ -s "$p12" ] || die "APPLE_CERTIFICATE decoded to nothing"

  # The keychain only has to outlive this job, so its password never leaves it.
  local keychain_password
  keychain_password="$(openssl rand -hex 24)"
  security create-keychain -p "$keychain_password" "$keychain"
  # No auto-lock for six hours (the longest a hosted job can run): Apple's
  # notary queue sits between signing the app and signing the dmg.
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$p12" -f pkcs12 -P "$APPLE_CERTIFICATE_PASSWORD" \
    -k "$keychain" -T /usr/bin/codesign > /dev/null \
    || die "couldn't import the .p12 (wrong APPLE_CERTIFICATE_PASSWORD, or not a .p12?)"
  # Lets codesign use the key without a GUI prompt nobody is there to answer.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
    -k "$keychain_password" "$keychain" > /dev/null

  # Tauri finds the identity through the keychain search list. Keep what's there.
  local existing=() line
  while IFS= read -r line; do
    if [ -n "$line" ]; then existing+=("$line"); fi
  done < <(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')
  security list-keychains -d user -s "$keychain" ${existing[@]+"${existing[@]}"}

  local identities identity
  identities="$(security find-identity -v -p codesigning "$keychain")"
  identity="$(developer_id_identity <<<"$identities")"
  if [ -z "$identity" ]; then
    echo "$identities" >&2
    die "no valid \"Developer ID Application\" identity in the .p12. It must hold that certificate *and* its private key; an Apple Development or Mac App Distribution certificate can't sign for Gatekeeper."
  fi

  # The IDs are short strings that are easy to save with stray whitespace.
  local key_id issuer
  key_id="$(printf '%s' "$APPLE_API_KEY" | tr -d '[:space:]')"
  issuer="$(printf '%s' "$APPLE_API_ISSUER" | tr -d '[:space:]')"
  printf '%s\n' "$APPLE_API_KEY_P8" > "$api_key"
  grep -q "BEGIN PRIVATE KEY" "$api_key" \
    || die "APPLE_API_KEY_P8 isn't the contents of an AuthKey_<key id>.p8 file"

  {
    echo "APPLE_SIGNING_IDENTITY=$identity"
    echo "APPLE_API_KEY=$key_id"
    echo "APPLE_API_ISSUER=$issuer"
    echo "APPLE_API_KEY_PATH=$api_key"
  } >> "$GITHUB_ENV"
  echo "enabled=true" >> "$GITHUB_OUTPUT"
  summary "macOS: signing as \"$identity\", notarizing with an App Store Connect API key."
}

# Reads `security find-identity -v` output, prints the first Developer ID
# Application identity's name.
developer_id_identity() {
  sed -n 's/^ *[0-9]*) [0-9A-F]* "\(Developer ID Application: .*\)"$/\1/p' | head -n 1
}

cleanup() {
  if [ -e "$keychain" ]; then
    # Also drops it from the keychain search list.
    security delete-keychain "$keychain" || true
  fi
  rm -f "$keychain" "$api_key" "$p12"
  if [ -e "$keychain" ] || [ -e "$api_key" ] || [ -e "$p12" ]; then
    die "signing material is still on the runner"
  fi
  echo "No signing material left on the runner."
}

case "${1:-}" in
  setup) setup ;;
  cleanup) cleanup ;;
  *) die "usage: $0 setup | cleanup" ;;
esac

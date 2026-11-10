#!/usr/bin/env bash
# Test the decision signing.sh makes before it touches a keychain: no Apple
# secrets means an unsigned build, some of them means a failed one. Runs
# anywhere bash does (CI runs it on Linux); needs no secrets and no macOS.
#
#   scripts/macos/test-signing-gate.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# run <name=value>...: signing.sh setup in a clean environment plus those
# variables. Sets $rc and $log; $work/output and $work/env are what the
# script wrote to $GITHUB_OUTPUT and $GITHUB_ENV.
run() {
  : > "$work/output"; : > "$work/env"; : > "$work/summary"
  rc=0
  log="$(env -i PATH="$PATH" RUNNER_TEMP="$work" GITHUB_OUTPUT="$work/output" \
    GITHUB_ENV="$work/env" GITHUB_STEP_SUMMARY="$work/summary" "$@" \
    bash "$here/signing.sh" setup 2>&1)" || rc=$?
}

unsigned() {
  [ "$rc" -eq 0 ] || fail "$1: exited $rc: $log"
  [ "$(cat "$work/output")" = "enabled=false" ] || fail "$1: output was '$(cat "$work/output")'"
  [ ! -s "$work/env" ] || fail "$1: exported variables to an unsigned build"
  grep -q "unsigned" "$work/summary" || fail "$1: the job summary doesn't say unsigned"
  echo "ok: $1 -> unsigned"
}

refused() {
  [ "$rc" -ne 0 ] || fail "$1: should have failed"
  [ ! -s "$work/output" ] || fail "$1: wrote '$(cat "$work/output")'"
  [ ! -s "$work/env" ] || fail "$1: exported variables"
  grep -q "half set up" <<<"$log" || fail "$1: unexpected error: $log"
  echo "ok: $1 -> refused"
}

run
unsigned "no secrets"

# What a fork sees: the variables exist, and are empty.
run APPLE_CERTIFICATE= APPLE_CERTIFICATE_PASSWORD= APPLE_API_KEY= APPLE_API_ISSUER= APPLE_API_KEY_P8=
unsigned "empty secrets"

run APPLE_CERTIFICATE=x APPLE_CERTIFICATE_PASSWORD=x
refused "certificate without an API key"
grep -q "APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_P8" <<<"$log" || fail "doesn't name the missing secrets: $log"

run APPLE_API_KEY=x APPLE_API_ISSUER=x APPLE_API_KEY_P8=x
refused "API key without a certificate"

run APPLE_CERTIFICATE=x APPLE_CERTIFICATE_PASSWORD=x APPLE_API_KEY=x APPLE_API_ISSUER=x
refused "four of five"
if grep -q "=x" <<<"$log"; then fail "the error printed a secret's value"; fi

rc=0
log="$(env -i PATH="$PATH" RUNNER_TEMP="$work" bash "$here/signing.sh" cleanup 2>&1)" || rc=$?
[ "$rc" -eq 0 ] || fail "cleanup with nothing to clean exited $rc: $log"
echo "ok: cleanup with nothing to clean"

echo "All signing gate checks passed."

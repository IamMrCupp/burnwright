#!/usr/bin/env bash
# Test what the release does when Apple's ticket lookup fails: stapler.sh
# tries again and gives up after six tries, notarize-dmg.sh goes through it
# and never staples a dmg Apple rejected, and no script calls stapler without
# it. Apple's tools are replaced with stand-ins, so this runs anywhere bash
# does (CI runs it on Linux); needs no secrets and no macOS.
#
#   scripts/macos/test-stapler-retry.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir "$work/bin"

# xcrun: `notarytool submit` answers with $NOTARY_STATUS, `stapler staple`
# fails $STAPLE_FAILURES times before it works, `stapler validate` fails
# $VALIDATE_FAILURES times, and every call is logged.
cat > "$work/bin/xcrun" <<'EOF'
#!/usr/bin/env bash
echo "$1 $2" >> "$CALLS"
flaky() {
  if [ "$(grep -c "^$1\$" "$CALLS")" -le "$2" ]; then
    echo "The $3 action failed! Error 68." >&2
    exit 68
  fi
}
case "$1 $2" in
  "notarytool submit") echo "{\"status\":\"$NOTARY_STATUS\",\"id\":\"1234\"}" ;;
  "notarytool log") echo "the notary log" ;;
  "stapler staple") flaky "stapler staple" "$STAPLE_FAILURES" "staple and validate" ;;
  "stapler validate") flaky "stapler validate" "$VALIDATE_FAILURES" validate ;;
  *) echo "unexpected xcrun $*" >&2; exit 2 ;;
esac
EOF

# plutil -extract <key> raw -o - <file>, for the flat JSON above.
cat > "$work/bin/plutil" <<'EOF'
#!/usr/bin/env bash
sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$6"
EOF

# sleep: note how long, and don't.
cat > "$work/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "$1" >> "$SLEEPS"
EOF
chmod +x "$work/bin/"*

: > "$work/test.dmg"
echo key > "$work/key.p8"

# run <staple failures> <validate failures> <notary status> <script> <args...>:
# sets $rc and $log; $work/calls and $work/sleeps are what the script asked
# Apple's tools and sleep for.
run() {
  local staple_failures="$1" validate_failures="$2" notary_status="$3" script="$4"
  shift 4
  : > "$work/calls"; : > "$work/sleeps"
  rc=0
  log="$(env -i PATH="$work/bin:$PATH" CALLS="$work/calls" SLEEPS="$work/sleeps" \
    NOTARY_STATUS="$notary_status" STAPLE_FAILURES="$staple_failures" \
    VALIDATE_FAILURES="$validate_failures" \
    APPLE_API_KEY=id APPLE_API_ISSUER=issuer APPLE_API_KEY_PATH="$work/key.p8" \
    bash "$here/$script" "$@" 2>&1)" || rc=$?
}

count() { grep -c "^$1\$" "$work/calls" || true; }
sleeps() { tr '\n' ' ' < "$work/sleeps"; }

# stapler.sh on its own.
run 0 0 - stapler.sh staple "$work/test.dmg"
[ "$rc" -eq 0 ] || fail "first try: exited $rc: $log"
[ "$(count 'stapler staple')" = 1 ] || fail "first try: stapled $(count 'stapler staple') times"
[ ! -s "$work/sleeps" ] || fail "first try: waited anyway"
echo "ok: staple works first time -> one try, no wait"

run 2 0 - stapler.sh staple "$work/test.dmg"
[ "$rc" -eq 0 ] || fail "two failures: exited $rc: $log"
[ "$(count 'stapler staple')" = 3 ] || fail "two failures: stapled $(count 'stapler staple') times"
[ "$(sleeps)" = "15 30 " ] || fail "two failures: waited '$(sleeps)'"
echo "ok: staple fails twice -> third try works"

run 0 1 - stapler.sh validate "$work/test.dmg"
[ "$rc" -eq 0 ] || fail "validate failure: exited $rc: $log"
[ "$(count 'stapler validate')" = 2 ] || fail "validate failure: validated $(count 'stapler validate') times"
[ "$(count 'stapler staple')" = 0 ] || fail "validate failure: stapled"
echo "ok: validate fails once -> second try works"

run 99 0 - stapler.sh staple "$work/test.dmg"
[ "$rc" -ne 0 ] || fail "always failing: should have failed"
[ "$(count 'stapler staple')" = 6 ] || fail "always failing: stapled $(count 'stapler staple') times"
[ "$(sleeps)" = "15 30 45 60 75 " ] || fail "always failing: waited '$(sleeps)'"
grep -q "stapler staple failed 6 times on test.dmg" <<<"$log" || fail "always failing: unexpected error: $log"
echo "ok: staple never works -> gives up after six tries"

run 0 0 - stapler.sh frobnicate "$work/test.dmg"
[ "$rc" -ne 0 ] || fail "bad action: should have failed"
[ ! -s "$work/calls" ] || fail "bad action: ran $(cat "$work/calls")"
echo "ok: an action that isn't staple or validate -> refused"

# notarize-dmg.sh goes through it.
run 1 1 Accepted notarize-dmg.sh "$work/test.dmg"
[ "$rc" -eq 0 ] || fail "notarize: exited $rc: $log"
[ "$(count 'notarytool submit')" = 1 ] || fail "notarize: submitted $(count 'notarytool submit') times"
[ "$(count 'stapler staple')" = 2 ] || fail "notarize: stapled $(count 'stapler staple') times"
[ "$(count 'stapler validate')" = 2 ] || fail "notarize: validated $(count 'stapler validate') times"
echo "ok: notarize-dmg.sh, staple and validate each fail once -> notarized once, both retried"

run 99 0 Accepted notarize-dmg.sh "$work/test.dmg"
[ "$rc" -ne 0 ] || fail "notarize, always failing: should have failed"
[ "$(count 'stapler validate')" = 0 ] || fail "notarize, always failing: validated an unstapled dmg"
echo "ok: notarize-dmg.sh, staple never works -> fails without validating"

run 0 0 Invalid notarize-dmg.sh "$work/test.dmg"
[ "$rc" -ne 0 ] || fail "rejected: should have failed"
[ "$(count 'stapler staple')" = 0 ] || fail "rejected: stapled a dmg Apple rejected"
[ "$(count 'notarytool log')" = 1 ] || fail "rejected: didn't fetch the notary log"
grep -q 'status "Invalid"' <<<"$log" || fail "rejected: unexpected error: $log"
echo "ok: notarize-dmg.sh, Apple rejects the dmg -> no stapling, notary log fetched"

# verify-signing.sh needs a Mac and a signed build, so it can't run here.
# What can be checked: nothing calls stapler behind stapler.sh's back.
direct="$(grep -n '^[^#]*xcrun stapler' "$here"/*.sh | grep -v "^$here/stapler.sh:" | grep -v "^$here/test-stapler-retry.sh:" || true)"
[ -z "$direct" ] || fail "calls stapler without stapler.sh: $direct"
echo "ok: every stapler call goes through stapler.sh"

echo "All stapler retry checks passed."

#!/usr/bin/env bash
# Test what the macOS build does when making the disk image fails with
# "Resource busy": shim/hdiutil tries `hdiutil create` again and gives up
# after five tries, clears up a half-made image between tries, doesn't retry
# any other failure, and passes every other hdiutil call straight through.
# hdiutil is replaced with a stand-in, so this runs anywhere bash does (CI
# runs it on Linux); needs no macOS.
#
#   scripts/macos/test-hdiutil-retry.sh
#
# $SHIM_BASH runs the shim under that bash instead of the one on PATH, to
# try it under the 3.2 that macOS ships: SHIM_BASH=/bin/bash.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir "$work/bin" "$work/empty"

# hdiutil: every call is logged with all its arguments. `create` fails
# $CREATE_FAILURES times before it works, saying $CREATE_ERROR and exiting
# $CREATE_RC; with $LEAVE_PARTIAL set, a failed create leaves the image
# behind. Like the real one, create refuses an image that's already there
# unless it's given -ov. Anything else prints a line and exits $OTHER_RC.
cat > "$work/bin/hdiutil" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
image="${!#}"
if [ "$1" = create ]; then
  case " $* " in
    *" -ov "*) ;;
    *)
      if [ -e "$image" ]; then
        echo "hdiutil: create failed - File exists" >&2
        exit 1
      fi ;;
  esac
  if [ "$(grep -c "^create " "$CALLS")" -le "$CREATE_FAILURES" ]; then
    [ -z "$LEAVE_PARTIAL" ] || echo half > "$image"
    [ -z "$CREATE_ERROR" ] || echo "hdiutil: create failed - $CREATE_ERROR" >&2
    exit "$CREATE_RC"
  fi
  echo whole > "$image"
  echo "created: $image"
  exit 0
fi
echo "did $1"
echo "noise from $1" >&2
exit "$OTHER_RC"
EOF

# sleep: note how long, and don't.
cat > "$work/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "$1" >> "$SLEEPS"
EOF
chmod +x "$work/bin/"*

# run <create failures> <command...>: runs the command in $work with the shim
# first on PATH and the stand-ins after it. Sets $rc, $out (stdout) and $err
# (stderr); $work/calls and $work/sleeps are what was asked of hdiutil and of
# sleep. $create_error, $create_rc, $leave_partial and $other_rc set up the
# stand-in; $path replaces the stand-ins' folder.
create_error="Resource busy"
create_rc=1
leave_partial=""
other_rc=0
path="$work/bin"
run() {
  local failures="$1"
  shift
  : > "$work/calls"; : > "$work/sleeps"
  rc=0
  out="$(cd "$work" && env -i PATH="$here/shim:$path:$PATH" CALLS="$work/calls" \
    SLEEPS="$work/sleeps" CREATE_FAILURES="$failures" CREATE_ERROR="$create_error" \
    CREATE_RC="$create_rc" LEAVE_PARTIAL="$leave_partial" OTHER_RC="$other_rc" \
    "$@" 2> "$work/stderr")" || rc=$?
  err="$(cat "$work/stderr")"
}

# The shim, the way bundle_dmg.sh reaches it (`hdiutil` off PATH), or under
# $SHIM_BASH.
shim=(hdiutil)
[ -z "${SHIM_BASH:-}" ] || shim=("$SHIM_BASH" "$here/shim/hdiutil")

creates() { grep -c "^create " "$work/calls" || true; }
sleeps() { tr '\n' ' ' < "$work/sleeps"; }

# What bundle_dmg.sh asks for.
create=(create -srcfolder src -volname burnwright -fs HFS+ -format UDRW rw.test.dmg)
fresh() { rm -f "$work/rw.test.dmg"; }

fresh
run 0 "${shim[@]}" "${create[@]}"
[ "$rc" -eq 0 ] || fail "first try: exited $rc: $err"
[ "$(creates)" = 1 ] || fail "first try: created $(creates) times"
[ ! -s "$work/sleeps" ] || fail "first try: waited anyway"
grep -qx "${create[*]}" "$work/calls" || fail "first try: changed the arguments: $(cat "$work/calls")"
[ "$out" = "created: rw.test.dmg" ] || fail "first try: lost hdiutil's output: '$out'"
[ -z "$err" ] || fail "first try: said something on stderr: $err"
echo "ok: create works first time -> one try, no wait, arguments and output kept"

fresh
run 2 "${shim[@]}" "${create[@]}"
[ "$rc" -eq 0 ] || fail "two failures: exited $rc: $err"
[ "$(creates)" = 3 ] || fail "two failures: created $(creates) times"
[ "$(sleeps)" = "5 10 " ] || fail "two failures: waited '$(sleeps)'"
[ "$out" = "created: rw.test.dmg" ] || fail "two failures: stdout was '$out'"
grep -q "hdiutil: create failed - Resource busy" <<<"$err" || fail "two failures: hid hdiutil's error: $err"
grep -q "Resource busy (try 2 of 5)" <<<"$err" || fail "two failures: didn't say it was retrying: $err"
echo "ok: create fails twice with Resource busy -> third try works"

fresh
leave_partial=1
run 2 "${shim[@]}" "${create[@]}"
leave_partial=""
[ "$rc" -eq 0 ] || fail "half-made image: exited $rc: $err"
[ "$(creates)" = 3 ] || fail "half-made image: created $(creates) times"
[ "$(cat "$work/rw.test.dmg")" = whole ] || fail "half-made image: ended with '$(cat "$work/rw.test.dmg")'"
echo "ok: a failed create leaves a half-made image -> cleared before the next try"

fresh
run 99 "${shim[@]}" "${create[@]}"
[ "$rc" -eq 1 ] || fail "always busy: exited $rc, not hdiutil's 1"
[ "$(creates)" = 5 ] || fail "always busy: created $(creates) times"
[ "$(sleeps)" = "5 10 15 20 " ] || fail "always busy: waited '$(sleeps)'"
grep -q 'hdiutil create failed 5 times with "Resource busy"' <<<"$err" || fail "always busy: unexpected error: $err"
echo "ok: create is always busy -> gives up after five tries with hdiutil's exit code"

fresh
create_error="No space left on device"
run 99 "${shim[@]}" "${create[@]}"
create_error="Resource busy"
[ "$rc" -eq 1 ] || fail "another error: exited $rc"
[ "$(creates)" = 1 ] || fail "another error: created $(creates) times"
[ ! -s "$work/sleeps" ] || fail "another error: waited '$(sleeps)'"
grep -q "No space left on device" <<<"$err" || fail "another error: hid hdiutil's error: $err"
echo "ok: create fails for another reason -> fails at once, no retry"

fresh
create_error=""
create_rc=16
run 1 "${shim[@]}" "${create[@]}"
create_error="Resource busy"
create_rc=1
[ "$rc" -eq 0 ] || fail "exit 16: exited $rc: $err"
[ "$(creates)" = 2 ] || fail "exit 16: created $(creates) times"
echo "ok: create exits 16 (EBUSY) without saying why -> retried"

# An image that was there before the call is the caller's.
echo theirs > "$work/rw.test.dmg"
leave_partial=""
run 99 "${shim[@]}" create -ov -srcfolder src rw.test.dmg
[ "$rc" -eq 1 ] || fail "caller's image: exited $rc"
[ "$(creates)" = 5 ] || fail "caller's image: created $(creates) times"
[ "$(cat "$work/rw.test.dmg")" = theirs ] || fail "caller's image: it's gone or changed"
echo "ok: the image was already there (-ov) -> retried, never deleted"

# Only a .dmg named last is ever removed. Here the last argument is the
# volume name, and the stand-in leaves its half-made file under that name.
# Left alone, it stops the second try on "File exists", which isn't retried.
leave_partial=1
run 99 "${shim[@]}" create -srcfolder src rw.other.dmg -volname burnwright
leave_partial=""
[ "$(cat "$work/burnwright" 2> /dev/null)" = half ] || fail "last argument: deleted a file that isn't a .dmg"
[ "$(creates)" = 2 ] || fail "last argument: created $(creates) times"
grep -q "File exists" <<<"$err" || fail "last argument: unexpected error: $err"
rm -f "$work/burnwright"
echo "ok: the last argument isn't a .dmg -> nothing is deleted"

# Everything that isn't create.
run 0 "${shim[@]}" attach -readwrite -noverify -nobrowse rw.test.dmg
[ "$rc" -eq 0 ] || fail "attach: exited $rc: $err"
grep -qx "attach -readwrite -noverify -nobrowse rw.test.dmg" "$work/calls" || fail "attach: got $(cat "$work/calls")"
[ "$out" = "did attach" ] || fail "attach: stdout was '$out'"
[ "$err" = "noise from attach" ] || fail "attach: stderr was '$err'"
echo "ok: attach -> straight through, stdout and stderr kept apart"

other_rc=16
run 0 "${shim[@]}" detach /dev/disk4
other_rc=0
[ "$rc" -eq 16 ] || fail "detach: exited $rc, not hdiutil's 16"
[ "$(wc -l < "$work/calls" | tr -d ' ')" = 1 ] || fail "detach: called $(wc -l < "$work/calls") times"
[ ! -s "$work/sleeps" ] || fail "detach: waited"
echo "ok: detach fails busy -> exit code passed back, not retried (bundle_dmg.sh retries its own)"

# On a Mac the shim would find the real hdiutil further down PATH and run it.
if command -v hdiutil > /dev/null; then
  echo "skip: this machine has a real hdiutil, so \"no hdiutil on PATH\" can't be staged"
else
  path="$work/empty"
  run 0 "${shim[@]}" create -srcfolder src rw.none.dmg
  path="$work/bin"
  [ "$rc" -eq 127 ] || fail "no hdiutil: exited $rc"
  grep -q "no real hdiutil on PATH" <<<"$err" || fail "no hdiutil: unexpected error: $err"
  echo "ok: no real hdiutil on PATH -> says so, exits 127"
fi

echo "All hdiutil retry checks passed."

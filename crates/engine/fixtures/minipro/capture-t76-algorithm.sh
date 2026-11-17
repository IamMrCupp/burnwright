#!/usr/bin/env bash
# Capture the t76_algorithm_*.stderr fixtures: what the T76 build of minipro
# prints when a chip operation can't get its bitstream from algorithm.xml.
#
#   crates/engine/fixtures/minipro/capture-t76-algorithm.sh [T76 minipro] [T76 database dir]
#
# Unlike capture-chips.sh this needs a T76 on USB: minipro opens the
# programmer before it looks for the file. Leave the socket empty.
#
# Every run here is `-p W25Q32BV@SOIC8 -D`, a chip ID read, and every one
# fails before minipro sends anything to the socket: the bitstream it needs
# first is exactly what's missing. To keep it that way the script refuses to
# run when minipro would find an algorithm.xml, and runs minipro in an empty
# folder with MINIPRO_HOME unset.
#
# No XGecu file is used or produced. The "unusable" capture hands minipro its
# own logicic.xml as the algorithm file: a real XML file with no bitstreams.
#
# The output is what minipro printed, byte for byte, except:
#   - the programmer's device and serial codes are replaced with zeros;
#   - the database folder is rewritten to /opt/burnwright/minipro-t76 and the
#     missing file's folder to /opt/burnwright/missing, so the fixtures don't
#     carry a local path.
#
# Captured from the T76 build (upstream 3e2f491) with a T76 on firmware
# 00.1.17, macOS arm64. Re-run after bumping vendor/minipro-t76 and read the
# diff.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
triple="$(rustc -vV | sed -n 's/^host: //p')"
minipro="${1:-$root/src-tauri/binaries/burnwright-minipro-t76-$triple}"
db="${2:-$root/src-tauri/binaries/minipro-t76}"

share=/usr/local/share/minipro
if [ -e "$share/algorithm.xml" ]; then
  echo "refusing to run: $share/algorithm.xml exists, so minipro would go on to read the chip" >&2
  exit 1
fi
unset MINIPRO_HOME

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
missing="$work/missing"

scrub() {
  sed -e "s|$db|/opt/burnwright/minipro-t76|g" \
      -e "s|$missing|/opt/burnwright/missing|g" \
      -e 's|^Device code: .*|Device code: 00000000|' \
      -e 's|^Serial code: .*|Serial code: 000000000000000000000000|'
}

# run <name> <args…>: stderr to <name>.stderr. Each of these has to fail.
run() {
  local name="$1"
  shift
  if (cd "$work" && "$minipro" --infoic "$db/infoic.xml" --logicic "$db/logicic.xml" "$@" \
      -p W25Q32BV@SOIC8 -D </dev/null >/dev/null 2>"$work/$name.raw"); then
    echo "$name: minipro succeeded, which this script never expects" >&2
    exit 1
  fi
  scrub <"$work/$name.raw" >"$here/$name.stderr"
}

run t76_algorithm_missing                                           # no file anywhere minipro looks
run t76_algorithm_missing_override --algorithms "$missing/algorithm.xml"  # a chosen file that isn't there
run t76_algorithm_unusable --algorithms "$db/logicic.xml"           # a file with no T76 bitstreams in it

ls -l "$here"/t76_algorithm_*.stderr

#!/usr/bin/env bash
# Capture the chip list / chip info fixtures in chips/ from a real minipro.
#
#   crates/engine/fixtures/minipro/capture-chips.sh [minipro] [database dir]
#
# Defaults to the sidecar `pnpm sidecar` builds for this machine. Every command
# here passes -q, so minipro never opens a programmer: it only reads its XML
# databases. Safe to run with one plugged in.
#
# The output is what minipro printed, byte for byte, except that the database
# folder in "Using overridden database file …" is rewritten to
# /opt/burnwright/minipro so the fixtures don't carry a local path.
#
# Captured from the bundled minipro 0.7.4 (3808aec). Re-run after bumping
# vendor/minipro and read the diff: it is the list of output changes the
# parsers in src/chips.rs have to cope with.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
minipro="${1:-$root/src-tauri/binaries/burnwright-minipro-$(rustc -vV | sed -n 's/^host: //p')}"
db="${2:-$root/src-tauri/binaries/minipro}"
out="$here/chips"
mkdir -p "$out"

scrub() { sed "s|$db|/opt/burnwright/minipro|g; s|$missing|/opt/burnwright/missing|g"; }
missing="$out/.missing"

# run <name> <args…>: stdout to <name>.stdout (kept only if not empty), stderr
# to <name>.stderr. minipro's exit code is the fixture's business, not ours.
run() {
  local name="$1"
  shift
  "$minipro" "$@" </dev/null >"$out/$name.stdout" 2>"$out/$name.raw" || true
  scrub <"$out/$name.raw" >"$out/$name.stderr"
  rm "$out/$name.raw"
  [ -s "$out/$name.stdout" ] || rm "$out/$name.stdout"
}

with_db=(--infoic "$db/infoic.xml" --logicic "$db/logicic.xml")
list() { local name="$1" q="$2" filter="$3"; run "$name" "${with_db[@]}" -q "$q" -L "$filter"; }
info() { local name="$1" q="$2" chip="$3"; run "$name" "${with_db[@]}" -q "$q" -d "$chip"; }

# Lists: -L <filter> prints the same lines as the full list, filtered.
list list_t48_w25q32 t48 W25Q32
list list_t48_at28c256 t48 AT28C256          # ends with three (custom) entries
list list_t48_93lc46 t48 93LC46              # every name twice: two manufacturers
list list_t48_gsto t48 GSTO                  # non-ASCII names
list list_tl866a_w25q32 tl866a W25Q32
list list_t48_7400 t48 7400                  # logic ICs and memories that contain "7400"

# Chip info. 0.7.4 prints "Available on: TL866A/CS" for -q t48 and -q t56
# whatever the chip; only -q tl866ii prints the real line.
info info_t48_w25q32bv_soic8 t48 W25Q32BV@SOIC8
info info_tl866ii_w25q32bv_soic8 tl866ii w25q32bv@soic8   # lookups ignore case
info info_tl866a_w25q32bv tl866a W25Q32BV
info info_tl866ii_atmega328p_dip28 tl866ii ATMEGA328P@DIP28          # code + data, ICSP
info info_t48_m27c256b_dip28 t48 M27C256B@DIP28                      # voltage block
info info_tl866ii_gal16v8d tl866ii GAL16V8D                          # bits, VPP only
info info_t48_7400 t48 7400                                          # logic IC
info info_tl866ii_s29gl032m_bga48 tl866ii S29GL032M10BBIR3@BGA48     # words, "T48, T56"
info info_tl866ii_rp_semc16da1_bga153 tl866ii RP-SEMC16DA1_8Bit@BGA153   # three memories, "T56 only"
info info_tl866ii_tc58dvg02d5_tsop48 tl866ii TC58DVG02D5TAI0@TSOP48  # needs an adapter
info info_tl866ii_kmqe60013b_isp tl866ii 'KMQE60013B-B318_(ISP)_1Bit'    # ICSP only
info info_tl866ii_sm59r03a1c tl866ii SM59R03A1C                      # "TL866II only"
info info_t48_unknown t48 NOSUCHCHIP

# Trouble.
run list_t76_unsupported "${with_db[@]}" -q t76 -L ""
run list_t48_no_infoic --infoic "$missing/infoic.xml" --logicic "$db/logicic.xml" -q t48 -L 7400
run list_t48_no_database --infoic "$missing/infoic.xml" --logicic "$missing/logicic.xml" -q t48 -L ""
run info_t48_no_database --infoic "$missing/infoic.xml" --logicic "$missing/logicic.xml" -q t48 -d AT28C256

ls -l "$out"

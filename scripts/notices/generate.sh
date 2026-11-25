#!/usr/bin/env bash
# Build THIRD-PARTY-NOTICES.txt: the licence of every Rust crate and npm
# package compiled into the burnwright program, for all four platforms it
# ships on (issue #156). The file is committed and goes into every installer.
#
#   scripts/notices/generate.sh           write THIRD-PARTY-NOTICES.txt
#   scripts/notices/generate.sh --check   fail if the committed file is stale
#
# Run it after a change to Cargo.lock or pnpm-lock.yaml adds or removes a
# dependency; CI runs --check. The file lists names, not versions, so a plain
# version bump leaves it alone.
#
# It stops, and so does CI, on a dependency whose licence isn't in about.toml:
# that's a licence somebody has to read before it ships.
#
# Needs: cargo-about at the version below, node, and `pnpm install` done.
set -euo pipefail

CARGO_ABOUT_VERSION=0.9.3

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
notices="$root/THIRD-PARTY-NOTICES.txt"

die() { echo "FAIL: $*" >&2; exit 1; }

mode="write"
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  *) die "usage: $0 [--check]" ;;
esac

have="$(cargo about --version 2>/dev/null || true)"
[ "$have" = "cargo-about $CARGO_ABOUT_VERSION" ] || die "this needs cargo-about $CARGO_ABOUT_VERSION (found: ${have:-none}).
Install it with: cargo install cargo-about --locked --version $CARGO_ABOUT_VERSION --features cli"
command -v node >/dev/null || die "this needs node"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --locked: never touch Cargo.lock. --fail: a licence file that no longer
# matches its checksum in about.toml stops the run instead of being skipped.
cargo about generate --locked --fail \
  --manifest-path "$root/src-tauri/Cargo.toml" \
  --config "$root/about.toml" \
  --output-file "$work/rust.txt" \
  "$here/rust.hbs"
node "$here/js-notices.mjs" >"$work/js.txt"

rule="$(printf '=%.0s' {1..80})"
{
  cat "$here/header.txt"
  cat "$work/rust.txt"
  printf '\n%s\n2. JavaScript packages\n%s\n\n' "$rule" "$rule"
  cat "$work/js.txt"
} |
  # Licence files come with every kind of line ending and trailing space.
  # One form, so the file is the same wherever it's generated or checked out.
  tr -d '\r' | sed -e 's/[[:space:]]*$//' | cat -s >"$work/notices.txt"

if [ "$mode" = check ]; then
  [ -f "$notices" ] || die "there's no $(basename "$notices"). Run scripts/notices/generate.sh and commit it."
  if ! diff -u "$notices" "$work/notices.txt" >"$work/diff"; then
    head -n 60 "$work/diff"
    die "THIRD-PARTY-NOTICES.txt doesn't match the dependencies any more.
Run scripts/notices/generate.sh (or \`just notices\`) and commit the result."
  fi
  echo "THIRD-PARTY-NOTICES.txt is up to date."
else
  cp "$work/notices.txt" "$notices"
  echo "wrote $notices ($(wc -c <"$notices" | tr -d ' ') bytes)"
fi

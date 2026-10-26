#!/usr/bin/env bash
# Prepare the patched icy_tools source that the WASM core builds against.
#
# Cargo.toml depends on icy_tools by git URL and rev (the pin), and a
# [patch."https://github.com/mkrueger/icy_tools"] section points icy_engine and
# icy_parser_core at build/icy_tools/, which this script creates: a shallow
# fetch of exactly that rev with patches/icy_tools/*.patch applied (in name
# order). The patches remove what enig-term must not ship (embedded font data,
# see 0001-no-embedded-fonts.patch). Cargo.lock still pins every other git
# dependency of icy_tools.
#
# Re-runs are cheap: a stamp records the rev and the patch hashes, and the
# checkout is rebuilt only when either changes.
#
# Environment: ICY_TOOLS_GIT (default https://github.com/mkrueger/icy_tools; a
# local clone works too, for offline builds).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_TOML="$ROOT/crates/enig-term-core/Cargo.toml"
DEST="$ROOT/build/icy_tools"
URL="${ICY_TOOLS_GIT:-https://github.com/mkrueger/icy_tools}"

REV=$(sed -n 's/^icy_engine = .*rev = "\([0-9a-f]\{40\}\)".*/\1/p' "$CARGO_TOML")
[ -n "$REV" ] || { echo "prepare-icy: no icy_engine rev in $CARGO_TOML" >&2; exit 1; }
REV2=$(sed -n 's/^icy_parser_core = .*rev = "\([0-9a-f]\{40\}\)".*/\1/p' "$CARGO_TOML")
[ "$REV" = "$REV2" ] || { echo "prepare-icy: icy_engine and icy_parser_core revs differ" >&2; exit 1; }

shopt -s nullglob
PATCHES=("$ROOT"/patches/icy_tools/*.patch)
STAMP="$REV $(cat "${PATCHES[@]}" /dev/null | sha256sum | cut -c1-64)"
if [ -f "$DEST/.enig-term-stamp" ] && [ "$(cat "$DEST/.enig-term-stamp")" = "$STAMP" ]; then
    exit 0
fi

echo "prepare-icy: icy_tools $REV with ${#PATCHES[@]} patch(es) -> build/icy_tools"
rm -rf "$DEST"
mkdir -p "$DEST"
git -C "$DEST" init -q
git -C "$DEST" remote add origin "$URL"
git -C "$DEST" fetch -q --depth 1 origin "$REV"
git -C "$DEST" -c advice.detachedHead=false checkout -q FETCH_HEAD
[ "$(git -C "$DEST" rev-parse HEAD)" = "$REV" ] || { echo "prepare-icy: fetched the wrong revision" >&2; exit 1; }
for p in "${PATCHES[@]}"; do
    git -C "$DEST" apply --whitespace=nowarn "$p" || { echo "prepare-icy: $(basename "$p") does not apply to $REV (see README, 'Rebasing icy_tools')" >&2; exit 1; }
done
echo "$STAMP" > "$DEST/.enig-term-stamp"

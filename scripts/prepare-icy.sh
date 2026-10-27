#!/usr/bin/env bash
# Prepare the patched upstream sources the WASM builds use.
#
# 1. icy_tools (the emulation core). Cargo.toml depends on icy_tools by git
#    URL and rev (the pin), and a [patch."https://github.com/mkrueger/icy_tools"]
#    section points icy_engine and icy_parser_core at build/icy_tools/, which
#    this script creates: a shallow fetch of exactly that rev with
#    patches/icy_tools/*.patch applied (in name order). icy_engine is built
#    without its embedded-fonts feature; the patch leaves out the BGI stroke
#    fonts that feature does not cover (see
#    0001-bgi-fonts-follow-embedded-fonts.patch). Cargo.lock still pins every
#    other git dependency of icy_tools.
#
# 2. icy_board's icy_net (ZModem, for file transfers). Only crates/icy_net is
#    checked out (sparse, blobs fetched on demand) at the rev in
#    crates/enig-term-zmodem/Cargo.toml ([package.metadata.enig-term]
#    icy-board-rev, the rev icy_tools itself pins for icy_net), into
#    build/icy_board/, with patches/icy_board/*.patch applied. The crate
#    compiles a few of those files straight from there (#[path]); see its
#    lib.rs. icy_board is Apache-2.0; the patches mark the files they change.
#
# Re-runs are cheap: a stamp records each rev and its patch hashes, and a
# checkout is rebuilt only when either changes.
#
# Environment: ICY_TOOLS_GIT (default https://github.com/mkrueger/icy_tools),
# ICY_BOARD_GIT (default https://github.com/mkrueger/icy_board); a local
# clone works too, for offline builds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
shopt -s nullglob

# prepare <dest> <url> <rev> <patch dir> [sparse paths...]
prepare() {
    local dest="$1" url="$2" rev="$3" pdir="$4"
    shift 4
    local patches=("$pdir"/*.patch)
    local stamp
    stamp="$rev $(cat "${patches[@]}" /dev/null | sha256sum | cut -c1-64)"
    if [ -f "$dest/.enig-term-stamp" ] && [ "$(cat "$dest/.enig-term-stamp")" = "$stamp" ]; then
        return 0
    fi
    echo "prepare-icy: $(basename "$url") $rev with ${#patches[@]} patch(es) -> ${dest#"$ROOT"/}"
    rm -rf "$dest"
    mkdir -p "$dest"
    git -C "$dest" init -q
    git -C "$dest" remote add origin "$url"
    local filter=()
    if [ $# -gt 0 ]; then
        git -C "$dest" sparse-checkout set --no-cone "$@"
        filter=(--filter=blob:none)
    fi
    git -C "$dest" fetch -q --depth 1 "${filter[@]}" origin "$rev"
    git -C "$dest" -c advice.detachedHead=false checkout -q FETCH_HEAD
    [ "$(git -C "$dest" rev-parse HEAD)" = "$rev" ] || { echo "prepare-icy: fetched the wrong revision of $url" >&2; exit 1; }
    for p in "${patches[@]}"; do
        git -C "$dest" apply --whitespace=nowarn "$p" || { echo "prepare-icy: $(basename "$p") does not apply to $rev (see docs/building.md, 'Rebasing icy_tools')" >&2; exit 1; }
    done
    echo "$stamp" > "$dest/.enig-term-stamp"
}

CARGO_TOML="$ROOT/crates/enig-term-core/Cargo.toml"
REV=$(sed -n 's/^icy_engine = .*rev = "\([0-9a-f]\{40\}\)".*/\1/p' "$CARGO_TOML")
[ -n "$REV" ] || { echo "prepare-icy: no icy_engine rev in $CARGO_TOML" >&2; exit 1; }
REV2=$(sed -n 's/^icy_parser_core = .*rev = "\([0-9a-f]\{40\}\)".*/\1/p' "$CARGO_TOML")
[ "$REV" = "$REV2" ] || { echo "prepare-icy: icy_engine and icy_parser_core revs differ" >&2; exit 1; }
prepare "$ROOT/build/icy_tools" "${ICY_TOOLS_GIT:-https://github.com/mkrueger/icy_tools}" "$REV" "$ROOT/patches/icy_tools"

ZM_TOML="$ROOT/crates/enig-term-zmodem/Cargo.toml"
BREV=$(sed -n 's/^icy-board-rev = "\([0-9a-f]\{40\}\)".*/\1/p' "$ZM_TOML")
[ -n "$BREV" ] || { echo "prepare-icy: no icy-board-rev in $ZM_TOML" >&2; exit 1; }
prepare "$ROOT/build/icy_board" "${ICY_BOARD_GIT:-https://github.com/mkrueger/icy_board}" "$BREV" "$ROOT/patches/icy_board" /crates/icy_net/ /LICENSE /README.md

#!/usr/bin/env bash
# Package a built dist/ as a release: enig-term-<version>.zip and .tar.gz (one
# top-level folder, enig-term-<version>/), SHA256SUMS, and notes.md (the
# CHANGELOG section for <version>). Checks what went into the archives.
# Used by .github/workflows/release.yml; run it locally the same way.
#
#   scripts/package-release.sh <version> <out-dir> [<dist-dir>]
#
# <dist-dir> defaults to ./dist. It must not hold fonts/amiga/ or config.json:
# the release never carries Amiga fonts or a site's config.
set -euo pipefail

version=${1:?usage: package-release.sh <version> <out-dir> [<dist-dir>]}
out=${2:?usage: package-release.sh <version> <out-dir> [<dist-dir>]}
root=$(cd "$(dirname "$0")/.." && pwd)
dist=$(cd "${3:-$root/dist}" && pwd)
name="enig-term-${version}"

fail() { echo "package-release: $*" >&2; exit 1; }

[ -e "$dist/fonts/amiga" ] && fail "$dist/fonts/amiga exists; package from a dist/ without Amiga fonts"
[ -e "$dist/config.json" ] && fail "$dist/config.json exists; a release never ships one"

# The build stamps the package version into the bundle and credits.html.
grep -q "enig-term ${version} " "$dist/enig-term.js" || fail "enig-term.js is not version ${version}"
grep -q "<h1>enig-term ${version}:" "$dist/credits.html" || fail "credits.html is not version ${version}"

mkdir -p "$out"
out=$(cd "$out" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -a "$dist" "$stage/$name"

rm -f "$out/$name.zip" "$out/$name.tar.gz"
(cd "$stage" && zip -qrX "$out/$name.zip" "$name")
tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.zip" "$name.tar.gz" > SHA256SUMS)

# What is in the archives: both list the same files, the required ones are
# there, and no Amiga fonts or config.json.
zlist=$(unzip -Z1 "$out/$name.zip" | grep -v '/$' | sort)
tlist=$(tar -tzf "$out/$name.tar.gz" | grep -v '/$' | sort)
[ "$zlist" = "$tlist" ] || fail "the zip and the tarball hold different files"
for f in index.html enig-term.js enig-term-audio.js enig-term-ogg.js enig-term-xfer.js \
    enig_term_core_bg.wasm enig-term-zmodem.wasm credits.html config.example.json \
    LICENSE LICENSE-APACHE-2.0 NOTICE fonts/manifest.json fonts/LICENSE fonts/README.txt \
    tools/fetch-amiga-fonts.mjs; do
    grep -qxF "$name/$f" <<<"$zlist" || fail "missing from the archive: $name/$f"
done
grep -q "^$name/fonts/pc/.*\.psf$" <<<"$zlist" || fail "no PC fonts in the archive"
grep -q "^$name/fonts/amiga" <<<"$zlist" && fail "Amiga fonts in the archive"
grep -qxF "$name/config.json" <<<"$zlist" && fail "config.json in the archive"
grep -v "^$name/" <<<"$zlist" && fail "files outside $name/ in the archive"

# Release notes: the CHANGELOG section headed "## <version> - <date>".
awk -v v="$version" '
    /^## / { if (on) exit; on = (index($0, "## " v " - ") == 1); next }
    on' "$root/CHANGELOG.md" > "$out/notes.md"
grep -q '[^[:space:]]' "$out/notes.md" || fail "no CHANGELOG section \"## ${version} - <date>\""

echo "$(wc -l <<<"$zlist") files in $name/"
(cd "$out" && ls -l "$name.zip" "$name.tar.gz" SHA256SUMS notes.md && cat SHA256SUMS)

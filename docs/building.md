# Building and testing

## Download a release

Building is not needed to run enig-term. Each release on the
[Releases page](https://github.com/NuSkooler/enig-term/releases) has the
built `dist/` as `enig-term-<version>.zip` and `enig-term-<version>.tar.gz`,
each with one top-level folder, `enig-term-<version>/`, and a `SHA256SUMS`.

```sh
sha256sum -c --ignore-missing SHA256SUMS
gh attestation verify enig-term-0.1.0.zip --repo NuSkooler/enig-term   # optional: build provenance (releases after 0.1.1)
unzip enig-term-0.1.0.zip                 # or: tar xzf enig-term-0.1.0.tar.gz
mkdir -p /path/to/enigma-bbs/ws-term      # or a directory under any web root
cp -a enig-term-0.1.0/. /path/to/enigma-bbs/ws-term/
cd /path/to/enigma-bbs/ws-term
node tools/fetch-amiga-fonts.mjs          # optional: the Amiga fonts (Node 18+)
```

`ws-term/` in the ENiGMA½ directory is where ENiGMA½ looks by default
(`contentServers.web.wsTerm.root`). The archive holds exactly the
[dist/ layout](#dist-layout): no `config.json` and no Amiga fonts.

The rest of this page is about building from source.

## Toolchain

- Node 22 (`mise.toml`; with mise, run commands through `mise exec --`).
- Rust stable with the `wasm32-unknown-unknown` target.
- `wasm-bindgen-cli` 0.2.129. It must match the crate's pinned version.
- Optionally binaryen's `wasm-opt`.

```sh
npm install
npm run build        # build:wasm (cargo, wasm-bindgen, wasm-opt -Oz; both modules) then build:js (esbuild -> dist/)
npm run serve        # http://127.0.0.1:8090/ serves dist/ (see "Development server")
```

Build variables:

| Variable | What it does |
|---|---|
| `WASM_BINDGEN=`, `WASM_OPT=` | Tool paths. |
| `CARGO_TOOLCHAIN=` | Default `stable`. |
| `CARGO_TARGET_DIR=` | Honoured. |
| `CARGO_LOCKED=0` | Lets cargo update `Cargo.lock`. By default it builds `--locked` and fails rather than change a lock; after changing a dependency, run `cargo update` in the crate and commit the lock. |
| `CORE_FEATURES=viewer` | Adds the whole-file viewer path. Roughly doubles the WASM. |
| `ENIG_TERM_SOURCEMAP=1` | Writes `enig-term.js.map`. Off by default so it is not part of `dist/`. |

## The engine: a patched icy_tools

icy_tools is pinned at `1456074e` in `crates/enig-term-core/Cargo.toml`.
`crates/enig-term-core/Cargo.lock` is the real pin for everything else,
because several of icy_tools' own git dependencies have no revision.

`scripts/prepare-icy.sh` (run by `build:wasm`) fetches exactly the pinned
revision into `build/icy_tools/` and applies `patches/icy_tools/*.patch`. The
checkout is shallow, about 125 MB on disk. Set `ICY_TOOLS_GIT=` to a local
clone for offline builds. The `[patch."https://github.com/mkrueger/icy_tools"]`
section in Cargo.toml builds icy_engine and icy_parser_core from there.

There is one patch, `0001-no-embedded-fonts.patch` (7 files, about 40 lines).
It removes every font compiled into icy_engine. It shadows
`include_bytes!`/`include_str!` for the crate with macros that yield empty
data, makes `BitFont::from_bytes` refuse empty data, and turns the unwraps on
built-in fonts into a blank placeholder. The shell loads the fonts it ships
instead (see [Fonts](fonts.md)).

## ZModem: a second WASM module

`crates/enig-term-zmodem` is loaded only for a transfer. It compiles icy_net's
ZModem (icy_board's `crates/icy_net`, Apache-2.0) straight from
`build/icy_board/`. `prepare-icy.sh` checks that out sparsely (only
`crates/icy_net`, about 2 MB; `ICY_BOARD_GIT=` for a local clone) at the
revision in the crate's `Cargo.toml` (`[package.metadata.enig-term]
icy-board-rev`, the one icy_tools pins for icy_net), and applies
`patches/icy_board/*.patch`. The crate's own files are the wrapper
(`src/lib.rs`) and the platform shims (`src/rt.rs`). What the eight patches
change is in [File transfers](transfers.md#how-it-is-built).

## Rebasing icy_tools

1. Change both `rev = "..."` values in `crates/enig-term-core/Cargo.toml`.
2. Run `scripts/prepare-icy.sh`. If the patch no longer applies, fix it in
   `build/icy_tools/` and save it again with
   `git -C build/icy_tools diff > patches/icy_tools/0001-no-embedded-fonts.patch`.
   The intent is in the patch's comments: no font data compiled in, no panic
   on a missing built-in font. Check for new `include_bytes!` users that are
   not fonts, since the shadowing macros would empty them too. There are none
   at `1456074e`.
3. Run `cargo update -p icy_engine -p icy_parser_core` in the crate, then
   review the `Cargo.lock` diff.
4. Regenerate the screen wrapper with `python3 scripts/gen-delegate.py build/icy_tools`.
5. `npm run build`, `npm test`. After checking the screenshots, `npm run goldens`.

icy_board (ZModem) works the same way. Change `icy-board-rev` in
`crates/enig-term-zmodem/Cargo.toml` to what the new icy_tools pins for
icy_net, run `scripts/prepare-icy.sh`, and fix any patch that no longer
applies in `build/icy_board/`. Patches apply in order, so regenerate one
against a checkout with the earlier ones committed. `prepare-icy.sh` rebuilds
the checkout whenever a patch changes, which drops such commits. Then
`npm run build` and `npm test`; the ZModem unit tests run lrzsz and sexyz.

## Tests

```sh
npm test             # typecheck, Node unit tests, Playwright (needs a built dist/)
npm run test:unit    # core (WASM) and shell tests in Node
npm run test:browser # Playwright: chromium, webkit, firefox, Pixel 7, iPhone 14
npm run fuzz -- 60   # feed fuzzer for N seconds (optional seed as 2nd argument)
npm run fuzz:audio -- 30   # audio fuzzer: APC strings, CSI = 7, music through core and engine
npm run fuzz:xfer -- 30    # transfer fuzzer: mutated X/Y/ZModem sessions into every engine
FFMPEG=... npm run fixtures:audio   # regenerate test/fixtures/audio/ and src/audio/probes.ts (rarely)
ENIG_TERM_LIVE_WS=ws://127.0.0.1:18810 npm run test:live            # a throwaway ENiGMA
ENIG_TERM_LIVE_PAGE=http://127.0.0.1:18080/_enig/ws-term/ npm run test:live   # through ENiGMA's route
ENIG_TERM_LIVE_XFER=ws://127.0.0.1:18910 ENIG_TERM_LIVE_XFER_DIR=<its scratch tree> npx playwright test test/transfer-live.spec.ts
npm run fonts:amiga  # optional: install the Amiga fonts into test/amiga-fonts/ (gitignored)
ENIGMA_ART=<file.ans> npx playwright test test/render.spec.ts   # optional: also screenshot a real piece of art (not committed)
npm run fonts -- <oldschool_pc_font_pack_v2.2_FULL.zip>   # regenerate fonts/ (rarely)
```

The transfer tests run the real transfer programs where they are installed
and skip them otherwise. That means Synchronet's `sexyz` (on `PATH`, in
`~/.local/bin`, or `ENIG_TERM_SEXYZ=`) and lrzsz (`sz`, `rz`, `sx`, `rx`,
`sb`, `rb`). In Node they run over pipes (`test/xymodem.test.mjs`,
`test/zmodem.test.mjs`). In the browsers the fake BBS runs them over the
WebSocket as ENiGMA does (`test/transfer.spec.ts`). The live matrix
(`test/transfer-live.spec.ts`) needs a throwaway ENiGMA prepared as its header
describes.

Tests that need the Amiga fonts (a Topaz test card, the explicit Amiga
profile's font, the fetch script's offline round trip) skip when
`test/amiga-fonts/` is missing. The development server serves that directory
as `/fonts/amiga/`. Everything else uses the shipped PC fonts. Where a test is
about slot numbers rather than designs, it puts our ISO-8859-1 font into slot
42 as a stand-in.

### WebKit on hosts without its system libraries

Playwright's WebKit build needs libraries a desktop may lack (Ubuntu 24.04:
`libevent-2.1-7t64`, `libavif16`). Without them `npm test` does not fail; the
WebKit projects are left out with a loud `SKIPPING WebKit tests` warning. To
run them, pick one:

- `npm run setup:webkit` (no root, Debian/Ubuntu only) checks WebKit with
  `ldd`, downloads the missing packages with `apt-get download`, unpacks them
  into `~/.cache/enig-term/wkdeps` and writes a launcher there. The Playwright
  config then uses it by itself.
- `npx playwright install-deps webkit` (root, system-wide).
- Point `WEBKIT_EXECUTABLE=` at a launcher of your own.

`ENIG_TERM_REQUIRE_WEBKIT=1` turns the skip into an error, for CI. Playwright
is pinned to 1.60.0 to match the cached browser builds.

### CI

`.github/workflows/ci.yml` builds both WASM modules from a clean checkout
with pinned tools (Rust 1.96.0, wasm-bindgen-cli 0.2.129, binaryen
version_133, Node 22). It then runs the typecheck, the Node unit tests and
Playwright on Chromium, Firefox and Pixel 7. WebKit runs as a non-blocking
step. lrzsz is installed there; sexyz is not packaged, so its tests skip.
`dist/` is uploaded as the `enig-term-dist` artifact. The pins and the
setup steps live in `.github/actions/setup-build/action.yml`, which the
release workflow shares. cargo builds `--locked` against the committed
`Cargo.lock` files, the checkout keeps no token in `.git/config`, and the job
can only read the repository. CI restores the npm and cargo caches.

### Releases

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`. It fails unless
the tag is `v` plus the `package.json` version. It builds with the same
toolchain as CI and runs the Node unit tests (Playwright is left to CI on
`main`). Then `scripts/package-release.sh` writes `enig-term-X.Y.Z.zip`,
`enig-term-X.Y.Z.tar.gz` and `SHA256SUMS`, and checks the archives: the
required files are there, and there is no `fonts/amiga/` and no
`config.json`. The release notes are the `## X.Y.Z - <date>` section of
`CHANGELOG.md`.

The workflow has three jobs, so that no write permission is held while
repository or dependency code runs:

- `build` (read-only) does all of the above. It is a clean build: no npm or
  cargo cache is restored, so nothing CI cached reaches a release. cargo
  runs `--locked` and the checkout keeps no token. It uploads the archives,
  `SHA256SUMS` and `notes.md` as the workflow artifact `release`.
- `attest` (`id-token` and `attestations: write`) signs
  [build provenance](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)
  for the two archives with `actions/attest-build-provenance`.
- `publish` (`contents: write`) creates the GitHub Release from the
  artifact. Neither it nor `attest` checks out or runs repository code.

The provenance ties each archive to the workflow run, commit and tag that
built it. To check a downloaded archive (GitHub CLI 2.49 or later):

```sh
gh attestation verify enig-term-X.Y.Z.zip --repo NuSkooler/enig-term
```

To cut a release: set the version in `package.json`, head the CHANGELOG
section `## X.Y.Z - YYYY-MM-DD`, commit, then tag and push the tag. To check
the packaging locally first, after `npm run build`:

```sh
scripts/package-release.sh "$(node -p 'require("./package.json").version')" build/release
```

It refuses a `dist/` that holds `fonts/amiga/`, so run it before installing
the Amiga fonts into `dist/`, or pass a copy without them as a third
argument.

### What the tests cover

The browser tests cover golden engine frames (`test/goldens.json`, the same
hashes in Node and every browser), canvas colour samples through WebGL2 and
the 2D fallback, the keymap and typed/pasted encodings, synthetic IME
composition and Gboard-style input, selection and copy, link confirmation,
scrollback, connection states and reconnect against a fake Telnet BBS
(`test/fake-bbs.mjs`), panic recovery, phone layouts and the key bar, and the
custom element on a hostile foreign page.

Audio has its own specs. `audio.spec.ts` covers OfflineAudioContext
measurements, formats, the autoplay lock, mute/volume, holds, the cache and
font notices. `audio-interop.spec.ts` runs ansi-bbs-utils 0.2.1's host side
over a WebSocket. The Node tests drive the real engine with ansi-bbs-utils'
`Terminal`, against enig-term and against its `Testing.FakeCTerm` with the
same calls (`test/audio.test.mjs`).

Screenshots go to `test/screenshots/` (gitignored) for checking by eye.

## Development server

`npm run serve` (`scripts/serve.mjs`) serves `dist/` at `/` and again at
`/_enig/ws-term/` (like ENiGMA), `test/fixtures/` at `/fixtures/`, and the fake
BBS at `ws://127.0.0.1:8090/fake-bbs?script=probe`.

`/config.json` comes from `$ENIG_TERM_DEV_CONFIG` or `./dev-config.json` if
either exists. Both live outside `dist/`, and `config.json` and
`dev-config.json` are gitignored. Without either, `/config.json` is a 404 and
the page shows its host input.

## dist/ layout

`npm run build` writes a self-contained directory. ENiGMA's `/_enig/ws-term/`
route serves it as is, so this layout is a contract.

| File | What it is |
|---|---|
| `index.html` | The standalone page. Fetches `./config.json` (relative); without one it asks for a host. |
| `enig-term.js` | The whole shell as one ES module, including the wasm-bindgen glue. Importing it defines `<enig-term>`; it also exports `mount`, `EnigTerm`, `version`. |
| `enig_term_core_bg.wasm` | The engine. Loaded from next to `enig-term.js` (resolved from `import.meta.url`), as `enig_term_core_bg.wasm?v=<16 hex digits of its SHA-256>`, so a bundle never pairs with a different WASM even though file names carry no hash. |
| `enig-term-audio.js` | The audio engine (CTerm audio, "ANSI" music, the file cache). An ES module the bundle imports from next to itself (`?v=<hash>`) the first time a board uses audio. |
| `enig-term-ogg.js` | Ogg Vorbis and Opus decoders (WebAssembly inside), imported by the audio engine only when the browser cannot decode an Ogg file itself. |
| `enig-term-xfer.js` | The transfer engines (X/YModem, the ZModem driver), imported (`?v=<hash>`) the first time a transfer starts. |
| `enig-term-zmodem.wasm` | ZModem (icy_net), fetched by `enig-term-xfer.js` from next to itself (`?v=<hash>`) for a ZModem transfer. Serve as `application/wasm`. |
| `fonts/` | `manifest.json` (SyncTERM slot -> file, code page, source, licence), `pc/*.psf` (48 PSF2 fonts, about 157 KB), and their `LICENSE` (CC BY-SA 4.0) and `README.txt`. Fetched lazily from next to `enig-term.js`: the manifest as `manifest.json?v=<16 hex digits of its SHA-256>` (stamped into the bundle), each font as `<file>?v=<16 hex digits of its own SHA-256>`, so all of it can be cached for good. |
| `fonts/amiga/` | Not shipped. The operator creates it with `tools/fetch-amiga-fonts.mjs` (see [Amiga fonts](fonts.md#amiga-fonts)). Its manifest is fetched with revalidation. The build fails if it appears in `dist/`. |
| `tools/fetch-amiga-fonts.mjs` | The operator's Amiga font installer (Node 18+, no dependencies, no root). |
| `credits.html` | Credits and licences (enig-term, icy_tools, the PC font table, the Amiga font source, palette sources). Linked from the Settings panel. |
| `LICENSE`, `NOTICE`, `LICENSE-APACHE-2.0` | BSD-2-Clause, the third-party notices (icy_tools, icy_net, fonts, decoders), and the Apache License 2.0 text (icy_net). |
| `config.example.json` | A `config.json` v1 example. |

There is no CSS file; styles live in the shadow root. There is no
`config.json` either: an operator's, or the one ENiGMA generates, is used.
The build fails if one ends up in `dist/`. Serve `.wasm` as
`application/wasm`.

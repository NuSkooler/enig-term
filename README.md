# enig-term

A browser terminal for ANSI-BBS boards. The emulation is
[icy_engine](https://github.com/mkrueger/icy_tools) compiled to WebAssembly;
around it sits a framework-free TypeScript shell (Telnet over WebSocket,
input, scrollback, selection, links, UI) and a WebGL2 output pass with sharp
scaling, 4:3 aspect correction and an optional CRT effect (2D-canvas
fallback).

Status: **Phase 4 (file transfers)**, version 0.1.0, not released. See
`CHANGELOG.md`, and `SPIKE.md` for the Phase 0 measurements behind the design
and the Phase 4 ZModem comparison.

- [Build](#build) · [Test](#test) · [dist/ layout](#dist-layout) ·
  [Standalone page](#standalone-page) · [config.json v1](#configjson-v1) ·
  [Embedding](#embedding) · [Settings](#settings) · [Keyboard](#keyboard) ·
  [Fonts](#fonts) · [Amiga profile](#amiga-profile) · [Audio](#audio) ·
  [File transfers](#file-transfers) · [Behaviour notes](#behaviour-notes) ·
  [Licences](#licences)

## Build

Toolchain:

- Node 22 (`mise.toml`; with mise, run commands through `mise exec --`).
- Rust stable with the `wasm32-unknown-unknown` target.
- `wasm-bindgen-cli` **0.2.129** (it must match the crate's pinned version).
- Optionally binaryen's `wasm-opt`.

```sh
npm install
npm run build        # build:wasm (cargo, wasm-bindgen, wasm-opt -Oz; both modules) then build:js (esbuild -> dist/)
npm run serve        # http://127.0.0.1:8090/ serves dist/ (see "Development server")
```

Build variables: `WASM_BINDGEN=` and `WASM_OPT=` (tool paths),
`CARGO_TOOLCHAIN=` (default `stable`), `CARGO_TARGET_DIR=` (honoured),
`CORE_FEATURES=viewer` (adds the whole-file viewer path; roughly doubles the
WASM), `ENIG_TERM_SOURCEMAP=1` (writes `enig-term.js.map`; off by default so
it is not part of `dist/`).

icy_tools is pinned at `1456074e` in `crates/enig-term-core/Cargo.toml`, and
`crates/enig-term-core/Cargo.lock` is the real pin for everything else
(several of icy_tools' own git dependencies have no revision).

**The engine is built from a patched icy_tools.** `scripts/prepare-icy.sh`
(run by `build:wasm`) fetches exactly the pinned revision into
`build/icy_tools/` (shallow, about 125 MB on disk; `ICY_TOOLS_GIT=` points it
at a local clone for offline builds) and applies `patches/icy_tools/*.patch`.
Cargo.toml's `[patch."https://github.com/mkrueger/icy_tools"]` section builds
icy_engine and icy_parser_core from there. The one patch,
`0001-no-embedded-fonts.patch` (7 files, about 40 lines), removes every font
compiled into icy_engine: it shadows `include_bytes!`/`include_str!` for the
crate with macros that yield empty data, makes `BitFont::from_bytes` refuse
empty data, and turns the unwraps on built-in fonts into a blank placeholder.
The shell loads the fonts it ships instead (see [Fonts](#fonts)).

**ZModem is a second WASM module**, `crates/enig-term-zmodem`, loaded only
for a transfer. It compiles icy_net's ZModem (icy_board's `crates/icy_net`,
Apache-2.0) straight from `build/icy_board/`, which `prepare-icy.sh` checks
out sparsely (only `crates/icy_net`, about 2 MB; `ICY_BOARD_GIT=` for a local
clone) at the revision in that crate's `Cargo.toml`
(`[package.metadata.enig-term] icy-board-rev`, the one icy_tools pins for
icy_net), with `patches/icy_board/*.patch` applied. The crate's own files are
the wrapper (`src/lib.rs`) and the platform shims (`src/rt.rs`); see
[File transfers](#file-transfers) for what the eight patches change.

### Rebasing icy_tools

1. Change both `rev = "..."` values in `crates/enig-term-core/Cargo.toml`.
2. `scripts/prepare-icy.sh`. If the patch no longer applies, fix it in
   `build/icy_tools/` (the intent is in the patch's comments: no font data
   compiled in, no panic on a missing built-in font) and save it again with
   `git -C build/icy_tools diff > patches/icy_tools/0001-no-embedded-fonts.patch`.
   Check for new `include_bytes!` users that are not fonts (none at `1456074e`;
   the shadowing macros would empty them too).
3. `cargo update -p icy_engine -p icy_parser_core` in the crate, then review
   the `Cargo.lock` diff.
4. Regenerate the screen wrapper with `python3 scripts/gen-delegate.py build/icy_tools`.
5. `npm run build`, `npm test`; after checking the screenshots, `npm run goldens`.

icy_board (ZModem) the same way: change `icy-board-rev` in
`crates/enig-term-zmodem/Cargo.toml` (to what the new icy_tools pins for
icy_net), run `scripts/prepare-icy.sh`, and fix any patch that no longer
applies in `build/icy_board/`. Patches apply in order, so regenerate one
against a checkout with the earlier ones committed (`prepare-icy.sh` rebuilds
the checkout whenever a patch changes, which drops such commits). Then
`npm run build` and `npm test` (the ZModem unit tests run lrzsz and sexyz).

## Test

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
and skip them otherwise: Synchronet's `sexyz` (on `PATH`, in
`~/.local/bin`, or `ENIG_TERM_SEXYZ=`) and lrzsz (`sz`, `rz`, `sx`, `rx`, `sb`,
`rb`). In Node they run over pipes (`test/xymodem.test.mjs`,
`test/zmodem.test.mjs`); in the browsers the fake BBS runs them over the
WebSocket as ENiGMA does (`test/transfer.spec.ts`). The live matrix
(`test/transfer-live.spec.ts`) needs a throwaway ENiGMA prepared as its
header describes.

Tests that need the Amiga fonts (a Topaz test card, the explicit Amiga
profile's font, the fetch script's offline round trip) skip when
`test/amiga-fonts/` is missing; the development server serves it as
`/fonts/amiga/`. Everything else uses the shipped PC fonts, and where a test
is about slot numbers rather than designs it puts our ISO-8859-1 font into
slot 42 as a stand-in.

**WebKit on hosts without its system libraries.** Playwright's WebKit build
needs libraries that a desktop may lack (Ubuntu 24.04: `libevent-2.1-7t64`,
`libavif16`). Without them `npm test` does not fail: the WebKit projects are
left out with a loud `SKIPPING WebKit tests` warning. To run them:

- `npm run setup:webkit` (no root): checks WebKit with `ldd`, downloads the
  missing packages with `apt-get download`, unpacks them into
  `~/.cache/enig-term/wkdeps` and writes a launcher there. The Playwright
  config then uses it by itself. Debian/Ubuntu only.
- or `npx playwright install-deps webkit` (root, system-wide),
- or point `WEBKIT_EXECUTABLE=` at a launcher of your own.

`ENIG_TERM_REQUIRE_WEBKIT=1` turns the skip into an error (for CI).
Playwright is pinned to 1.60.0 to match the cached browser builds.

What the browser tests cover: golden engine frames (`test/goldens.json`, the
same hashes in Node and every browser), canvas colour samples through WebGL2
and the 2D fallback, the keymap and typed/pasted encodings, synthetic IME
composition and Gboard-style input, selection and copy, link confirmation,
scrollback, connection states and reconnect against a fake Telnet BBS
(`test/fake-bbs.mjs`), panic recovery, phone layouts and the key bar, and the
custom element on a hostile foreign page, and audio (`audio.spec.ts`:
OfflineAudioContext measurements, formats, autoplay lock, mute/volume,
holds, the cache, font notices; `audio-interop.spec.ts`: ansi-bbs-utils
0.2.1's host side over a WebSocket). The Node tests drive the real engine
with ansi-bbs-utils' `Terminal` against enig-term and against its
`Testing.FakeCTerm` with the same calls (`test/audio.test.mjs`). Screenshots go to
`test/screenshots/` (gitignored) for checking by eye.

### Development server

`npm run serve` (`scripts/serve.mjs`) serves `dist/` at `/` and again at
`/_enig/ws-term/` (like ENiGMA), `test/fixtures/` at `/fixtures/`, and the fake
BBS at `ws://127.0.0.1:8090/fake-bbs?script=probe`. `/config.json` comes from
`$ENIG_TERM_DEV_CONFIG` or `./dev-config.json` if either exists (both outside
`dist/`; `config.json` and `dev-config.json` are gitignored), otherwise it is a
404 and the page shows its host input.

## dist/ layout

`npm run build` writes a self-contained directory. ENiGMA's `/_enig/ws-term/`
route serves it as is, so this layout is a contract:

| File | What it is |
|---|---|
| `index.html` | The standalone page. Fetches `./config.json` (relative); without one it asks for a host. |
| `enig-term.js` | The whole shell as one ES module, including the wasm-bindgen glue. Importing it defines `<enig-term>`; it also exports `mount`, `EnigTerm`, `version`. |
| `enig_term_core_bg.wasm` | The engine. Loaded from next to `enig-term.js` (resolved from `import.meta.url`), as `enig_term_core_bg.wasm?v=<16 hex digits of its SHA-256>`, so a bundle never pairs with a different WASM even though file names carry no hash. |
| `enig-term-audio.js` | The audio engine (CTerm audio, "ANSI" music, the file cache), an ES module the bundle imports from next to itself (`?v=<hash>`) the first time a board uses audio. |
| `enig-term-ogg.js` | Ogg Vorbis and Opus decoders (WebAssembly inside), imported by the engine only when the browser cannot decode an Ogg file itself. |
| `enig-term-xfer.js` | The transfer engines (X/YModem, the ZModem driver), imported (`?v=<hash>`) the first time a transfer starts. |
| `enig-term-zmodem.wasm` | ZModem (icy_net), fetched by `enig-term-xfer.js` from next to itself (`?v=<hash>`) for a ZModem transfer. Serve as `application/wasm`. |
| `fonts/` | `manifest.json` (SyncTERM slot -> file, code page, source, licence), `pc/*.psf` (48 PSF2 fonts, about 157 KB), and their `LICENSE` (CC BY-SA 4.0) and `README.txt`. Fetched lazily from next to `enig-term.js`: the manifest as `manifest.json?v=<16 hex digits of its SHA-256>` (stamped into the bundle), each font as `<file>?v=<16 hex digits of its own SHA-256>`, so all of it can be cached for good. |
| `fonts/amiga/` | **Not shipped.** Created by the operator with `tools/fetch-amiga-fonts.mjs` (see [Amiga fonts](#amiga-fonts)). Its manifest is fetched with revalidation. The build fails if it appears in `dist/`. |
| `tools/fetch-amiga-fonts.mjs` | The operator's Amiga font installer (Node 18+, no dependencies, no root). |
| `credits.html` | Credits and licences (enig-term, icy_tools, the PC font table, the Amiga font source, palette sources). Linked from the Settings panel. |
| `LICENSE`, `NOTICE`, `LICENSE-APACHE-2.0` | BSD-2-Clause, the third-party notices (icy_tools, icy_net, fonts, decoders), and the Apache License 2.0 text (icy_net). |
| `config.example.json` | A commented-by-example `config.json` v1. |

There is no CSS file (styles live in the shadow root) and **no
`config.json`**: an operator's or ENiGMA's generated one is used. The build
fails if one ends up in `dist/`. Serve `.wasm` as `application/wasm`.

## Standalone page

`index.html` is `<enig-term config="config.json" url-params fill>`. URL
parameters (standalone page only) override `config.json`:

| Parameter | Option |
|---|---|
| `endpoint=wss://…` | `endpoint` (ignored when the config sets `lockEndpoint`) |
| `connect=1` | `autoConnect` |
| `aspect=0/1`, `crt=0/1`, `sharp=0/1`, `blink=0/1` | the booleans of the same name |
| `scale=fit\|integer`, `keys=auto\|on\|off`, `profile=auto\|pc\|amiga` | `scale`, `keyBar`, `profile` |
| `amigaPalette=ncomm\|term-ega`, `amigaAspect=pal\|ntsc\|<1-3>`, `amigaRows=` | the same |
| `cols=`, `rows=`, `scrollback=`, `renderer=webgl2\|2d`, `autoReconnect=0/1` | the same |
| `mute=0/1`, `volume=0-100`, `musicTone=square\|syncterm\|sine` | the same |
| `zmodemDetect=auto\|ask\|off` | the same |

Test hooks, never on by default: `naws=0` (refuse NAWS, so a host falls back
to `CSI 255 n`), `debugDa=cterm` (answer DA as CTerm, for ENiGMA builds that
only probe CTerm), `debugPanic=1` (let `CSI ? 2026 h` panic the engine, to
exercise recovery), `audioLock=1` (behave as if the browser refused audio
until a gesture), `audioFallback=1` (decode Ogg with the bundled decoders).

## config.json v1

A JSON object. Unknown keys are ignored (operators may pass extras through);
invalid values are dropped with a console warning. ENiGMA generates
`version`, `endpoint` and `title`, then merges its `wsTerm.client` object.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | integer | `1` | Schema version. A newer version is read for the keys this build knows, with a warning. |
| `endpoint` | string or `null` | `null` | `wss://` URL of the board. `ws://` is accepted only for loopback hosts (or with `allowInsecure`). `host:port` alone means `wss://host:port`. `null`: the page asks. |
| `title` | string | `"enig-term"` | Board name: toolbar and page title. |
| `lockEndpoint` | boolean | `false` | The user cannot change the endpoint (host input read-only; the `endpoint` URL parameter is ignored). |
| `autoConnect` | boolean | `false` | Connect on load when there is an endpoint. |
| `cols`, `rows` | integer | `80`, `25` | Terminal size (20-255, 10-255). Sent by NAWS. |
| `profile` | `"auto"`, `"pc"` or `"amiga"` | `"auto"` | Look profile ([Amiga profile](#amiga-profile)). `auto`: PC, switching to Amiga while the host's normal font is an Amiga font (SyncTERM 37-42) and back on a PC font. `pc` or `amiga` locks it (a Phase 1 config with `"pc"` keeps the PC look). Typed text always follows the active font (Latin-1 under Amiga fonts). |
| `fonts` | string | `"fonts/"` | Directory of the PC fonts and their `manifest.json`, relative to `enig-term.js`. |
| `amigaFonts` | string, or `false` | `"fonts/amiga/"` | Directory of the operator-installed Amiga fonts, relative to `enig-term.js`. `""` or `false`: none (Amiga fonts are refused without a request). |
| `amigaPalette` | `"ncomm"` or `"term-ega"` | `"ncomm"` | Amiga profile palette. |
| `amigaAspect` | `"pal"`, `"ntsc"` or a number 1-3 | `"pal"` | Amiga profile pixel aspect, height:width of an Amiga hires pixel: PAL 1.875, NTSC 2.4. Applies when `aspect` is on. |
| `amigaRows` | integer 10-255, or `null` | `null` | Rows while the Amiga profile is active (e.g. 24, 25 or 32; NAWS tells the host). `null` keeps `rows`. |
| `amigaFont` | integer 37-42 | `42` | Font the explicit `"amiga"` profile selects when Amiga fonts are installed (42 Topaz). |
| `amigaIce` | boolean | `false` | Amiga profile honours the host's `CSI ? 33 h` (iCE colours). |
| `amigaBlink` | boolean | `true` | Amiga profile blinks SGR 5 text. |
| `amigaCursor` | `"block"` or `"host"` | `"block"` | Amiga profile cursor: always a block, or the shape the host sets. |
| `aspect` | boolean | `true` | 4:3 aspect correction. |
| `crt` | boolean | `false` | CRT effect (curvature, scanlines). |
| `scale` | `"fit"` or `"integer"` | `"fit"` | Fit the space, or only whole multiples (falls back to fit when even 1x does not fit). |
| `sharp` | boolean | `true` | Sharp-bilinear sampling (off: plain bilinear). |
| `keyBar` | `"auto"`, `"on"`, `"off"` (or boolean) | `"auto"` | On-screen key bar; `auto` shows it on coarse pointers (touch). |
| `scrollback` | integer | `2000` | Scrollback lines kept (0-100000; 0 disables). |
| `scrollbackOnClear` | boolean | `true` | Keep the non-blank lines of a screen the host clears. |
| `autoReconnect` | boolean | `false` | Reconnect after an unexpected close, with backoff (1 s doubling to 30 s, jittered; reset after a session of 10 s or more). |
| `backspace` | `"bs"` or `"del"` | `"bs"` | Backspace sends `^H` (Delete sends DEL), or the reverse. |
| `linkSchemes` | string array | `["http:", "https:"]` | OSC 8 link schemes that may be opened. |
| `allowInsecure` | boolean | `false` | Allow `ws://` to non-loopback hosts (development only). Not settable from the URL. |
| `termType` | string | `"ansi-bbs"` | Telnet TTYPE answer. |
| `renderer` | `"webgl2"` or `"2d"` | `"webgl2"` | Output pass. |
| `lock` | string array | `[]` | User settings (see [Settings](#settings)) the user may not change, e.g. `["crt"]`. |
| `toolbar` | boolean | `true` | Show the toolbar. |
| `persist` | boolean | `true` | Remember user settings in `localStorage`. |
| `blink` | boolean | `true` | Text and cursor blink (off is for screenshots). |
| `urlParams` | boolean | `false` | Read URL parameters (the standalone page sets it). |
| `sound` | boolean | `true` | Sound at all ([Audio](#audio)): `false` answers no audio query and plays nothing. |
| `mute` | boolean | `false` | Muted (a user setting). |
| `volume` | integer 0-100 | `70` | Master volume (a user setting). |
| `musicTone` | `"square"`, `"syncterm"` or `"sine"` | `"square"` | Voice of "ANSI" music (a user setting). |
| `audioCache` | integer (MB) | `64` | Board sounds kept in IndexedDB, all boards together (LRU); `0`: none kept (files last until the page closes). |
| `audioMaxFile` | integer (MB) 1-64 | `16` | Largest sound file a board may store, load or send. |
| `audioMemory` | integer (MB) 16-2048 | `192` | Decoded audio held at once (slots and channels). |
| `transfers` | boolean | `true` | File transfers ([File transfers](#file-transfers)): the Files button and ZModem detection. `false`: none (a board's ZModem start shows as text). |
| `zmodemDetect` | `"auto"`, `"ask"` or `"off"` | `"auto"` | A ZModem download the board starts: begins at once, asks first, or is ignored (its bytes show as text). An upload the board starts always asks for files (unless `off`). A user setting. |
| `transferMaxFile` | integer (MB) 1-4096 | `512` | Largest file saved through a browser download; a larger one is refused (ZModem skips it, X/YModem stop). A folder the user picked has no limit. |

Example: `config.example.json`.

### Precedence

Lowest first:

1. built-in defaults;
2. `config.json`;
3. element attributes, or `mount()` options (the embedding page);
4. URL parameters, only when `urlParams` is on (the standalone page), and
   never for `endpoint` when `lockEndpoint` is set, nor for `lock`,
   `lockEndpoint`, `urlParams`, `allowInsecure`, `linkSchemes` or a locked key;
5. user settings saved in `localStorage`, only for the user-settable keys and
   only those not in `lock`.

## Embedding

```html
<script type="module" src="/path/to/enig-term.js"></script>
<enig-term endpoint="wss://bbs.example.com:8443" auto-connect crt="off" keybar="auto"></enig-term>
```

Attributes: `config` (URL of a `config.json`, relative to the page),
`endpoint`, `lock-endpoint`, `auto-connect`, `title`, `cols`, `rows`,
`profile`, `scrollback`, `crt`, `aspect`, `scale`, `keybar`, `toolbar`,
`persist`, `url-params`, `renderer`, `blink`, `auto-reconnect`,
`backspace`, `fonts`, `amiga-fonts`, `amiga-palette`, `amiga-aspect`,
`amiga-rows`, `sound`, `mute`, `volume`, `music-tone`, `transfers`,
`zmodem-detect`, `transfer-max-file`, and `fill` (fit the
element's height too; give it a height).
Booleans: present, `on`, `true` or `1` is on; `off`, `false` or `0` is off.
`endpoint`, `title`, `crt`, `aspect`, `scale`, `keybar`, `toolbar`,
`auto-reconnect`, `backspace`, `blink`, `scrollback`, `profile`,
`amiga-palette`, `amiga-aspect`, `amiga-rows`, `mute`, `volume`,
`music-tone`, `transfers`, `zmodem-detect` and `transfer-max-file` also apply
when changed later. The element has `ready` (a promise of the handle), `handle`,
`connect()` and `disconnect()`.

```js
import { mount } from '/path/to/enig-term.js';
const term = await mount(document.getElementById('bbs'), {
  config: '/bbs/config.json',      // or an object; ranks below the options here
  endpoint: 'wss://bbs.example.com:8443',
  crt: false,
});
term.on('state', e => console.log(e.state, e.detail));   // idle|connecting|connected|closed|error
term.connect();
```

Handle: `connect(endpoint?)`, `disconnect()`, `setOption(key, value)`,
`getOption(key)`, `on(event, fn)` (returns an unsubscribe function),
`send(text)`, `paste(text)`, `write(data)` (as if from the host),
`copySelection()`, `focus()`, `resize(cols, rows)`, `toggleFullscreen()`,
`soundState`, `enableSound()` (from a user gesture: your own "enable sound"
control), `clearSoundCache()`, `download(protocol?, name?)` and
`upload(files, protocol?)` (protocol `"zmodem"` by default, `"ymodem"` or
`"xmodem"`; files from an `<input type=file>`), `cancelTransfer()`,
`transfer` (the current or last transfer's status), `state`, `version`,
`destroy()`, and `terminal` (internals; not stable).

Events (on the handle, and as DOM `CustomEvent`s on `<enig-term>` with the
event object as `detail`):

| Event | Detail |
|---|---|
| `state` | `{ state, detail, endpoint, reconnectInMs? }` |
| `title` | `{ title }` (OSC 0/2) |
| `bell` | `{}` (BEL; the screen also flashes) |
| `link` | `{ url, allowed, reason?, preventDefault() }`: an OSC 8 link was clicked. `preventDefault()` (or on the DOM event) skips the built-in confirmation. |
| `notice` | `{ level, text }`: messages the UI shows (copy refused, engine restarted...) |
| `recovered` | `{ message, recovered }`: the engine trapped and was replaced |
| `scroll` | `{ offset, lines }`: the scrollback view moved (0 = live) |
| `selection` | `{ text }` |
| `profile` | `{ profile, setting }`: the look in effect changed (`pc` or `amiga`; `setting` is the configured `auto`/`pc`/`amiga`) |
| `sound` | `{ state }`: `off` (disabled or unsupported), `idle` (no audio yet), `locked` (the board plays sound; waiting for a gesture), `on`, `muted` |
| `transfer` | `{ phase, direction, protocol, file, fileBytes, totalBytes, doneBytes, rate, eta, files, skipped, error, message }`: `phase` is `idle`, `armed` (prepared, waiting for the board), `offer` (the board started ZModem, waiting for the user), `loading`, `running`, `done`, `failed` or `cancelled`; `files` lists the files finished (`{ name, size, ok, url?, where }`) |

Isolation: everything lives in an open shadow root. The page's CSS does not
reach in (inherited properties are reset at the root), and nothing is added
to the page's `<head>`. The WASM is resolved from the script's own URL, so
the bundle can be served from any path. Several terminals can share a page
(they share one WASM instance; see engine recovery below).

## Settings

The Settings panel holds the user-settable keys, saved per origin in
`localStorage` (`enig-term:settings:v1`; every access is guarded, and the
terminal works without storage): `crt`, `aspect`, `scale`, `keyBar`,
`autoReconnect`, `backspace`, `profile` ("Look": Auto, PC, Amiga),
`amigaPalette`, `amigaAspect`, `mute`, `volume`, `musicTone`, `zmodemDetect`
(in the Files panel) (and `sharp` through the API), plus **Clear sound
cache**. Keys in the
config's `lock` are shown disabled. The panel links to the credits page.
The toolbar also has the host input,
Connect/Disconnect/Reconnect, Copy, Paste, Sound (mute) with a volume
slider, Files ([File transfers](#file-transfers)), and Full screen (an iPhone, which
has no element fullscreen, gets a viewport-covering mode instead).

## Keyboard

| Key | Sends |
|---|---|
| Arrows | `CSI A` `CSI B` `CSI C` `CSI D` |
| Home / End | `CSI H` / `CSI K` |
| Insert / Delete | `CSI @` / DEL (0x7F) |
| PgUp / PgDn | `CSI V` / `CSI U` |
| Backspace | ^H (0x08); swapped with Delete by `backspace: "del"` |
| Enter / Tab / Shift+Tab / Esc | CR / HT / `CSI Z` / ESC |
| F1-F4 | `ESC O P` .. `ESC O S` |
| F5-F12 | `CSI 15~` `17~` `18~` `19~` `20~` `21~` `23~` `24~` |
| Ctrl+letter, Ctrl+`[ \ ] ^ _`, Ctrl+Space | C0 controls (Ctrl+Space and Ctrl+2: NUL) |
| Alt+key | ESC, then the key (also for named keys) |

Typed and pasted text is encoded as CP437, or as Latin-1 while an Amiga font
(SyncTERM 37-42) is active. Characters with no encoding become `?`. Line
breaks become CR. Paste goes out in 256-byte chunks, 10 ms apart.

While a file transfer runs (and for the moment after a failed one while the
board's program winds down), keys, the key bar and paste send nothing (it
would land in the protocol); the transfer card's buttons still work, and the
keyboard is the terminal's again when it ends.

Shortcuts the terminal keeps: **Shift+PgUp / Shift+PgDn** (scrollback),
**Ctrl+Shift+C** or **Ctrl+Insert** (copy), **Ctrl+C with a selection**
(copy; without one it is ^C for the host), **Ctrl+V**, **Ctrl+Shift+V**,
**Shift+Insert** (paste). ^V itself can be sent from the key bar (Ctrl, then
V). Cmd/Win combinations are left to the browser.

On touch devices the key bar has Esc, Tab, sticky Ctrl and Alt, arrows,
Home/End/PgUp/PgDn/Ins/Del and an Fn row (F1-F12). It sits on the bottom edge
of the visual viewport, so it stays above the soft keyboard (iOS does not
shrink the layout viewport). Tap the screen to raise the keyboard.

## Fonts

No font is compiled into the WASM. The PC fonts are 256-glyph PSF2 files in
`fonts/pc/`, one per code page and cell height, built by
`scripts/build-fonts.mjs` from VileR's **Ultimate Oldschool PC Font Pack**
v2.2 (int10h.org, CC BY-SA 4.0; SHA-256 of the pack checked): the IBM VGA
design, sampled from the pack's Px437 and PxPlus pixel-outline TrueType fonts.
16-pixel cells use IBM VGA 8x16, 14-pixel cells IBM VGA 8x14, 8-pixel cells
the first 8 columns of IBM VGA 9x8. The CP437 files match the pack's own
Windows bitmap (FON) fonts bit for bit. Other code pages are arranged from
the same designs with Python's codec tables (`scripts/fonts/codepages.json`);
C0 positions show the CP437 graphics, as DOS code page fonts do.

The shell fetches the manifest and the slot 0 font (CP437) at start, with the
WASM: a CP437 session loads `fonts/manifest.json` (22,218 B, 4,156 B gzipped)
and `cp437-8x16.psf` (4,128 B, 1,400 B gzipped). Any other font is fetched
when the host selects it: the stream is held at the final byte of
`CSI Ps1 ; Ps2 SP D` until the font is in (at most 5 s), so the selection
succeeds and the text after it uses the font.

**SyncTERM font slots** (`CSI Ps1 ; Ps2 SP D`, numbered as in the CTerm
manual):

| Slot | Font | Drawn with |
|---|---|---|
| 0, 26 | CP437 (26: "thin") | IBM VGA, CP437 |
| 1, 20 | CP1251 Cyrillic (1: "swiss") | IBM VGA, CP1251 |
| 2, 12, 22 | KOI8-R ((b), (c)) | IBM VGA, KOI8-R |
| 3 | ISO-8859-2 | IBM VGA |
| 4, 11, 13, 23 | ISO-8859-4 Baltic (wide, VGA 9bit mapped) | IBM VGA, ISO-8859-4 |
| 5, 25, 27 | CP866 ((c), (b)) | IBM VGA, CP866 |
| 6 | ISO-8859-9 | IBM VGA |
| 8 | ISO-8859-8 Hebrew | IBM VGA (LRM/RLM blank) |
| 9 | KOI8-U | IBM VGA |
| 10, 16 | ISO-8859-15 (10: "thin") | IBM VGA |
| 14 | ISO-8859-5 | IBM VGA |
| 17, 18 | CP850 (17: "thin") | IBM VGA |
| 19, 28 | CP865 (19: "thin"; the manual says "885") | IBM VGA |
| 21 | ISO-8859-7 Greek | IBM VGA (0xA5 drachma and 0xAA ypogegrammeni are blank: not in the pack) |
| 24, 30 | ISO-8859-1 (30: "thin") | IBM VGA |
| 29 | cp866u Ukrainian | IBM VGA, CP1125 |
| 7, 15 | haik8, ARMSCII-8 | **refused**: no Armenian glyphs in the licensed set |
| 31 | CP1131 Belarusian | **refused**: no code page table to build it from |
| 32-35 | Commodore 64/128 | **refused**: no licensed font |
| 36 | Atari | **refused**: no licensed font |
| 37-42 | P0T NOoDLE, mO'sOul, MicroKnight Plus, Topaz Plus, MicroKnight, Topaz | operator-installed Amiga fonts, else **refused** |
| 43, 44, 45 | Prestel, Atari ST, RIPterm | **refused**: no licensed font (CTerm built-ins; a DCS load into them is refused too) |
| 46-255 | `DCS CTerm:Font` | loaded by the host |

Style variants (thin, swiss, (b), (c), wide) are drawn in the one IBM VGA
design; `credits.html` lists them. A refused selection changes nothing on
screen and reports `pR = 1` in `CSI = 1 n`; a selection never draws blank.

- **Cell size follows the screen mode, as in SyncTERM**: 25 (and most) rows
  use 16-pixel cells, 28 and 43 rows 14, 50 rows 8; each slot loads the font
  of that height. A resize that changes the cell height reloads the fonts on
  screen at the new height (the core reports which ones it needs). A font of
  another height (from a DCS) is refused while the mode's height differs.
  (icy_engine draws every cell at slot 0's size, so cells cannot follow
  their own font's size: an upstream limit.)
- **Ps1**: the font goes into attribute slot 0 (normal), 1 (bold), 2 (blink)
  or 3 (bold and blink). Bold text uses slot 1 under `CSI ? 31 h`, blinking
  text slot 2 under `CSI ? 34 h`, both slot 3; `CSI ? 32 h` stops bold from
  brightening and `CSI ? 35 h` stops blinking text from blinking (CTerm's
  meaning of 35, not icy_engine's cursor blink). Like everything in
  icy_engine, these apply to text written afterwards (fonts are per cell).
  Ps1 above 3 is refused.
- **DCS `CTerm:Font:<slot>:<base64>`**: slots 46-255 (`pF = 46` in
  `CSI = 1 n`; the current CTerm manual puts loadable fonts above its
  built-ins, which now end at 45), any drawable size (8 wide, 1-32 high), kept at its own
  height. Reloading a slot in use updates its cells at once.
- **SAUCE**: letter spacing (9-dot) and iCE apply; the SAUCE font name is not
  mapped to our fonts yet (the file renders with slot 0, CP437 at the mode's
  height). The 9th column is the engine's: blank, or a copy of column 8 for
  0xC0-0xDF (the VGA's 9-dot alternate glyphs are not reproduced).

### Amiga fonts

enig-term does not ship Amiga fonts. The operator installs them, in the
directory that holds `enig-term.js`:

```sh
node tools/fetch-amiga-fonts.mjs                # writes fonts/amiga/
node tools/fetch-amiga-fonts.mjs --kickstart 1  # Topaz and Topaz Plus from Kickstart 1.x
node tools/fetch-amiga-fonts.mjs --out DIR      # elsewhere (then set config.json "amigaFonts")
```

It downloads TrueSchool's **Multi Platform Amiga Fonts** v1.02 (dMG/t!s^dS!)
from <https://github.com/rewtnull/amigafonts>, pinned to commit `d4298753`,
checks every file against a SHA-256 in the script (on any mismatch it writes
nothing and exits 1), converts the 8x16 raw fonts (line-doubled 8x8 "Amiga
aspect" bitmaps, ISO-8859-1 order) to PSF2 at 16 rows, plus an 8-row variant
from the even rows, and writes them with a `manifest.json` and the source's
README (`README-amigafonts.txt`). Slots: 37 P0T-NOoDLE, 38 mO'sOul, 39
MicroKnight Plus, 40 Topaz Plus, 41 MicroKnight, 42 Topaz (Kickstart 2.x+
versions by default).

**Licence status:** the source README releases these files "under the GPL-FE
license" (GPL with the font exception) and also says "Topaz is (c) AmigaInc."
(the files are remakes); P0T-NOoDLE, MicroKnight and mO'sOul are credited to
their original authors. That is why enig-term only points to them: whether
to serve them is the operator's decision. Note that in these bitmaps
Topaz/Topaz Plus (Kickstart 2) and P0T-NOoDLE hold the Amiga's inverted
underscore at 0xA0 (non-breaking space), as the README explains.

## Amiga profile

The Ami/X look: the Amiga palette, Amiga pixel aspect, a block cursor, iCE
off, optionally an Amiga screen height, and typed text in Latin-1 (that
follows the font in every profile).

- **When**: `profile: "auto"` (default) switches to it while the host's normal
  font (Ps1 0) is an Amiga font (37-42) and back on any other font; a font
  that is refused changes nothing. `"amiga"` or `"pc"` (config, attribute,
  URL, API `setOption('profile', ...)` or the Settings panel) locks it; the
  explicit `"amiga"` also selects `amigaFont` (Topaz) when Amiga fonts are
  installed, and undoes that when the profile ends. The user's setting ranks
  as described in [Precedence](#precedence), unless the config locks `profile`.
- **Palette**: `src/palettes.ts` holds the tables. `ncomm` (default) is NComm
  3.0/3.09's ANSI pens: `000 C00 0B0 BA0 00C B0B 0DD DDD | 666 F00 0F0 FF0 00F
  F0F 0FF FFF` (12-bit, ANSI order, each component x17); `term-ega` is Term
  4.8's table. It is the default palette while the profile is active: host
  OSC 4 changes still apply, and OSC 104 resets to it.
- **Aspect**: the Amiga fonts are 8x8 glyphs line-doubled into 16-row cells,
  so a frame row is half an Amiga pixel and the frame is stretched by
  `amigaAspect` x 8 / cell height: PAL (1.875, 640x256 at 4:3) by default, NTSC
  2.4 (640x200 at 4:3, the same shape as the PC's 4:3). `aspect: false` shows
  square pixels.
- **Geometry**: `amigaRows` (off by default) resizes while the profile is
  active and sends NAWS; the configured `rows` return with the PC profile.
  NComm's "80x24" used a 640x204 screen; Term followed the display mode.
- **Defaults**, all overridable: bold is bright, SGR 5 blinks
  (`amigaBlink`), iCE colours off (`amigaIce`: no Amiga terminal is documented
  with bright backgrounds; the host's `CSI ? 33 h` is remembered and reported,
  and applies again in the PC profile), block cursor (`amigaCursor`).

## Audio

Two kinds of sound, both through one WebAudio mixer with the user's mute and
volume:

- **CTerm audio** (`APC SyncTERM:A;...`, `SyncTERM:C;S`/`C;L`, `SyncTERM:Q;...`,
  `CSI = 7 n`), as the "Audio APCs" section of the current CTerm manual
  (CTerm 1.332) defines it: what SyncTERM 1.10 and IcyTerm 0.8.4 speak, and
  what [ansi-bbs-utils](https://github.com/NuSkooler/ansi-bbs-utils) 0.2.1
  drives.
- **"ANSI" music** (`CSI | ... ^N`, BananaCom `CSI N ... ^N`, `CSI M ... ^N`),
  as in the manual's "ANSI" Music section.

The engine (`enig-term-audio.js`, about 13 KB gzipped) is loaded the first
time a board uses audio; a board that never does costs nothing but the
toolbar button. Everything audio is off with `sound: false`: the terminal
then answers no audio query, like a terminal without audio.

### CTerm audio

- **Patch slots** (256) and **channels** (16): `Load` (from the cache),
  `LoadBlob` (base64 data), `Synth` (SIN, SAW, SQ, SINE_HARM, SINE_SAW,
  SINE_SAW_CHORD, SINE_SAW_HARM, SILENCE; the four "noisy" shapes sound as
  SyncTERM makes them), `Copy`, `Queue`, `Flush`, `Volume`, `Wait`, `Update`.
  Channels 0 and 1 belong to the terminal (0 is "ANSI" music; nothing plays
  on 1): `Queue` there is refused, `Flush`/`Volume`/`Wait`/`Update` work.
- **Queue** moves the slot's buffer onto the channel (the slot is empty
  afterwards); buffers play back to back without gaps. `I=` fades in (first
  pass of a loop), `O=` fades out the end of the final pass (both scaled to
  fit a short buffer), `L` loops, `V=`/`VL=`/`VR=` set the buffer's level on
  top of the channel's. **A later Queue ends a loop** at the end of the pass
  in progress (the manual's rule; SyncTERM's and IcyTerm's mixers keep
  looping). **`X`** with `I=`: the buffer playing decays while the new one
  fades in over `I`, equal-power, both audible during the overlap; on an
  empty channel it is a plain fade-in.
- **Flush** drains the channel; with `O=` what is sounding fades out first.
- **Volume** sets the channel's base level (every channel starts at -12 dB,
  as in SyncTERM; `V=100` is 0 dB, `V=0` the -60 dB floor, or `V=-6dB`);
  `T=` ramps from the current level, dB-linear; a side not given keeps its
  value. Durations: milliseconds, `ms`, `f` (frames at 44.1 kHz) and, for
  `Synth`'s `T`, `p` (periods of `F`).
- **Wait** holds the stream (CTerm blocks there) until the channel is idle,
  or at once if its head buffer loops; at most 5 minutes. **Update** arms a
  one-shot `CSI = 7 ; ch ; 0 n` for the channel's next running-to-stopped
  transition.
- **Replies**: `SyncTERM:Q;libsndfile` -> `CSI = 7 ; 100 ; 1 n`;
  `SyncTERM:Q;libsndfileFormat;pm;ps` -> `CSI = 7 ; 101 ; pm ; ps ; 0|1 n`
  (see the table below; the answer is what this browser decodes, tried once
  on a tiny sample); `CSI = 7 n` -> the running channels (`CSI = 7 n` when
  idle); `CSI = 7 ; ch n` -> one pair (`ch` 100: the decoder, 1); `C;L` ->
  the listing; `SyncTERM:Q;JXL` -> `CSI = 1 ; 0 - n`. DA and CTDA are
  unchanged (CTDA has no audio feature number; a host detects audio with
  the libsndfile query, as ansi-bbs-utils does).
- **The file cache** (`C;S` stores, `C;L` lists, `Load` reads) is kept per
  board (the endpoint without query or fragment) in IndexedDB, so it
  survives reconnects and reloads and a board uploads a file once.
  `C;L;<glob>` matches like glob(3): `*` and `?` stay within a directory;
  files are listed as `path TAB md5`, with their path relative to the cache,
  and matching subdirectories as `dir/` with no MD5 (SyncTERM prints those
  blank and files by basename; IcyTerm lists everything at once; hosts that
  handle both, like ansi-bbs-utils, handle this too). Names are path
  segments of printable ASCII, without `.`, `..`, `\ : * ? " < > |`. Without
  IndexedDB (private windows) the files live in memory until the page
  closes. Settings has **Clear sound cache** (all boards).

### "ANSI" music

`CSI = Ps M` picks the introducers: 0 only `CSI |`, **1 (default) also
`CSI N`**, 2 also `CSI M` without parameters (otherwise Delete Line, which
ENiGMA uses). The string is everything up to SO (0x0E); a character outside
the manual's set ends it unplayed. `T` (32-255, default 120), `O` (0-6,
default 4), `L` (1-64), `N` (0-71), notes with `+`/`#`/`-`/`.`/length,
`P`, `<`, `>`, `MF`/`MB`/`MN`/`ML`/`MS`, upper or lower case. Timing is
CTerm's: a whole note is 240000/tempo ms, dotted x1.5, normal articulation
sounds 7/8, staccato 3/4, legato all. **Foreground** (`MF`, the default)
holds the stream until the music has played, as CTerm does (at most two
minutes per string); `MB` plays in the background. State (tempo, octave,
length, style) carries over to the next string and resets with `ESC c`.
Pitch: note 0 is C in octave 0, 65.406 Hz, equal-tempered (the manual's
table), so the default octave's C is 1046.5 Hz. Voice: **`musicTone`**
`square` (default: a band-limited square, the PC speaker), `syncterm`
(SyncTERM's SINE_SAW_HARM timbre) or `sine`. Music plays on channel 0.

### Autoplay, mute and volume

Browsers let a page start audio only after a user gesture. Clicking
**Connect** counts (enig-term starts audio then, and suspends it again after
15 s if the board plays nothing); so does any key or tap in the terminal, the
toolbar's **Sound** button, or the prompt that appears when a board plays
sound before any of these happened ("This board plays sound: click to enable
it"). While sound is not allowed yet:

- **CTerm audio keeps its state.** Channels "play" on the wall clock: what
  the board hears back (`CSI = 7 n`, `Update` reports, `Wait`) is as if
  sound were on, and when sound starts, whatever is still in progress starts
  where it would be by then (a looping track mid-loop), after a 50 ms fade-in.
  Nothing is dropped.
- **"ANSI" music is skipped** and does not hold the stream: it belongs to the
  screen it came with, and starting it later would be out of place. The same
  applies while the user has muted sound.

The toolbar has **Sound** (mute toggle; "Enable sound" while waiting for a
gesture) and a volume slider (hidden at phone width); Settings has **Mute
sound**, **Volume**, **Music** (the `musicTone`) and **Clear sound cache**.
`mute`, `volume` and `musicTone` are user settings (saved, lockable). On
iOS, choosing to enable sound also sets `navigator.audioSession.type` to
`playback` (when the browser has it), so the ring/silent switch does not
mute it.

### Limits

Host input is untrusted; every limit drops what exceeds it (and logs it)
without breaking the session:

| Limit | Default | Config |
|---|---|---|
| One file stored, loaded or sent as a blob | 16 MB | `audioMaxFile` (MB) |
| One audio APC string (base64 of the above, plus the command) | ~21.3 MB | follows `audioMaxFile` |
| The cache in IndexedDB, all boards together (least recently used dropped) | 64 MB | `audioCache` (MB) |
| Decoded audio held in slots and on channels | 192 MB | `audioMemory` (MB) |
| Length of one decoded or synthesised buffer | 300 s | |
| One decode (browser or Ogg decoder) | 15 s | |
| Buffers per channel / on all channels (queued or playing) | 64 / 128 | |
| One "ANSI" music string | 1022 characters (CTerm's), 120 s of sound | |
| Holding the stream (`Wait`, foreground music) | 5 min, or 32 MB of host data meanwhile | |

The APC parser and the engine are fuzzed (`npm run fuzz`, `npm run fuzz:audio`).

### Formats

Decoding is the browser's `decodeAudioData`. Where it cannot read Ogg Vorbis
or Opus (Safari before 18.4, for one), the bundled decoders take over:
libvorbis and libopus compiled to WebAssembly by
[wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) (MIT; the
libraries BSD-3-Clause), with enig-term's own Ogg page reader.
`enig-term-ogg.js` (about 120 KB gzipped) is fetched only when a browser
fails to decode an Ogg file itself.

| Format (libsndfile pm;ps) | Chromium | Firefox | WebKit |
|---|---|---|---|
| WAV PCM U8, 16, 24, 32 bit, float (1;5 1;2 1;3 1;4 1;6) | yes | yes | yes |
| FLAC 16 and 24 bit (23;2 23;3) | yes | yes | yes |
| Ogg Vorbis (32;96) | yes | yes | yes |
| Ogg Opus (32;100) | yes | yes | yes |
| MP3 (35;130) | yes | yes | yes |
| Ogg Vorbis/Opus with the bundled decoders | yes | yes | yes |

Established by `test/audio.spec.ts` with generated 440 Hz files
(`test/fixtures/audio/`) in Playwright 1.60's Chromium 148, Firefox 150 and
WebKit 26.4 (WebKitGTK on Linux, which decodes through GStreamer; macOS and
iOS Safari decode through Core Audio and were not available to test, hence
the fallback). The format query answers from a decode of a tiny sample in
the browser at hand, so it stays truthful elsewhere. Notes: Firefox and
WebKitGTK keep MP3 encoder padding (a few tens of ms longer), Chromium keeps
Vorbis end padding; WebKitGTK decodes a WAV whose data chunk has an odd
length (8- or 24-bit with an odd sample count) as empty, which enig-term
treats as a failed decode.

## File transfers

XModem, YModem and ZModem, both ways, as ENiGMA offers them
(`fileTransferProtocols` in its `config_default.js`), each checked against the
real program behind it (see [Test](#test)):

| ENiGMA protocol | The board runs (download / upload) | In enig-term |
|---|---|---|
| ZModem 8k (SEXYZ), `zmodem8kSexyz` | `sexyz -telnet -8 sz @list` / `sexyz -telnet -8 rz <dir>` | ZModem: starts by itself |
| ZModem 8k, `zmodem8kSz` | lrzsz `sz --zmodem --try-8k --binary --restricted` / `rz --zmodem --binary --restricted` | ZModem: starts by itself |
| YModem (SEXYZ), `ymodemSexyz` | `sexyz -telnet sY @list` (1K blocks) / `sexyz -telnet ry <dir>` | YModem batch, from the Files panel |
| XModem (SEXYZ), `xmodemSexyz` | `sexyz -telnet sX @list` (1K blocks) / `sexyz -telnet rC <file>` | XModem (checksum, CRC-16, 1K), from the Files panel |

ENiGMA offers no YModem-G, and enig-term has none.

**Downloading.** Pick the files on the board and start its download.

- *ZModem* starts by itself: the board's `sz` announces it (a ZRQINIT header,
  which the terminal takes off the stream before it is drawn), and receiving
  begins. `zmodemDetect: "ask"` shows the card first (Receive or Refuse);
  `"off"` leaves it alone (its bytes then show as text). Files → Download →
  ZModem → "Wait for the board" does the same for one transfer when detection
  is off.
- *YModem and XModem* cannot announce themselves: start the download on the
  board first (its sender waits about 100 s), then Files → Download → the
  protocol → Receive. Started the other way round, the receiver's first `C`
  would reach the board's menu as a keystroke. XModem carries no file name:
  the panel's "Save as" names it (`download.bin`). XModem pads the last block
  with SUB (0x1A) to 128 bytes and the file keeps that padding, as sexyz's and
  lrzsz's receivers do.
- Each file is saved the moment it is complete, under the name the board
  sent (path parts and control characters removed), as a browser download (the
  browser may ask once before several). A Chromium browser can instead save
  into a folder (Files → "Save into a folder…", asked once per page): written
  as it arrives, with no size limit. Otherwise a file is kept as Blobs (4 MB
  parts, which a browser may move to disk) until it is complete, and one
  larger than `transferMaxFile` (512 MB) is refused: ZModem skips just that
  file, X/YModem stop. A file that ends short of the size the board announced
  (YModem's header, ZModem's ZFILE) is reported incomplete and not saved.

**Uploading.**

- *ZModem*: start the upload on the board; its receiver announces itself
  (ZRINIT) and the card asks for files (Choose files…; the system's picker,
  also on iOS and Android; several files). Or prepare it: Files → Upload →
  ZModem → Choose files → "Send when the board is ready".
- *YModem and XModem*: Files → Upload → the protocol → Choose files (one, for
  XModem) → Send, and start the upload on the board within a minute (or the
  board first: its receiver asks every 3 s and gives up after about 30).
  ENiGMA's XModem upload is its "supply filename" upload.
- Files are read a megabyte at a time (one ahead), never whole.

**While a transfer runs** the card over the screen shows the file (n of m),
bytes, rate, time left and a Cancel button. The stream belongs to the
protocol: nothing is drawn, keys and paste are not sent, and a resize's NAWS
and audio replies wait until it ends. Telnet stays underneath: the terminal
escapes IAC (0xFF) going out and decodes it coming in (`sexyz -telnet` does
the same on its side; ENiGMA does it for lrzsz). On a board the transfer
program runs on a pty, so its status text is in the stream with the
protocol (sexyz's banner and progress lines, lrzsz's "rz waiting to
receive."); the engines skip it, and what follows the last of the protocol
goes back to the screen.

**How it ends.**

- Done: the card lists the files (with Save again links) and closes after a
  few seconds; the board's next screen shows as usual.
- Cancel: X/YModem send ten CANs and ten backspaces; ZModem its abort
  sequence. Data the board had already sent is dropped until the line is
  quiet; while protocol data keeps coming (lrzsz's `sz` can notice an abort
  late) the abort goes out again, up to ten times. Then the text that
  followed is shown. Keys wait for that too. Refusing the board's offer
  drains the same way, so a header it repeats does not start another offer.
- The board cancels (CAN): the transfer fails. When the board's program dies
  instead and the board draws its menu again (ANSI sequences where the
  protocol should be), the transfer ends and that screen is shown (protocol
  data still ahead of it in the stream is dropped first). What this side sent
  after the program died (headers, requests, data) reached the board's prompt
  as typing, so the abort goes out with enough backspaces to rub it out (as
  many as were sent, 10 to 256; a prompt's field holds little). Otherwise
  ZModem gives up after 60 s without traffic and X/YModem after their retries
  (ten of 10 s). A closed connection ends a transfer at once.

**Speed.** ZModem streams. X/YModem wait for an acknowledgement after every
block (1 KB), so they run at one block per round trip: fast on a near line,
about 20 KB/s at 50 ms. (Playwright's Chromium on the development host takes
50-200 ms per WebSocket round trip, Firefox and WebKit about 1 ms; real
browsers were not measured.)

**Known limits.**

- sexyz cannot send an empty file with ZModem: it refuses the receiver's
  ZRPOS 0 ("Received INVALID ZRPOS offset: 0"), against lrzsz's `rz` too.
  The transfer fails cleanly; lrzsz's ZModem and sexyz's YModem send empty
  files.
- XModem cannot tell a file cut short at a block boundary from a shorter
  file; YModem and ZModem can (the size is announced).
- No resume of partial downloads (a browser cannot append to a saved file).

**How it is built.** XModem and YModem are TypeScript state machines
(`src/transfer/xymodem.ts`) written from Forsberg's protocol reference and
checked against sexyz and lrzsz. ZModem is icy_net's (icy_board,
Apache-2.0), compiled to `enig-term-zmodem.wasm` (about 70 KB gzipped) behind a
polling wrapper (`crates/enig-term-zmodem`; `src/transfer/zmodem.ts` drives
it, with an inactivity timeout and the board-left check). The patches in
`patches/icy_board/`, each marked in the files it changes:

| Patch | What |
|---|---|
| 0001 | The wasm32 port: no transports, no X/YModem or Kermit; clock, sleep, timeouts, the file reader and the output file come from the wrapper. |
| 0002 | A CAN abort inside file data ends the transfer (it was skipped as noise and the receiver hung). |
| 0003 | A repeated ZRPOS for the same offset within a second is ignored (lrzsz repeats it; icy_net restarted each time and the two sides ping-ponged until `rz` gave up). |
| 0004 | Upload data is awaited from the host a window at a time; the host may refuse (ZSKIP) an offered file. |
| 0005 | The sender skips text before a header (status text on the board's pty) instead of failing after three bytes of it. |
| 0006 | An overlong data subpacket (text spliced into it) is asked for again (ZRPOS) instead of failing the transfer. |
| 0007 | ZFILE also carries the file's modification time and what is left of the batch (without it sexyz dated uploads in the year 2446). |
| 0008 | After a file was taken, a stale ZDATA (a late answer to an earlier ZRPOS) is ignored instead of failing the session. |

The ZModem start detector is `src/transfer/detect.ts`, the stream handover and
saving `src/transfers.ts` and `src/transfer/save.ts`. `npm run fuzz:xfer`
mutates recorded sessions (flipped bytes, CAN and ZDLE runs, status text,
screens, cuts, repeats) into every engine with a jumping clock: each must end,
never throw, never deliver past its limit, and a file it calls complete must
be byte-identical; the unit tests run a fixed-seed pass.

## Behaviour notes

- **Scrollback** is cells, not pixels: lines leaving the top of the screen
  (and, by default, what a clear removes) keep their glyph bytes, attributes
  and font slots. The view is rendered by the engine from a copy of the live
  screen, so it is pixel-identical. Mouse wheel, touch drag and
  Shift+PgUp/PgDn move it; output while scrolled back keeps the view on the
  same lines; any key (or the Live button) returns. Lines take the fonts and
  palette current when viewed.
- **Selection**: drag with the mouse, double-click a word, triple-click a
  line; long-press then drag on touch. Copied as Unicode (CP437 glyphs, or
  Latin-1 for Amiga-font cells), trailing blanks trimmed. A refused
  clipboard falls back to a copy command and otherwise tells the user.
- **OSC 8 links** are underlined by the engine, show a pointer and their URL
  on hover, and on click show a confirmation with the full, normalised URL
  (IDN hosts in punycode) before `window.open(url, "_blank", "noopener,noreferrer")`.
  Only http(s) by default; others are shown but cannot be opened. Links in
  scrollback work. The terminal answers `CSI = 6 n` with `CSI = 6 ; 1 n`.
- **Replies**: DA `CSI = 101;110;105;103;45;116;101;114;109;<maj>;<min>;<patch> c`
  ("enig-term", the package version); CTDA `CSI < 0;1;2;3;5 c` (DCS fonts,
  bright backgrounds, OSC palette, font selection, numbered as in the current
  CTerm manual); CPR; `CSI 5 n`; `CSI 255 n` as a CPR of the screen size;
  `CSI = 1 n` as `CSI = 1 ; 46 ; pR ; pS0 ; pS1 ; pS2 ; pS3 n` (pR 0 the last
  selection worked, 1 refused, 99 none yet); `CSI = 2 n` with the set modes
  among 6, 7, 25, 31, 32, 33, 34, 35 (`CSI = 2 ; n` when none); `CSI = 3 n` as
  `CSI = 3 ; <cell height> ; <cell width> n` (width 9 with SAUCE letter
  spacing); `CSI = 4/5/6 n`; `CSI = 7 n` and the other audio replies
  ([Audio](#audio)).
- **Telnet**: BINARY, SGA and ECHO accepted, TTYPE `ansi-bbs`, NAWS at
  negotiation and on every resize, NEW-ENVIRON and anything else refused.
- **Blink**: with iCE colours off, blinking text blinks at the VGA rate
  (toggles every 16 frames of 70 Hz, about 229 ms; the cursor every 8). With
  `CSI ? 33 h`, SGR 5 is a bright background instead (applied to text written
  after the mode is set).
- **Engine recovery**: a panic in the engine is a WASM trap. The shell reads
  the panic message, instantiates the compiled module again, rebuilds every
  terminal on the page, replays bytes that arrived meanwhile (dropping the
  chunk that trapped), reselects the host's font, and shows a notice. The
  connection stays open; the screen and scrollback are lost. After six traps
  in a minute it stops and asks for a reload.
- **Hardening** (from an audit of icy_engine and fuzzing): horizontal scrolls
  are padded, margins are kept inside the screen, DCS fonts are limited to
  slots 46-255 and drawable sizes, repeat counts are clamped to the screen,
  and SyncTERM inline images (JXL/PPM) are off. Each kind of host request is
  answered at most 8 times a second, so an echoing host cannot loop on our
  replies (a CTDA answer echoed back parses as a new CTDA request).
- **Holding the stream**: like a font fetch, CTerm audio can hold host
  output: `A;Wait` until the channel is idle, foreground "ANSI" music until
  it has played (the core stops right after them; the rest is fed when the
  wait ends, at most 5 minutes).
- **Font notices**: a selection of a font this terminal does not have is
  refused as before, and the first time in a session the UI says so in a
  toast (and `console.warn`): for Amiga fonts that the site has not installed
  them (with a pointer to [Amiga fonts](#amiga-fonts)), for other slots which
  font it was. Once per font (once for all Amiga fonts) per connection.
- **Known limit**: CTerm macros (`DCS ... !z`, invoked by `CSI Pn * z`) can be
  chained so that expanding them takes exponential time inside the parser.
  That hangs the tab rather than crashing the engine, and there is no hook to
  stop it from outside the parser (an upstream ask).
- **Throughput**: scrolling moves whole lines instead of copying cells, so
  scroll-heavy text feeds at about 10 MB/s in Node (icy_engine's own path:
  about 1 MB/s).

## Licences

enig-term is BSD-2-Clause (`LICENSE`). The WASM links icy_tools (MIT OR
Apache-2.0, used under MIT), built without its embedded fonts;
`src/crt.ts` ports its CRT shader functions. See `NOTICE`.

The PC fonts in `fonts/` are derived from VileR's Ultimate Oldschool PC Font
Pack and are **CC BY-SA 4.0** (`fonts/LICENSE`, `fonts/README.txt`). They are
separate data files under their own licence, so share-alike applies to them
only. Amiga fonts are not distributed; see [Amiga fonts](#amiga-fonts). The
Amiga palettes are numbers taken from NComm and Term (cited in
`src/palettes.ts`), no code. `enig-term-ogg.js` contains wasm-audio-decoders
(MIT) with libvorbis, libogg and libopus (BSD-3-Clause) and puff (zlib);
see `NOTICE`. `enig-term-zmodem.wasm` is icy_net's ZModem (icy_board, by Mike
Krueger and contributors, **Apache-2.0**, `LICENSE-APACHE-2.0`) with the
changes listed under [File transfers](#file-transfers); the patched files say
so. The audio test fixtures are generated tones. `credits.html` in `dist/` lists all of this for
users.

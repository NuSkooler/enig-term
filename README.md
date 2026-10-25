# enig-term

A browser terminal for ANSI-BBS boards. The emulation is
[icy_engine](https://github.com/mkrueger/icy_tools) compiled to WebAssembly;
around it sits a framework-free TypeScript shell (Telnet over WebSocket,
input, scrollback, selection, links, UI) and a WebGL2 output pass with sharp
scaling, 4:3 aspect correction and an optional CRT effect (2D-canvas
fallback).

Status: **Phase 1 (MVP)**, version 0.1.0, not released. See `CHANGELOG.md`,
and `SPIKE.md` for the Phase 0 measurements behind the design.

- [Build](#build) · [Test](#test) · [dist/ layout](#dist-layout) ·
  [Standalone page](#standalone-page) · [config.json v1](#configjson-v1) ·
  [Embedding](#embedding) · [Settings](#settings) · [Keyboard](#keyboard) ·
  [Behaviour notes](#behaviour-notes) · [Licences](#licences)

## Build

Toolchain:

- Node 22 (`mise.toml`; with mise, run commands through `mise exec --`).
- Rust stable with the `wasm32-unknown-unknown` target.
- `wasm-bindgen-cli` **0.2.129** (it must match the crate's pinned version).
- Optionally binaryen's `wasm-opt`.

```sh
npm install
npm run build        # build:wasm (cargo, wasm-bindgen, wasm-opt -Oz) then build:js (esbuild -> dist/)
npm run serve        # http://127.0.0.1:8090/ serves dist/ (see "Development server")
```

Build variables: `WASM_BINDGEN=` and `WASM_OPT=` (tool paths),
`CARGO_TOOLCHAIN=` (default `stable`), `CARGO_TARGET_DIR=` (honoured),
`CORE_FEATURES=viewer` (adds the whole-file viewer path; roughly doubles the
WASM), `ENIG_TERM_SOURCEMAP=1` (writes `enig-term.js.map`; off by default so
it is not part of `dist/`).

icy_tools is pinned at `1456074e` in `crates/enig-term-core/Cargo.toml`, and
`crates/enig-term-core/Cargo.lock` is the real pin (several of icy_tools' own
git dependencies have no revision). After a deliberate rebase, regenerate the
screen wrapper with `python3 scripts/gen-delegate.py <icy_tools checkout>`
and the golden frames with `npm run goldens` (after checking the screenshots).

## Test

```sh
npm test             # typecheck, Node unit tests, Playwright (needs a built dist/)
npm run test:unit    # core (WASM) and shell tests in Node
npm run test:browser # Playwright: chromium, webkit, firefox, Pixel 7, iPhone 14
npm run fuzz -- 60   # feed fuzzer for N seconds (optional seed as 2nd argument)
ENIG_TERM_LIVE_WS=ws://127.0.0.1:18810 npm run test:live            # a throwaway ENiGMA
ENIG_TERM_LIVE_PAGE=http://127.0.0.1:18080/_enig/ws-term/ npm run test:live   # through ENiGMA's route
```

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
custom element on a hostile foreign page. Screenshots go to
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
| `LICENSE`, `NOTICE` | BSD-2-Clause, and the third-party notices (icy_tools). |
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
| `scale=fit\|integer`, `keys=auto\|on\|off`, `profile=pc\|amiga` | `scale`, `keyBar`, `profile` |
| `cols=`, `rows=`, `scrollback=`, `renderer=webgl2\|2d`, `autoReconnect=0/1` | the same |

Test hooks, never on by default: `naws=0` (refuse NAWS, so a host falls back
to `CSI 255 n`), `debugDa=cterm` (answer DA as CTerm, for ENiGMA builds that
only probe CTerm), `debugPanic=1` (let `CSI ? 2026 h` panic the engine, to
exercise recovery).

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
| `profile` | `"pc"` or `"amiga"` | `"pc"` | Reserved for the Phase 2 Amiga profile; Phase 1 renders `pc`. Typed text already follows the active font (Latin-1 under Amiga fonts). |
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
`backspace`, and `fill` (fit the element's height too; give it a height).
Booleans: present, `on`, `true` or `1` is on; `off`, `false` or `0` is off.
`endpoint`, `title`, `crt`, `aspect`, `scale`, `keybar`, `toolbar`,
`auto-reconnect`, `backspace`, `blink` and `scrollback` also apply when
changed later. The element has `ready` (a promise of the handle), `handle`,
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
`state`, `version`, `destroy()`, and `terminal` (internals; not stable).

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

Isolation: everything lives in an open shadow root. The page's CSS does not
reach in (inherited properties are reset at the root), and nothing is added
to the page's `<head>`. The WASM is resolved from the script's own URL, so
the bundle can be served from any path. Several terminals can share a page
(they share one WASM instance; see engine recovery below).

## Settings

The Settings panel holds the user-settable keys, saved per origin in
`localStorage` (`enig-term:settings:v1`; every access is guarded, and the
terminal works without storage): `crt`, `aspect`, `scale`, `keyBar`,
`autoReconnect`, `backspace` (and `sharp` through the API). Keys in the
config's `lock` are shown disabled. The toolbar also has the host input,
Connect/Disconnect/Reconnect, Copy, Paste and Full screen (an iPhone, which
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

Shortcuts the terminal keeps: **Shift+PgUp / Shift+PgDn** (scrollback),
**Ctrl+Shift+C** or **Ctrl+Insert** (copy), **Ctrl+C with a selection**
(copy; without one it is ^C for the host), **Ctrl+V**, **Ctrl+Shift+V**,
**Shift+Insert** (paste). ^V itself can be sent from the key bar (Ctrl, then
V). Cmd/Win combinations are left to the browser.

On touch devices the key bar has Esc, Tab, sticky Ctrl and Alt, arrows,
Home/End/PgUp/PgDn/Ins/Del and an Fn row (F1-F12). It sits on the bottom edge
of the visual viewport, so it stays above the soft keyboard (iOS does not
shrink the layout viewport). Tap the screen to raise the keyboard.

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
  `CSI = 1/2/3/4/5/6 n`. No answer to reports this build lacks (`CSI = 7 n`, audio).
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
  slots 43-255 and drawable sizes, repeat counts are clamped to the screen,
  and SyncTERM inline images (JXL/PPM) are off. Each kind of host request is
  answered at most 8 times a second, so an echoing host cannot loop on our
  replies (a CTDA answer echoed back parses as a new CTDA request).
- **Known limit**: CTerm macros (`DCS ... !z`, invoked by `CSI Pn * z`) can be
  chained so that expanding them takes exponential time inside the parser.
  That hangs the tab rather than crashing the engine, and there is no hook to
  stop it from outside the parser (an upstream ask).
- **Throughput**: scrolling moves whole lines instead of copying cells, so
  scroll-heavy text feeds at about 10 MB/s in Node (icy_engine's own path:
  about 1 MB/s).

## Licences

enig-term is BSD-2-Clause (`LICENSE`). The WASM links icy_tools (MIT OR
Apache-2.0, used under MIT); `src/crt.ts` ports its CRT shader functions.
See `NOTICE`. The fonts embedded in the engine are icy_engine's (provenance
to be settled before release; Phase 2 replaces them with int10h and
operator-installed Amiga fonts).

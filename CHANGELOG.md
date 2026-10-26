# Changelog

## Unreleased: Phase 2, fonts and Amiga

- **No fonts in the WASM.** icy_engine is built from the pinned revision with
  `patches/icy_tools/0001-no-embedded-fonts.patch` (prepared by
  `scripts/prepare-icy.sh`): WASM 7,867,283 -> 4,815,657 B, gzip -9
  1,929,390 -> 1,603,574 B. A slot without a loaded font is refused, never
  drawn blank.
- **PC fonts** from VileR's Ultimate Oldschool PC Font Pack (CC BY-SA 4.0):
  IBM VGA 8x16/8x14/8x8 in 16 code pages as PSF2 files under `fonts/` with a
  manifest (`scripts/build-fonts.mjs` regenerates them from the pack, checksum
  checked). Fetched lazily and cacheable; a CP437 session loads the manifest
  and one 4 KB font. A host font selection holds the stream until its font
  has arrived.
- **SyncTERM slots 0-42**: 29 slots built (style variants share the IBM VGA
  design), Armenian, CP1131, Commodore and Atari refused, 37-42 from
  operator-installed Amiga fonts. Cell height follows the screen mode (8, 14
  or 16) as in SyncTERM, with fonts reloaded on a mode change.
- **CTerm font attributes**: Ps1 0-3 (normal, bold, blink, both) with
  `CSI ? 31 h`, `? 32 h`, `? 34 h` and CTerm's `? 35 h` (blink disabled), which
  icy_engine does not handle; `CSI = 1 n` with the real result and slots,
  `CSI = 2 n` with modes 31-35, `CSI = 3 n` with the cell size.
- **DCS fonts** kept per height (selectable in a mode of that height);
  reloading a slot in use updates it.
- **Ami/X profile**: `profile` is now `auto` (default), `pc` or `amiga`; auto
  follows the host's normal font. Amiga palette (NComm by default, Term 4.8
  selectable; OSC 4/104 still work and reset to it), PAL or NTSC pixel aspect,
  optional rows (`amigaRows`), block cursor, iCE off, all configurable. New
  `profile` event; Look, Amiga colours and Amiga aspect in Settings.
- **Amiga fonts for operators**: `tools/fetch-amiga-fonts.mjs` downloads
  TrueSchool's Amiga fonts from GitHub (pinned commit, SHA-256 per file,
  nothing written on a mismatch) and installs them as `fonts/amiga/`.
- **config.json v1** (compatible): `fonts`, `amigaFonts`, `amigaPalette`,
  `amigaAspect`, `amigaRows`, `amigaFont`, `amigaIce`, `amigaBlink`,
  `amigaCursor`; `profile` gains `auto`.
- **dist/** now also holds `fonts/`, `tools/fetch-amiga-fonts.mjs` and
  `credits.html` (linked from Settings).
- Fixed on the way: icy_engine replaced the font of a SAUCE file ("IBM VGA")
  with a blank one once its fonts were stripped; SAUCE files keep slot 0.

## 0.1.0 (unreleased): Phase 1 MVP

First usable terminal, built on the Phase 0 spike (see `SPIKE.md`).

- **Connection**: Telnet over WebSocket (BINARY, SGA, ECHO, TTYPE `ansi-bbs`,
  NAWS on every resize, NEW-ENVIRON refused); connection states in the UI;
  manual reconnect and optional auto-reconnect with backoff; `wss://` only,
  `ws://` for loopback; a host input seeded from config and lockable.
- **Replies**: enig-term DA with the package version, CTDA `1;2;3;5`, CPR,
  `CSI 5 n`, `CSI 255 n`, `CSI = 1..6 n` (OSC 8 reported as supported).
- **Scrollback**: cell-based (2000 lines by default), rendered through the
  engine; wheel, touch drag, Shift+PgUp/PgDn; stays put while output
  scrolls; any key returns to live.
- **Input**: ANSI-BBS keymap (F1-F12, Alt as ESC prefix, ^H/DEL), hidden
  textarea with IME and soft-keyboard handling (keyCode 229, predictive
  replacements), paste; CP437, or Latin-1 under Amiga fonts.
- **Key bar** for touch devices (sticky Ctrl/Alt, arrows, paging keys, Fn row)
  that stays above the soft keyboard; phone-width layout.
- **Selection and copy** as Unicode; **OSC 8 links** with a confirmation that
  shows the full URL, http(s) only by default.
- **Display**: VGA-rate text and cursor blink, iCE bright backgrounds,
  fullscreen, CRT (off by default), 4:3 aspect (on by default), fit or
  integer scaling; settings saved in localStorage.
- **Embedding**: `<enig-term>` and `EnigTerm.mount()` with events, in a shadow
  root; assets resolved from the script URL; documented option precedence.
- **dist/ contract** and **config.json v1** (README).
- **Robustness**: engine panics are recovered without dropping the
  connection; several host-reachable panics in icy_engine are guarded; a feed
  fuzzer runs in the unit tests.
- **Tests**: Node unit tests, Playwright on Chromium, WebKit (runs without
  root via `npm run setup:webkit`, or is skipped with a warning) and Firefox,
  plus Pixel 7 and iPhone 14 emulation; a live test against ENiGMA.

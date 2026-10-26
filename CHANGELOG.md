# Changelog

## Unreleased: font slots 43-45

- **DCS-loaded fonts start at slot 46** (`pF = 46` in `CSI = 1 n`). The
  current CTerm manual adds built-in fonts 43 (Prestel), 44 (Atari ST) and
  45 (RIPterm) and puts loadable fonts above them. enig-term has no licensed
  font for 43-45: selecting one is refused like the other unlicensed
  built-ins (`pR = 1`, a one-time notice naming the font), and a
  `DCS CTerm:Font` into 43-45 is refused like one into 0-42. The font
  manifest lists them as refused; `credits.html` shows the slots in order,
  with 46-255 as the board's.

## Unreleased: Phase 3, audio

- **CTerm audio APC**, complete per the current manual's "Audio APCs"
  (CTerm 1.332): 256 patch slots, 16 channels (0 "ANSI" music, 1 reserved),
  `Load`/`LoadBlob`/`Synth` (all eight shapes)/`Copy`/`Queue`/`Flush`/`Volume`/
  `Wait`/`Update`, with fades (`I=`, `O=`), loops, crossfade (`X`, equal
  power, both audible during the overlap), per-buffer and per-channel levels
  and pan (`V=`, `VL=`, `VR=`, dB or 0-100), dB-linear volume ramps (`T=`),
  durations in ms, frames or periods. A Queue behind a loop ends it at the
  pass boundary, as the manual says (SyncTERM's and IcyTerm's mixers do not).
  Replies: `Q;libsndfile`, `Q;libsndfileFormat` (from what this browser
  decodes), `CSI = 7 n` and `CSI = 7 ; ch n`, asynchronous idle reports,
  `C;L` listings with MD5, `Q;JXL` (no).
- **File cache** per board in IndexedDB (memory without it): uploads survive
  reconnects and reloads, LRU-bounded, glob(3) listings, Clear sound cache
  in Settings.
- **"ANSI" music** (`CSI |`, `CSI N`, `CSI M` per `CSI = Ps M`, default mode
  1) parsed in the core per the manual (icy_engine's own parser is off) and
  synthesised in WebAudio: PC-speaker square by default, SyncTERM's timbre or
  a sine (`musicTone`); foreground music holds the stream until it has
  played, background does not.
- **The stream can wait for audio**: the core stops right after music and
  `A;Wait` (`Core::fed`), and the shell holds the rest (as it does for fonts).
- **Autoplay**: audio starts on Connect, any key or tap, the Sound button or a
  prompt; until then CTerm audio keeps its state on the wall clock and starts
  in place when allowed; "ANSI" music meanwhile is skipped. Toolbar Sound
  button and volume, Settings mute/volume/music voice; `mute`, `volume`,
  `musicTone` persisted. New `sound` event; `soundState`, `enableSound()`,
  `clearSoundCache()` on the handle.
- **Limits** for untrusted input (file size, APC size, cache, decoded memory,
  buffer length, decode time, buffers per channel, music length, hold time);
  the APC paths are fuzzed (`npm run fuzz:audio`).
- **Ogg decoders** for browsers without Ogg Vorbis/Opus in `decodeAudioData`
  (wasm-audio-decoders, MIT; libvorbis/libopus, BSD-3-Clause), loaded only
  when needed.
- **dist/** adds `enig-term-audio.js` (loaded on first use, ~13 KB gzipped)
  and `enig-term-ogg.js` (only where needed, ~120 KB gzipped).
- **config.json v1** (compatible): `sound`, `mute`, `volume`, `musicTone`,
  `audioCache`, `audioMaxFile`, `audioMemory`.
- **Font notices** (Phase 2 follow-up): a board selecting an Amiga font this
  site does not have gets a one-time, non-modal notice (and a console
  warning) instead of nothing; other refused fonts get their own, once each.
- Tests: ansi-bbs-utils 0.2.1's own host side drives the terminal over a real
  WebSocket in every browser (probe, upload once across reconnects, music,
  effects, idle, stop, heard at the expected levels), and in Node against the
  same calls on its `Testing.FakeCTerm`; OfflineAudioContext measurements of
  levels, pitch, fades, crossfades, ramps, loop ends and music timing; every
  claimed format decoded in Chromium, Firefox and WebKit.

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

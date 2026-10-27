# Changelog

## Unreleased

- A decode Worker that fails to load is tried again on a later decode.
  One failure (a failed fetch while offline, say) used to move the bundled
  Ogg decoders to the page's thread, without the 15 s stop, until the page
  closed; now that takes 3 failures in a row.
- The audio cache keeps at most 4096 files per board, dropping the least
  recently used, and a `C;S` store no longer reads and sorts every stored
  file: the cache keeps its index in memory, read from IndexedDB once. A
  board storing 16000 tiny files with distinct names took about 10 s of the
  page's thread (7.9 s for the last 8000); it now takes about 0.2 s. Tabs
  sharing the cache tell each other when they store, and the index is read
  again before the next store.
- The bundled Ogg decoders refuse a file of more than 8 channels, and stop
  decoding once the PCM (samples x channels x 4 bytes) would pass
  `audioMemory`. A half-megabyte Opus file claiming 255 channels froze the
  tab for seconds and took gigabytes of memory. An Opus file with more than
  8 streams is refused too: every stream is decoded whether or not a channel
  uses it, so 255 streams made each second of audio 255 times as costly.
- The Ogg page reader skips empty packets and refuses a file of more than
  262144 pages or packets. 16 MB of empty pages made 15 million packets
  (36 s, about 3 GB), and a Vorbis file of many small packets overflowed
  the stack.
- The bundled Ogg decoders run in a module Worker, terminated when a decode
  passes the 15 s limit, so a slow or hostile file no longer blocks the page.
  Under a Content Security Policy the Worker needs `worker-src 'self'` (the
  default when `script-src` allows the page's origin). Where no Worker can
  start, they run on the page's thread as before.
- Nested CTerm macros expand at most 4 MB of macro text per top-level
  invocation (icy_tools patch 0002, upstream PR mkrueger/icy_tools#197).
  About 100 bytes of macros that invoke each other hung the tab for good.
- A screen keeps at most 64 MB of decoded sixel images: a new image evicts
  the oldest, and one larger than that alone is dropped. About 140 KB of
  sixel grew the engine's memory to about 3.8 GB and trapped it. A screen
  also keeps at most 4096 images, however small: icy_engine scans the whole
  list for every new image, so 40000 one-pixel images (1.6 MB of sixel)
  took about 5 s, and the time grew with the square of their number.
- A cache listing (`SyncTERM:C;L;pattern`) whose pattern escaped a `*` or `?`
  with a backslash failed with a regular expression error and got no answer;
  the character now matches itself.

## 0.1.1 - 2026-10-27

- A ZModem upload of two small files, each with a damaged start, no longer
  stalls until the board's receiver times out: the ZRPOS 0 for the second
  file was ignored as a repeat of the one for the first.

## 0.1.0 - 2026-10-27

First release. The archive's `enig-term-0.1.0/` folder holds the built
terminal: copy its contents into ENiGMA½'s `ws-term/` directory or a web
root (see the README). Amiga fonts are not included;
`node tools/fetch-amiga-fonts.mjs` installs them.

### Terminal

- Connection: Telnet over WebSocket (BINARY, SGA, ECHO, TTYPE `ansi-bbs`,
  NAWS on every resize; NEW-ENVIRON refused). Connection states in the UI,
  manual reconnect and optional auto-reconnect with backoff. `wss://` only,
  plus `ws://` for loopback.
- Replies: enig-term DA with the version, CTDA `1;2;3;5`, CPR,
  `CSI 5 n`, `CSI 255 n`, `CSI = 1..6 n`.
- Scrollback (2000 lines by default): wheel, touch drag,
  Shift+PgUp/PgDn; any key returns to live.
- Input: ANSI-BBS keymap (F1-F12, Alt as ESC prefix, ^H/DEL), IME and
  soft-keyboard handling, paste; CP437, or Latin-1 under Amiga fonts.
- Phones: a key bar (sticky Ctrl/Alt, arrows, paging keys, Fn row) that
  stays above the soft keyboard, and a phone-width layout.
- Selection and copy as Unicode. OSC 8 links, http(s) only by
  default, opened after a confirmation that shows the full URL.
- Display: WebGL2 with a 2D canvas fallback, VGA-rate blink, iCE colours,
  fullscreen, 4:3 aspect (on by default), fit or integer scaling, an optional
  CRT effect. Settings are saved in localStorage.
- Embedding: the `<enig-term>` element and `EnigTerm.mount()`, in a
  shadow root, with events. Assets are found relative to `enig-term.js`.
- Robustness: an engine panic is recovered without dropping the
  connection; several host-reachable panics in icy_engine are guarded.

### Fonts

- No fonts in the WASM: icy_engine is built with
  `patches/icy_tools/0001-no-embedded-fonts.patch`, which takes the WASM from
  7.9 MB to 4.8 MB. A slot without a font is refused, never drawn blank.
- PC fonts: IBM VGA 8x16, 8x14 and 8x8 in 16 code pages, from VileR's
  Ultimate Oldschool PC Font Pack (CC BY-SA 4.0), fetched as needed. A CP437
  session loads the manifest and one 4 KB font.
- SyncTERM slots 0-42: 29 built, Armenian, CP1131, Commodore and Atari
  refused, 37-42 from the operator's Amiga fonts. Slots 43-45 (Prestel,
  Atari ST, RIPterm) are refused; fonts loaded with `DCS CTerm:Font` start
  at 46. A refused font gets a one-time notice.
- CTerm font attributes (normal, bold, blink, both; `CSI ? 31/32/34/35 h`)
  and the `CSI = 1/2/3 n` reports. Cell height follows the screen mode.
- SAUCE font names select the matching PC or Amiga font; anything else
  stays on slot 0.
- Amiga profile: `profile` is `auto`, `pc` or `amiga`. NComm or Term 4.8
  palette, PAL or NTSC aspect, optional rows, block cursor, iCE off.
- Amiga fonts are not shipped. `tools/fetch-amiga-fonts.mjs` downloads
  TrueSchool's fonts (pinned commit, SHA-256 per file) into `fonts/amiga/`.

### Audio

- CTerm audio APC, per the CTerm 1.332 manual: 256 patch slots, 16
  channels, `Load`/`LoadBlob`/`Synth`/`Copy`/`Queue`/`Flush`/`Volume`/`Wait`/
  `Update`, fades, loops, crossfade, levels and pan, volume ramps, and the
  query replies. Uploaded files are cached per board in IndexedDB.
- "ANSI" music (`CSI |`, `CSI N`, `CSI M`): PC-speaker square by default,
  SyncTERM's timbre or a sine.
- Autoplay: audio starts on Connect, a key or tap, or the Sound button.
  Mute and volume in the toolbar and Settings.
- Limits on file size, cache, decoded memory and music length for
  untrusted input; the APC paths are fuzzed.
- Ogg Vorbis and Opus decoders (wasm-audio-decoders) load only in
  browsers that cannot decode Ogg themselves.

### File transfers

- XModem, YModem and ZModem, both ways, tested against sexyz and lrzsz
  in Chromium, Firefox and WebKit, through ENiGMA½ and a fake BBS.
- ZModem starts by itself when the board sends its header: at once, after
  a yes, or never (`zmodemDetect`). X/YModem start from the Files panel.
- Saving as browser downloads (up to `transferMaxFile`, 512 MB by
  default) or, in Chromium, streamed into a folder the user picks. Uploads
  take several files for the batch protocols.
- ZModem is icy_net's (from icy_board, Apache-2.0), patched and built as
  a second WASM that loads only for a transfer. X/YModem are enig-term's own.

### dist/

`index.html`, `enig-term.js`, `enig_term_core_bg.wasm`, the lazily loaded
`enig-term-audio.js`, `enig-term-ogg.js`, `enig-term-xfer.js` and
`enig-term-zmodem.wasm`, `fonts/`, `tools/fetch-amiga-fonts.mjs`,
`credits.html`, `config.example.json`, `LICENSE`, `LICENSE-APACHE-2.0` and
`NOTICE`. The layout is described in docs/building.md; `config.json` v1 in
docs/configuration.md.

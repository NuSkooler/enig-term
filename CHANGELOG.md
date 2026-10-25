# Changelog

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

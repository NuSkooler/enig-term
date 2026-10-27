# Behaviour

## Scrollback

Scrollback is cells, not pixels. Lines leaving the top of the screen keep
their glyph bytes, attributes and font slots, and by default so does what a
clear removes (`scrollbackOnClear`). The engine renders the view from a copy
of the live screen, so it is pixel-identical. The mouse wheel, a touch drag
and Shift+PgUp/PgDn move it. Output while scrolled back keeps the view on the
same lines, and any key (or the Live button) returns. Lines take the fonts
and palette current when viewed.

## Selection

Drag with the mouse, double-click a word, or triple-click a line. On touch,
long-press then drag. The selection is copied as Unicode (CP437 glyphs, or
Latin-1 for Amiga-font cells) with trailing blanks trimmed. If the clipboard
is refused, it falls back to a copy command, and failing that tells the user.

## Links

OSC 8 links are underlined by the engine and show a pointer and their URL on
hover. A click shows a confirmation with the full, normalised URL (IDN hosts
in punycode) before `window.open(url, "_blank", "noopener,noreferrer")`. Only
http(s) is allowed by default (`linkSchemes`); other links are shown but
cannot be opened. Links in scrollback work. The terminal answers `CSI = 6 n`
with `CSI = 6 ; 1 n`.

## Replies

| Request | Reply |
|---|---|
| DA | `CSI = 101;110;105;103;45;116;101;114;109;<maj>;<min>;<patch> c` ("enig-term", the package version) |
| CTDA | `CSI < 0;1;2;3;5 c`: DCS fonts, bright backgrounds, OSC palette, font selection, numbered as in the current CTerm manual |
| CPR, `CSI 5 n` | answered |
| `CSI 255 n` | a CPR of the screen size |
| `CSI = 1 n` | `CSI = 1 ; 46 ; pR ; pS0 ; pS1 ; pS2 ; pS3 n` (pR 0: the last selection worked, 1: refused, 99: none yet) |
| `CSI = 2 n` | the set modes among 6, 7, 25, 31, 32, 33, 34, 35 (`CSI = 2 ; n` when none) |
| `CSI = 3 n` | `CSI = 3 ; <cell height> ; <cell width> n` (width 9 with SAUCE letter spacing) |
| `CSI = 4 n`, `CSI = 5 n`, `CSI = 6 n` | answered |
| `CSI = 7 n` and the other audio queries | see [Audio](audio.md#replies) |

## Telnet

BINARY, SGA and ECHO are accepted. TTYPE answers `ansi-bbs` (`termType`).
NAWS is sent at negotiation and on every resize. NEW-ENVIRON and anything
else is refused.

## Blink

With iCE colours off, blinking text blinks at the VGA rate: it toggles every
16 frames of 70 Hz, about 229 ms, and the cursor every 8. With `CSI ? 33 h`,
SGR 5 is a bright background instead, applied to text written after the mode
is set.

## Engine recovery

A panic in the engine is a WASM trap. The shell reads the panic message,
instantiates the compiled module again, rebuilds every terminal on the page,
replays the bytes that arrived meanwhile (dropping the chunk that trapped),
reselects the host's font, and shows a notice. The connection stays open, but
the screen and scrollback are lost. After six traps in a minute it stops and
asks for a reload.

## Hardening

From an audit of icy_engine and fuzzing: horizontal scrolls are padded,
margins are kept inside the screen, DCS fonts are limited to slots 46-255 and
drawable sizes, repeat counts are clamped to the screen, and SyncTERM inline
images (JXL/PPM) are off.

Each kind of host request is answered at most 8 times a second, so an echoing
host cannot loop on our replies. A CTDA answer echoed back parses as a new
CTDA request.

## Holding the stream

Like a font fetch (see [Fonts](fonts.md)), CTerm audio can hold host output:
`A;Wait` until the channel is idle, and foreground "ANSI" music until it has
played. The core stops right after them, and the rest is fed when the wait
ends, after at most 5 minutes.

## Font notices

A selection of a font the terminal does not have gets a one-time toast; see
[Font notices](fonts.md#font-notices).

## Known limit: CTerm macros

CTerm macros (`DCS ... !z`, invoked by `CSI Pn * z`) can be chained so that
expanding them takes exponential time inside the parser. That hangs the tab
rather than crashing the engine, and there is no hook to stop it from outside
the parser. It is an upstream ask.

## Throughput

Scrolling moves whole lines instead of copying cells, so scroll-heavy text
feeds at about 10 MB/s in Node. icy_engine's own path does about 1 MB/s.

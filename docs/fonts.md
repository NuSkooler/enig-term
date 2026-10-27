# Fonts

No font is compiled into the WASM. The PC fonts are 256-glyph PSF2 files in
`fonts/pc/`, one per code page and cell height. `scripts/build-fonts.mjs`
builds them from VileR's Ultimate Oldschool PC Font Pack v2.2 (int10h.org,
CC BY-SA 4.0; the SHA-256 of the pack is checked). The design is IBM VGA,
sampled from the pack's Px437 and PxPlus pixel-outline TrueType fonts.
16-pixel cells use IBM VGA 8x16, 14-pixel cells IBM VGA 8x14, and 8-pixel
cells the first 8 columns of IBM VGA 9x8. The CP437 files match the pack's
own Windows bitmap (FON) fonts bit for bit. Other code pages are arranged from
the same designs with Python's codec tables (`scripts/fonts/codepages.json`).
C0 positions show the CP437 graphics, as DOS code page fonts do.

The shell fetches the manifest and the slot 0 font (CP437) at start, along
with the WASM. A CP437 session loads `fonts/manifest.json` (22,218 B, 4,156 B
gzipped) and `cp437-8x16.psf` (4,128 B, 1,400 B gzipped). Any other font is
fetched when the host selects it. The stream is held at the final byte of
`CSI Ps1 ; Ps2 SP D` until the font is in (at most 5 s), so the selection
succeeds and the text after it uses the font.

## SyncTERM font slots

`CSI Ps1 ; Ps2 SP D`, numbered as in the CTerm manual:

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
| 7, 15 | haik8, ARMSCII-8 | refused: no Armenian glyphs in the licensed set |
| 31 | CP1131 Belarusian | refused: no code page table to build it from |
| 32-35 | Commodore 64/128 | refused: no licensed font |
| 36 | Atari | refused: no licensed font |
| 37-42 | P0T NOoDLE, mO'sOul, MicroKnight Plus, Topaz Plus, MicroKnight, Topaz | operator-installed Amiga fonts, else refused |
| 43, 44, 45 | Prestel, Atari ST, RIPterm | refused: no licensed font (CTerm built-ins; a DCS load into them is refused too) |
| 46-255 | `DCS CTerm:Font` | loaded by the host |

Style variants (thin, swiss, (b), (c), wide) are drawn in the one IBM VGA
design; `credits.html` lists them. A refused selection changes nothing on
screen and reports `pR = 1` in `CSI = 1 n`. A selection never draws blank.

Cell size follows the screen mode, as in SyncTERM. 25 rows (and most other
heights) use 16-pixel cells, 28 and 43 rows use 14, and 50 rows use 8. Each
slot loads the font of that height. A resize that changes the cell height
reloads the fonts on screen at the new height; the core reports which ones it
needs. A font of another height (from a DCS) is refused while the mode's
height differs. icy_engine draws every cell at slot 0's size, so cells cannot
follow their own font's size. That is an upstream limit.

Ps1 puts the font into attribute slot 0 (normal), 1 (bold), 2 (blink) or 3
(bold and blink). Bold text uses slot 1 under `CSI ? 31 h`, blinking text slot
2 under `CSI ? 34 h`, and text that is both uses slot 3. `CSI ? 32 h` stops
bold from brightening and `CSI ? 35 h` stops blinking text from blinking
(CTerm's meaning of 35, not icy_engine's cursor blink). Fonts are per cell,
so like everything in icy_engine these apply to text written afterwards. Ps1
above 3 is refused.

`DCS CTerm:Font:<slot>:<base64>` loads slots 46-255 (`pF = 46` in
`CSI = 1 n`). The current CTerm manual puts loadable fonts above its
built-ins, which now end at 45. Any drawable size is accepted (8 wide, 1-32
high), and the font is kept at its own height. Reloading a slot in use
updates its cells at once.

## SAUCE

`terminal.showSauceArt(bytes)` applies letter spacing (9-dot) and iCE, and the
font name (TInfoS) selects one of our fonts. The font is fetched first and
used at the mode's cell height. The height the name implies (e.g. 8 for "IBM
VGA50") is reported as `sauceFont.height` but not applied. Case, spacing,
`_`/`-`, "plus" for "+" and 0 for O ("P0T-NOoDLE") do not matter.

| SAUCE name | Font |
|---|---|
| IBM VGA, VGA50, VGA25G, EGA, EGA43 (no code page, or 437) | 0, CP437 |
| IBM ... 850, ... 858 | 18, CP850 (858's euro at 0xD5 shows CP850's dotless i) |
| IBM ... 865 | 28, CP865 |
| IBM ... 866 | 25, CP866 |
| IBM ... 819 | 24, ISO-8859-1 |
| Amiga Topaz 1, Amiga Topaz 2 | 42, Topaz (the Kickstart version the operator installed) |
| Amiga Topaz 1+, Amiga Topaz 2+ | 40, Topaz Plus |
| Amiga P0T-NOoDLE, Amiga MicroKnight, Amiga MicroKnight+, Amiga mOsOul | 37, 41, 39, 38 |
| IBM ... 720, 737, 775, 852, 855, 857, 860-864, 869, 872, KAM, MAZ, MIK; C64 PETSCII; Atari ATASCII; anything else | none: slot 0 |

A name we have no font for, an Amiga font that is not installed, or a fetch
that fails or takes over 5 s leaves slot 0 (CP437), without a notice. An
Amiga font switches the auto profile to the Amiga look, as a host's selection
does. The result's `sauceFont` is `{ name, slot, height }` (`slot` is null
when the default was used), or null without a font name. The 9th column is the
engine's: blank, or a copy of column 8 for 0xC0-0xDF. The VGA's 9-dot
alternate glyphs are not reproduced.

## Font notices

A selection of a font this terminal does not have is refused as described
above. The first time in a session, the UI also says so in a toast (and
`console.warn`). For Amiga fonts it says the site has not installed them and
points to [Amiga fonts](#amiga-fonts); for other slots it names the font.
This happens once per font (once for all Amiga fonts) per connection.

## Amiga fonts

enig-term does not ship Amiga fonts. The operator installs them, in the
directory that holds `enig-term.js`:

```sh
node tools/fetch-amiga-fonts.mjs                # writes fonts/amiga/
node tools/fetch-amiga-fonts.mjs --kickstart 1  # Topaz and Topaz Plus from Kickstart 1.x
node tools/fetch-amiga-fonts.mjs --out DIR      # elsewhere (then set config.json "amigaFonts")
```

The script downloads TrueSchool's Multi Platform Amiga Fonts v1.02
(dMG/t!s^dS!) from <https://github.com/rewtnull/amigafonts>, pinned to commit
`d4298753`. It checks every file against a SHA-256 in the script, and on any
mismatch it writes nothing and exits 1. It converts the 8x16 raw fonts
(line-doubled 8x8 "Amiga aspect" bitmaps, ISO-8859-1 order) to PSF2 at 16
rows, plus an 8-row variant from the even rows, and writes them with a
`manifest.json` and the source's README (`README-amigafonts.txt`).

Slots: 37 P0T-NOoDLE, 38 mO'sOul, 39 MicroKnight Plus, 40 Topaz Plus, 41
MicroKnight, 42 Topaz. The Kickstart 2.x+ versions are the default.

The licence is why enig-term only points to these fonts. The source README
releases the files "under the GPL-FE license" (GPL with the font exception)
and also says "Topaz is (c) AmigaInc."; the files are remakes. P0T-NOoDLE,
MicroKnight and mO'sOul are credited to their original authors. Whether to
serve them is the operator's decision.

In these bitmaps, Topaz/Topaz Plus (Kickstart 2) and P0T-NOoDLE hold the
Amiga's inverted underscore at 0xA0 (non-breaking space), as the source README
explains.

## Amiga profile

The Amiga profile is the Ami/X look: the Amiga palette, Amiga pixel aspect, a
block cursor, iCE off, and optionally an Amiga screen height. Typed text is
Latin-1 under an Amiga font, but that follows the font in every profile.

### When it applies

`profile: "auto"` (the default) switches to it while the host's normal font
(Ps1 0) is an Amiga font (37-42), and back on any other font. A font that is
refused changes nothing.

`"amiga"` or `"pc"` locks it. That can be set in the config, an attribute,
the URL, the API (`setOption('profile', ...)`) or the Settings panel. The
explicit `"amiga"` also selects `amigaFont` (Topaz) when Amiga fonts are
installed, and undoes that when the profile ends. The user's setting ranks as
described in [Precedence](configuration.md#precedence), unless the config
locks `profile`.

### Palette

`src/palettes.ts` holds the tables. `ncomm` (the default) is NComm
3.0/3.09's ANSI pens: `000 C00 0B0 BA0 00C B0B 0DD DDD | 666 F00 0F0 FF0 00F
F0F 0FF FFF` (12-bit, ANSI order, each component x17). `term-ega` is Term
4.8's table. The chosen table is the default palette while the profile is
active: host OSC 4 changes still apply, and OSC 104 resets to it.

### Aspect

The Amiga fonts are 8x8 glyphs line-doubled into 16-row cells, so a frame row
is half an Amiga pixel. The frame is stretched by `amigaAspect` x 8 / cell
height. PAL (1.875, 640x256 at 4:3) is the default. NTSC is 2.4 (640x200 at
4:3, the same shape as the PC's 4:3). `aspect: false` shows square pixels.

### Geometry

`amigaRows` (off by default) resizes while the profile is active and sends
NAWS. The configured `rows` return with the PC profile. NComm's "80x24" used a
640x204 screen; Term followed the display mode.

### Defaults

All of these can be overridden. Bold is bright. SGR 5 blinks (`amigaBlink`).
iCE colours are off (`amigaIce`), because no Amiga terminal is documented with
bright backgrounds; the host's `CSI ? 33 h` is still remembered and reported,
and applies again in the PC profile. The cursor is a block (`amigaCursor`).

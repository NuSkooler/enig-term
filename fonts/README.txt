enig-term fonts
===============

pc/*.psf and manifest.json are derived from "The Ultimate Oldschool PC Font
Pack" v2.2 by VileR (https://int10h.org/oldschool-pc-fonts/), licensed under
the Creative Commons Attribution-ShareAlike 4.0 International License
(LICENSE in this directory, https://creativecommons.org/licenses/by-sa/4.0/).

Changes: the IBM VGA 8x16, 8x14 and 9x8 designs (Px437 and PxPlus TrueType
pixel outlines) were sampled at their pixel grid into 256-glyph PSF2 bitmap
fonts, one per code page and cell height, by enig-term's
scripts/build-fonts.mjs. The 8-row fonts keep the first 8 of the 9x8 font's
9 columns. Code pages other than 437 are re-arranged from the same designs
(Unicode to code page tables from Python's codecs); C0 positions use the CP437
graphics.

These files (this directory only) are under CC BY-SA 4.0; if you adapt them,
share the result under the same licence. The rest of enig-term is
BSD-2-Clause and is not affected.

amiga/ is not part of enig-term: an operator creates it with
tools/fetch-amiga-fonts.mjs, and its own README says where it came from.

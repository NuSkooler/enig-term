// Palettes for the Amiga (Ami/X) profile: the 16 ANSI colours, in ANSI order
// (SGR 30-37, then the bright 90-97 / bold set). Data only; the profile
// applies the chosen one as the default palette, and host OSC 4 / OSC 104
// still change and reset entries on top of it.
//
// Sources (numbers cited, no code copied):
//
// "ncomm" (default): NComm 3.0 and 3.09, Aminet comm/term/ncomm30.lha and
//   ncomm309.lha. A 16-word table of 12-bit Amiga colours at file offset
//   0x31f6a (3.0) / 0x331e6 (3.09); the same values are in the shipped
//   NCommANSI.config. In the binary's pen order they are
//     000 DDD 0B0 BA0 00C B0B 0DD C00 | 666 FFF 0F0 FF0 00F F0F 0FF F00
//   Pens 1 and 7 (and 9 and 15) are swapped relative to ANSI, because Amiga
//   pen 1 is the text pen. That 1<->7 mapping is inferred from the pen
//   layout, not traced in NComm's code. Values verified by the coordinator.
//
// "term-ega": Term 4.8 by Olaf Barthel, Data.c (around line 168), already in
//   ANSI order. Term's source is All Rights Reserved; only the values are used.
//
// 12-bit to 8-bit: each 4-bit component times 17 ($C -> 0xCC).

export type AmigaPaletteName = 'ncomm' | 'term-ega';

/** 12-bit Amiga colours ($RGB), ANSI order. */
const AMIGA_12BIT: Record<AmigaPaletteName, readonly number[]> = {
    ncomm: [
        0x000, 0xc00, 0x0b0, 0xba0, 0x00c, 0xb0b, 0x0dd, 0xddd,
        0x666, 0xf00, 0x0f0, 0xff0, 0x00f, 0xf0f, 0x0ff, 0xfff,
    ],
    'term-ega': [
        0x000, 0xa00, 0x0a0, 0xa60, 0x00a, 0xa0a, 0x0aa, 0xbbb,
        0x666, 0xf00, 0x0f0, 0xff0, 0x00f, 0xf0f, 0x0ff, 0xfff,
    ],
};

export const AMIGA_PALETTE_NAMES = Object.keys(AMIGA_12BIT) as AmigaPaletteName[];

/** 48 bytes of RGB, ANSI order, for the core's set_palette(). */
export function amigaPalette(name: AmigaPaletteName): Uint8Array {
    const src = AMIGA_12BIT[name] ?? AMIGA_12BIT.ncomm;
    const out = new Uint8Array(48);
    src.forEach((c, i) => {
        out[i * 3] = ((c >> 8) & 15) * 17;
        out[i * 3 + 1] = ((c >> 4) & 15) * 17;
        out[i * 3 + 2] = (c & 15) * 17;
    });
    return out;
}

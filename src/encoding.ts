// Character sets: typed and pasted text going to the host, and screen cells
// coming back out as Unicode for copy.
//
// CP437 is the default. While an Amiga font (SyncTERM 37..42) is active the
// host expects ISO-8859-1, so text goes out as Latin-1 (owner decision), and
// cells drawn with an Amiga font copy out as Latin-1.

/** CP437 0x80..0xFF as Unicode (the standard IBM PC mapping). */
const CP437_HIGH =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/**
 * CP437 0x01..0x1F and 0x7F as the glyphs a PC draws for them (smileys,
 * arrows, the house), for copying screen cells. 0x00 copies as a space.
 */
const CP437_LOW =
    '☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼';
const CP437_DEL = '⌂';

const toCp437 = new Map<string, number>();
for (let i = 0; i < 128; i++) toCp437.set(CP437_HIGH[i], 0x80 + i);

export type Charset = 'cp437' | 'latin1';

/** SyncTERM font numbers of the Amiga fonts (ISO-8859-1 glyph order). */
export const AMIGA_FONTS: ReadonlySet<number> = new Set([37, 38, 39, 40, 41, 42]);

export function charsetForFont(font: number): Charset {
    return AMIGA_FONTS.has(font) ? 'latin1' : 'cp437';
}

/**
 * Text to host bytes. Characters the charset cannot express become '?'.
 * Line breaks become CR (what a BBS expects from Enter).
 */
export function encode(text: string, charset: Charset): Uint8Array {
    const out: number[] = [];
    const s = text.replace(/\r\n?|\n/g, '\r');
    for (const ch of s) {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x80) out.push(cp);
        else if (charset === 'latin1') out.push(cp <= 0xff ? cp : 0x3f);
        else out.push(toCp437.get(ch) ?? 0x3f);
    }
    return new Uint8Array(out);
}

/** One screen cell (glyph code as stored by the engine) to Unicode. */
export function cellToUnicode(code: number, charset: Charset): string {
    if (code === 0) return ' ';
    if (code > 0xff) return String.fromCodePoint(code); // utf8ansi cells hold Unicode already
    if (charset === 'latin1') return code < 0x20 || (code >= 0x7f && code < 0xa0) ? ' ' : String.fromCharCode(code);
    if (code < 0x20) return CP437_LOW[code - 1];
    if (code === 0x7f) return CP437_DEL;
    if (code < 0x80) return String.fromCharCode(code);
    return CP437_HIGH[code - 0x80];
}

/**
 * Split host bytes into chunks for sending (paste): at most `size` bytes each,
 * never splitting a CR LF pair.
 */
export function chunk(bytes: Uint8Array, size = 256): Uint8Array[] {
    const out: Uint8Array[] = [];
    let i = 0;
    while (i < bytes.length) {
        let end = Math.min(bytes.length, i + size);
        if (end < bytes.length && bytes[end - 1] === 0x0d && bytes[end] === 0x0a) end++;
        out.push(bytes.subarray(i, end));
        i = end;
    }
    return out;
}

/** Bytes to a string, one char per byte (for logging replies and probes). */
export function latin1(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
}

export function fromLatin1(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

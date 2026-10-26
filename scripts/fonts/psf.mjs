// PSF2 bitmap fonts: the format enig-term ships its fonts in (icy_engine's
// BitFont::from_bytes reads it). 256 glyphs, 8 pixels wide, no Unicode table.
// Our own code (BSD-2-Clause).

/** glyphs: 256 Uint8Arrays of `height` rows (MSB = leftmost pixel). */
export function writePsf2(glyphs, height) {
    if (glyphs.length !== 256) throw new Error('psf: need 256 glyphs');
    const out = new Uint8Array(32 + 256 * height);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x864ab572, true); // magic
    dv.setUint32(4, 0, true); // version
    dv.setUint32(8, 32, true); // header size
    dv.setUint32(12, 0, true); // flags: no Unicode table
    dv.setUint32(16, 256, true); // glyphs
    dv.setUint32(20, height, true); // bytes per glyph (8 wide: one byte per row)
    dv.setUint32(24, height, true);
    dv.setUint32(28, 8, true);
    glyphs.forEach((g, i) => out.set(g.subarray(0, height), 32 + i * height));
    return out;
}

/** Read a PSF2 (8 wide) or raw 8xN font into { height, glyphs }. */
export function readFont(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length >= 32 && dv.getUint32(0, true) === 0x864ab572) {
        const hs = dv.getUint32(8, true), n = dv.getUint32(16, true), cs = dv.getUint32(20, true);
        const h = dv.getUint32(24, true), w = dv.getUint32(28, true);
        if (w !== 8 || cs !== h || n < 256) throw new Error('psf: not an 8-wide 256-glyph PSF2');
        return { height: h, glyphs: Array.from({ length: 256 }, (_, i) => buf.slice(hs + i * h, hs + (i + 1) * h)) };
    }
    if (buf.length && buf.length % 256 === 0 && buf.length / 256 <= 32) {
        const h = buf.length / 256;
        return { height: h, glyphs: Array.from({ length: 256 }, (_, i) => buf.slice(i * h, (i + 1) * h)) };
    }
    throw new Error('font: neither PSF2 nor raw 8xN');
}

/** Every second row of a line-doubled font (8x16 -> 8x8). Throws if rows are not doubled. */
export function undouble(glyphs) {
    return glyphs.map((g, i) => {
        const out = new Uint8Array(g.length / 2);
        for (let r = 0; r < out.length; r++) {
            if (g[2 * r] !== g[2 * r + 1]) throw new Error(`font: glyph ${i} is not line-doubled`);
            out[r] = g[2 * r];
        }
        return out;
    });
}

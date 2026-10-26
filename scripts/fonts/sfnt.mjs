// Minimal TrueType reader for int10h's "Px" (pixel outline) fonts: the
// tables needed to rasterise a glyph whose outline is made of whole pixels
// (cmap format 4/12, head, hhea, hmtx, maxp, loca, glyf). Only simple glyphs
// with straight edges are drawn; composite glyphs are followed one level.
//
// Used at build time (scripts/build-fonts.mjs) to turn the Ultimate Oldschool
// PC Font Pack into 256-glyph bitmap tables. Our own code (BSD-2-Clause).

export function parseSfnt(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const numTables = dv.getUint16(4);
    const tables = {};
    for (let i = 0; i < numTables; i++) {
        const o = 12 + i * 16;
        const tag = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
        tables[tag] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
    }
    const need = t => {
        if (!tables[t]) throw new Error(`sfnt: no ${t} table`);
        return tables[t].off;
    };
    const head = need('head');
    const unitsPerEm = dv.getUint16(head + 18);
    const indexToLoc = dv.getInt16(head + 50);
    const hhea = need('hhea');
    const ascender = dv.getInt16(hhea + 4);
    const descender = dv.getInt16(hhea + 6);
    const numHMetrics = dv.getUint16(hhea + 34);
    const numGlyphs = dv.getUint16(need('maxp') + 4);
    const hmtx = need('hmtx');
    const advance = g => dv.getUint16(hmtx + 4 * Math.min(g, numHMetrics - 1));
    const loca = need('loca');
    const glyfOff = need('glyf');
    const locaAt = g => (indexToLoc ? dv.getUint32(loca + g * 4) : dv.getUint16(loca + g * 2) * 2);
    let os2 = null;
    if (tables['OS/2']) {
        const o = tables['OS/2'].off;
        os2 = { winAscent: dv.getUint16(o + 74), winDescent: dv.getUint16(o + 76), typoAscender: dv.getInt16(o + 68) };
    }

    // cmap: prefer a Unicode format 12 subtable, then format 4.
    const cmapOff = need('cmap');
    const map = new Map();
    const nSub = dv.getUint16(cmapOff + 2);
    const subs = [];
    for (let i = 0; i < nSub; i++) {
        const r = cmapOff + 4 + i * 8;
        const pid = dv.getUint16(r), eid = dv.getUint16(r + 2), off = cmapOff + dv.getUint32(r + 4);
        subs.push({ pid, eid, off, fmt: dv.getUint16(off) });
    }
    const uni = subs.filter(s => s.pid === 0 || (s.pid === 3 && (s.eid === 1 || s.eid === 10)));
    const pick = uni.find(s => s.fmt === 12) ?? uni.find(s => s.fmt === 4);
    if (!pick) throw new Error('sfnt: no Unicode cmap');
    if (pick.fmt === 12) {
        const n = dv.getUint32(pick.off + 12);
        for (let i = 0; i < n; i++) {
            const r = pick.off + 16 + i * 12;
            const s = dv.getUint32(r), e = dv.getUint32(r + 4), g = dv.getUint32(r + 8);
            for (let c = s; c <= e; c++) map.set(c, g + (c - s));
        }
    } else {
        const o = pick.off;
        const segX2 = dv.getUint16(o + 6);
        const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let i = 0; i < segX2 / 2; i++) {
            const e = dv.getUint16(ends + i * 2), s = dv.getUint16(starts + i * 2);
            const d = dv.getInt16(deltas + i * 2), ro = dv.getUint16(ranges + i * 2);
            for (let c = s; c <= e && c !== 0xffff; c++) {
                let g;
                if (ro === 0) g = (c + d) & 0xffff;
                else {
                    const gi = ranges + i * 2 + ro + (c - s) * 2;
                    g = dv.getUint16(gi);
                    if (g) g = (g + d) & 0xffff;
                }
                if (g) map.set(c, g);
            }
        }
    }

    /** Contours of glyph g as arrays of on-curve points [x, y] (font units). */
    function contours(g, depth = 0) {
        const start = locaAt(g), end = locaAt(g + 1);
        if (end <= start) return [];
        const p = glyfOff + start;
        const nC = dv.getInt16(p);
        if (nC < 0) {
            if (depth > 2) return [];
            // Composite: offsets only (ARGS_ARE_XY_VALUES), no scaling.
            const out = [];
            let q = p + 10;
            for (;;) {
                const flags = dv.getUint16(q), sub = dv.getUint16(q + 2);
                q += 4;
                let dx, dy;
                if (flags & 1) { dx = dv.getInt16(q); dy = dv.getInt16(q + 2); q += 4; }
                else { dx = dv.getInt8(q); dy = dv.getInt8(q + 1); q += 2; }
                if (flags & 8) q += 2; else if (flags & 0x40) q += 4; else if (flags & 0x80) q += 8;
                for (const c of contours(sub, depth + 1)) out.push(c.map(([x, y]) => [x + dx, y + dy]));
                if (!(flags & 0x20)) break;
            }
            return out;
        }
        const endPts = [];
        for (let i = 0; i < nC; i++) endPts.push(dv.getUint16(p + 10 + i * 2));
        const nPts = nC ? endPts[nC - 1] + 1 : 0;
        let q = p + 10 + nC * 2;
        q += 2 + dv.getUint16(q); // instructions
        const flags = [];
        while (flags.length < nPts) {
            const f = buf[q++];
            flags.push(f);
            if (f & 8) {
                let r = buf[q++];
                while (r--) flags.push(f);
            }
        }
        const xs = [], ys = [];
        let v = 0;
        for (const f of flags) {
            if (f & 2) v += f & 16 ? buf[q++] : -buf[q++];
            else if (!(f & 16)) { v += dv.getInt16(q); q += 2; }
            xs.push(v);
        }
        v = 0;
        for (const f of flags) {
            if (f & 4) v += f & 32 ? buf[q++] : -buf[q++];
            else if (!(f & 32)) { v += dv.getInt16(q); q += 2; }
            ys.push(v);
        }
        const out = [];
        let s = 0;
        for (const e of endPts) {
            const c = [];
            for (let i = s; i <= e; i++) {
                if (!(flags[i] & 1)) throw new Error(`sfnt: glyph ${g} has curves (not a pixel font)`);
                c.push([xs[i], ys[i]]);
            }
            out.push(c);
            s = e + 1;
        }
        return out;
    }

    return { unitsPerEm, ascender, descender, os2, numGlyphs, advance, cmap: map, contours };
}

/** Non-zero winding test of point (x, y) against straight-edged contours. */
function inside(cs, x, y) {
    let w = 0;
    for (const c of cs) {
        for (let i = 0; i < c.length; i++) {
            const [x0, y0] = c[i], [x1, y1] = c[(i + 1) % c.length];
            if (y0 <= y) {
                if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) w++;
            } else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) w--;
        }
    }
    return w !== 0;
}

/**
 * Rasterise a pixel-outline font at its native cell size: `cellW` x `cellH`
 * pixels, sampling each pixel's centre. The pixel pitch is the advance width
 * divided by `cellW`; the cell's top edge is the font's ascender.
 * Returns { glyph(codepoint) -> Uint8Array rows (MSB = leftmost) | null }.
 */
export function pixelFont(buf, cellW, cellH) {
    const f = parseSfnt(buf);
    const g0 = f.cmap.get(0x41) ?? 1;
    const pitch = f.advance(g0) / cellW;
    const top = f.os2 ? f.os2.winAscent : f.ascender;
    if (Math.abs(top / pitch - Math.round(top / pitch)) > 1e-6) throw new Error('sfnt: ascender is not on the pixel grid');
    return {
        pitch,
        has: cp => f.cmap.has(cp),
        glyph(cp) {
            const g = f.cmap.get(cp);
            if (g === undefined) return null;
            const cs = f.contours(g);
            const rows = new Uint8Array(cellH);
            for (let r = 0; r < cellH; r++) {
                const y = top - (r + 0.5) * pitch;
                let bits = 0;
                for (let c = 0; c < Math.min(cellW, 8); c++) if (inside(cs, (c + 0.5) * pitch, y)) bits |= 0x80 >> c;
                rows[r] = bits;
            }
            return rows;
        },
    };
}

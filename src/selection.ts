// Cell selection over the displayed screen, and turning it into text.
//
// Selection is a stream (like a text editor): from the anchor cell to the head
// cell, row by row. Coordinates are displayed cells (the scrollback view when
// scrolled back). Cells come from the core packed as u32: bits 0-15 the glyph
// code, 16-23 the font slot, bit 24 "has a link".
import { cellToUnicode, charsetForFont } from './encoding.ts';

export interface CellPos {
    x: number;
    y: number;
}

export interface SelRange {
    x0: number;
    y0: number;
    /** Inclusive. */
    x1: number;
    y1: number;
}

export const cellCode = (v: number) => v & 0xffff;
export const cellFont = (v: number) => (v >>> 16) & 0xff;
export const cellHasLink = (v: number) => ((v >>> 24) & 1) === 1;

export function normalize(a: CellPos, b: CellPos): SelRange {
    const first = a.y < b.y || (a.y === b.y && a.x <= b.x) ? a : b;
    const last = first === a ? b : a;
    return { x0: first.x, y0: first.y, x1: last.x, y1: last.y };
}

export function contains(r: SelRange, x: number, y: number): boolean {
    if (y < r.y0 || y > r.y1) return false;
    if (r.y0 === r.y1) return x >= r.x0 && x <= r.x1;
    if (y === r.y0) return x >= r.x0;
    if (y === r.y1) return x <= r.x1;
    return true;
}

/** One row of packed cells to Unicode, each cell by its own font's charset. */
export function rowToText(cells: ArrayLike<number>, from = 0, to = cells.length - 1): string {
    let s = '';
    for (let x = Math.max(0, from); x <= Math.min(to, cells.length - 1); x++) {
        const v = cells[x];
        s += cellToUnicode(cellCode(v), charsetForFont(cellFont(v)));
    }
    return s;
}

/**
 * The selected text: rows joined with "\n", trailing blanks of each row
 * dropped (a BBS screen pads with spaces; nobody wants them on paste).
 */
export function selectionText(r: SelRange, row: (y: number) => ArrayLike<number>, cols: number): string {
    const lines: string[] = [];
    for (let y = r.y0; y <= r.y1; y++) {
        const from = y === r.y0 ? r.x0 : 0;
        const to = y === r.y1 ? r.x1 : cols - 1;
        lines.push(rowToText(row(y), from, to).replace(/[  ]+$/, ''));
    }
    return lines.join('\n');
}

/** The run of non-blank cells around x (double-click word selection). */
export function wordAt(cells: ArrayLike<number>, x: number): [number, number] {
    const blank = (i: number) => {
        const c = cellCode(cells[i]);
        return c === 0 || c === 0x20 || c === 0xff;
    };
    if (x < 0 || x >= cells.length || blank(x)) return [x, x];
    let a = x;
    let b = x;
    while (a > 0 && !blank(a - 1)) a--;
    while (b < cells.length - 1 && !blank(b + 1)) b++;
    return [a, b];
}

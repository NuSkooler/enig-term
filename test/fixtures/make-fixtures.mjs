// Generates the synthetic test art used by the browser tests. All content is
// ours (no third-party art). Run: node test/fixtures/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ESC = String.fromCharCode(0x1b);
const CSI = ESC + '[';
const at = (r, c) => `${CSI}${r};${c}H`;
const sgr = (...n) => `${CSI}${n.join(';')}m`;
const ch = n => String.fromCharCode(n);
const write = (name, s) => fs.writeFileSync(path.join(here, name), Buffer.from(s, 'latin1'));

// --- CP437 test card -------------------------------------------------------
function testCard(title) {
    let s = `${sgr(0)}${CSI}2J${CSI}?25l${at(1, 1)}${sgr(1, 37, 44)}${title.padEnd(80)}${sgr(0)}`;
    // 0x20..0xFF as a 16-wide grid with hex labels
    s += at(3, 2) + sgr(0, 33) + '   ' + [...'0123456789ABCDEF'].map(h => h + ' ').join('');
    for (let row = 2; row < 16; row++) {
        s += at(2 + row, 2) + sgr(0, 33) + row.toString(16).toUpperCase() + '_ ' + sgr(0, 37);
        for (let col = 0; col < 16; col++) s += ch(row * 16 + col) + ' ';
    }
    // box drawing: single and double frames
    const box = (r, c, w, h, [tl, tr, bl, br, hz, vt], color) => {
        let b = sgr(0, ...color) + at(r, c) + ch(tl) + ch(hz).repeat(w - 2) + ch(tr);
        for (let i = 1; i < h - 1; i++) b += at(r + i, c) + ch(vt) + ' '.repeat(w - 2) + ch(vt);
        return b + at(r + h - 1, c) + ch(bl) + ch(hz).repeat(w - 2) + ch(br);
    };
    s += box(3, 40, 39, 7, [0xc9, 0xbb, 0xc8, 0xbc, 0xcd, 0xba], [1, 36]);
    s += box(10, 40, 39, 7, [0xda, 0xbf, 0xc0, 0xd9, 0xc4, 0xb3], [0, 32]);
    // shading ramps in the 16 foreground colours
    for (let i = 0; i < 8; i++) {
        s += at(4 + (i >> 1), 42 + (i & 1) * 18) + sgr(0, 30 + i) + ch(0xb0).repeat(4) + ch(0xb1).repeat(4) + ch(0xb2).repeat(4) + ch(0xdb).repeat(4);
        s += at(11 + (i >> 1), 42 + (i & 1) * 18) + sgr(1, 30 + i) + ch(0xb0).repeat(4) + ch(0xb1).repeat(4) + ch(0xb2).repeat(4) + ch(0xdb).repeat(4);
    }
    s += at(8, 42) + sgr(0, 37) + 'double frame, dim ramps';
    s += at(15, 42) + sgr(0, 37) + 'single frame, bright ramps';
    // background colours, then iCE bright backgrounds (SGR 5 under CSI ?33h)
    s += at(18, 2) + sgr(0, 37) + 'bg:  ';
    for (let i = 0; i < 8; i++) s += sgr(0, 30 + ((i + 7) & 7), 40 + i) + ` ${i} `;
    s += sgr(0) + '  ' + `${CSI}?33h` + sgr(0, 37) + 'iCE: ';
    for (let i = 0; i < 8; i++) s += sgr(0, 5, 30 + ((i + 7) & 7), 40 + i) + ` ${i + 8} `;
    // half blocks and arrows
    s += at(20, 2) + sgr(0, 31, 43) + ch(0xdc).repeat(10) + ch(0xdf).repeat(10) + sgr(0, 34, 47) + ch(0xdd).repeat(10) + ch(0xde).repeat(10) + sgr(0);
    s += at(22, 2) + sgr(0, 37) + 'The quick brown fox jumps over the lazy dog. 0123456789 !@#$%^&*()';
    s += at(23, 2) + sgr(1, 32) + 'ENiGMA' + ch(0xab) + ' ' + ch(0xab) + ch(0xbb) + ' ' + ch(0xae) + ch(0xaf) + ' ' + ch(0xe1) + ch(0xe9) + ch(0xf8) + ch(0xfb) + ' ' + ch(0x9b) + ch(0x9c) + ch(0x9d) + sgr(0);
    return s;
}
write('cp437-testcard.ans', testCard(' enig-term  CP437 test card  (0x20-0xFF, frames, shading, colours, iCE)'));

// --- SAUCE: iCE + 9px + legacy aspect + "IBM VGA" ---------------------------
function sauce({ title, author, group, cols, rows, flags, font, size }) {
    const b = Buffer.alloc(128, 0);
    let o = 0;
    const put = (str, len) => {
        b.write(str.padEnd(len, ' ').slice(0, len), o, 'latin1');
        o += len;
    };
    put('SAUCE', 5);
    put('00', 2);
    put(title, 35);
    put(author, 20);
    put(group, 20);
    put('20261024', 8);
    b.writeUInt32LE(size, o); o += 4;
    b[o++] = 1; // DataType: Character
    b[o++] = 1; // FileType: ANSi
    b.writeUInt16LE(cols, o); o += 2;
    b.writeUInt16LE(rows, o); o += 2;
    o += 4; // TInfo3, TInfo4
    b[o++] = 0; // comments
    b[o++] = flags;
    b.write(font, o, 'latin1'); // TInfoS, zero padded
    return b;
}
{
    const body = Buffer.from(testCard(' SAUCE test: iCE colours + 9px letter spacing + legacy aspect, font "IBM VGA"').replace(`${CSI}?33h`, ''), 'latin1');
    // TFlags: bit0 iCE; bits1-2 letter spacing (10 = 9px); bits3-4 aspect (01 = legacy)
    const flags = 0x01 | (0b10 << 1) | (0b01 << 3);
    const rec = sauce({ title: 'enig-term SAUCE test', author: 'enig-term', group: 'tests', cols: 80, rows: 25, flags, font: 'IBM VGA', size: body.length });
    fs.writeFileSync(path.join(here, 'sauce-ice-9px.ans'), Buffer.concat([body, Buffer.from([0x1a]), rec]));
}

// --- Amiga: Topaz (SyncTERM font 42) + Latin-1 high half ---------------------
{
    let s = `${sgr(0)}${CSI}2J${CSI}?25l${CSI}0;42 D`;
    s += at(1, 1) + sgr(1, 37, 44) + ' Amiga test: CSI 0;42 SP D (Topaz), then ISO-8859-1 0xA0-0xFF'.padEnd(80) + sgr(0);
    s += at(3, 2) + sgr(0, 33) + '   ' + [...'0123456789ABCDEF'].map(h => h + ' ').join('');
    for (let row = 0xa; row <= 0xf; row++) {
        s += at(4 + row - 0xa, 2) + sgr(0, 33) + row.toString(16).toUpperCase() + '_ ' + sgr(0, 37);
        for (let col = 0; col < 16; col++) s += ch(row * 16 + col) + ' ';
    }
    s += at(11, 2) + sgr(0, 37) + 'Expect: nbsp ' + [0xa1, 0xa2, 0xa3].map(ch).join(' ') + ' ... ' + ch(0xa9) + ' (copyright) ... ' + [0xbd, 0xbe, 0xbf].map(ch).join(' ') + ' / accented letters ' + ch(0xc0) + '-' + ch(0xff);
    s += at(13, 2) + sgr(1, 36) + 'Gr' + ch(0xfc) + ch(0xdf) + 'e aus K' + ch(0xf6) + 'ln: caf' + ch(0xe9) + ', na' + ch(0xef) + 've, ' + ch(0xa9) + ' 1985 Commodore-Amiga, ' + ch(0xbd) + ch(0xb0) + ch(0xb1);
    s += at(15, 2) + sgr(0, 37) + 'ASCII: The quick brown fox jumps over the lazy dog. 0123456789';
    s += at(16, 2) + sgr(1, 33) + '{}[]|\\~^`_ <>@#$%&*()+-=/?;:\'",.';
    s += `${CSI}0;0 D` + at(18, 2) + sgr(0, 37) + 'Back on font 0 (CP437): ' + ch(0xc9) + ch(0xcd).repeat(10) + ch(0xbb) + ' ' + ch(0xb0) + ch(0xb1) + ch(0xb2) + ch(0xdb);
    s += at(19, 2) + sgr(0, 37) + 'Same bytes 0xE9 0xFC 0xDF on CP437: ' + ch(0xe9) + ch(0xfc) + ch(0xdf);
    write('amiga-topaz-latin1.ans', s);
}
console.log('fixtures written to', here);

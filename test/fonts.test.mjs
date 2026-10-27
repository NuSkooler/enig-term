// Phase 2 font behaviour of the WASM core: no embedded fonts, refusal of
// slots without a font, CTerm attribute slots (Ps1) and modes 31/32/34/35,
// the CSI = 1/2/3 n reports, DCS fonts and cell heights, the profile palette
// and iCE gating. Plus the shipped font data itself.
// Run: node --test test/fonts.test.mjs   (after npm run build:wasm)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadCore, bytes, framePixels, withFonts, pcFont, amigaFont, AMIGA_FONT_DIR, FONT_DIR, ESC, CSI, ST } from './core-harness.mjs';

const { Core, memory } = await loadCore();
const events = c => JSON.parse(c.take_events());
const req = (c, k) => events(c).find(e => e.k === k);

/** The font page of the cell at (x, y). */
const pageAt = (c, x, y) => (c.row_cells(y)[x] >> 16) & 0xff;

/** RGB of the pixel at (px, py) of a full render. */
function pixel(c, px, py) {
    c.render(true);
    const f = framePixels(c, memory);
    const i = (py * c.frame_width() + px) * 4;
    return [f[i], f[i + 1], f[i + 2]];
}

test('the engine has no fonts of its own: a fresh core draws nothing until slot 0 is loaded', () => {
    const c = new Core(80, 25, 'ansi');
    assert.equal(c.font_name(0), '', 'slot 0 is an unnamed placeholder');
    for (const n of [0, 1, 24, 37, 42]) assert.equal(c.has_font(n), false, `slot ${n}`);
    c.feed(bytes(`${CSI}1;1H${CSI}37;40m\xdb`)); // a full block
    assert.deepEqual(pixel(c, 3, 8), [0, 0, 0], 'placeholder glyphs are blank');
    assert.equal(c.cell_height(), 16);
    withFonts(c);
    assert.equal(c.has_font(0), true);
    assert.deepEqual(pixel(c, 3, 8), [0xaa, 0xaa, 0xaa], 'the loaded CP437 font draws the block');
});

test('every SyncTERM slot is either built from a font or refused, never both', () => {
    const m = JSON.parse(fs.readFileSync(path.join(FONT_DIR, 'manifest.json'), 'utf8'));
    for (let n = 0; n <= 36; n++) {
        const e = m.slots[n];
        assert.ok(e, `slot ${n} described`);
        assert.ok(!!e.refused !== !!e.files, `slot ${n}: refused xor files`);
        for (const f of Object.values(e.files ?? {})) {
            const b = fs.readFileSync(path.join(FONT_DIR, f));
            assert.equal(crypto.createHash('sha256').update(b).digest('hex'), m.files[f].sha256, f);
        }
    }
    for (const n of [37, 38, 39, 40, 41, 42]) assert.equal(m.slots[n], undefined, `Amiga slot ${n} is not shipped`);
    assert.deepEqual(
        [7, 15, 31, 32, 33, 34, 35, 36].filter(n => m.slots[n].refused),
        [7, 15, 31, 32, 33, 34, 35, 36],
    );
    assert.equal(fs.existsSync(path.join(FONT_DIR, 'amiga')), false);
});

test('CP437 font: the glyphs of the int10h IBM VGA 8x16 font (spot checks)', () => {
    const f = pcFont('cp437', 16);
    const g = ch => Array.from(f.subarray(32 + ch * 16, 32 + ch * 16 + 16));
    assert.deepEqual(g(0x41), [0, 0, 0x10, 0x38, 0x6c, 0xc6, 0xc6, 0xfe, 0xc6, 0xc6, 0xc6, 0xc6, 0, 0, 0, 0], "'A'");
    assert.deepEqual(g(0xdb), Array(16).fill(0xff), 'full block');
    assert.deepEqual(g(0xb0).slice(0, 2), [0x11, 0x44], 'light shade');
});

test('Ps1 selects one of four attribute slots; bold uses slot 1 only under CSI ? 31 h', () => {
    const c = withFonts(new Core(80, 25, 'ansi'), { 24: pcFont('iso-8859-1'), 2: pcFont('koi8-r') });
    c.feed(bytes(`${CSI}1;24 D${CSI}=1n`));
    assert.deepEqual(req(c, 'fontstate').slots, [0, 24, 0, 0]);
    assert.equal(c.font_page(), 0, 'Ps1 1 does not change the normal font');
    c.feed(bytes(`${CSI}1;1H${CSI}1mA${CSI}?31h${CSI}1mB${CSI}0mC${CSI}?31l${CSI}1mD`));
    assert.deepEqual([0, 1, 2, 3].map(x => pageAt(c, x, 0)), [0, 24, 0, 0]);
    // Blink slot (2) under ? 34 h, both bits (3) under both modes.
    c.feed(bytes(`${CSI}2;2 D${CSI}3;24 D${CSI}0m${CSI}2;1H${CSI}?34h${CSI}5mE${CSI}?31h${CSI}1;5mF${CSI}0mG`));
    assert.deepEqual([0, 1, 2].map(x => pageAt(c, x, 1)), [2, 24, 0]);
    c.feed(bytes(`${CSI}=1n${CSI}=2n`));
    const ev = events(c);
    assert.deepEqual(ev.find(e => e.k === 'fontstate').slots, [0, 24, 2, 24]);
    assert.deepEqual(ev.find(e => e.k === 'fontmode').modes, [7, 25, 31, 34]);
});

test('Ps1 above 3 and fonts above 255 are refused', () => {
    const c = withFonts(new Core(80, 25, 'ansi'));
    c.feed(bytes(`${CSI}4;0 D${CSI}=1n`));
    let ev = events(c);
    assert.deepEqual([ev[0].ok, ev[0].reason, ev.find(e => e.k === 'fontstate').result], [false, 'slot', 1]);
    c.feed(bytes(`${CSI}0;300 D`));
    ev = events(c);
    assert.deepEqual([ev[0].ok, ev[0].reason], [false, 'font']);
});

test('CTerm modes split across feeds still apply where they occur', () => {
    const c = withFonts(new Core(80, 25, 'ansi'), { 24: pcFont('iso-8859-1') });
    c.feed(bytes(`${CSI}1;24 D${CSI}1;1H${CSI}1mA${CSI}?3`));
    c.feed(bytes(`1hB`));
    assert.deepEqual([pageAt(c, 0, 0), pageAt(c, 1, 0)], [0, 24]);
});

test('CSI ? 32 h: bold does not brighten; CSI ? 35 h: blinking text does not blink', () => {
    const c = withFonts(new Core(80, 25, 'ansi'));
    c.feed(bytes(`${CSI}1;1H${CSI}1;37m\xdb${CSI}?32h\xdb${CSI}0m${CSI}2;1H${CSI}5;37m\xdb${CSI}?35h\xdb`));
    assert.deepEqual(pixel(c, 3, 8), [0xff, 0xff, 0xff], 'bold white');
    assert.deepEqual(pixel(c, 11, 8), [0xaa, 0xaa, 0xaa], 'bold white without intensity');
    c.set_blink(false); // the blink "off" phase
    assert.deepEqual(pixel(c, 3, 24), [0, 0, 0], 'blinking cell in its off phase');
    assert.deepEqual(pixel(c, 11, 24), [0xaa, 0xaa, 0xaa], 'written under ? 35 h: steady');
    c.feed(bytes(`${CSI}=2n`));
    assert.deepEqual(req(c, 'fontmode').modes, [7, 25, 32, 35]);
});

test('CSI ? 35 h with iCE on: the blink bit still brightens the background; ? 35 is not the cursor blink', () => {
    const c = withFonts(new Core(80, 25, 'ansi'));
    c.feed(bytes(`${CSI}?33h${CSI}?35h${CSI}1;1H${CSI}5;41m ${CSI}0m`));
    assert.deepEqual(pixel(c, 4, 8), [0xff, 0x55, 0x55], 'bright red background');
    assert.equal(c.cursor_blinking(), true, '? 35 h leaves the cursor alone');
    c.feed(bytes(`${CSI}?12l`));
    assert.equal(c.cursor_blinking(), false, 'xterm ? 12 l stops the cursor blinking');
    c.feed(bytes(`${CSI}?12h`));
    assert.equal(c.cursor_blinking(), true);
});

test('CSI = 3 n reports the cell size of the screen mode, including 9-dot letter spacing', () => {
    const c = withFonts(new Core(80, 25, 'ansi'));
    c.feed(bytes(`${CSI}=3n`));
    const d0 = req(c, 'fontdim');
    assert.deepEqual([d0.h, d0.w], [16, 8]);
    const sauce = fs.readFileSync(new URL('./fixtures/sauce-ice-9px.ans', import.meta.url));
    c.load_sauce_art(sauce);
    c.take_events();
    c.feed(bytes(`${CSI}=3n`));
    const d = req(c, 'fontdim');
    assert.deepEqual([d.h, d.w], [16, 9]);
});

test('cell height follows the screen mode: 50 rows use 8-pixel fonts, and the shell is told what to load', () => {
    const c = withFonts(new Core(80, 25, 'ansi'), { 24: pcFont('iso-8859-1') });
    c.feed(bytes(`${CSI}0;24 D`));
    events(c);
    c.resize(80, 50);
    const ev = events(c).find(e => e.t === 'fontheight');
    assert.deepEqual([ev.height, ev.missing.sort((a, b) => a - b)], [8, [0, 24]]);
    assert.equal(c.mode_font_height(), 8);
    assert.equal(c.has_font(24), false, 'the 16-pixel font is not selectable in 8-pixel cells');
    c.load_font(0, 'cp437', pcFont('cp437', 8));
    c.load_font(24, 'latin1', pcFont('iso-8859-1', 8));
    c.feed(bytes(`${CSI}=3n`));
    const d = req(c, 'fontdim');
    assert.deepEqual([d.h, d.w, c.frame_width() || 640], [8, 8, 640]);
    c.render(true);
    assert.deepEqual([c.frame_width(), c.frame_height()], [640, 400]);
    assert.equal(c.has_font(24), true);
    c.resize(80, 25);
    assert.equal(c.has_font(24), true, 'back at 16 px: the 16-pixel fonts are still there');
});

test('DCS fonts: kept at their own height; selectable only in a mode of that height (as in SyncTERM)', () => {
    const c = withFonts(new Core(80, 25, 'ansi'));
    const font8 = Buffer.from(new Uint8Array(256 * 8).fill(0x81)).toString('base64');
    c.feed(bytes(`${ESC}PCTerm:Font:47:${font8}${ST}${CSI}0;47 D${CSI}=1n`));
    let ev = events(c);
    const load = ev.find(e => e.t === 'fontload');
    assert.deepEqual([load.ok, load.height, load.width], [true, 8, 8]);
    assert.deepEqual([ev.find(e => e.t === 'font').reason, ev.find(e => e.k === 'fontstate').result], ['missing', 1]);
    c.resize(80, 50);
    c.load_font(0, 'cp437', pcFont('cp437', 8));
    c.feed(bytes(`${CSI}0;47 D${CSI}=1n`));
    ev = events(c);
    assert.deepEqual([ev.find(e => e.t === 'font').ok, ev.find(e => e.k === 'fontstate').result], [true, 0]);
});

test('DCS font reloaded into a slot in use changes what its cells show at once', () => {
    const c = withFonts(new Core(80, 25, 'ansi'));
    const font = v => Buffer.from(new Uint8Array(256 * 16).fill(v)).toString('base64');
    c.feed(bytes(`${ESC}PCTerm:Font:46:${font(0x80)}${ST}${CSI}0;46 D${CSI}1;1H${CSI}37;40mA`));
    assert.deepEqual([pixel(c, 0, 0)[0] > 0, pixel(c, 1, 0)[0] > 0], [true, false]);
    c.feed(bytes(`${ESC}PCTerm:Font:46:${font(0x40)}${ST}`));
    assert.deepEqual([pixel(c, 0, 0)[0] > 0, pixel(c, 1, 0)[0] > 0], [false, true]);
});

test('profile palette: the default for SGR colours; OSC 4 still changes it; OSC 104 resets to it', () => {
    const c = withFonts(new Core(80, 25, 'ansi'));
    const pal = new Uint8Array(48);
    for (let i = 0; i < 16; i++) pal.set([i * 16, 255 - i * 16, i], i * 3);
    c.set_palette(pal);
    assert.deepEqual(Array.from(c.palette_rgb()), Array.from(pal));
    c.feed(bytes(`${CSI}1;1H${CSI}0;41m `));
    assert.deepEqual(pixel(c, 4, 8), [16, 239, 1], 'SGR 41 is ANSI colour 1 of the palette');
    c.feed(bytes(`${ESC}]4;1;rgb:12/34/56${ST}`));
    assert.deepEqual(pixel(c, 4, 8), [0x12, 0x34, 0x56], 'OSC 4 on top');
    c.feed(bytes(`${ESC}]104;1${ST}`));
    assert.deepEqual(pixel(c, 4, 8), [16, 239, 1], 'OSC 104 back to the profile colour');
    c.feed(bytes(`${ESC}]4;2;rgb:00/00/00${ST}${ESC}]104${ST}`));
    assert.deepEqual(Array.from(c.palette_rgb()), Array.from(pal), 'OSC 104 without indices: all 16');
    c.clear_palette();
    assert.deepEqual(pixel(c, 4, 8), [0xaa, 0, 0], 'cleared: VGA red');
    c.reset();
    assert.deepEqual(Array.from(c.palette_rgb()).slice(3, 6), [0xaa, 0, 0]);
});

test('profile palette survives a terminal reset (RIS and reset())', () => {
    const c = withFonts(new Core(80, 25, 'ansi'));
    const pal = new Uint8Array(48).fill(7);
    c.set_palette(pal);
    c.feed(bytes(`${ESC}]4;3;rgb:ff/ff/ff${ST}${ESC}c`));
    assert.deepEqual(Array.from(c.palette_rgb()), Array.from(pal));
    c.feed(bytes(`${ESC}]4;3;rgb:ff/ff/ff${ST}`));
    c.reset();
    assert.deepEqual(Array.from(c.palette_rgb()), Array.from(pal));
});

test('RIS (ESC c) clears font selections and CTerm modes but keeps loaded fonts', () => {
    const c = withFonts(new Core(80, 25, 'ansi'), { 24: pcFont('iso-8859-1') });
    c.feed(bytes(`${CSI}0;24 D${CSI}1;24 D${CSI}?31h${ESC}c${CSI}=1n${CSI}=2n`));
    const ev = events(c);
    assert.deepEqual(ev.find(e => e.k === 'fontstate').slots, [0, 0, 0, 0]);
    assert.ok(!ev.find(e => e.k === 'fontmode').modes.includes(31));
    assert.equal(c.has_font(24), true);
    c.feed(bytes(`${CSI}1;1H${CSI}37;40m\xdb`));
    assert.deepEqual(pixel(c, 3, 8), [0xaa, 0xaa, 0xaa], 'slot 0 still draws after RIS');
});

test('iCE gating: with iCE not allowed, CSI ? 33 h is remembered but SGR 5 blinks', () => {
    const c = withFonts(new Core(80, 25, 'ansi'));
    c.set_ice_allowed(false);
    c.feed(bytes(`${CSI}?33h${CSI}1;1H${CSI}5;41m ${CSI}=2n`));
    assert.ok(req(c, 'fontmode').modes.includes(33), 'reported as set by the host');
    assert.deepEqual(pixel(c, 4, 8), [0xaa, 0, 0], 'normal red background, not bright');
    c.set_ice_allowed(true);
    c.feed(bytes(`${CSI}1;2H${CSI}5;41m `));
    assert.deepEqual(pixel(c, 12, 8), [0xff, 0x55, 0x55], 'allowed again: bright background for new text');
});

test('Amiga Topaz from the operator fetch script renders Latin-1 (skipped when not installed)', { skip: !AMIGA_FONT_DIR && 'no Amiga fonts (npm run fonts:amiga)' }, () => {
    const topaz = amigaFont(42);
    const c = withFonts(new Core(80, 25, 'ansi'), { 42: topaz });
    c.feed(bytes(`${CSI}0;42 D${CSI}1;1H${CSI}37;40m\xe9`));
    assert.ok(events(c).find(e => e.t === 'font').ok);
    assert.equal(pageAt(c, 0, 0), 42);
    c.render(true);
    const f = framePixels(c, memory);
    const glyph = topaz.subarray(32 + 0xe9 * 16, 32 + 0xe9 * 16 + 16);
    for (let r = 0; r < 16; r++) {
        let bits = 0;
        for (let x = 0; x < 8; x++) if (f[(r * c.frame_width() + x) * 4] > 0) bits |= 0x80 >> x;
        assert.equal(bits, glyph[r], `row ${r} of e-acute`);
    }
});

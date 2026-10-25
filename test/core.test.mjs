// Node tests for the WASM core API: host requests, split sequences, partial
// rendering correctness, fonts, palette, OSC 8, and the wasm32 time trap.
// Run: node --test test/core.test.mjs   (after npm run build:wasm)
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, bytes, framePixels, testFont8x16, ESC, CSI, ST } from './core-harness.mjs';

const { Core, memory } = await loadCore();

function events(core) {
    return JSON.parse(core.take_events());
}

test('host requests surface as events with state captured at request time', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}0c${CSI}5;10H${CSI}6n${CSI}20;30Hmore${CSI}255n${CSI}=6n${CSI}<c${CSI}=1n${CSI}=3n`));
    const ev = events(c).filter(e => e.t === 'req');
    assert.deepEqual(
        ev.map(e => e.k),
        ['da', 'cpr', 'size', 'ctsmrr', 'ctda', 'fontstate', 'fontdim'],
    );
    assert.deepEqual([ev[1].row, ev[1].col], [5, 10], 'CPR is where the caret was when 6n was parsed');
    assert.deepEqual([ev[2].rows, ev[2].cols], [25, 80]);
    assert.equal(ev[3].n, 6);
    assert.equal(ev[5].result, 99, 'no font selection yet');
    assert.deepEqual([ev[6].h, ev[6].w], [16, 8]);
});

test('sequences split across feed() calls', () => {
    const c = new Core(80, 25, 'ansi');
    const s = `${CSI}12;34H${CSI}6n${CSI}1;31mX`;
    for (let i = 0; i < s.length; i++) c.feed(bytes(s[i])); // one byte at a time
    const ev = events(c).filter(e => e.t === 'req');
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].row, ev[0].col], [12, 34]);
    assert.equal(c.cursor_x(), 34, 'X printed after the CPR moved the caret');
    // ESC split from '[' as well
    c.feed(bytes(ESC));
    c.feed(bytes('[6'));
    c.feed(bytes('n'));
    assert.equal(events(c).filter(e => e.t === 'req').length, 1);
});

test('CSI 999;999H then 255n reports the screen size (bansi)', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}999;999H${CSI}6n${CSI}255n`));
    const ev = events(c).filter(e => e.t === 'req');
    assert.deepEqual([ev[0].row, ev[0].col], [25, 80]);
    assert.deepEqual([ev[1].rows, ev[1].cols], [25, 80]);
});

test('resize changes reported size and frame dimensions', () => {
    const c = new Core(80, 25, 'ansi');
    c.render(true);
    assert.deepEqual([c.frame_width(), c.frame_height()], [640, 400]);
    c.resize(100, 40);
    c.feed(bytes(`${CSI}255n`));
    const ev = events(c).filter(e => e.t === 'req');
    assert.deepEqual([ev[0].rows, ev[0].cols], [40, 100]);
    assert.equal(c.render(false), 2);
    assert.deepEqual([c.frame_width(), c.frame_height()], [800, 640]);
});

// Applies partial renders to a shadow framebuffer and checks it against a full
// render after each step. This is exactly the contract the GPU upload relies on.
test('dirty-region renders keep a shadow frame identical to a full render', () => {
    const c = new Core(80, 25, 'ansi');
    c.render(true);
    const W = c.frame_width();
    let shadow = framePixels(c, memory);
    const steps = [
        ['print one char', `${CSI}10;10HX`],
        ['sgr + print', `${CSI}1;33;44mHELLO${CSI}0m`],
        ['erase line', `${CSI}10;1H${CSI}K`],
        ['erase screen part', `${CSI}5;1H${CSI}J`],
        ['fill + scroll at bottom', `${CSI}25;1H` + 'line\r\n'.repeat(5)],
        ['insert line', `${CSI}3;1H${CSI}L`],
        ['delete line', `${CSI}3;1H${CSI}M`],
        ['scroll region + LF', `${CSI}5;10r${CSI}10;1HAAA\r\nBBB\r\n${CSI}r`],
        ['clear screen', `${CSI}2J`],
        ['cursor move only', `${CSI}20;20H`],
        ['iCE on + blink attr', `${CSI}?33h${CSI}5;47mICE${CSI}0m`],
        ['font switch 42 + text', `${CSI}0;42 DTopaz${CSI}0;0 D`],
        ['reverse index', `${CSI}1;1H${ESC}M`],
        ['tab + backspace', `\t\tab\x08\x08`],
    ];
    const report = [];
    for (const [name, seq] of steps) {
        c.feed(bytes(seq));
        const kind = c.render(false);
        if (kind === 2) shadow = framePixels(c, memory);
        else if (kind === 1) shadow.set(framePixels(c, memory), c.region_y() * W * 4);
        report.push(`${name}: ${['none', 'rows ' + c.rendered_row_start() + '-' + c.rendered_row_end(), 'full'][kind]}`);
        c.render(true);
        const full = framePixels(c, memory);
        let diff = 0;
        for (let i = 0; i < full.length; i++) if (full[i] !== shadow[i]) diff++;
        assert.equal(diff, 0, `${name}: partial render diverged (${diff} bytes); ${report.join('; ')}`);
        shadow = full;
    }
    console.log('# dirty regions:', report.join('; '));
});

test('a one-character change renders one text row, not the full frame', () => {
    const c = new Core(80, 25, 'ansi');
    c.render(true);
    c.feed(bytes(`${CSI}12;40HZ`));
    assert.equal(c.render(false), 1);
    assert.equal(c.region_h(), 16);
    assert.equal(c.frame_len(), 640 * 16 * 4);
});

test('font select 42 loads Topaz and reports success', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}0;42 D${CSI}=1n`));
    const ev = events(c);
    const f = ev.find(e => e.t === 'font');
    assert.ok(f && f.ok && f.font === 42);
    const st = ev.find(e => e.k === 'fontstate');
    assert.equal(st.result, 0);
    assert.equal(st.slots[0], 42);
    assert.equal(c.font_page(), 42);
    assert.match(c.font_name(42), /topaz/i);
});

test('dcs font: CTerm:Font loads a slot that SP D can select (slot >= 43)', () => {
    const c = new Core(80, 25, 'ansi');
    const b64 = Buffer.from(testFont8x16()).toString('base64');
    c.feed(bytes(`${ESC}PCTerm:Font:43:${b64}${ST}${CSI}0;43 D${CSI}=1n${CSI}1;1H${CSI}37;40m\x41`));
    const ev = events(c);
    assert.ok(ev.find(e => e.t === 'fontload' && e.slot === 43));
    assert.equal(ev.find(e => e.k === 'fontstate').result, 0, 'selection of a loaded slot reports success');
    c.render(true);
    const px = framePixels(c, memory);
    const W = c.frame_width();
    // glyph 0x41 row 0 = 0x41: bits 01000001 -> pixels 1 and 7 lit
    const lit = x => px[(0 * W + x) * 4] > 0;
    assert.deepEqual([0, 1, 2, 7].map(lit), [false, true, false, true]);
});

test('runtime load_font overrides a built-in slot', () => {
    const c = new Core(80, 25, 'ansi');
    assert.equal(c.load_font(42, 'test font', testFont8x16()), '8x16');
    c.feed(bytes(`${CSI}0;42 D${CSI}1;1H${CSI}37;40m\x41`));
    assert.equal(c.font_name(42), 'test font');
    c.render(true);
    const px = framePixels(c, memory);
    assert.ok(px[1 * 4] > 0 && px[2 * 4] === 0);
});

test('osc palette: OSC 4 changes a palette entry', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${ESC}]4;1;rgb:12/34/56${ST}${CSI}1;1H${CSI}41m `));
    c.render(true);
    const px = framePixels(c, memory);
    assert.deepEqual([px[0], px[1], px[2]], [0x12, 0x34, 0x56]);
});

test('osc 8 links are parsed out of the text stream', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}1;1H${ESC}]8;;https://example.com/f${ST}file${ESC}]8;;${ST}`));
    const ev = events(c);
    assert.ok(ev.find(e => e.t === 'link' && e.uri === 'https://example.com/f'));
    assert.equal(c.cursor_x(), 4, 'only the 4 visible chars advanced the caret');
});

test('CSI ?2026h (synchronized output) is intercepted; raw passthrough traps on wasm32', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}?2026h`));
    assert.equal(c.sync_output(), true);
    c.feed(bytes(`${CSI}?2026l`));
    assert.equal(c.sync_output(), false);
    const d = new Core(80, 25, 'ansi');
    d.debug_passthrough_sync(true);
    const origError = console.error;
    let logged = '';
    console.error = m => (logged += m);
    try {
        assert.throws(() => d.feed(bytes(`${CSI}?2026h`)), /unreachable/);
    } finally {
        console.error = origError;
    }
    assert.match(logged, /time not implemented|panic/);
    console.log('# passthrough panic message:', logged.slice(0, 200));
});

test('cursor getters', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}7;9H${CSI}?25l`));
    assert.deepEqual([c.cursor_x(), c.cursor_y(), c.cursor_visible()], [8, 6, false]);
    c.feed(bytes(`${CSI}?25h${CSI}4 q`));
    assert.equal(c.cursor_visible(), true);
    console.log('# cursor shape after DECSCUSR 4:', c.cursor_shape(), 'blinking:', c.cursor_blinking());
});

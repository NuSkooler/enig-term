// Node tests for the WASM core API: host requests, split sequences, partial
// rendering correctness, fonts, palette, OSC 8, and the wasm32 time trap.
// Run: node --test test/core.test.mjs   (after npm run build:wasm)
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, bytes, framePixels, testFont8x16, withFonts, pcFont, amigaFont, AMIGA_FONT_DIR, ESC, CSI, ST } from './core-harness.mjs';

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

test('font select of a slot with no font is refused, not drawn blank', () => {
    const c = withFonts(new Core(80, 25, 'ansi'));
    c.feed(bytes(`${CSI}0;42 D${CSI}=1n`));
    const ev = events(c);
    const f = ev.find(e => e.t === 'font');
    assert.deepEqual([f.ok, f.font, f.reason], [false, 42, 'missing']);
    const st = ev.find(e => e.k === 'fontstate');
    assert.equal(st.result, 1, 'pR = 1: failed');
    assert.deepEqual(st.slots, [0, 0, 0, 0]);
    assert.equal(c.font_page(), 0, 'text keeps the font it had');
    assert.equal(c.has_font(42), false);
});

test('font select 42 works once the shell has loaded a font for it', () => {
    const c = withFonts(new Core(80, 25, 'ansi'), { 42: pcFont('iso-8859-1') });
    c.feed(bytes(`${CSI}0;42 D${CSI}=1n`));
    const ev = events(c);
    assert.ok(ev.find(e => e.t === 'font').ok);
    const st = ev.find(e => e.k === 'fontstate');
    assert.deepEqual([st.first, st.result, st.slots[0]], [46, 0, 42]);
    assert.equal(c.font_page(), 42);
});

test('dcs font: CTerm:Font loads a slot that SP D can select (slot >= 46)', () => {
    const c = new Core(80, 25, 'ansi');
    const b64 = Buffer.from(testFont8x16()).toString('base64');
    c.feed(bytes(`${ESC}PCTerm:Font:46:${b64}${ST}${CSI}0;46 D${CSI}=1n${CSI}1;1H${CSI}37;40m\x41`));
    const ev = events(c);
    assert.ok(ev.find(e => e.t === 'fontload' && e.slot === 46 && e.ok));
    assert.equal(ev.find(e => e.k === 'fontstate').result, 0, 'selection of a loaded slot reports success');
    c.render(true);
    const px = framePixels(c, memory);
    const W = c.frame_width();
    // glyph 0x41 row 0 = 0x41: bits 01000001 -> pixels 1 and 7 lit
    const lit = x => px[(0 * W + x) * 4] > 0;
    assert.deepEqual([0, 1, 2, 7].map(lit), [false, true, false, true]);
});

test('dcs font: 43-45 are CTerm built-ins (Prestel, Atari ST, RIPterm): a DCS load there is refused, and so is selecting them', () => {
    const c = new Core(80, 25, 'ansi');
    const b64 = Buffer.from(testFont8x16()).toString('base64');
    for (const slot of [43, 44, 45]) {
        c.feed(bytes(`${ESC}PCTerm:Font:${slot}:${b64}${ST}${CSI}0;${slot} D${CSI}=1n`));
        const ev = events(c);
        assert.equal(ev.find(e => e.t === 'fontload').ok, false, `DCS into ${slot}`);
        assert.deepEqual(ev.find(e => e.t === 'font'), { t: 'font', slot: 0, font: slot, ok: false, reason: 'missing', height: 16 });
        const st = ev.find(e => e.k === 'fontstate');
        assert.deepEqual([st.first, st.result, st.slots[0]], [46, 1, 0]);
        assert.equal(c.has_font(slot), false);
    }
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

test('CSI ?2026h (synchronized output) is intercepted; raw passthrough traps on wasm32', async () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}?2026h`));
    assert.equal(c.sync_output(), true);
    c.feed(bytes(`${CSI}?2026l`));
    assert.equal(c.sync_output(), false);
    // The trap leaves its instance unusable, so it gets one of its own.
    const { Core: Fresh } = await loadCore({ fresh: true });
    const d = new Fresh(80, 25, 'ansi');
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

// --- Phase 1: cell scrollback, view, links -----------------------------------

const lines = (from, to) => Array.from({ length: to - from }, (_, i) => `${CSI}${31 + ((from + i) % 7)}mline ${from + i}${CSI}0m\r\n`).join('');
const rowText = (c, y) => String.fromCharCode(...Array.from(c.row_cells(y), v => v & 0xffff)).trimEnd();

test('lines scrolling off the top are kept as cells, bounded', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(lines(0, 30))); // 30 lines + final CRLF: 6 scroll off
    assert.equal(c.scrollback_len(), 6);
    c.set_view_offset(6);
    assert.equal(rowText(c, 0), 'line 0');
    assert.equal(rowText(c, 5), 'line 5');
    assert.equal(rowText(c, 6), 'line 6', 'row 6 of the view is the live top row');
    c.set_scrollback_lines(3);
    assert.equal(c.scrollback_len(), 3);
    assert.equal(c.view_offset(), 3, 'view offset clamps to what is held');
    assert.equal(rowText(c, 0), 'line 3');
});

test('scroll region: top margin 0 feeds scrollback, a region lower down does not', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}1;24r${CSI}24;1H` + 'a\r\nb\r\n' + `${CSI}r`));
    assert.equal(c.scrollback_len(), 2, 'status-line layout: region 1..24 scrolls into scrollback');
    const d = new Core(80, 25, 'ansi');
    d.feed(bytes(`${CSI}5;20r${CSI}20;1H` + 'a\r\nb\r\n' + `${CSI}r`));
    assert.equal(d.scrollback_len(), 0);
});

test('clear screen keeps its non-blank lines; can be turned off', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}1;1Hfirst${CSI}3;1Hthird${CSI}2J`));
    assert.equal(c.scrollback_len(), 3, 'rows 0..2 (trailing blank rows dropped)');
    c.set_view_offset(3);
    assert.equal(rowText(c, 0), 'first');
    assert.equal(rowText(c, 1), '');
    assert.equal(rowText(c, 2), 'third');
    const d = new Core(80, 25, 'ansi');
    d.set_capture_on_clear(false);
    d.feed(bytes(`${CSI}1;1Hfirst${CSI}2J`));
    assert.equal(d.scrollback_len(), 0);
});

test('scrollback view renders pixel-identical to the live frame it came from', () => {
    const c = new Core(80, 25, 'ansi');
    // 25 full rows (no CRLF after the last), with a Topaz block and iCE colours.
    const screen = `${CSI}0;42 D` + lines(0, 12) + `${CSI}0;0 D${CSI}?33h${CSI}5;44m iCE ${CSI}0m` + lines(12, 25);
    c.feed(bytes(screen.slice(0, -2)));
    c.render(true);
    const before = framePixels(c, memory);
    c.feed(bytes('\r\n' + lines(25, 35).slice(0, -2))); // 10 more lines: 10 scroll off
    assert.equal(c.scrollback_len(), 10);
    assert.equal(c.set_view_offset(10), 10);
    assert.equal(c.render(false), 2);
    const same = a => a.length === before.length && a.every((v, i) => v === before[i]);
    assert.ok(same(framePixels(c, memory)), 'view of 10 lines back equals the frame rendered before they scrolled');

    // Live output while scrolled back keeps the view on the same lines.
    c.feed(bytes('\r\n' + lines(35, 40).slice(0, -2)));
    assert.equal(c.view_offset(), 15);
    assert.equal(c.render(false), 2);
    assert.ok(same(framePixels(c, memory)), 'view did not move');
    assert.equal(c.render(false), 0, 'nothing new to draw');

    c.set_view_offset(0);
    assert.equal(c.render(false), 2, 'back to live: full frame');
});

test('OSC 8 links are tracked per cell, survive scrolling into scrollback, drop on erase', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}1;1Hsee ${ESC}]8;;https://example.com/a${ST}here${ESC}]8;;${ST} and ${ESC}]8;id=x;http://b.example/${ESC}\\b${ESC}]8;;${ST}`));
    const cells = c.row_cells(0);
    const linked = Array.from(cells, v => (v >> 24) & 1).join('');
    assert.equal(linked.slice(0, 15), '000011110000010');
    assert.equal(c.link_at(4, 0), 'https://example.com/a');
    assert.equal(c.link_at(7, 0), 'https://example.com/a');
    assert.equal(c.link_at(8, 0), '');
    assert.equal(c.link_at(13, 0), 'http://b.example/');
    // scroll it into scrollback
    c.feed(bytes(`${CSI}25;1H` + '\r\n'.repeat(3)));
    assert.equal(c.link_at(4, 0), '', 'live row 0 no longer holds the link');
    c.set_view_offset(c.scrollback_len());
    assert.equal(c.link_at(5, 0), 'https://example.com/a', 'link kept in scrollback');
    c.set_view_offset(0);
    // erase drops links
    c.feed(bytes(`${CSI}2;1H${ESC}]8;;https://e.example/${ST}xx${ESC}]8;;${ST}`));
    assert.equal(c.link_at(0, 1), 'https://e.example/');
    c.feed(bytes(`${CSI}2;1H${CSI}2K`));
    assert.equal(c.link_at(0, 1), '');
});

test('panic message is kept for the shell', async () => {
    // A separate instance: a trap leaves the module unusable.
    const { Core: C2, glue } = await loadCore({ fresh: true });
    const d = new C2(80, 25, 'ansi');
    d.debug_passthrough_sync(true);
    const origError = console.error;
    console.error = () => {};
    try {
        assert.throws(() => d.feed(bytes(`${CSI}?2026h`)), /unreachable/);
    } finally {
        console.error = origError;
    }
    assert.match(glue.last_panic(), /time not implemented/);
});

// --- Phase 1: host-reachable panics found by the audit and the fuzzer --------

test('host-reachable panic paths are guarded (each on a fresh instance)', async () => {
    const font = n => Buffer.alloc(n, 0x55).toString('base64');
    const psf1 = h => {
        const b = Buffer.alloc(4 + 256 * h, 0x0f);
        b.set([0x36, 0x04, 0, h]);
        return b.toString('base64');
    };
    const cases = {
        'scroll left after clear (CSI SP @)': `${CSI}2J${CSI} @`,
        'scroll right after clear (CSI SP A)': `${CSI}2J${CSI} A`,
        'scroll left on a short inserted line': `${CSI}LX${CSI} @`,
        'scroll left after XTWINOPS widen': `${CSI}8;25;132t${CSI} @${CSI} A`,
        'scroll left with margins past the screen': `${CSI}1;9999r${CSI} @`,
        'DCS font into slot 0, 0 rows high': `${ESC}PCTerm:Font:0:${font(65536)}${ST}`,
        'DCS font into slot 0, 40 rows high': `${ESC}PCTerm:Font:0:${psf1(40)}${ST}`,
        'DCS 40-row font into 46, selected': `${ESC}PCTerm:Font:46:${psf1(40)}${ST}${CSI}0;46 DX`,
    };
    for (const [name, seq] of Object.entries(cases)) {
        const { Core: C } = await loadCore({ fresh: true });
        const c = new C(80, 25, 'ansi');
        c.feed(bytes(seq));
        c.render(true);
        c.feed(bytes('ok\r\n'));
        assert.ok(c.render(false) >= 0, name);
    }
    {
        // Found by the fuzzer: left/right margins outliving a smaller resize.
        const { Core: C } = await loadCore({ fresh: true });
        const d = new C(80, 25, 'ansi');
        d.feed(bytes(`${CSI}?69h${CSI}5;140s`));
        d.resize(24, 10);
        d.feed(bytes(`${CSI} @${CSI} A${CSI}2J${CSI} @`));
        d.render(true);
    }
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${ESC}PCTerm:Font:0:${font(4096)}${ST}`));
    assert.equal(events(c).find(e => e.t === 'fontload').ok, false, 'slots below 46 are refused');
});

test('huge repeat counts are clamped to the screen', () => {
    const c = new Core(80, 25, 'ansi');
    const t = Date.now();
    c.feed(bytes(`${CSI}65535S${CSI}65535T${CSI}65535@${CSI}65535P${CSI}65535L${CSI}65535M`));
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test('fuzz smoke: 400 fixed-seed cases without a trap', async () => {
    const { fuzz } = await import('./fuzz-core.mjs');
    const res = await fuzz({ seconds: 60, seed: 4242, cases: 400 });
    assert.equal(res.cases, 400);
    assert.deepEqual(res.traps.map(t => t.message), []);
});

test('golden engine frames match test/goldens.json', async () => {
    const { computeGoldens, GOLDEN_FILE } = await import('./goldens.mjs');
    const fs = await import('node:fs');
    const want = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
    assert.deepEqual(await computeGoldens(), want, 'engine output changed: check screenshots, then node test/goldens.mjs --write');
});

test('CSI ? 33 h: blink becomes a bright background (CTDA 2)', () => {
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(`${CSI}?33h${CSI}1;1H${CSI}5;41m `));
    c.render(true);
    const px = framePixels(c, memory);
    assert.deepEqual([px[0], px[1], px[2]], [0xff, 0x55, 0x55]);
});

test('fast line-moving scroll matches the engine cell-by-cell scroll (fuzzed)', async () => {
    const { fuzzCase } = await import('./fuzz-core.mjs');
    const fast = new Core(80, 25, 'ansi');
    const slow = new Core(80, 25, 'ansi');
    slow.debug_slow_scroll(true);
    const quiet = console.error;
    console.error = () => {};
    try {
        for (let i = 0; i < 300; i++) {
            const parts = fuzzCase(9000 + i);
            for (const p of parts) {
                fast.feed(bytes(p));
                slow.feed(bytes(p));
            }
            fast.feed(bytes('\r\nscroll\r\n\r\n'));
            slow.feed(bytes('\r\nscroll\r\n\r\n'));
            assert.equal(fast.rows(), slow.rows());
            for (let y = 0; y < fast.rows(); y++) assert.deepEqual(fast.row_cells(y), slow.row_cells(y), `case ${i} row ${y}`);
            if (i % 30 === 0) {
                fast.render(true);
                const a = framePixels(fast, memory);
                slow.render(true);
                const b = framePixels(slow, memory);
                assert.ok(a.length === b.length && a.every((v, k) => v === b[k]), `case ${i}: frames differ`);
            }
        }
    } finally {
        console.error = quiet;
    }
    assert.equal(fast.scrollback_len(), slow.scrollback_len());
});

test('nested CTerm macros expand within a budget per top-level invocation (patch 0002)', () => {
    const hex = s => [...s].map(ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    // Macro 3 prints "x"; macros 2, 1 and 0 each run the next one 255 times: 16.6 million "x"s from about 110 bytes.
    let p = `${ESC}P3;0;1!z${hex('x')}${ST}`;
    for (let d = 2; d >= 0; d--) p += `${ESC}P${d};0;1!z!255;${hex(`${ESC}[${d + 1}*z`)};${ST}`;
    const c = new Core(80, 25, 'ansi');
    c.feed(bytes(p));
    const t = performance.now();
    c.feed(bytes(`${CSI}0*z`));
    // (About 0.2 s alone; the limit leaves room for a busy machine. Without the budget this never returns.)
    assert.ok(performance.now() - t < 10000, `${(performance.now() - t).toFixed(0)} ms`);
    // The budget is per invocation: a small nested macro still expands in full afterwards.
    c.feed(bytes(`${ESC}P4;0;1!z!3;${hex(`${ESC}[3*z`)};${ST}${CSI}H${CSI}2J${CSI}4*z`));
    assert.equal(c.cursor_x(), 3);
});

test('decoded sixel images on a screen stay within a budget (oldest evicted)', async () => {
    const { Core: Fresh, memory: mem } = await loadCore({ fresh: true });
    const c = new Fresh(80, 25, 'ansi');
    // 4000 x 1200 pixels, 19.2 MB of RGBA each, from about 1.6 KB of sixel.
    const one = `${ESC}Pq#0!4000~${'-!4000~'.repeat(199)}${ST}`;
    c.feed(bytes(`${CSI}H${one}`));
    const before = mem.buffer.byteLength;
    for (let i = 1; i < 20; i++) c.feed(bytes(`${CSI}${(i % 20) + 1};${(i % 70) + 1}H${one}`));
    const grew = (mem.buffer.byteLength - before) / 2 ** 20;
    assert.ok(grew < 160, `WASM memory grew ${grew.toFixed(0)} MB for 20 images of 19.2 MB`);
});

test('a screen keeps at most 4096 sixel images, however small (the list is scanned for every new one)', () => {
    const c = new Core(80, 25, 'ansi');
    // 6000 images of 1 to 3 pixels: at one cell a narrower image does not cover the wider one before it,
    // so nothing is dropped as shadowed. 6000 x 4 bytes of pixels is far under the byte budget.
    const parts = [];
    for (let w = 3; w >= 1; w--) for (let y = 1; y <= 25; y++) for (let x = 1; x <= 80; x++) parts.push(`${CSI}${y};${x}H${ESC}Pq#0!${w}~${ST}`);
    const t = performance.now();
    for (let i = 0; i < parts.length; i += 500) c.feed(bytes(parts.slice(i, i + 500).join('')));
    assert.equal(c.sixel_count(), 4096);
    assert.ok(performance.now() - t < 5000, `${(performance.now() - t).toFixed(0)} ms`);
});

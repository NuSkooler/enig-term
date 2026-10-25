// Engine-only measurements in Node (no browser, no GPU): raster cost, partial
// renders, feed throughput, and icy_engine's scrollback memory behaviour.
// Run: node test/bench-core.mjs   (ENIG_TERM_WASM_DIR=<dir> to test another build)
import fs from 'node:fs';
import path from 'node:path';
import { loadCore, bytes, CSI } from './core-harness.mjs';

const { Core, memory } = await loadCore();
const MB = () => memory.buffer.byteLength / 1048576;

/** Run fn repeatedly for ~ms milliseconds, 3 times; median per-call microseconds. */
function time(fn, ms = 400) {
    const runs = [];
    for (let r = 0; r < 3; r++) {
        let n = 0;
        const a = performance.now();
        while (performance.now() - a < ms) {
            fn(n++);
        }
        runs.push(((performance.now() - a) * 1000) / n);
    }
    return runs.sort((x, y) => x - y)[1];
}

const out = {};
const card = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'cp437-testcard.ans')));
{
    const c = new Core(80, 25, 'ansi');
    c.feed(card);
    out.fullRender640x400_us = time(() => c.render(true));
    out.oneCharRender_us = time(i => {
        c.feed(bytes(`${CSI}12;${(i % 70) + 1}HZ`));
        c.render(false);
    });
    out.noChangeRender_us = time(() => c.render(false));
    c.free();
}
{
    const c = new Core(80, 25, 'ansi');
    const rows = Array.from({ length: 24 }, (_, i) => `${CSI}${i + 1};1H${CSI}1;3${i % 8}m` + 'x'.repeat(70)).join('');
    const b = bytes(rows);
    out.feedNoScroll_MBs = b.length / time(() => c.feed(b));
    out.feedTestCard_MBs = card.length / time(() => c.feed(card));
    c.free();
}
for (const limit of [0, 2000]) {
    const c = new Core(80, 25, 'ansi');
    c.set_scrollback_limit(limit);
    const line = bytes('line of text, the quick brown fox jumps over the lazy dog\r\n');
    const m0 = MB();
    out[`scrollLine_limit${limit}_us`] = time(() => c.feed(line), 300);
    for (let i = 0; i < 2100; i++) c.feed(line);
    out[`memAfter2100ScrolledLines_limit${limit}_MB`] = Math.round(MB() - m0);
    const m1 = MB();
    const clr = bytes(`${CSI}2J${CSI}1;1Hmenu`);
    out[`clearScreen_limit${limit}_us`] = time(() => c.feed(clr), 300);
    for (let i = 0; i < 200; i++) c.feed(clr);
    out[`memAfter200Clears_limit${limit}_MB`] = Math.round(MB() - m1);
    c.free();
}
out.wasmMemoryNow_MB = Math.round(MB());
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(40), typeof v === 'number' ? Number(v.toFixed(2)) : v);

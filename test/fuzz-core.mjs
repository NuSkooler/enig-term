// Feed fuzzer for the WASM core: random bytes, random escape sequences and
// mutated fixtures, with renders, resizes and scrollback views mixed in.
// A trap (panic) or a slow case is recorded with the input that caused it.
//
//   node test/fuzz-core.mjs [seconds=30] [seed]
//
// Exits non-zero if any case trapped. The unit tests run a short fixed-seed pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCore, bytes, ESC, CSI, ST } from './core-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = ['cp437-testcard.ans', 'sauce-ice-9px.ans', 'amiga-topaz-latin1.ans'].map(f => fs.readFileSync(path.join(here, 'fixtures', f)));

/** Small deterministic PRNG (mulberry32). */
export function rng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = n => Math.floor(next() * n);
    const pick = arr => arr[int(arr.length)];
    return { next, int, pick };
}

const NUMS = [0, 1, 2, 3, 5, 7, 24, 25, 26, 42, 43, 45, 46, 79, 80, 81, 99, 132, 255, 256, 999, 9999, 32767, 65535, 65536, 99999999];

function param(r) {
    return r.next() < 0.7 ? String(r.pick(NUMS)) : String(r.int(300));
}

function csi(r) {
    const priv = r.next() < 0.35 ? r.pick(['?', '=', '<', '>']) : '';
    const n = r.int(5);
    const ps = Array.from({ length: n }, () => (r.next() < 0.1 ? '' : param(r))).join(r.next() < 0.05 ? ':' : ';');
    const inter = r.next() < 0.2 ? r.pick([' ', '!', '"', '$', "'", '*', '#', '+']) : '';
    const fin = String.fromCharCode(0x40 + r.int(0x3f));
    return CSI + priv + ps + inter + fin;
}

function str(r, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(r.next() < 0.8 ? 0x20 + r.int(0x5f) : r.int(256));
    return s;
}

function b64(r, n) {
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = r.int(256);
    return Buffer.from(raw).toString('base64');
}

const MUSIC = 'aAbBcCdDeEfFgGlLmMnNoOpPsStT0123456789.-+#<> ';

/** CTerm "ANSI" music: the three introducers, modes, good and bad strings. */
export function music(r) {
    const intro = r.pick([`${CSI}|`, `${CSI}N`, `${CSI}M`, `${CSI}${r.int(3)}|`, `${CSI}=${r.pick([0, 1, 2, 3, 99])}M`]);
    let body = '';
    const n = r.pick([0, 1, 5, 20, 200, 1500]);
    for (let i = 0; i < n; i++) body += r.next() < 0.97 ? MUSIC[r.int(MUSIC.length)] : String.fromCharCode(r.int(256));
    return intro + body + r.pick(['\x0e', '\x0e', '', ESC]);
}

/** CTerm audio APC strings, valid-looking and mutated. */
export function audioApc(r) {
    const k = r.int(12);
    const n = () => String(r.pick(NUMS));
    const body = [
        () => `SyncTERM:A;Queue;C=${n()};S=${n()}${r.next() < 0.5 ? ';I=' + n() : ''}${r.next() < 0.3 ? ';X' : ''}${r.next() < 0.3 ? ';L' : ''}${r.next() < 0.3 ? ';V=' + n() : ''}`,
        () => `SyncTERM:A;Synth;S=${n()};W=${r.pick(['SIN', 'SQ', 'SINE_HARM', 'X', ''])};F=${n()};T=${n()}${r.pick(['', 'ms', 'f', 'p', 'zz'])}`,
        () => `SyncTERM:A;Load;S=${n()};${r.pick(['a', '../x', 'sfx/hit', str(r, 10)])}`,
        () => `SyncTERM:A;LoadBlob;S=${n()};${b64(r, r.pick([0, 4, 100, 3000]))}`,
        () => `SyncTERM:A;Flush;C=${n()}${r.next() < 0.5 ? ';O=' + n() : ''}`,
        () => `SyncTERM:A;Volume;C=${n()};${r.pick(['V', 'VL', 'VR'])}=${r.pick([n(), '-6dB', 'x'])};T=${n()}`,
        () => `SyncTERM:A;${r.pick(['Wait', 'Update', 'Copy'])};C=${n()};S=${n()};D=${n()}`,
        () => `SyncTERM:C;S;${r.pick(['sfx/a', 'b', '', '/x'])};${b64(r, r.pick([0, 10, 5000, 70000]))}`,
        () => `SyncTERM:C;L${r.pick(['', ';*', ';sfx/*', ';[', ';' + str(r, 8)])}`,
        () => `SyncTERM:Q;${r.pick(['libsndfile', 'libsndfileFormat;32;96', 'libsndfileFormat;0x;', 'JXL', str(r, 10)])}`,
        () => `SyncTERM:${r.pick(['A', 'C', 'Q'])};${str(r, r.int(80))}`,
        () => `SyncTERM:A;Queue;${str(r, 30)}`,
    ][k]();
    if (r.next() < 0.2) return `${CSI}=7${r.next() < 0.5 ? ';' + n() : ''}${r.next() < 0.2 ? ';' + n() : ''}n`;
    return `${ESC}_${body}${r.pick([ST, ST, ST, '', ESC + 'x'])}`;
}

function token(r) {
    const k = r.int(100);
    if (k < 30) return csi(r);
    if (k < 45) return str(r, 1 + r.int(40));
    if (k < 50) return r.pick(['\r', '\n', '\r\n', '\b', '\t', '\x07', '\x0c', '\x7f', ESC + 'M', ESC + 'D', ESC + 'E', ESC + 'c', ESC + '7', ESC + '8']);
    if (k < 56) return `${ESC}]${r.pick(['0', '2', '4', '8', '104', '1337', ''])};${r.next() < 0.5 ? `;https://x.example/${str(r, r.int(20))}` : str(r, r.int(60))}${r.pick([ST, '\x07', ''])}`;
    if (k < 60) return `${ESC}P${r.pick(['CTerm:Font:' + r.pick(NUMS) + ':' + b64(r, r.pick([0, 1, 256, 2048, 4096, 8192, 4100])), '0;0;0q' + str(r, 30), r.int(64) + ';0;0!z' + str(r, 20), str(r, 20)])}${r.pick([ST, ''])}`;
    if (k < 63) return `${ESC}_${r.pick(['SyncTERM:C;DrawPPMBlob;', 'SyncTERM:A;', 'SyncTERM:C;S;', ''])}${str(r, r.int(40))}${r.pick([ST, ''])}`;
    if (k < 66) return `${CSI}${r.int(64)}*z`;
    if (k < 70) return `${CSI}${r.pick(['0', '1'])};${r.int(50)} D`;
    if (k < 75) return music(r);
    if (k < 80) return audioApc(r);
    if (k < 90) {
        const f = r.pick(FIXTURES);
        const a = r.int(f.length);
        return String.fromCharCode(...f.subarray(a, Math.min(f.length, a + 1 + r.int(400))));
    }
    return String.fromCharCode(...Array.from({ length: 1 + r.int(32) }, () => r.int(256)));
}

/** The tokens of the case with this seed (for tests that replay fuzz input elsewhere). */
export function fuzzCase(seed) {
    return makeCase(rng(seed >>> 0));
}

function makeCase(r) {
    const parts = [];
    const n = 1 + r.int(40);
    for (let i = 0; i < n; i++) parts.push(token(r));
    return parts;
}

/**
 * Run the fuzzer. Returns { cases, traps: [{seed, message, input}], slow: [...] }.
 * `seconds` bounds the time; `cases` bounds the count (whichever comes first).
 */
export async function fuzz({ seconds = 30, seed = Date.now() & 0xffffffff, cases = Infinity, log = () => {} } = {}) {
    const traps = [];
    const slow = [];
    let mod = await loadCore({ fresh: true });
    let core = new mod.Core(80, 25, 'ansi');
    core.set_scrollback_lines?.(200);
    const end = Date.now() + seconds * 1000;
    // FUZZ_TRACE_CASE=n logs per-token feed times of case n (to pin down a slow case).
    const traceCase = process.env.FUZZ_TRACE_CASE ? Number(process.env.FUZZ_TRACE_CASE) : -1;
    let done = 0;
    const quiet = console.error;
    console.error = () => {};
    try {
        for (; done < cases && Date.now() < end; done++) {
            const caseSeed = (seed + done * 0x9e3779b1) >>> 0;
            const r = rng(caseSeed);
            const parts = makeCase(r);
            const t0 = Date.now();
            let step = '';
            try {
                for (const p of parts) {
                    step = 'feed';
                    const tf = Date.now();
                    // The core stops after music and A;Wait: feed the rest, as the shell does.
                    for (let b = bytes(p); ; ) {
                        core.feed(b);
                        core.take_events();
                        while (core.take_apc?.() !== undefined);
                        const fed = core.fed?.() ?? b.length;
                        if (fed >= b.length) break;
                        b = b.subarray(fed);
                    }
                    if (traceCase === done) log(`trace case ${done}: ${Date.now() - tf} ms feed ${JSON.stringify(p).slice(0, 300)}`);
                    const k = r.int(100);
                    if (k < 25) {
                        step = 'render';
                        core.render(r.next() < 0.1);
                    } else if (k < 28) {
                        step = 'resize';
                        core.resize(1 + r.int(160), 1 + r.int(60));
                    } else if (k < 33) {
                        step = 'view';
                        core.set_view_offset?.(r.int(300));
                        core.render(false);
                        core.row_cells?.(r.int(core.rows()));
                        core.link_at?.(r.int(core.cols()), r.int(core.rows()));
                    } else if (k < 35) {
                        step = 'view0';
                        core.set_view_offset?.(0);
                    }
                }
                step = 'final render';
                core.render(false);
                core.render(true);
            } catch (e) {
                const message = `${step}: ${e}: ${mod.glue.last_panic?.() ?? ''}`;
                traps.push({ seed: caseSeed, message, input: parts });
                log(`TRAP seed=${caseSeed} ${message.slice(0, 300)}`);
                mod = await loadCore({ fresh: true });
                core = new mod.Core(80, 25, 'ansi');
                core.set_scrollback_lines?.(200);
                continue;
            }
            const ms = Date.now() - t0;
            if (ms > 500) {
                slow.push({ seed: caseSeed, ms, input: parts });
                log(`SLOW seed=${caseSeed} ${ms} ms`);
            }
            if (done % 50 === 49) {
                // Start from a clean terminal now and then, as a new session would.
                core.reset();
                core.resize(80, 25);
            }
        }
    } finally {
        console.error = quiet;
    }
    return { cases: done, traps, slow };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const seconds = Number(process.argv[2] ?? 30);
    const seed = process.argv[3] !== undefined ? Number(process.argv[3]) : (Date.now() & 0xffffffff) >>> 0;
    console.log(`fuzz: ${seconds}s, seed ${seed}`);
    const res = await fuzz({ seconds, seed, log: m => console.log(m) });
    console.log(`fuzz: ${res.cases} cases, ${res.traps.length} traps, ${res.slow.length} slow`);
    const groups = new Map();
    for (const t of res.traps) {
        const key = (t.message.match(/panicked at ([^\n]*?:\d+)/) ?? [, t.message.slice(0, 80)])[1];
        if (!groups.has(key)) groups.set(key, t);
    }
    for (const [key, t] of groups) console.log(`  ${key}\n    seed ${t.seed}: ${JSON.stringify(t.input).slice(0, 400)}`);
    if (process.env.FUZZ_OUT) fs.writeFileSync(process.env.FUZZ_OUT, JSON.stringify(res, null, 1));
    process.exit(res.traps.length ? 1 : 0);
}

// Audio in the browser.
//
// 1. Rendering: the real engine (dist/enig-term-audio.js) on an
//    OfflineAudioContext with a scripted clock, so what CTerm commands
//    produce can be measured: level, pitch (Goertzel), timing, fade shapes,
//    crossfade overlap, loop ends, Flush with a fade, Volume ramps, pan,
//    "ANSI" music.
// 2. Formats: every libsndfile format the terminal claims in its format
//    query decodes here (natively, or with the bundled Ogg decoders), and
//    the Ogg decoders work in every browser when forced.
// 3. The shell: autoplay lock and the "enable sound" prompt, mute and volume
//    (persisted), A;Wait and foreground music holding the stream, the cache
//    in IndexedDB, the font notices (Phase 2 follow-up).
// The ansi-bbs-utils interop over a real WebSocket is audio-interop.spec.ts.
import { test, expect, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { open, write, CSI, ESC, ST, SHOTS, rowText } from './helpers';

const APC = ESC + '_';
const SO = String.fromCharCode(0x0e);

/** Run `steps` (in the page) against an engine on an OfflineAudioContext; returns the analysis. */
async function offline(page: Page, seconds: number, steps: string, probes: string) {
    return page.evaluate(
        async ({ seconds, steps, probes }) => {
            const m = await import('/enig-term-audio.js' as string);
            const rate = 48000;
            const ctx = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
            const clock = { t: 0 };
            const host = { reply: (_s: string) => {}, log: (_s: string) => {}, board: () => 'test' };
            const e = new m.AudioEngine(host, { maxFile: 1 << 24, cacheBytes: 1 << 26, memoryBytes: 1 << 28, decodeMs: 5000, musicTone: 'sine', clock: () => clock.t }, m.browserDeps(ctx, { clock: () => clock.t }));
            const enc = new TextEncoder();
            const apc = (s: string) => e.run({ kind: 'apc', body: enc.encode('SyncTERM:' + s) });
            const at = (t: number) => (clock.t = t);
            await new Function('apc', 'at', 'e', `return (async () => { ${steps} })()`)(apc, at, e);
            const buf = await ctx.startRendering();
            const L = buf.getChannelData(0);
            const R = buf.getChannelData(1);
            const win = (ch: Float32Array, a: number, b: number) => ch.subarray(Math.floor(a * rate), Math.floor(b * rate));
            const rms = (a: number, b: number, ch = L) => {
                const w = win(ch, a, b);
                let s = 0;
                for (const v of w) s += v * v;
                return Math.sqrt(s / Math.max(1, w.length));
            };
            // Goertzel magnitude of `f` in [a, b], scaled to a sine's amplitude.
            const tone = (f: number, a: number, b: number, ch = L) => {
                const w = win(ch, a, b);
                const k = (2 * Math.PI * f) / rate;
                let s1 = 0;
                let s2 = 0;
                for (const v of w) {
                    const s0 = v + 2 * Math.cos(k) * s1 - s2;
                    s2 = s1;
                    s1 = s0;
                }
                return (2 * Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(k) * s1 * s2)) / w.length;
            };
            // First time (s) after `from` where tone f exceeds `thr` in 5 ms windows.
            const onset = (f: number, from: number, thr: number) => {
                for (let t = from; t < seconds - 0.005; t += 0.001) if (tone(f, t, t + 0.005) > thr) return t;
                return -1;
            };
            const series = (fn: (a: number, b: number) => number, a: number, b: number, step: number) => {
                const out: number[] = [];
                for (let t = a; t + step <= b + 1e-9; t += step) out.push(fn(t, t + step));
                return out;
            };
            return new Function('rms', 'tone', 'onset', 'series', 'L', 'R', 'e', `return (${probes})`)(rms, tone, onset, series, L, R, e);
        },
        { seconds, steps, probes },
    );
}

const FULL = 0.251; // a full-scale sine on a channel at its default -12 dB
const near = (v: number, want: number, tol: number) => expect(Math.abs(v - want), `${v} vs ${want}`).toBeLessThanOrEqual(tol);
const increasing = (xs: number[], slack = 0.002) => xs.every((v, i) => i === 0 || v >= xs[i - 1] - slack);
const decreasing = (xs: number[], slack = 0.002) => xs.every((v, i) => i === 0 || v <= xs[i - 1] + slack);

test.describe('rendering (OfflineAudioContext)', () => {
    test.beforeEach(async ({ page }) => open(page));

    test('Synth + Queue: level, pitch, start and end', async ({ page }) => {
        const r = await offline(
            page,
            1.5,
            `at(0); await apc('A;Synth;S=1;W=SIN;F=440;T=1000'); await apc('A;Queue;C=2;S=1');`,
            `{ on: tone(440, 0.1, 0.9), other: tone(660, 0.1, 0.9), after: rms(1.02, 1.5), start: onset(440, 0, 0.05), end: rms(0.95, 0.99) }`,
        );
        near(r.on, FULL, 0.01);
        expect(r.other).toBeLessThan(0.005);
        expect(r.after).toBeLessThan(0.001);
        expect(r.start).toBeLessThan(0.01);
        expect(r.end).toBeGreaterThan(0.1);
    });

    test('I= fades in and O= fades out, both monotonic', async ({ page }) => {
        const r = await offline(
            page,
            1.2,
            `at(0); await apc('A;Synth;S=1;W=SIN;F=440;T=1000'); await apc('A;Queue;C=2;S=1;I=500;O=300');`,
            `{ rise: series((a, b) => tone(440, a, b), 0, 0.5, 0.05), flat: tone(440, 0.55, 0.65), fall: series((a, b) => tone(440, a, b), 0.7, 1.0, 0.05) }`,
        );
        expect(increasing(r.rise), JSON.stringify(r.rise)).toBe(true);
        expect(r.rise[0]).toBeLessThan(0.05);
        near(r.flat, FULL, 0.01);
        expect(decreasing(r.fall), JSON.stringify(r.fall)).toBe(true);
        expect(r.fall[r.fall.length - 1]).toBeLessThan(0.06);
    });

    test('X crossfades: the old buffer decays while the new one rises, both audible in the overlap', async ({ page }) => {
        const r = await offline(
            page,
            3,
            `at(0); await apc('A;Synth;S=1;W=SIN;F=440;T=4000'); await apc('A;Queue;C=2;S=1;L');
             at(1); await apc('A;Synth;S=2;W=SIN;F=660;T=4000'); await apc('A;Queue;C=2;S=2;I=1000;X;L');`,
            `{ before: tone(440, 0.5, 0.95), a: series((x, y) => tone(440, x, y), 1, 2, 0.1), b: series((x, y) => tone(660, x, y), 1, 2, 0.1),
               mid440: tone(440, 1.45, 1.55), mid660: tone(660, 1.45, 1.55), after440: tone(440, 2.05, 2.9), after660: tone(660, 2.05, 2.9) }`,
        );
        near(r.before, FULL, 0.01);
        expect(decreasing(r.a), JSON.stringify(r.a)).toBe(true);
        expect(increasing(r.b), JSON.stringify(r.b)).toBe(true);
        // Equal power: each about 0.707 of full at the midpoint.
        near(r.mid440, FULL * Math.SQRT1_2, 0.03);
        near(r.mid660, FULL * Math.SQRT1_2, 0.03);
        expect(r.after440).toBeLessThan(0.003);
        near(r.after660, FULL, 0.01);
    });

    test('a plain Queue behind a loop ends it at the pass boundary and follows gaplessly', async ({ page }) => {
        const r = await offline(
            page,
            1.2,
            `at(0); await apc('A;Synth;S=1;W=SIN;F=440;T=300'); await apc('A;Queue;C=2;S=1;L');
             at(0.45); await apc('A;Synth;S=2;W=SIN;F=660;T=300'); await apc('A;Queue;C=2;S=2');`,
            `{ second: tone(440, 0.32, 0.58), onset: onset(660, 0.45, 0.08), tail440: tone(440, 0.62, 0.88), b: tone(660, 0.62, 0.88), after: rms(0.92, 1.2) }`,
        );
        near(r.second, FULL, 0.02);
        near(r.onset, 0.6, 0.006);
        expect(r.tail440).toBeLessThan(0.005);
        near(r.b, FULL, 0.02);
        expect(r.after).toBeLessThan(0.001);
    });

    test('Flush with O= fades what is playing, then silence; without O= at once', async ({ page }) => {
        const r = await offline(
            page,
            2,
            `at(0); await apc('A;Synth;S=1;W=SIN;F=440;T=4000'); await apc('A;Queue;C=2;S=1;L');
             await apc('A;Synth;S=2;W=SIN;F=660;T=4000'); await apc('A;Queue;C=3;S=2;L');
             at(1); await apc('A;Flush;C=2;O=500'); await apc('A;Flush;C=3');`,
            // (two full-scale tones together: the soft clip takes a few per cent off each)
            `{ fall: series((a, b) => tone(440, a, b), 1, 1.5, 0.05), after: tone(440, 1.55, 2), cut: tone(660, 1.01, 1.5), before: tone(660, 0.5, 0.99) }`,
        );
        expect(decreasing(r.fall), JSON.stringify(r.fall)).toBe(true);
        expect(r.fall[0]).toBeGreaterThan(0.2);
        expect(r.after).toBeLessThan(0.002);
        near(r.before, FULL, 0.02);
        expect(r.cut).toBeLessThan(0.003);
    });

    test('Volume T= ramps dB-linearly from the current level; a side not given stays', async ({ page }) => {
        const r = await offline(
            page,
            2.2,
            `at(0); await apc('A;Synth;S=1;W=SIN;F=440;T=4000'); await apc('A;Queue;C=2;S=1;L');
             at(0.5); await apc('A;Volume;C=2;V=-36dB;T=1000');
             at(1.7); await apc('A;Volume;C=2;VR=-20dB');`,
            `{ db: series((a, b) => 20 * Math.log10(tone(440, a, b)), 0.5, 1.5, 0.1), end: tone(440, 1.55, 1.65), l: tone(440, 1.8, 2.1, L), r: tone(440, 1.8, 2.1, R) }`,
        );
        // dB-linear: equal steps of 2.4 dB per 100 ms from -12 to -36.
        const steps = r.db.slice(1).map((v: number, i: number) => v - r.db[i]);
        for (const s of steps) near(s, -2.4, 0.1);
        near(20 * Math.log10(r.end), -36, 0.2);
        near(20 * Math.log10(r.l), -36, 0.2);
        near(20 * Math.log10(r.r), -20, 0.2);
    });

    test('pan with VL/VR, and Queue V= adds to the channel base', async ({ page }) => {
        const r = await offline(
            page,
            1.2,
            `at(0); await apc('A;Synth;S=2;W=SIN;F=660;T=500'); await apc('A;Queue;C=3;S=2;VL=100;VR=0');
             at(0.6); await apc('A;Synth;S=3;W=SIN;F=880;T=500'); await apc('A;Queue;C=4;S=3;V=50');`,
            `{ panL: tone(660, 0.1, 0.4, L), panR: tone(660, 0.1, 0.4, R), half: tone(880, 0.7, 1.0) }`,
        );
        near(r.panL, FULL, 0.005);
        near(20 * Math.log10(r.panR), -12 - 60, 1); // 0 is the -60 dB floor
        near(r.half, FULL / 2, 0.005);
    });

    test('"ANSI" music: CTerm note numbers, lengths and articulation', async ({ page }) => {
        // A (33) 438 + 62 ms, then A an octave up (45), legato 250 ms
        const r = await offline(
            page,
            1.0,
            `at(0); await e.run({ kind: 'music', notes: [33, 438, 62, 45, 250, 0], fg: false, audible: true });`,
            `{ a: tone(440, 0.05, 0.4), gap: rms(0.445, 0.495), b: tone(880, 0.52, 0.72), bOnset: onset(880, 0.4, 0.05), after: rms(0.76, 1) }`,
        );
        expect(r.a).toBeGreaterThan(0.15);
        expect(r.gap).toBeLessThan(0.001);
        expect(r.b).toBeGreaterThan(0.15);
        near(r.bOnset, 0.5, 0.006);
        expect(r.after).toBeLessThan(0.001);
    });

    test('silent while nothing plays, and the soft clip keeps a loud sum below full scale', async ({ page }) => {
        const r = await offline(
            page,
            1,
            `at(0); for (let c = 2; c < 10; c++) { await apc('A;Synth;S=' + c + ';W=SQ;F=' + (200 + c * 50) + ';T=800'); await apc('A;Queue;C=' + c + ';S=' + c + ';V=+12dB'); await apc('A;Volume;C=' + c + ';V=100'); }`,
            `{ peak: Math.max(...Array.from(L).map(Math.abs)), tail: rms(0.85, 1) }`,
        );
        expect(r.peak).toBeLessThanOrEqual(1);
        expect(r.peak).toBeGreaterThan(0.9);
        expect(r.tail).toBe(0);
    });
});

// --- formats -------------------------------------------------------------------------

const FIXTURES: [string, string][] = [
    ['wav-u8.wav', '1;5'],
    ['wav-16.wav', '1;2'],
    ['wav-24.wav', '1;3'],
    ['wav-32.wav', '1;4'],
    ['wav-float.wav', '1;6'],
    ['flac-16.flac', '23;2'],
    ['flac-24.flac', '23;3'],
    ['vorbis.ogg', '32;96'],
    ['opus.opus', '32;100'],
    ['mp3.mp3', '35;130'],
];

async function decodeAll(page: Page, fallback: boolean) {
    return page.evaluate(
        async ({ files, fallback }) => {
            const m = await import('/enig-term-audio.js' as string);
            const ctx = new OfflineAudioContext(1, 48000, 48000);
            const e = new m.AudioEngine({ reply() {}, log() {}, board: () => 't' }, { maxFile: 1 << 24, cacheBytes: 1 << 24, memoryBytes: 1 << 28, decodeMs: 10000, musicTone: 'square', forceFallback: fallback, clock: () => 0 }, m.browserDeps(ctx, { clock: () => 0 }));
            const out: Record<string, { claimed: boolean; ok: boolean; seconds?: number; purity?: number; fallback?: boolean }> = {};
            for (const [f, pair] of files) {
                const bytes = new Uint8Array(await (await fetch('/fixtures/audio/' + f)).arrayBuffer());
                const before = e.stats.fallbackDecodes;
                const b = await e.decode(bytes);
                const [pm, ps] = pair.split(';').map(Number);
                const claimed = await e.formatSupported(pm, ps);
                if (!b) {
                    out[f] = { claimed, ok: false };
                    continue;
                }
                const ab = b.data as AudioBuffer;
                const ch = ab.getChannelData(0);
                // How much of the signal is the 440 Hz tone (Goertzel against RMS; 1 = all of it).
                const k = (2 * Math.PI * 440) / ab.sampleRate;
                let s1 = 0;
                let s2 = 0;
                let e2 = 0;
                for (const v of ch) {
                    const s0 = v + 2 * Math.cos(k) * s1 - s2;
                    s2 = s1;
                    s1 = s0;
                    e2 += v * v;
                }
                const amp = (2 * Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(k) * s1 * s2)) / ch.length;
                const purity = amp / Math.SQRT2 / Math.sqrt(e2 / ch.length);
                out[f] = { claimed, ok: true, seconds: +ab.duration.toFixed(3), purity: +purity.toFixed(3), fallback: e.stats.fallbackDecodes > before };
            }
            return out;
        },
        { files: FIXTURES, fallback },
    );
}

/** One Ogg page (enig-term's reader does not check the CRC, so it is left 0). */
function oggPage(seq: number, granule: number, packets: Buffer[], flags = 0) {
    const lacing: number[] = [];
    for (const p of packets) {
        let n = p.length;
        while (n >= 255) {
            lacing.push(255);
            n -= 255;
        }
        lacing.push(n);
    }
    const h = Buffer.alloc(27 + lacing.length);
    h.write('OggS', 0, 'latin1');
    h[5] = flags;
    h.writeUInt32LE(granule >>> 0, 6);
    h.writeUInt32LE(1, 14);
    h.writeUInt32LE(seq, 18);
    h[26] = lacing.length;
    lacing.forEach((l, i) => (h[27 + i] = l));
    return Buffer.concat([h, ...packets]);
}

/** A long 8-channel Ogg Opus file: 8 uncoupled streams, each the fixture's audio packets over and over. */
function longOpus(fixture: Buffer, packets: number) {
    // The fixture's audio packets (one frame each, under 252 bytes): pages 2 on.
    const audio: Buffer[] = [];
    for (let off = 0, page = 0; off < fixture.length; page++) {
        const nseg = fixture[off + 26];
        let p = off + 27 + nseg;
        for (let i = 0; i < nseg; i++) {
            const len = fixture[off + 27 + i];
            if (page >= 2 && len > 0) audio.push(fixture.subarray(p, p + len));
            p += len;
        }
        off = p;
    }
    const head = Buffer.alloc(29);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1;
    head[9] = 8;
    head.writeUInt32LE(48000, 12);
    head[18] = 255;
    head[19] = 8;
    for (let i = 0; i < 8; i++) head[21 + i] = i;
    const pages = [oggPage(0, 0, [head], 2), oggPage(1, 0, [Buffer.from('OpusTags\0\0\0\0\0\0\0\0', 'latin1')])];
    // Every stream's packet but the last is self-delimited: TOC, length, data.
    const delimited = (a: Buffer) => Buffer.concat([a.subarray(0, 1), Buffer.from([a.length - 1]), a.subarray(1)]);
    for (let i = 0, seq = 2; i < packets; i += 20, seq++) {
        const batch = Array.from({ length: 20 }, (_, k) => {
            const a = audio[(i + k) % audio.length];
            return Buffer.concat([...Array.from({ length: 7 }, () => delimited(a)), a]);
        });
        pages.push(oggPage(seq, 0xffffffff, batch));
    }
    return Buffer.concat(pages);
}

test.describe('formats', () => {
    test.beforeEach(async ({ page }) => open(page));

    test('every format the format query claims decodes (natively or with the Ogg decoders)', async ({ page }, ti) => {
        const r = await decodeAll(page, false);
        fs.writeFileSync(path.join(SHOTS, `${ti.project.name}-audio-formats.json`), JSON.stringify(r, null, 1));
        // What the format query says is what decodes: claimed => decodes a 440 Hz quarter second.
        for (const [f, pair] of FIXTURES) {
            expect(r[f].ok, `${f} (${pair}): query says ${r[f].claimed}, decodes ${JSON.stringify(r[f])}`).toBe(r[f].claimed);
            if (!r[f].claimed) continue;
            near(r[f].seconds!, 0.25, 0.04);
            expect(r[f].purity!, `${f} is the 440 Hz tone`).toBeGreaterThan(0.8);
        }
        // The formats a BBS relies on are there everywhere.
        for (const f of ['wav-16.wav', 'flac-16.flac', 'vorbis.ogg', 'opus.opus', 'mp3.mp3']) expect(r[f].claimed, f).toBe(true);
    });

    test('the bundled Ogg Vorbis and Opus decoders work here when forced', async ({ page }, ti) => {
        const r = await decodeAll(page, true);
        fs.writeFileSync(path.join(SHOTS, `${ti.project.name}-audio-formats-fallback.json`), JSON.stringify(r, null, 1));
        for (const f of ['vorbis.ogg', 'opus.opus']) {
            expect(r[f].ok && r[f].fallback, `${f}: ${JSON.stringify(r[f])}`).toBe(true);
            near(r[f].seconds!, 0.25, 0.01);
            expect(r[f].purity!).toBeGreaterThan(0.9);
        }
        // Only Ogg goes to them: the others still decode natively.
        expect(r['wav-16.wav'].fallback).toBe(false);
    });

    test('the bundled Ogg decoders run in a Worker: the page stays responsive, and a decode past decodeMs is stopped', async ({ page }) => {
        // A few seconds of decoding on one thread (more than 10 s with 15000 packets on a busy Firefox, which then
        // ran into the 20 s limit of the second run): 8 Opus streams of 4000 packets each.
        const file = longOpus(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'audio', 'opus.opus')), 4000).toString('base64');
        const r = await page.evaluate(async b64 => {
            const m = await import('/enig-term-audio.js' as string);
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const ctx = new OfflineAudioContext(1, 48000, 48000);
            const run = async (decodeMs: number) => {
                const e = new m.AudioEngine({ reply() {}, log() {}, board: () => 't' }, { maxFile: 1 << 24, cacheBytes: 1 << 24, memoryBytes: 1 << 28, decodeMs, musicTone: 'square', forceFallback: true, clock: () => 0 }, m.browserDeps(ctx, { clock: () => 0 }));
                // The longest gap between timer ticks is how long the page was blocked.
                let gap = 0;
                let last = performance.now();
                const tick = setInterval(() => {
                    const n = performance.now();
                    gap = Math.max(gap, n - last);
                    last = n;
                }, 20);
                const t = performance.now();
                const buf = await e.decode(bytes);
                const ms = performance.now() - t;
                gap = Math.max(gap, performance.now() - last);
                clearInterval(tick);
                return { ok: !!buf, channels: buf ? (buf.data as AudioBuffer).numberOfChannels : 0, ms, gap, stats: { ...e.stats } };
            };
            return { stopped: await run(300), full: await run(20000) };
        }, file);
        // Stopped at decodeMs, without waiting for the decode and without blocking the page.
        expect(r.stopped.ms, JSON.stringify(r.stopped)).toBeLessThan(1500);
        expect(r.stopped.gap, JSON.stringify(r.stopped)).toBeLessThan(250);
        expect(r.stopped.ok).toBe(false);
        expect(r.stopped.stats.decodeTimeouts).toBe(1);
        // Given time, the same file decodes there (8 channels, the budget's worth).
        expect(r.full.ok && r.full.stats.workerDecodes === 1, JSON.stringify(r.full)).toBe(true);
        expect(r.full.channels).toBe(8);
    });
});

// --- the shell ---------------------------------------------------------------------------

/** Host-bound bytes while not connected, as a string. */
async function capture(page: Page) {
    await page.evaluate(() => {
        const t = (window as any).enigTerm;
        (window as any).sent = '';
        t.onLocalReply = (b: Uint8Array) => ((window as any).sent += String.fromCharCode(...b));
    });
}
const sentText = (page: Page) => page.evaluate(() => (window as any).sent as string);

/** Record the mix (after the soft clip, before volume and mute) in real time. */
async function tap(page: Page) {
    await page.waitForFunction(() => !!(window as any).enigTerm.sound.engine);
    await page.evaluate(() => {
        const e = (window as any).enigTerm.sound.engine;
        const ctx = e.out.ctx as AudioContext;
        const sp = ctx.createScriptProcessor(2048, 2, 2);
        const rec: { t: number; peak: number }[] = [];
        sp.onaudioprocess = ev => {
            const d = ev.inputBuffer.getChannelData(0);
            let p = 0;
            for (const v of d) p = Math.max(p, Math.abs(v));
            rec.push({ t: ev.playbackTime, peak: p });
        };
        e.out.mix.connect(sp);
        sp.connect(ctx.destination);
        (window as any).rec = rec;
        (window as any).recNode = sp;
    });
}
const loudSince = (page: Page, sinceMs: number) =>
    page.evaluate(ms => {
        const rec = (window as any).rec as { t: number; peak: number }[];
        const ctx = (window as any).enigTerm.sound.engine.out.ctx as AudioContext;
        const from = ctx.currentTime - ms / 1000;
        return Math.max(0, ...rec.filter(r => r.t >= from).map(r => r.peak));
    }, sinceMs);

test.describe('shell', () => {
    test('autoplay lock: host state is kept, a prompt asks, a click starts what is still playing', async ({ page }, ti) => {
        await open(page, '&audioLock=1');
        await capture(page);
        await write(page, `${APC}SyncTERM:Q;libsndfile${ST}${APC}SyncTERM:A;Synth;S=1;W=SIN;F=440;T=1500${ST}${APC}SyncTERM:A;Queue;C=2;S=1;L${ST}`);
        await expect(page.locator('[data-soundprompt]')).toBeVisible();
        await expect(page.locator('[data-act="sound"]')).toHaveText('Enable sound');
        expect(await page.evaluate(() => (window as any).enigTerm.sound.state)).toBe('locked');
        // The host sees the channel running although nothing is heard yet.
        await write(page, `${CSI}=7;2n`);
        await expect.poll(() => sentText(page)).toContain(`${CSI}=7;2;1n`);
        expect(await sentText(page)).toContain(`${CSI}=7;100;1n`);
        // "ANSI" music now is skipped and does not hold the stream.
        await write(page, `${CSI}|MFT120L4CDEC${SO}after`);
        expect(await page.evaluate(() => (window as any).enigTerm.holding)).toBe(false);
        expect(await rowText(page, 0)).toBe('after');
        await page.screenshot({ path: `${SHOTS}/${ti.project.name}-sound-prompt.png` });
        await tap(page);
        await page.locator('[data-act="sound-enable"]').click();
        await expect(page.locator('[data-soundprompt]')).toBeHidden();
        await expect.poll(() => page.evaluate(() => (window as any).enigTerm.sound.state)).toBe('on');
        await expect.poll(() => loudSince(page, 300), { timeout: 5000 }).toBeGreaterThan(0.1);
    });

    test('mute and volume: toolbar and settings, applied to the master gain, persisted', async ({ page }) => {
        await open(page);
        await capture(page);
        await write(page, `${APC}SyncTERM:A;Synth;S=1;W=SIN;F=440;T=200${ST}${APC}SyncTERM:A;Queue;C=2;S=1${ST}`);
        await page.waitForFunction(() => (window as any).enigTerm.sound.engine);
        const gain = () => page.evaluate(() => (window as any).enigTerm.sound.engine.out.master.gain.value as number);
        await expect.poll(gain).toBeGreaterThan(0.3);
        await page.locator('[data-act="sound"]').click();
        await expect(page.locator('[data-act="sound"]')).toHaveText('Muted');
        await expect.poll(gain).toBeLessThan(0.001);
        await page.locator('[data-act="settings"]').click();
        await expect(page.locator('.settings [data-set="mute"]')).toBeChecked();
        await page.locator('.settings [data-set="mute"]').uncheck();
        await page.locator('.settings [data-set="volume"]').fill('50');
        await expect.poll(gain).toBeLessThan(0.3);
        await expect.poll(gain).toBeGreaterThan(0.2);
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('enig-term:settings:v1') ?? '{}'));
        expect(saved).toMatchObject({ mute: false, volume: 50 });
        await page.locator('[data-act="sound"]').click();
        await page.reload();
        await page.waitForFunction(() => document.body.dataset.ready === '1');
        expect(await page.evaluate(() => (window as any).enigTerm.opts.mute)).toBe(true);
        await expect(page.locator('[data-act="sound"]')).toHaveText('Muted');
    });

    test('A;Wait and foreground music hold the stream; background music does not', async ({ page }) => {
        await open(page);
        await capture(page);
        await write(page, `${APC}SyncTERM:Q;libsndfile${ST}`);
        await page.waitForFunction(() => (window as any).enigTerm.sound.state === 'on');
        const t0 = Date.now();
        await write(page, `${APC}SyncTERM:A;Synth;S=1;W=SIN;F=440;T=600${ST}${APC}SyncTERM:A;Queue;C=2;S=1${ST}${APC}SyncTERM:A;Wait;C=2${ST}waited`);
        expect(await page.evaluate(() => (window as any).enigTerm.holding)).toBe(true);
        await expect.poll(() => rowText(page, 0), { timeout: 5000 }).toBe('waited');
        const waited = Date.now() - t0;
        expect(waited).toBeGreaterThan(450);
        expect(waited).toBeLessThan(2500);
        // Foreground music (the default): T255 L16 is 58 ms a note.
        await write(page, `${CSI}2;1H${CSI}|T255L16CDEFGAB${SO}fg`);
        expect(await page.evaluate(() => (window as any).enigTerm.holding)).toBe(true);
        await expect.poll(() => rowText(page, 1), { timeout: 5000 }).toBe('fg');
        // MB: background; the text follows at once.
        await write(page, `${CSI}3;1H${CSI}|MBT60L1C${SO}bg`);
        expect(await rowText(page, 2)).toBe('bg');
        expect(await page.evaluate(() => (window as any).enigTerm.holding)).toBe(false);
        // Flush ends it; channel 0 then reports idle.
        await write(page, `${APC}SyncTERM:A;Flush;C=0${ST}${CSI}=7;0n`);
        await expect.poll(() => sentText(page)).toContain(`${CSI}=7;0;0n`);
    });

    test('the cache: stored files survive a reload (IndexedDB), C;L lists them with MD5, Clear empties it', async ({ page }) => {
        await open(page);
        await capture(page);
        const b64 = Buffer.from('hello audio').toString('base64');
        await write(page, `${APC}SyncTERM:C;S;sfx/hi.txt;${b64}${ST}`);
        await expect.poll(() => page.evaluate(async () => (await (window as any).enigTerm.sound.cacheUsage()).files)).toBe(1);
        await page.reload();
        await page.waitForFunction(() => document.body.dataset.ready === '1');
        await capture(page);
        await write(page, `${APC}SyncTERM:C;L;sfx/*${ST}`);
        const md5 = crypto.createHash('md5').update('hello audio').digest('hex');
        await expect.poll(() => sentText(page)).toBe(`${APC}SyncTERM:C;L\nsfx/hi.txt\t${md5}\n${ST}`);
        await page.locator('[data-act="settings"]').click();
        await page.locator('[data-act="clear-sound"]').click();
        await expect(page.locator('[data-soundcache]')).toHaveText(/Cleared 1 file/);
        await write(page, `${APC}SyncTERM:C;L${ST}`);
        await expect.poll(() => sentText(page)).toContain(`${APC}SyncTERM:C;L\n${ST}`);
    });

    test('the cache in IndexedDB: a board keeps at most maxFiles, and another tab\'s stores are counted before evicting', async ({ page }) => {
        await open(page);
        const r = await page.evaluate(async () => {
            const m = await import('/enig-term-audio.js' as string);
            const ctx = new OfflineAudioContext(2, 4800, 48000);
            const mk = () => new m.AudioEngine({ reply() {}, log() {}, board: () => 't' }, { maxFile: 1 << 24, cacheBytes: 1 << 24, memoryBytes: 1 << 28, decodeMs: 5000, musicTone: 'square', clock: () => 0 }, m.browserDeps(ctx, { clock: () => 0 })).store;
            const a = mk();
            const b = mk();
            await a.clear();
            a.limits.maxFiles = b.limits.maxFiles = 10;
            const one = new Uint8Array([1]);
            // b reads the index first (one file of its own board), then a fills board 'q'.
            await b.put('other', 'x', one);
            await b.flushed();
            for (let i = 0; i < 25; i++) await a.put('q', `a${i}`, one);
            await a.flushed();
            const afterA = (await a.list('q')).length;
            await new Promise(res => setTimeout(res, 100)); // the BroadcastChannel message
            // b stores 3 more on 'q': it must see a's 10, so 'q' stays at 10 on disk.
            for (let i = 0; i < 3; i++) await b.put('q', `b${i}`, one);
            await b.flushed();
            const fresh = mk(); // a new page: only what is in IndexedDB
            const disk = (await fresh.list('q')).map((e: { name: string }) => e.name);
            const usage = await fresh.usage();
            await fresh.clear();
            return { persistent: a.persistent && b.persistent, afterA, disk, usage };
        });
        expect(r.persistent).toBe(true);
        expect(r.afterA).toBe(10);
        expect(r.disk.length).toBe(10);
        expect(r.disk).toEqual(expect.arrayContaining(['b0', 'b1', 'b2', 'a24']));
        expect(r.usage).toEqual({ files: 11, bytes: 11 });
    });

    test('sound off: no audio answers at all', async ({ page }) => {
        await open(page);
        await page.evaluate(async () => {
            const { mount } = await import('/enig-term.js' as string);
            const el = document.createElement('div');
            document.body.appendChild(el);
            const h = await mount(el, { sound: false, persist: false });
            (window as any).h = h;
            (window as any).sent = '';
            h.terminal.onLocalReply = (b: Uint8Array) => ((window as any).sent += String.fromCharCode(...b));
            h.write(`\x1b_SyncTERM:Q;libsndfile\x1b\\\x1b[=7n\x1b[6n`);
        });
        await expect.poll(() => page.evaluate(() => (window as any).sent)).toContain('R');
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => (window as any).sent)).not.toContain('=7');
        expect(await page.evaluate(() => (window as any).h.soundState)).toBe('off');
    });
});

test.describe('font notices (Phase 2 follow-up)', () => {
    test('a missing Amiga font is noticed once per session, other refused fonts in their own words', async ({ page }) => {
        const warns: string[] = [];
        page.on('console', m => m.type() === 'warning' && m.text().startsWith('enig-term:') && warns.push(m.text()));
        await open(page);
        await page.evaluate(async () => {
            const { mount } = await import('/enig-term.js' as string);
            const el = document.createElement('div');
            el.id = 'second';
            document.body.appendChild(el);
            const h = await mount(el, { amigaFonts: '', persist: false });
            (window as any).h = h;
            (window as any).notices = [];
            h.on('notice', (ev: { text: string }) => (window as any).notices.push(ev.text));
        });
        const sel = (n: number) => page.evaluate(n => (window as any).h.write(`\x1b[0;${n} D`), n);
        await sel(42);
        await sel(42);
        await sel(39);
        await sel(7);
        await sel(7);
        await expect.poll(() => page.evaluate(() => (window as any).notices.length)).toBe(2);
        const n = await page.evaluate(() => (window as any).notices as string[]);
        expect(n[0]).toMatch(/Amiga font \(Topaz.*not installed on this site.*README/);
        expect(n[1]).toMatch(/SyncTERM font 7 .*does not have/);
        expect(warns.length).toBe(2);
        // The notice is the non-modal toast.
        await expect(page.locator('#second [data-toast]')).toBeVisible();
    });
});

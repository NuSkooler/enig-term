// Node tests for the audio engine's pure parts (APC grammar, base64, MD5,
// cache listing globs, synthesis, the mixer model) and for the engine on the
// wire against ansi-bbs-utils 0.2.1: its own host side (Terminal, probeAudio,
// audio.asset/play) driving enig-term (WASM core + engine), compared with its
// Testing.FakeCTerm for the same calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseApc, parseDuration, parseVolume, parseUlong, base64Decode, validName } from '../src/audio/apc.ts';
import { md5hex } from '../src/audio/md5.ts';
import { globToRegExp, listMatches } from '../src/audio/glob.ts';
import { synthShape, renderMusic, noteHz } from '../src/audio/synth.ts';
import { Mixer, overlayGain, volAt } from '../src/audio/mixer.ts';
import { AudioStore } from '../src/audio/cache.ts';
import { NodeTerm, Recorder, abu, wav, sleep } from './audio-harness.mjs';

const enc = s => new Uint8Array(Buffer.from(s, 'latin1'));
const ESC = String.fromCharCode(27);

// --- grammar ---------------------------------------------------------------------

test('durations: ms by default, ms, frames at 44.1 kHz, periods only for Synth; errors are 0', () => {
    assert.equal(parseDuration('500'), 0.5);
    assert.equal(parseDuration('250ms'), 0.25);
    assert.equal(parseDuration('22050f'), 0.5);
    assert.equal(parseDuration('4p', 440, true), 4 / 440);
    assert.equal(parseDuration('4p', 440, false), 0, 'p is rejected outside Synth');
    for (const bad of ['', 'x', '5s', '-5', '1.5', undefined]) assert.equal(parseDuration(bad), 0, String(bad));
});

test('volumes: 0..100 linear (100 = 0 dB, 50 about -6 dB, 0 the -60 dB floor) or dB', () => {
    assert.equal(parseVolume('100'), 0);
    assert.ok(Math.abs(parseVolume('50') + 6.0206) < 1e-3);
    assert.equal(parseVolume('0'), -60);
    assert.equal(parseVolume('250'), 0, 'clamped to 100');
    assert.equal(parseVolume('-6.5dB'), -6.5);
    assert.equal(parseVolume('+3DB'), 3);
    assert.equal(parseVolume('junk'), 0, 'parse errors are unity');
    assert.equal(parseUlong('0x20'), 32);
    assert.equal(parseUlong('040'), 32, 'strtoul base 0: leading 0 is octal');
    assert.equal(parseUlong('96'), 96);
    assert.equal(parseUlong('9x'), null);
});

test('APC commands parse per the manual', () => {
    const p = s => parseApc(enc(s));
    assert.deepEqual(p('SyncTERM:Q;libsndfile'), { k: 'qsndfile' });
    assert.deepEqual(p('SyncTERM:Q;libsndfileFormat;32;0x64'), { k: 'qformat', major: 32, subtype: 100 });
    assert.equal(p('SyncTERM:Q;libsndfileFormat;32').k, 'reject');
    assert.deepEqual(p('SyncTERM:A;Load;S=3;music/lobby.ogg'), { k: 'load', slot: 3, name: 'music/lobby.ogg' });
    assert.equal(p('SyncTERM:A;Load;S=3;../x').k, 'reject', 'no traversal');
    assert.equal(p('SyncTERM:A;Load;S=256;x').k, 'reject');
    assert.deepEqual(p('SyncTERM:A;Synth;S=1;W=SQ;F=440;T=10p'), { k: 'synth', slot: 1, shape: 'SQ', freq: 440, seconds: 10 / 440 });
    assert.equal(p('SyncTERM:A;Synth;S=1;W=SINE_SAW_HARM;F=220;T=0').seconds, 0);
    assert.equal(p('SyncTERM:A;Synth;S=1;W=NOPE;F=220;T=5').k, 'reject');
    assert.deepEqual(p('SyncTERM:A;Copy;S=1;D=2'), { k: 'copy', src: 1, dst: 2 });
    assert.deepEqual(p('SyncTERM:A;Queue;C=2;S=4;I=500;O=1000ms;X;L;V=50;VR=100'), {
        k: 'queue',
        ch: 2,
        slot: 4,
        fadeIn: 0.5,
        fadeOut: 1,
        crossfade: true,
        loop: true,
        volL: parseVolume('50'),
        volR: 0,
    });
    assert.equal(p('SyncTERM:A;Queue;C=1;S=4').k, 'reject', 'channels 0 and 1 belong to the terminal');
    assert.equal(p('SyncTERM:A;Queue;C=16;S=4').k, 'reject');
    assert.deepEqual(p('SyncTERM:A;Flush;C=0;O=250'), { k: 'flush', ch: 0, fadeOut: 0.25 });
    assert.deepEqual(p('SyncTERM:A;Volume;C=3;VL=-6dB;T=22050f'), { k: 'volume', ch: 3, volL: -6, volR: null, ramp: 0.5 });
    assert.equal(p('SyncTERM:A;Volume;C=3;T=100').k, 'reject');
    assert.deepEqual(p('SyncTERM:A;Wait;C=2'), { k: 'wait', ch: 2 });
    assert.deepEqual(p('SyncTERM:A;Update;C=15'), { k: 'update', ch: 15 });
    assert.deepEqual(p('SyncTERM:C;L'), { k: 'list', glob: '*' });
    assert.deepEqual(p('SyncTERM:C;L;sfx/*'), { k: 'list', glob: 'sfx/*' });
    const st = p('SyncTERM:C;S;sfx/hit.wav;aGVs\r\nbG8=');
    assert.equal(st.k, 'store');
    assert.equal(Buffer.from(st.data).toString(), 'hello');
    assert.equal(p('SyncTERM:C;S;sfx/hit.wav;not*base64').k, 'reject');
    const lb = p('SyncTERM:A;LoadBlob;S=9;aGVsbG8');
    assert.equal(lb.slot, 9);
    assert.equal(Buffer.from(lb.data).toString(), 'hello');
    for (const junk of ['SyncTERM:A;', 'SyncTERM:A;Nope;C=2', 'SyncTERM:A;Queue', 'SyncTERM:A;Queue;C=x;S=y', 'SyncTERM:A;LoadBlob;S=1', 'SyncTERM:Q;']) assert.equal(p(junk).k, 'reject', junk);
});

test('base64 and cache names', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 1001]) {
        const raw = crypto.randomBytes(n);
        assert.deepEqual(Buffer.from(base64Decode(enc(raw.toString('base64')))), raw);
        assert.deepEqual(Buffer.from(base64Decode(enc(raw.toString('base64url')))), raw);
    }
    assert.equal(base64Decode(enc('QUJD=x')), null, 'data after padding');
    assert.equal(base64Decode(enc('Q')), null);
    for (const ok of ['a', 'sfx/hit.wav', 'Music Box/01 - Intro.ogg']) assert.ok(validName(ok), ok);
    for (const bad of ['', '/x', 'x/', 'a//b', '.', 'a/../b', 'a\\b', 'a:b', ' lead', 'x'.repeat(256)]) assert.ok(!validName(bad), bad);
});

test('MD5 matches node:crypto', () => {
    for (const n of [0, 3, 55, 56, 64, 65, 1000, 70000]) {
        const b = crypto.randomBytes(n);
        assert.equal(md5hex(new Uint8Array(b)), crypto.createHash('md5').update(b).digest('hex'));
    }
});

test('cache listing globs work like glob(3): one level, directories marked', () => {
    assert.ok(globToRegExp('*.wav').test('a.wav'));
    assert.ok(!globToRegExp('*.wav').test('sfx/a.wav'));
    assert.ok(globToRegExp('sfx/h?t.[wo]*').test('sfx/hit.wav'));
    assert.ok(!globToRegExp('[!a]*').test('abc'));
    const names = ['a.wav', 'sfx/hit.wav', 'sfx/deep/x.ogg', 'music/lobby.ogg'];
    assert.deepEqual(listMatches(names, '*'), { files: ['a.wav'], dirs: ['music/', 'sfx/'] });
    assert.deepEqual(listMatches(names, 'sfx/*'), { files: ['sfx/hit.wav'], dirs: ['sfx/deep/'] });
    assert.deepEqual(listMatches(names, 'm*/l*'), { files: ['music/lobby.ogg'], dirs: [] });
});

test('an escaped * or ? in a listing glob is a literal, not a regular expression error', () => {
    // A backslash before * used to become `^*`, a SyntaxError that the engine logged as an error and answered with nothing.
    assert.ok(globToRegExp('a\\*b').test('a*b'));
    assert.ok(!globToRegExp('a\\*b').test('axb'));
    assert.ok(globToRegExp('a\\?').test('a?'));
    assert.deepEqual(listMatches(['a*b', 'axb'], 'a\\*b'), { files: ['a*b'], dirs: [] });
    assert.doesNotThrow(() => listMatches(['a'], '*\\*'));
});

// --- synthesis ------------------------------------------------------------------------

const crossings = w => {
    let n = 0;
    for (let i = 1; i < w.length; i++) if ((w[i - 1] < 0 && w[i] >= 0) || (w[i - 1] > 0 && w[i] <= 0)) n++;
    return n;
};

test('Synth shapes: length, pitch, silence, clean ends', () => {
    const rate = 48000;
    for (const shape of ['SIN', 'SAW', 'SQ', 'SINE_SAW', 'SINE_SAW_HARM']) {
        const w = synthShape(shape, 440, 0.5, rate);
        assert.equal(w.length, 24000, shape);
        const per = crossings(w) / 2 / 0.5;
        assert.ok(Math.abs(per - 440) < 15, `${shape}: ${per} Hz`);
        assert.equal(w[w.length - 1], 0, `${shape} ends on a whole wave`);
        assert.ok(Math.abs(w[1]) < 0.1, `${shape} starts softly`);
    }
    // SyncTERM's SINE_HARM arithmetic leaves a square-ish wave at 3F.
    const h = synthShape('SINE_HARM', 200, 0.5, rate);
    assert.ok(Math.abs(crossings(h) - 600) < 30, `SINE_HARM ${crossings(h)} crossings`);
    assert.ok(synthShape('SILENCE', 440, 0.1, rate).every(v => v === 0));
    assert.ok(synthShape('SIN', 0, 0.1, rate).every(v => v === 0), 'F=0 is silence');
});

test('ANSI music renders CTerm durations and pitches', () => {
    const rate = 48000;
    // A4 (note 33) for 438 ms + 62 ms silence, a rest of 500, C5 (36) 100 + 0 (legato)
    const w = renderMusic([33, 438, 62, -1, 438, 62, 36, 100, 0], rate);
    assert.equal(w.length, Math.floor((rate * 438) / 1000) * 2 + Math.floor((rate * 62) / 1000) * 2 + rate / 10);
    const a = w.subarray(0, Math.floor(rate * 0.438));
    assert.ok(Math.abs(crossings(a) / 2 / 0.438 - 440) < 6);
    const rest = w.subarray(Math.floor(rate * 0.438), Math.floor(rate * 1.0));
    assert.ok(rest.every(v => v === 0), 'silences and rests');
    assert.ok(Math.abs(noteHz(0) - 65.406) < 0.01 && Math.abs(noteHz(48) - 1046.5) < 0.1, 'the manual\'s C frequencies');
    assert.ok(renderMusic([33, 1e7, 0], 8000).length <= 120 * 8000, 'capped');
});

// --- the mixer model --------------------------------------------------------------------

function mixer() {
    let t = 0;
    const rec = new Recorder(() => t);
    const reports = [];
    const m = new Mixer(() => t, rec, s => reports.push(s));
    const buf = d => ({ duration: d, bytes: 100, data: null });
    return {
        m,
        rec,
        reports,
        buf,
        at: (x, f) => {
            t = x;
            m.tick();
            f?.();
        },
        q: (o, d = 1) => {
            m.setSlot(1, buf(d));
            return m.queue({ ch: 2, slot: 1, fadeIn: 0, fadeOut: 0, crossfade: false, loop: false, volL: 0, volR: 0, ...o });
        },
    };
}

test('mixer: Queue moves the slot; buffers play back to back; Update reports the idle transition once', () => {
    const x = mixer();
    x.m.update(2);
    const a = x.q({}, 1);
    assert.equal(x.m.slots[1], null, 'the slot is empty after Queue');
    const b = x.q({}, 0.5);
    assert.deepEqual([a.start, a.end, b.start, b.end], [0, 1, 1, 1.5]);
    assert.equal(x.m.stateReport([7]), '\x1b[=7;2;1n');
    x.at(1.2);
    assert.deepEqual(x.reports, []);
    x.at(1.5);
    assert.deepEqual(x.reports, ['\x1b[=7;2;0n']);
    assert.equal(x.m.stateReport([7, 2]), '\x1b[=7;2;0n');
    assert.equal(x.m.stateReport([7]), '\x1b[=7n', 'an idle terminal: no pairs');
    assert.equal(x.m.stateReport([7, 100]), '\x1b[=7;100;1n');
    x.q({}, 1);
    x.at(5);
    assert.equal(x.reports.length, 1, 'one-shot');
    assert.equal(x.m.queue({ ch: 2, slot: 7, fadeIn: 0, fadeOut: 0, crossfade: false, loop: false, volL: 0, volR: 0 }), null, 'empty slot');
});

test('mixer: a Queue behind a loop ends it at the end of the pass in progress', () => {
    const x = mixer();
    const loop = x.q({ loop: true, fadeOut: 0.25 }, 2);
    assert.equal(loop.end, Infinity);
    x.at(3.1);
    const next = x.q({}, 1);
    assert.equal(loop.end, 4, 'end of the second pass');
    assert.equal(next.start, 4);
    assert.deepEqual([loop.fadeOutAt, loop.fadeOutDur], [3.75, 0.25], 'the final pass fades out');
    // Close to a boundary: the following pass.
    const y = mixer();
    const l2 = y.q({ loop: true }, 1);
    y.at(0.99);
    y.q({}, 1);
    assert.equal(l2.end, 2);
});

test('mixer: crossfade decays the playing buffer while the new one fades in; Flush with O fades what sounds', () => {
    const x = mixer();
    const a = x.q({ loop: true }, 10);
    x.at(2);
    const b = x.q({ crossfade: true, fadeIn: 1.5, loop: true }, 8);
    assert.equal(b.start, 2, 'starts at once');
    assert.deepEqual(a.overlay, { at: 2, dur: 1.5, from: 1 });
    assert.equal(a.end, 3.5);
    assert.ok(Math.abs(overlayGain(a.overlay, 2.75) - Math.SQRT1_2) < 1e-9, 'equal power');
    assert.ok(x.m.isRunning(2));
    x.at(3.5);
    assert.deepEqual(x.m.items(2).map(i => i.id), [b.id], 'the old one is gone after the overlap');
    // X on an empty channel is a plain fade-in.
    const y = mixer();
    const c = y.q({ crossfade: true, fadeIn: 1 }, 3);
    assert.deepEqual([c.start, c.fadeIn, c.overlay], [0, 1, null]);
    // Flush with a fade: the queued rest is dropped, the sounding one fades over O.
    x.at(4);
    x.m.setSlot(1, x.buf(1));
    x.m.queue({ ch: 2, slot: 1, fadeIn: 0, fadeOut: 0, crossfade: false, loop: false, volL: 0, volR: 0 });
    x.m.flush(2, 0.5);
    assert.equal(x.m.items(2).length, 1);
    assert.deepEqual([x.m.items(2)[0].id, x.m.items(2)[0].end], [b.id, 4.5]);
    x.m.update(2);
    x.at(4.5);
    assert.deepEqual(x.reports, ['\x1b[=7;2;0n']);
    // Flush without O: at once.
    x.q({ loop: true }, 1);
    x.m.flush(2, 0);
    assert.ok(!x.m.isRunning(2));
});

test('mixer: fades are clamped and scaled to the buffer; Volume ramps dB-linearly, a missing side stays', () => {
    const x = mixer();
    // I and O are first clamped to the buffer (2 and 1), then scaled to fit it (as SyncTERM does).
    const a = x.q({ fadeIn: 3, fadeOut: 1 }, 2);
    assert.deepEqual([a.fadeIn, a.fadeOutDur].map(v => +v.toFixed(6)), [1.333333, 0.666667]);
    x.m.volume(2, -6, null, 2);
    const v = x.m.channelVolume(2);
    assert.deepEqual([v.l0, v.l1, v.r0, v.r1], [-12, -6, -12, -12]);
    assert.deepEqual(volAt(v, 1), [-9, -12]);
    x.at(1);
    x.m.volume(2, null, 0, 0);
    assert.deepEqual(volAt(x.m.channelVolume(2), 1), [-9, 0], 'left frozen where the ramp was');
});

test('mixer: Wait resolves when the channel idles or its head loops; limits drop the excess', async () => {
    const x = mixer();
    x.q({}, 1);
    let done = false;
    const w = x.m.wait(2).then(() => (done = true));
    x.at(0.5);
    await Promise.resolve();
    assert.equal(done, false);
    x.at(1);
    await w;
    x.q({ loop: true }, 1);
    let looped = false;
    await x.m.wait(2).then(() => (looped = true));
    assert.ok(looped, 'no wait on a loop');
    const y = mixer();
    for (let i = 0; i < 70; i++) y.q({}, 1);
    assert.equal(y.m.items(2).length, 64);
    assert.equal(y.m.dropped, 6);
});

// --- the engine on the wire, against ansi-bbs-utils ---------------------------------------

const { Testing } = abu;

test('engine: store, list with MD5 (glob), load, synth, queue, update in Node', async () => {
    const node = new NodeTerm();
    const A = `${ESC}_`;
    const ST = `${ESC}\\`;
    const w = wav(0.2);
    const md5 = crypto.createHash('md5').update(w).digest('hex');
    const got = [];
    node.onReply(b => got.push(b.toString('latin1')));
    node.socket.write(`${A}SyncTERM:C;S;sfx/hit.wav;${Buffer.from(w).toString('base64')}${ST}${A}SyncTERM:C;L${ST}${A}SyncTERM:C;L;sfx/*${ST}`);
    node.socket.write(`${A}SyncTERM:A;Load;S=4;sfx/hit.wav${ST}${A}SyncTERM:A;Queue;C=3;S=4${ST}${A}SyncTERM:A;Update;C=3${ST}${ESC}[=7;3n`);
    await node.pending;
    await sleep(350);
    assert.deepEqual(got, [`${A}SyncTERM:C;L\nsfx/\t\n${ST}`, `${A}SyncTERM:C;L\nsfx/hit.wav\t${md5}\n${ST}`, `${ESC}[=7;3;1n`, `${ESC}[=7;3;0n`]);
    node.destroy();
});

test('interop: ansi-bbs-utils 0.2.1 host side drives enig-term like FakeCTerm (probe, upload once, play, idle, stop)', async () => {
    const store = new AudioStore({ capBytes: 64 << 20, maxFile: 16 << 20 });
    const cache = new Map();
    const lobby = wav(0.3, { freq: 330 });
    const hit = wav(0.1, { freq: 880 });

    async function session(kind) {
        const { term, fake, node } =
            kind === 'fake'
                ? (() => {
                      const r = Testing.FakeCTerm.connect({ sndfile: true, playbackMs: 100, cache, listing: 'flat' });
                      return { ...r, node: null };
                  })()
                : (() => {
                      const r = NodeTerm.connect({ store });
                      return { ...r, fake: null };
                  })();
        const probe = await term.probeAudio({ timeout: 2000 });
        const audio = term.audio;
        audio.asset({ name: 'music/lobby', bytes: Buffer.from(lobby) });
        audio.asset({ name: 'sfx/hit', bytes: Buffer.from(hit) });
        const idle = [];
        audio.on('idle', ev => idle.push(ev.channel));
        const music = await audio.play('music', 'music/lobby', { loop: true, volume: 60, fadeIn: 50 });
        await audio.play('sfx', 'sfx/hit', { pan: 40 });
        await sleep(400);
        await music.volume(30, { ramp: 100 });
        await audio.play('music', 'music/lobby', { loop: true, fadeIn: 100, crossfade: true });
        await music.stop({ fade: 100 });
        await sleep(400);
        const out = {
            probe: { backend: probe.backend, files: probe.files },
            idle,
            apcs: (fake ? fake.apcs : node.apcs).map(a => a.replace(/;[A-Za-z0-9+/=]{40,}$/, ';<data>')),
            running2: fake ? fake.channels.get(2).running : node.running(2),
            waits: fake ? fake.waitCalls : node.apcs.filter(a => a.startsWith('SyncTERM:A;Wait')).length,
            fmt: await audio.formatSupported('ogg', 'vorbis'),
        };
        term.destroy?.();
        fake?.destroy();
        node?.destroy();
        return out;
    }

    const f1 = await session('fake');
    const n1 = await session('node');
    assert.deepEqual(n1.probe, { backend: 'cterm', files: true });
    assert.deepEqual(n1.probe, f1.probe);
    assert.equal(n1.waits, 0);
    // Same wire traffic from the host for the same calls (listing, uploads, plays).
    assert.deepEqual(n1.apcs.filter(a => !a.startsWith('SyncTERM:Q;libsndfileFormat')), f1.apcs.filter(a => !a.startsWith('SyncTERM:Q;libsndfileFormat')));
    assert.equal(n1.apcs.filter(a => a.startsWith('SyncTERM:C;S;')).length, 2, 'both files uploaded in the first session');
    // The sfx channel went idle and said so, on both.
    assert.ok(n1.idle.includes(3) && f1.idle.includes(3), `idle: node ${n1.idle} fake ${f1.idle}`);
    assert.equal(n1.fmt, true, 'Ogg Vorbis: yes');
    // Second session: nothing uploaded again (the cache lists the files with matching MD5s).
    const f2 = await session('fake');
    const n2 = await session('node');
    assert.equal(f2.apcs.filter(a => a.startsWith('SyncTERM:C;S;')).length, 0);
    assert.equal(n2.apcs.filter(a => a.startsWith('SyncTERM:C;S;')).length, 0, 'upload once per board');
    assert.deepEqual(n2.apcs.filter(a => !a.startsWith('SyncTERM:Q;libsndfileFormat')), f2.apcs.filter(a => !a.startsWith('SyncTERM:Q;libsndfileFormat')));
});

test('interop: bounded patch slots (0.2.1) stay within 28 slots on enig-term and nothing stays resident after Queue', async () => {
    const { term, node } = NodeTerm.connect();
    await term.probeAudio({ timeout: 2000 });
    term.audio.asset({ name: 'sfx/hit', bytes: Buffer.from(wav(0.05)) });
    for (let i = 0; i < 40; i++) await term.audio.play('sfx', 'sfx/hit');
    await node.pending;
    await sleep(50);
    const slots = new Set(node.apcs.filter(a => a.startsWith('SyncTERM:A;Load')).map(a => /S=(\d+)/.exec(a)[1]));
    assert.ok(slots.size <= 28, `${slots.size} slots`);
    assert.ok(node.engine.mixer.slots.every(s => s === null), 'Queue moved every buffer out of its slot');
    node.destroy();
});

test('interop: tones without files, and the fake and enig-term agree on Synth/Queue/Update', async () => {
    const { term, node } = NodeTerm.connect();
    await term.probeAudio({ timeout: 2000 });
    const idle = [];
    term.audio.on('idle', ev => idle.push(ev.channel));
    await term.audio.playTone('sfx', { hz: 440, duration: 120 });
    await sleep(300);
    assert.deepEqual(idle, [3]);
    node.destroy();
});

test('engine: limits: oversized store, undecodable data and junk do not break it', async () => {
    const node = new NodeTerm();
    node.engine.opts.maxFile = 1000;
    node.store.limits.maxFile = 1000;
    const A = `${ESC}_`;
    const ST = `${ESC}\\`;
    const got = [];
    node.onReply(b => got.push(b.toString('latin1')));
    node.socket.write(`${A}SyncTERM:C;S;big;${Buffer.alloc(2000).toString('base64')}${ST}${A}SyncTERM:C;S;bad;${Buffer.from('nope').toString('base64')}${ST}`);
    node.socket.write(`${A}SyncTERM:A;Load;S=1;bad${ST}${A}SyncTERM:A;Queue;C=2;S=1${ST}${A}SyncTERM:A;LoadBlob;S=2;%%%${ST}${A}SyncTERM:A;Queue;C=2;S=2${ST}${A}SyncTERM:C;L${ST}${ESC}[=7;2n`);
    await node.pending;
    await sleep(100);
    assert.deepEqual(got, [`${A}SyncTERM:C;L\nbad\t${md5hex(enc('nope'))}\n${ST}`, `${ESC}[=7;2;0n`]);
    assert.ok(node.engine.stats.rejected >= 1 && node.engine.stats.decodeFailures >= 1);
    node.destroy();
});

test('cache: glob with a reversed range does not throw (found by the fuzzer); audioCache 0 keeps files in memory only', async () => {
    assert.deepEqual(listMatches(['a', '[z-a]'], '[z-a]'), { files: ['[z-a]'], dirs: [] });
    const s = new AudioStore({ capBytes: 0, maxFile: 1000 });
    assert.equal(await s.put('b', 'x', enc('hi')), true);
    assert.deepEqual(await s.list('b'), [{ name: 'x', md5: md5hex(enc('hi')), size: 2 }]);
    assert.equal(Buffer.from(await s.get('b', 'x')).toString(), 'hi');
    assert.equal(await s.put('b', 'big', new Uint8Array(1001)), false);
});

test('fuzz smoke: 300 fixed-seed audio cases through core and engine', async () => {
    const { fuzzAudio } = await import('./fuzz-audio.mjs');
    const res = await fuzzAudio({ seconds: 60, seed: 4242, cases: 300 });
    assert.equal(res.cases, 300);
    assert.deepEqual(res.failures.map(f => f.message), []);
});

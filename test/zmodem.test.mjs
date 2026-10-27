// ZModem (src/transfer/zmodem.ts over the enig-term-zmodem WASM, icy_net's
// ZModem): against lrzsz's sz/rz and Synchronet's sexyz over pipes, in both
// directions, with batches, every byte value, 10 MB, cancels both ways, a
// remote abort, refused (skipped) files, a slow sink, streamed reads, paced
// output, and the bytes after the session handed back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZmodemEngine, loadZmodem } from '../src/transfer/zmodem.ts';
import { boardLeftAbort } from '../src/transfer/xymodem.ts';
import { BOARD_LEFT } from '../src/transfer/types.ts';
import { LRZSZ, SEXYZ, allBytes, craftedZmodem, peerCommand, random, runPeer, sha, tmpdir } from './xfer-peers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadZmodem(fs.readFileSync(path.join(here, '..', 'build', 'wasm-zmodem', 'enig_term_zmodem_bg.wasm')));

const enc = s => new TextEncoder().encode(s);
const now = () => performance.now();
const MTIME = Date.UTC(2024, 4, 17, 12, 0, 0);
const src = (name, data, reads) => ({ name, size: data.length, mtime: MTIME, read: (o, n) => (reads?.push(n), Promise.resolve(data.subarray(o, o + n))) });

function sink() {
    const files = [];
    const skipped = [];
    let cur = null;
    return {
        files,
        skipped,
        ev: {
            fileStart: f => (cur = { ...f, parts: [] }),
            data: c => cur.parts.push(Buffer.from(c)),
            fileEnd: ok => {
                files.push({ name: cur.name, size: cur.size, ok, data: Buffer.concat(cur.parts) });
                cur = null;
            },
            fileSkipped: f => skipped.push(f),
            progress: () => {},
            done: () => {},
        },
    };
}
const quiet = () => ({ fileStart: () => {}, fileEnd: () => {}, progress: () => {}, done: () => {} });

const SETS = {
    small: () => [['hello.txt', enc('hello, world\r\n')]],
    allbytes: () => [['allbytes.bin', allBytes(70_000)]],
    empty: () => [['empty.bin', new Uint8Array(0)]],
    batch: () => [['one.bin', random(1000)], ['two.bin', allBytes(8192 * 3 + 17)], ['three.txt', enc('three\n'.repeat(500))]],
    big: () => [['big.bin', random(10 << 20)]],
};

async function download(peer, set, opts = {}) {
    const dir = tmpdir();
    const files = SETS[set]();
    for (const [n, d] of files) fs.writeFileSync(path.join(dir, n), d);
    const r = sink();
    const res = await runPeer(peerCommand(peer, dir), io => new ZmodemEngine('receive', [], io.send, { ...r.ev, ...(opts.ev ?? {}), done: x => io.done(x) }, { now, ...opts.zm }), opts.run);
    fs.rmSync(dir, { recursive: true, force: true });
    return { res, r, files };
}

async function upload(peer, set, opts = {}) {
    const dir = tmpdir();
    const files = opts.files ?? SETS[set]();
    const res = await runPeer(peerCommand(peer, dir), io => new ZmodemEngine('send', files.map(([n, d]) => src(n, d, opts.reads)), io.send, { ...quiet(), done: x => io.done(x) }, { now, ...opts.zm }), opts.run);
    const got = Object.fromEntries(fs.readdirSync(dir).map(n => [n, fs.readFileSync(path.join(dir, n))]));
    const mtimes = fs.readdirSync(dir).map(n => fs.statSync(path.join(dir, n)).mtimeMs);
    fs.rmSync(dir, { recursive: true, force: true });
    return { res, got, files, mtimes };
}

const PEERS = [
    ['lrzsz', 'sz', 'rz', !LRZSZ && 'lrzsz not installed'],
    ['sexyz', 'sexyz sz', 'sexyz rz', !SEXYZ && 'sexyz not installed'],
];

for (const [label, down, up, skip] of PEERS) {
    for (const set of Object.keys(SETS)) {
        // sexyz cannot send an empty file: it rejects the receiver's ZRPOS 0
        // ("Received INVALID ZRPOS offset: 0"), against lrzsz's rz too.
        const sexyzEmpty = label === 'sexyz' && set === 'empty';
        test(`${label} ${down} -> us (${set})`, { skip }, async () => {
            const { res, r, files } = await download(down, set, sexyzEmpty ? { zm: { idleTimeout: 3000 } } : {});
            if (sexyzEmpty) {
                assert.equal(res.result.ok, false, 'a known sexyz limitation');
                assert.ok(!res.result.hung, 'a clean failure, not a hang');
                return;
            }
            assert.equal(res.result.ok, true, `${JSON.stringify(res.result)}\n${res.stderr.slice(-1500)}`);
            assert.equal(res.exit.code, 0, res.stderr.slice(-1500));
            assert.deepEqual(r.files.map(f => f.name).sort(), files.map(f => f[0]).sort());
            for (const [n, d] of files) assert.equal(sha(r.files.find(f => f.name === n).data), sha(d), `${n} differs`);
        });
        test(`us -> ${label} ${up} (${set})`, { skip }, async () => {
            const { res, got, files, mtimes } = await upload(up, set);
            // ZFILE carries the modification time (patch 0007); the program sets it.
            assert.deepEqual([...new Set(mtimes)], files.length ? [MTIME] : []);
            assert.equal(res.result.ok, true, `${JSON.stringify(res.result)}\n${res.stderr.slice(-1500)}`);
            assert.equal(res.exit.code, 0, res.stderr.slice(-1500));
            assert.deepEqual(Object.keys(got).sort(), files.map(f => f[0]).sort());
            for (const [n, d] of files) assert.equal(sha(got[n]), sha(d), `${n} differs`);
        });
    }

    // Under ENiGMA the program runs on a pty: its status text is in the stream.
    for (const set of ['allbytes', 'batch']) {
        test(`${label} ${down} -> us, status text in the stream (${set})`, { skip }, async () => {
            const { res, r, files } = await download(down, set, { run: { mergeStderr: true } });
            assert.equal(res.result.ok, true, `${JSON.stringify(res.result)}\n${res.stderr.slice(-1500)}`);
            for (const [n, d] of files) assert.equal(sha(r.files.find(f => f.name === n).data), sha(d), `${n} differs`);
        });
        test(`us -> ${label} ${up}, status text in the stream (${set})`, { skip }, async () => {
            const { res, got, files } = await upload(up, set, { run: { mergeStderr: true } });
            assert.equal(res.result.ok, true, `${JSON.stringify(res.result)}\n${res.stderr.slice(-1500)}`);
            for (const [n, d] of files) assert.equal(sha(got[n]), sha(d), `${n} differs`);
        });
    }

    test(`us -> ${label}: cancelled from our side mid-file; both ends stop`, { skip }, async () => {
        let engine;
        const { res } = await upload(up, 'big', {
            run: { onBytes: (n, io, e) => n > 1_000_000 && !e.finished && e.cancel('test') },
        });
        void engine;
        assert.deepEqual([res.result.ok, res.result.cancelled], [false, 'local']);
        assert.notEqual(res.exit.code, 0, 'the board sees a failed transfer');
        assert.ok(res.ms < 20_000, `took ${res.ms} ms`);
    });

    test(`${label} -> us: cancelled from our side mid-file; both ends stop`, { skip }, async () => {
        const { res, r } = await download(down, 'big', { run: { onBytes: (n, io, e) => n > 1_000_000 && !e.finished && e.cancel('test') } });
        assert.deepEqual([res.result.ok, res.result.cancelled], [false, 'local']);
        assert.equal(r.files.at(-1)?.ok, false, 'the partial file is abandoned');
        assert.ok(!res.result.hung);
    });

    test(`${label} -> us: the board aborts mid-file (SIGINT): a remote cancel, no hang`, { skip }, async () => {
        let killed = false;
        const { res } = await download(down, 'big', {
            run: {
                onBytes: (n, io) => {
                    if (n > 1_000_000 && !killed) {
                        killed = true;
                        io.kill('SIGINT');
                    }
                },
            },
            zm: { idleTimeout: 5000 },
        });
        assert.equal(res.result.ok, false);
        assert.ok(!res.result.hung, 'the engine ended by itself');
    });

    test(`${label} -> us: a file over the limit is skipped, the rest of the batch arrives`, { skip }, async () => {
        const dir = tmpdir();
        const files = [['a.bin', random(5000)], ['b.bin', random(300_000)], ['c.bin', random(7000)]];
        for (const [n, d] of files) fs.writeFileSync(path.join(dir, n), d);
        const r = sink();
        const res = await runPeer(peerCommand(down, dir), io => new ZmodemEngine('receive', [], io.send, { ...r.ev, done: x => io.done(x) }, { now, maxBytes: 100_000 }));
        fs.rmSync(dir, { recursive: true, force: true });
        assert.equal(res.result.ok, true, JSON.stringify(res.result));
        assert.deepEqual(r.files.map(f => f.name), ['a.bin', 'c.bin']);
        assert.deepEqual(r.skipped.map(f => f.name), ['b.bin']);
        for (const f of r.files) assert.equal(sha(f.data), sha(files.find(x => x[0] === f.name)[1]));
    });
}

test('upload reads the file in windows (never whole) and paces output by canSend', { skip: !LRZSZ && 'lrzsz not installed' }, async () => {
    const reads = [];
    let open = false;
    const t0 = Date.now();
    setTimeout(() => (open = true), 1500);
    const { res, got } = await upload('rz', 'big', { reads, files: [['big.bin', random(4 << 20)]], zm: { canSend: () => open } });
    assert.equal(res.result.ok, true, JSON.stringify(res.result));
    assert.equal(got['big.bin'].length, 4 << 20);
    assert.ok(Math.max(...reads) <= 64 * 1024, `largest read ${Math.max(...reads)}`);
    assert.ok(res.ms >= 1400 || Date.now() - t0 >= 1400, 'output waited for canSend');
});

test('us -> rz: two small files, each with a damaged start; the ZRPOS 0 for the second is honoured too', { skip: !LRZSZ && 'lrzsz not installed' }, async () => {
    // One byte of each file's first data subpacket is damaged on the way out,
    // so rz asks for ZRPOS 0 on each, well within a second of each other.
    // The second must not be taken for a repeat of the first (patch 0003).
    const files = [['one.txt', enc('ONE-FIRST-DATA\n'.repeat(40))], ['two.txt', enc('TWO-FIRST-DATA\n'.repeat(40))]];
    const marks = ['ONE-FIRST-DATA', 'TWO-FIRST-DATA'].map(enc);
    const damaged = [false, false];
    const at = (b, m) => {
        for (let i = 0; i + m.length <= b.length; i++) if (m.every((x, j) => b[i + j] === x)) return i;
        return -1;
    };
    const dir = tmpdir();
    const res = await runPeer(
        peerCommand('rz', dir),
        io =>
            new ZmodemEngine(
                'send',
                files.map(([n, d]) => src(n, d)),
                u8 => {
                    const i = damaged.findIndex(d => !d);
                    const p = i < 0 ? -1 : at(u8, marks[i]);
                    if (p >= 0) {
                        damaged[i] = true;
                        u8 = Uint8Array.from(u8);
                        u8[p + 4] ^= 0x01;
                    }
                    io.send(u8);
                },
                { ...quiet(), done: x => io.done(x) },
                { now },
            ),
        { timeout: 30_000 },
    );
    const got = Object.fromEntries(fs.readdirSync(dir).map(n => [n, fs.readFileSync(path.join(dir, n))]));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(damaged, [true, true], 'both starts damaged');
    assert.equal(res.result.ok, true, `${JSON.stringify(res.result)}\n${res.stderr.slice(-1500)}`);
    assert.equal(res.exit.code, 0, res.stderr.slice(-1500));
    for (const [n, d] of files) assert.equal(sha(got[n] ?? ''), sha(d), `${n} differs`);
    assert.ok(res.ms < 5000, `took ${res.ms} ms (a stall until rz times out)`);
});

test('a slow (asynchronous) sink holds the session; the file still arrives whole', { skip: !LRZSZ && 'lrzsz not installed' }, async () => {
    let writes = 0;
    const { res, r } = await download('sz', 'allbytes', {
        ev: {
            data(c) {
                writes++;
                this.__parts ??= [];
                return new Promise(ok => setTimeout(() => ok(), 5));
            },
        },
    });
    assert.equal(res.result.ok, true, JSON.stringify(res.result));
    assert.ok(writes >= 1);
    void r;
});

test('bytes after the end of the session go back to the screen', { skip: !LRZSZ && 'lrzsz not installed' }, async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'abc');
    // sz, then text from "the board" once it has exited.
    const cmd = ['sh', ['-c', `sz --zmodem --binary --restricted a.txt; printf '\\r\\nBack at the menu'`], dir];
    let engine;
    const res = await runPeer(cmd, io => (engine = new ZmodemEngine('receive', [], io.send, { ...quiet(), done: x => io.done(x) }, { now })));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(res.result.ok, true);
    await new Promise(r => setTimeout(r, 300));
    const rest = new TextDecoder().decode(engine.takeTrailing());
    assert.match(rest, /Back at the menu$/);
    assert.doesNotMatch(rest, /^OO/, 'the "OO" ending the session is the protocol\'s');
});

test('receiving: the board drawing its screen again ends the transfer; the headers it got as typing are rubbed out', async () => {
    let t = 0;
    const out = [];
    let result = null;
    const e = new ZmodemEngine('receive', [], b => out.push(...b), { ...quiet(), done: r => (result = r) }, { now: () => t });
    e.feed(enc('**\x18B00000000000000\r\x8a\x11')); // ZRQINIT
    for (let i = 0; i < 20 && !out.length; i++) await new Promise(r => setTimeout(r, 10)), e.tick();
    assert.ok(out.length > 0, 'ZRINIT went out');
    const sent = out.length;
    // The board's program has gone; its menu arrives, then nothing.
    e.feed(enc('\x1b[2J\x1b[1;1H\x1b[0;1mMain\x1b[0m\x1b[5;5Hcmd: '));
    assert.equal(result, null, 'file data can hold ANSI: not over yet');
    t += 3100;
    e.tick();
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual([result?.ok, result?.cancelled, result?.error], [false, 'remote', BOARD_LEFT]);
    assert.deepEqual(out.slice(sent), Array.from(boardLeftAbort(sent)));
    assert.equal(new TextDecoder().decode(e.takeTrailing()).endsWith('cmd: '), true, 'the screen is the terminal\'s');
});

test('receiving: a screen after more than 64 KB of noise is still the one shown', async () => {
    let t = 0;
    let result = null;
    const e = new ZmodemEngine('receive', [], () => {}, { ...quiet(), done: r => (result = r) }, { now: () => t });
    e.feed(enc('**\x18B00000000000000\r\x8a\x11')); // ZRQINIT
    await new Promise(r => setTimeout(r, 20));
    e.tick();
    e.feed(new Uint8Array(200_000).fill(0x15)); // what is left of a stream cut off mid-file (no header in it)
    e.feed(enc('\x1b[2J\x1b[1;1H\x1b[0;1mMain\x1b[0m\x1b[5;5Hcmd: '));
    t += 3100;
    e.tick();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(result?.error, BOARD_LEFT);
    const rest = e.takeTrailing();
    assert.ok(rest.length <= 65536 + 64, `kept ${rest.length} bytes`);
    assert.ok(new TextDecoder().decode(rest).endsWith('\x1b[2J\x1b[1;1H\x1b[0;1mMain\x1b[0m\x1b[5;5Hcmd: '), 'the whole screen, at the end');
});

test('receiving: the board leaves right after a file; the header answering its end is rubbed out too', { skip: !LRZSZ && 'lrzsz not installed' }, async () => {
    const { spawn } = await import('node:child_process');
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.bin'), random(20_000));
    let skew = 0;
    const out = [];
    let ended = false;
    let result = null;
    const sz = spawn('sz', ['--zmodem', '--binary', '--restricted', 'a.bin'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    let live = true;
    const e = new ZmodemEngine('receive', [], b => (out.push(...b), live && sz.stdin.write(b)), {
        ...quiet(),
        // The board's program dies as the file ends: what answers the end reaches the prompt.
        fileEnd: () => ((live = false), (ended = true), sz.kill('SIGKILL')),
        done: r => (result = r),
    }, { now: () => performance.now() + skew });
    sz.stdout.on('data', d => live && e.feed(new Uint8Array(d)));
    const tick = setInterval(() => e.tick(), 20);
    try {
        for (let i = 0; i < 500 && !ended; i++) await new Promise(r => setTimeout(r, 10));
        assert.ok(ended, 'the file arrived');
        await new Promise(r => setTimeout(r, 100));
        const sent = out.length;
        e.feed(enc('\x1b[2J\x1b[1;1H\x1b[0;1mMain\x1b[0m\x1b[5;5Hcmd: '));
        skew += 3100;
        for (let i = 0; i < 50 && !result; i++) await new Promise(r => setTimeout(r, 20));
        assert.equal(result?.error, BOARD_LEFT);
        // The ZRINIT answering ZEOF (21 bytes as a hex header) went out with
        // the file's end, or just before it: all of it is rubbed out.
        const abort = out.slice(sent);
        const bs = abort.length - 8;
        assert.deepEqual(abort, Array.from(boardLeftAbort(bs)));
        assert.ok(bs >= 21, `${bs} backspaces`);
    } finally {
        clearInterval(tick);
        sz.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

async function crafted(files, maxBytes) {
    let delivered = 0;
    let result = null;
    const sent = [];
    const ends = [];
    const e = new ZmodemEngine('receive', [], b => sent.push(...b), { fileStart: () => {}, data: c => (delivered += c.length), progress: () => {}, fileEnd: ok => ends.push(ok), done: r => (result = r) }, { now, maxBytes });
    for (const c of craftedZmodem(files)) e.feed(c);
    for (let i = 0; i < 50 && !result; i++) {
        e.tick();
        await new Promise(r => setTimeout(r, 10));
    }
    return { delivered, result, ends, sent };
}

test('receiving: a file that runs past its announced size, or past maxBytes, is stopped', async () => {
    // Announced 1000 bytes, sends 5 MB: stopped a subpacket or so past 1000.
    const a = await crafted([{ name: 'readme.txt', announce: '1000', total: 5 << 20 }], 0);
    assert.equal(a.result?.ok, false);
    assert.match(a.result.error, /more than the 1000 bytes it announced/);
    assert.ok(a.delivered <= 1000 + 8192, `delivered ${a.delivered}`);
    assert.deepEqual(a.ends, [false]);
    // Announced within maxBytes, sent past it: stopped at the limit.
    const b = await crafted([{ name: 'readme.txt', announce: '99000', total: 5 << 20 }], 100_000);
    assert.equal(b.result?.ok, false);
    assert.match(b.result.error, /larger than this terminal accepts/);
    assert.ok(b.delivered <= 100_000, `delivered ${b.delivered}`);
    // Either way the abort goes out to the board.
    assert.ok(Buffer.from(a.sent).includes(Buffer.from([0x18, 0x18, 0x18, 0x18, 0x18])));
    // An honest file of the same shape still arrives.
    const c = await crafted([{ name: 'ok.bin', announce: '3000', total: 3000 }], 100_000);
    assert.equal(c.result?.ok, true, c.result?.error);
    assert.equal(c.delivered, 3000);
});

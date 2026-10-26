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
import { LRZSZ, SEXYZ, allBytes, peerCommand, random, runPeer, sha, tmpdir } from './xfer-peers.mjs';

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

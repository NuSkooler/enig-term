// X/YModem (src/transfer/xymodem.ts): CRCs and framing, the sender and
// receiver state machines against each other on a simulated line (with a
// fake clock, status text, corruption, losses), the traps the real remote
// ends set (see the file's header), and interop with sexyz and lrzsz over
// pipes when they are installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    ACK, BS, CAN, CANCEL_SEQ, CRC_REQ, EOT, NAK, SOH, STX, SUB, QUIET_MS, REQUEST_MS,
    XyReceiver, XySender, boardLeftAbort, checksum, crc16, encodeBlock, parseYmodemHeader, safeName, wireName, ymodemHeader,
} from '../src/transfer/xymodem.ts';
import { LRZSZ, SEXYZ, allBytes, peerCommand, random, runPeer, sha, tmpdir } from './xfer-peers.mjs';
import { BOARD_LEFT } from '../src/transfer/types.ts';

const enc = s => new TextEncoder().encode(s);
const src = (name, data, mtime = 0) => ({ name, size: data.length, mtime, read: (o, n) => data.subarray(o, o + n) });
// Resolves later (in a microtask), as a Blob slice would: the sender must wait for it.
const asyncSrc = (name, data) => ({ name, size: data.length, read: (o, n) => Promise.resolve().then(() => data.subarray(o, o + n)) });

/** Collects what a receiver delivers. */
function sink() {
    const files = [];
    let cur = null;
    const ev = {
        log: () => {},
        fileStart: f => (cur = { ...f, parts: [] }),
        data: c => cur.parts.push(Buffer.from(c)),
        fileEnd: ok => {
            files.push({ name: cur.name, size: cur.size, ok, data: Buffer.concat(cur.parts) });
            cur = null;
        },
        progress: () => {},
        done: r => (ev.result = r),
        result: null,
    };
    return { ev, files };
}
const quietEv = () => ({ fileStart: () => {}, fileEnd: () => {}, progress: () => {}, done: r => (quietEv.last = r) });

/**
 * A simulated line between two engines with a fake clock. `mangle(dir, bytes)`
 * may return different bytes (corruption, text, losses). Runs until both are
 * finished or `limit` ms of simulated time pass.
 */
function line({ mangle = (d, b) => b, limit = 600_000, latency = 5 } = {}) {
    let now = 0;
    const q = []; // [deliverAt, to, bytes]
    const clock = () => now;
    const ends = {};
    const toB = b => q.push([now + latency, 'b', mangle('ab', b)]);
    const toA = b => q.push([now + latency, 'a', mangle('ba', b)]);
    return {
        clock,
        sendFromA: toB,
        sendFromB: toA,
        attach(a, b) {
            ends.a = a;
            ends.b = b;
        },
        async run() {
            while (now < limit && !(ends.a.finished && ends.b.finished)) {
                await null; // let asynchronous reads and writes settle
                now += 10;
                q.sort((x, y) => x[0] - y[0]);
                while (q.length && q[0][0] <= now) {
                    const [, to, bytes] = q.shift();
                    if (bytes?.length) ends[to].feed(bytes);
                }
                ends.a.tick();
                ends.b.tick();
            }
            return now;
        },
    };
}

/** Sender (end a) and receiver (end b) of `proto` over a simulated line. */
async function loop(proto, files, opts = {}) {
    const l = line(opts);
    const r = sink();
    const sent = { result: null };
    const sevents = { fileStart: () => {}, fileEnd: () => {}, progress: () => {}, done: x => (sent.result = x), log: opts.log };
    const s = new XySender(proto === 'ymodem' ? 'ymodem' : proto, files, b => l.sendFromA(b), sevents, { now: l.clock, log: opts.log });
    const rv = new XyReceiver(proto === 'ymodem' ? 'ymodem' : 'xmodem', b => l.sendFromB(b), r.ev, { now: l.clock, name: 'x.bin', log: opts.log, maxBytes: opts.maxBytes });
    l.attach(s, rv);
    const ms = await l.run();
    return { sent: sent.result, recv: r.ev.result, files: r.files, ms, s, rv };
}

const padTo = (data, n) => {
    const out = Buffer.alloc(Math.ceil(data.length / n) * n || 0, SUB);
    Buffer.from(data).copy(out);
    return out;
};

test('CRC-16/XMODEM and checksum known values', () => {
    assert.equal(crc16(enc('123456789')), 0x31c3);
    assert.equal(crc16(new Uint8Array(0)), 0);
    assert.equal(checksum(Uint8Array.of(0xff, 0x02)), 0x01);
});

test('block framing: SOH/STX, number and complement, padding, CRC or checksum', () => {
    const b = encodeBlock(1, enc('hi'), 128, true);
    assert.equal(b.length, 133);
    assert.deepEqual([b[0], b[1], b[2], b[3], b[4], b[5]], [SOH, 1, 0xfe, 0x68, 0x69, SUB]);
    assert.equal((b[131] << 8) | b[132], crc16(b.subarray(3, 131)));
    const k = encodeBlock(256 + 7, new Uint8Array(1024).fill(9), 1024, false);
    assert.deepEqual([k.length, k[0], k[1], k[2], k[1027]], [1028, STX, 7, 0xf8, checksum(k.subarray(3, 1027))]);
    assert.equal(encodeBlock(0, new Uint8Array(0), 128, true, 0).subarray(3, 131).every(x => x === 0), true, 'null block is all zero');
    assert.throws(() => encodeBlock(1, new Uint8Array(129), 128, true));
});

test('YModem header: written as lrzsz and sexyz read it, parsed back, names made safe', () => {
    const h = ymodemHeader({ name: 'dir/My File.zip', size: 1234, mtime: 0o1234 * 1000 }, 2, 5000);
    assert.equal(new TextDecoder().decode(h), 'My File.zip\x001234 1234 100644 0 2 5000\x00');
    assert.deepEqual(parseYmodemHeader(h), { name: 'My File.zip', size: 1234, mtime: 0o1234, files: 2, bytes: 5000 });
    assert.deepEqual(parseYmodemHeader(enc('a.txt\0')), { name: 'a.txt', size: null, mtime: null, files: null, bytes: null });
    assert.equal(parseYmodemHeader(new Uint8Array(128)), null, 'empty name: end of batch');
    assert.equal(wireName('C:\\x\\na\u00efve.txt'), 'na_ve.txt');
    assert.equal(safeName('../../etc/passwd'), 'passwd');
    assert.equal(safeName('..'), 'download.bin');
    assert.equal(safeName('a\x1bb:c.txt'), 'a_b_c.txt');
});

test('safeName: no spoofing characters, no dots or spaces at the ends, capped, never empty', () => {
    // Bidi overrides and isolates, marks, zero-width and other format characters go.
    assert.equal(safeName('Invoice_\u202efdp.exe'), 'Invoice_fdp.exe');
    for (const c of ['\u202a', '\u202b', '\u202c', '\u202d', '\u2066', '\u2067', '\u2068', '\u2069', '\u200e', '\u200f', '\u200b', '\u200d', '\u2060', '\ufeff', '\u00ad']) assert.equal(safeName(`a${c}b.txt`), 'ab.txt', `U+${c.codePointAt(0).toString(16)}`);
    // C0, DEL and C1 controls, and line separators, become _.
    assert.equal(safeName('x\u0085y\u009b\x7f\u2028.txt'), 'x_y___.txt');
    // Lookalike slashes cannot make a name look like a path.
    for (const c of ['\u2215', '\u2044', '\uff0f', '\u29f8', '\uff3c', '\u2216', '\ufe68', '\u29f9']) assert.equal(safeName(`etc${c}passwd`), 'etc_passwd', `U+${c.codePointAt(0).toString(16)}`);
    // Dots and spaces at either end, including Unicode spaces.
    assert.equal(safeName(' .. evil.exe. . '), 'evil.exe');
    assert.equal(safeName('\u3000report.pdf\u00a0'), 'report.pdf');
    // Capped at 200 characters (code points: a surrogate pair is not split).
    assert.equal(Array.from(safeName('\u{1F600}'.repeat(300))).length, 60, '240 bytes, not 200 characters');
    assert.equal(safeName('a'.repeat(300)).length, 200);
    assert.equal(safeName('a'.repeat(199) + '. x'), 'a'.repeat(199), 'no trailing dot left by the cap');
    // Nothing left: the fallback.
    for (const n of ['', ' ', '...', '\u202e', '\u200b\u200b', '/']) assert.equal(safeName(n), 'download.bin', JSON.stringify(n));
    assert.equal(safeName('\u2066', 'x.bin'), 'x.bin');
    // Windows device names, with or without an extension, trailing dots or spaces.
    for (const n of ['CON', 'nul', 'COM1', 'lpt9', 'con.txt', 'NUL.tar.gz', 'aux .txt', 'PRN.', 'COM\u00b2']) assert.match(safeName(n), /^_/, n);
    assert.equal(safeName('console.txt'), 'console.txt');
    assert.equal(safeName('com10'), 'com10');
    // Fullwidth and compatibility forms of what Windows refuses, lookalike dots, lone surrogates.
    assert.equal(safeName('a\uff1ab\uff0ac\uff1fd\uff5ce'), 'a_b_c_d_e');
    assert.equal(safeName('\uff0ebashrc'), 'bashrc');
    assert.equal(safeName('a\u2024\ufe52'), 'a');
    assert.equal(safeName('a\ud800b'), 'a_b');
    // At most 240 bytes whatever the characters.
    for (const c of ['\u540d', '\u{1F600}', 'e\u0301', 'a']) assert.ok(Buffer.byteLength(safeName(c.repeat(400))) <= 240, c);
});

for (const proto of ['xmodem', 'xmodem-1k', 'ymodem']) {
    test(`${proto}: loopback, byte-identical (${proto === 'ymodem' ? 'size from the header' : 'SUB padding kept'})`, async () => {
        const data = allBytes(proto === 'xmodem' ? 5000 : 70_000);
        const r = await loop(proto, [src('allbytes.bin', data)]);
        assert.deepEqual([r.sent?.ok, r.recv?.ok], [true, true], JSON.stringify([r.sent, r.recv]));
        assert.equal(r.files.length, 1);
        const want = proto === 'ymodem' ? Buffer.from(data) : padTo(data, 128);
        assert.equal(sha(r.files[0].data), sha(want));
        assert.equal(r.files[0].name, proto === 'ymodem' ? 'allbytes.bin' : 'x.bin');
    });
}

test('ymodem batch: several files (one empty, one asynchronous source), the null block ends it', async () => {
    const files = [src('one.bin', random(1000)), src('empty.bin', new Uint8Array(0)), asyncSrc('two.bin', allBytes(8192 * 3 + 17)), src('three.txt', enc('three\n'.repeat(500)))];
    const seen = [];
    const r = await loop('ymodem', files, { mangle: (d, b) => (d === 'ab' && b[0] === SOH && b[1] === 0 && b.subarray(3, 131).every(x => x === 0) && seen.push('null'), b) });
    assert.deepEqual([r.sent?.ok, r.recv?.ok, r.recv?.files], [true, true, 4], JSON.stringify([r.sent, r.recv]));
    assert.deepEqual(r.files.map(f => [f.name, f.data.length, f.ok]), [['one.bin', 1000, true], ['empty.bin', 0, true], ['two.bin', 24593, true], ['three.txt', 3000, true]]);
    for (const [i, f] of r.files.entries()) assert.equal(sha(f.data), sha(Buffer.from(files[i].name === 'two.bin' ? allBytes(24593) : files[i].read(0, files[i].size))));
    assert.deepEqual(seen, ['null'], 'the batch ends with the null block 0');
});

test('recovers from status text, a flipped byte and a lost block on the line', async () => {
    let n = 0;
    const text = enc('\r\nKByte: 12/70  1024/CRC-16  Time: 0:01/0:05  CPS\r\n');
    const r = await loop('ymodem', [src('a.bin', allBytes(70_000))], {
        mangle: (d, b) => {
            n++;
            if (d === 'ab' && n === 9) return Buffer.concat([text, b]); // text before a block
            if (d === 'ab' && n === 13) return b.map((x, i) => (i === 500 ? x ^ 0x40 : x)); // a flipped byte
            if (d === 'ab' && n === 21) return new Uint8Array(0); // a lost block
            if (d === 'ab' && n === 27) return Buffer.concat([b.subarray(0, 300), text, b.subarray(300)]); // text inside a block
            return b;
        },
    });
    assert.deepEqual([r.sent?.ok, r.recv?.ok], [true, true], JSON.stringify([r.sent, r.recv]));
    assert.equal(sha(r.files[0].data), sha(Buffer.from(allBytes(70_000))));
});

test('random line noise: either byte-identical or a clean failure, never a hang', async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let run = 0; run < 30; run++) {
        const data = random(20_000);
        const r = await loop(run % 2 ? 'ymodem' : 'xmodem-1k', [src('n.bin', data)], {
            limit: 900_000,
            mangle: (_d, b) => {
                const x = rnd();
                if (x < 0.03) return new Uint8Array(0);
                if (x < 0.08) return b.map(v => (rnd() < 0.002 ? v ^ (1 + Math.floor(rnd() * 255)) : v));
                if (x < 0.1) return Buffer.concat([b, enc('CRC-16 C Copyright\r\n')]);
                return b;
            },
        });
        assert.ok(r.s.finished && r.rv.finished, `run ${run} hung`);
        if (r.recv.ok) {
            const want = run % 2 ? Buffer.from(data) : padTo(data, 128);
            assert.equal(sha(r.files[0].data), sha(want), `run ${run}: delivered wrong bytes`);
        }
    }
});

/** Drive one engine by hand: what it sends, with a fake clock. */
function manual(make) {
    let now = 0;
    const out = [];
    const e = make(b => out.push(...b), () => now);
    return {
        e,
        out,
        take: () => out.splice(0),
        feed: b => e.feed(typeof b === 'string' ? enc(b) : Uint8Array.from(b)),
        wait: ms => {
            for (let t = 0; t < ms; t += 10) {
                now += 10;
                e.tick();
            }
        },
    };
}

test('sender: a C inside status text is not a request; a C or NAK followed by silence is, promptly', () => {
    const ev = sink().ev;
    const m = manual((send, now) => new XySender('ymodem', [src('a.bin', enc('hello'))], send, ev, { now }));
    m.feed('Synchronet External X/Y/ZMODEM  Copyright Rob Swindell\r\n');
    m.wait(1000);
    assert.deepEqual(m.take(), [], 'text with C in it starts nothing');
    m.feed([NAK]);
    m.wait(QUIET_MS - 20);
    assert.deepEqual(m.take(), [], 'not before the line has been quiet');
    m.wait(40);
    const b0 = m.take();
    assert.equal(b0.length, 3 + 128 + 1, 'NAK: a checksum block 0');
    assert.deepEqual(b0.slice(0, 3), [SOH, 0, 0xff]);
    // A C in status text right after the block is not a request...
    m.feed('Block 0: Requesting mode: 16-bit CRC\n');
    m.wait(200);
    assert.deepEqual(m.take(), []);
    // ...a C on a quiet line after it is (sexyz's purge threw the block away): send it again.
    m.feed([CRC_REQ]);
    m.wait(QUIET_MS + 20);
    assert.equal(m.take().length, 132);
    m.feed([ACK, CRC_REQ]);
    m.wait(200);
    const b1 = m.take();
    assert.deepEqual([b1.length, b1[0], b1[1], b1[2]], [133, SOH, 1, 0xfe], 'then block 1 with CRC');
    m.feed([ACK]);
    assert.deepEqual(m.take(), [EOT]);
    m.feed([NAK]);
    assert.deepEqual(m.take(), [EOT], 'EOT again after a NAK (double EOT)');
    m.feed([ACK, CRC_REQ]);
    m.wait(200);
    const nul = m.take();
    assert.deepEqual([nul.length, nul[1], nul.slice(3, 131).every(x => x === 0)], [133, 0, true], 'the null block, not CAN');
    m.feed([ACK]);
    assert.equal(ev.result?.ok, true);
    assert.ok(!m.out.includes(CAN));
});

test('sender: the board drawing its screen after the end-of-batch block is a success, before it a failure', () => {
    const screen = '\x1b[2J\x1b[1;1H\x1b[0;1mScanning\x1b[0m\x1b[5;5H...';
    const ev = sink().ev;
    const m = manual((send, now) => new XySender('ymodem', [src('a.bin', enc('x'))], send, ev, { now }));
    m.feed([CRC_REQ]);
    m.wait(200);
    m.feed([ACK, CRC_REQ]);
    m.wait(200);
    m.feed([ACK]);
    m.feed([NAK]);
    m.feed([ACK, CRC_REQ]);
    m.wait(200); // the null block goes out
    m.feed(screen); // no ACK for it: sexyz exited, the board moved on
    assert.equal(ev.result?.ok, true);
    assert.equal(new TextDecoder().decode(m.e.takeTrailing()), screen, 'the screen is the terminal\'s');
    const ev2 = sink().ev;
    const m2 = manual((send, now) => new XySender('ymodem', [src('a.bin', enc('x'))], send, ev2, { now }));
    m2.feed([CRC_REQ]);
    m2.wait(200);
    m2.feed(screen);
    assert.deepEqual([ev2.result?.ok, ev2.result?.cancelled], [false, 'remote']);
    // Block 0 went to a prompt as typing: the abort rubs it out (a prompt
    // holds little, so 256 backspaces at most).
    assert.deepEqual(m2.take().slice(133), Array.from(boardLeftAbort(133)));
    assert.deepEqual(Array.from(boardLeftAbort(133)), [...Array(8).fill(CAN), ...Array(133).fill(BS)]);
    assert.equal(boardLeftAbort(0).length, 8 + 10);
    assert.equal(boardLeftAbort(1 << 20).length, 8 + 256);
});

test('receiver: the board drawing its screen ends the transfer; the requests it got as typing are rubbed out', () => {
    const screen = '\x1b[2J\x1b[1;1H\x1b[0;1mMain\x1b[0m\x1b[5;5Hcmd: ';
    const ev = sink().ev;
    const m = manual((send, now) => new XyReceiver('ymodem', send, ev, { now }));
    m.wait(6100); // 'C' now, then every 3 s
    assert.deepEqual(m.take(), [CRC_REQ, CRC_REQ, CRC_REQ]);
    m.feed(screen);
    assert.deepEqual([ev.result?.ok, ev.result?.cancelled, ev.result?.error], [false, 'remote', BOARD_LEFT]);
    assert.deepEqual(m.take(), Array.from(boardLeftAbort(3)));
});

test('sender: resends on NAK and on silence, gives up after too many errors with CAN', () => {
    const ev = sink().ev;
    const m = manual((send, now) => new XySender('xmodem', [src('a.bin', enc('x'.repeat(200)))], send, ev, { now }));
    m.feed([CRC_REQ]);
    m.wait(200);
    const b1 = m.take();
    m.feed([NAK]);
    assert.deepEqual(m.take(), b1);
    m.wait(10_100);
    assert.deepEqual(m.take(), b1, 'resent after 10 s of silence');
    for (let i = 0; i < 9; i++) m.feed([NAK]);
    assert.equal(ev.result?.ok, false);
    assert.match(ev.result.error, /too many errors/);
    assert.deepEqual(m.take().slice(-20), Array.from(CANCEL_SEQ));
});

test('sender: start timeout, remote CAN CAN, local cancel', () => {
    const ev = sink().ev;
    const m = manual((send, now) => new XySender('ymodem', [src('a.bin', enc('x'))], send, ev, { now, startTimeout: 5000 }));
    m.wait(5100);
    assert.match(ev.result?.error ?? '', /did not start receiving/);
    const ev2 = sink().ev;
    const m2 = manual((send, now) => new XySender('ymodem', [src('a.bin', enc('x'))], send, ev2, { now }));
    m2.feed([CAN, CAN]);
    assert.deepEqual([ev2.result?.ok, ev2.result?.cancelled], [false, 'remote']);
    const ev3 = sink().ev;
    const m3 = manual((send, now) => new XySender('ymodem', [src('a.bin', enc('x'))], send, ev3, { now }));
    m3.e.cancel();
    assert.deepEqual(m3.take(), Array.from(CANCEL_SEQ));
    assert.equal(ev3.result?.cancelled, 'local');
});

test('receiver: C every 3 s; XModem falls back to NAK after three (YModem never); then the start timeout', () => {
    const y = manual((send, now) => new XyReceiver('ymodem', send, sink().ev, { now }));
    y.wait(REQUEST_MS * 4 + 50);
    assert.deepEqual(y.take(), [CRC_REQ, CRC_REQ, CRC_REQ, CRC_REQ, CRC_REQ], 'YModem is CRC-16 by definition');
    const ev = sink().ev;
    const m = manual((send, now) => new XyReceiver('xmodem', send, ev, { now, startTimeout: 20_000 }));
    assert.deepEqual(m.take(), [CRC_REQ]);
    m.wait(REQUEST_MS * 3 + 50);
    assert.deepEqual(m.take(), [CRC_REQ, CRC_REQ, NAK]);
    m.wait(20_000);
    assert.match(ev.result?.error ?? '', /did not start sending/);
    assert.deepEqual(m.take().slice(-20), Array.from(CANCEL_SEQ));
});

test('receiver: skips text, NAKs the first EOT, ACKs the second; trailing bytes go back to the screen', () => {
    const r = sink();
    const m = manual((send, now) => new XyReceiver('xmodem', send, r.ev, { now, name: 'f.txt' }));
    m.take();
    m.feed([...enc('Sending...\r\n'), ...encodeBlock(1, enc('data'), 128, true)]);
    assert.deepEqual(m.take(), [ACK]);
    m.feed([EOT]);
    assert.deepEqual(m.take(), [NAK]);
    m.feed([EOT, ...enc('\r\nTransfer complete')]);
    assert.deepEqual(m.take(), [ACK]);
    assert.deepEqual([r.ev.result?.ok, r.files[0].name, r.files[0].data.length], [true, 'f.txt', 128]);
    assert.equal(new TextDecoder().decode(m.e.takeTrailing()), '\r\nTransfer complete');
});

test('receiver: never falls back to checksums once a block has begun; CRC blocks read as checksum ones switch it back', () => {
    // A block began (then broke off): the sender is there and chose CRC-16.
    const r = sink();
    const m = manual((send, now) => new XyReceiver('xmodem', send, r.ev, { now }));
    m.take();
    m.feed([SOH, 1, 0xfe]);
    m.wait(REQUEST_MS * 4);
    assert.ok(!m.take().includes(NAK), 'still asking for CRC-16');
    m.feed(encodeBlock(1, enc('crc'), 128, true));
    assert.deepEqual(m.take(), [ACK], 'the CRC block is taken');
    // In checksum mode (no block yet, no answer to C), a CRC block puts it back to CRC.
    const r2 = sink();
    const m2 = manual((send, now) => new XyReceiver('xmodem', send, r2.ev, { now }));
    m2.wait(REQUEST_MS * 3 + 50);
    assert.equal(m2.take().at(-1), NAK);
    let blk = encodeBlock(1, enc('data'), 128, true);
    if (blk[131] === encodeBlock(1, enc('data'), 128, false)[131]) blk = encodeBlock(1, enc('datb'), 128, true); // not a chance match
    m2.feed(blk);
    m2.wait(400);
    assert.equal(m2.take().at(-1), CRC_REQ, 'asks for CRC-16 again');
    m2.feed(blk);
    assert.deepEqual(m2.take(), [ACK]);
});

test('receiver: a repeated block is acknowledged and dropped; an out-of-sequence one aborts', () => {
    const r = sink();
    const m = manual((send, now) => new XyReceiver('xmodem', send, r.ev, { now }));
    m.take();
    m.feed(encodeBlock(1, enc('a'), 128, true));
    m.feed(encodeBlock(1, enc('a'), 128, true));
    assert.deepEqual(m.take(), [ACK, ACK]);
    m.feed(encodeBlock(3, enc('c'), 128, true));
    assert.match(r.ev.result?.error ?? '', /lost block sync/);
});

test('receiver: a file over maxBytes is refused (YModem header), and so is a stream that grows past it', async () => {
    const r = await loop('ymodem', [src('big.bin', new Uint8Array(5000))], { maxBytes: 4096 });
    assert.equal(r.recv.ok, false);
    assert.match(r.recv.error, /larger than this terminal accepts/);
    assert.equal(r.sent.ok, false);
    const x = await loop('xmodem-1k', [src('big.bin', new Uint8Array(5000))], { maxBytes: 4096 });
    assert.match(x.recv.error, /larger than this terminal accepts/);
});

test('receiver: an asynchronous sink holds the ACK until the write settles', async () => {
    let release;
    const ev = { ...sink().ev, data: () => new Promise(r => (release = r)) };
    const m = manual((send, now) => new XyReceiver('xmodem', send, ev, { now }));
    m.take();
    m.feed(encodeBlock(1, enc('a'), 128, true));
    assert.deepEqual(m.take(), []);
    m.feed(encodeBlock(2, enc('b'), 128, true)); // queued meanwhile
    release();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(m.take(), [ACK]);
});

// --- interop with the real programs (over pipes) -------------------------------

const realFiles = {
    small: () => [['hello.txt', enc('hello, world\r\n')]],
    allbytes: () => [['allbytes.bin', allBytes(70_000)]],
    batch: () => [['one.bin', random(1000)], ['two.bin', allBytes(8192 * 3 + 17)], ['three.txt', enc('three\n'.repeat(500))]],
    big: () => [['big.bin', random(2 << 20)]],
};

const tick = () => performance.now();

async function weReceive(peer, set, proto, { blockPad, mergeStderr = false }) {
    const dir = tmpdir();
    const files = realFiles[set]();
    for (const [n, d] of files) fs.writeFileSync(path.join(dir, n), d);
    const r = sink();
    const res = await runPeer(peerCommand(peer, dir), io => new XyReceiver(proto, io.send, { ...r.ev, done: x => io.done(x) }, { now: tick, name: files[0][0] }), { mergeStderr });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(res.result.ok, true, `${JSON.stringify(res.result)}\n${res.stderr.slice(-1500)}`);
    assert.equal(res.exit.code, 0, res.stderr.slice(-1500));
    // (the programs send in name order)
    assert.deepEqual(r.files.map(f => f.name), files.map(f => f[0]).sort());
    for (const [n, d] of files) assert.equal(sha(r.files.find(f => f.name === n).data), sha(blockPad ? padTo(d, blockPad) : Buffer.from(d)), `${n} differs`);
}

async function weSend(peer, set, proto, { blockPad, mergeStderr = false }) {
    const dir = tmpdir();
    const files = realFiles[set]();
    const res = await runPeer(peerCommand(peer, dir, { recvName: files[0][0] }), io => new XySender(proto, files.map(([n, d]) => src(n, d)), io.send, { ...quietEv(), done: x => io.done(x) }, { now: tick }), { mergeStderr });
    const got = fs.readdirSync(dir).sort();
    try {
        assert.equal(res.result.ok, true, `${JSON.stringify(res.result)}\n${res.stderr.slice(-1500)}`);
        assert.equal(res.exit.code, 0, res.stderr.slice(-1500));
        assert.deepEqual(got, files.map(f => f[0]).sort());
        for (const [n, d] of files) assert.equal(sha(fs.readFileSync(path.join(dir, n))), sha(blockPad ? padTo(d, blockPad) : Buffer.from(d)), `${n} differs`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const SETS = ['small', 'allbytes', 'big'];
for (const set of SETS) {
    // ENiGMA's XModem (SEXYZ): sX to send (1K blocks), rC to receive (CRC).
    test(`sexyz sX -> us (XModem-1K download, ${set})`, { skip: !SEXYZ && 'sexyz not installed' }, () => weReceive('sexyz sX', set, 'xmodem', { blockPad: 128 }));
    test(`us -> sexyz rC (XModem upload, ${set})`, { skip: !SEXYZ && 'sexyz not installed' }, () => weSend('sexyz rC', set, 'xmodem-1k', { blockPad: 128 }));
    test(`sexyz sx -> us (XModem 128 download, ${set})`, { skip: (!SEXYZ || set === 'big') && 'sexyz not installed / slow' }, () => weReceive('sexyz sx', set, 'xmodem', { blockPad: 128 }));
    test(`lrzsz sx -> us (XModem-1K download, ${set})`, { skip: !LRZSZ && 'lrzsz not installed' }, () => weReceive('sx', set, 'xmodem', { blockPad: 128 }));
    test(`us -> lrzsz rx (XModem upload, ${set})`, { skip: !LRZSZ && 'lrzsz not installed' }, () => weSend('rx', set, 'xmodem-1k', { blockPad: 128 }));
}
for (const set of [...SETS, 'batch']) {
    // ENiGMA's YModem (SEXYZ): sY to send (1K), ry to receive.
    test(`sexyz sY -> us (YModem download, ${set})`, { skip: !SEXYZ && 'sexyz not installed' }, () => weReceive('sexyz sY', set, 'ymodem', {}));
    test(`us -> sexyz ry (YModem upload, ${set})`, { skip: !SEXYZ && 'sexyz not installed' }, () => weSend('sexyz ry', set, 'ymodem', {}));
    test(`lrzsz sb -> us (YModem download, ${set})`, { skip: !LRZSZ && 'lrzsz not installed' }, () => weReceive('sb', set, 'ymodem', {}));
    test(`us -> lrzsz rb (YModem upload, ${set})`, { skip: !LRZSZ && 'lrzsz not installed' }, () => weSend('rb', set, 'ymodem', {}));
}

// Under ENiGMA sexyz runs on a pty: its status text ("Copyright", "CRC-16", progress) is in the stream.
for (const set of ['allbytes', 'batch']) {
    test(`sexyz sY -> us with its status text in the stream (${set})`, { skip: !SEXYZ && 'sexyz not installed' }, () => weReceive('sexyz sY', set, 'ymodem', { mergeStderr: true }));
    test(`us -> sexyz ry with its status text in the stream (${set})`, { skip: !SEXYZ && 'sexyz not installed' }, () => weSend('sexyz ry', set, 'ymodem', { mergeStderr: true }));
}
test('sexyz sX -> us and us -> sexyz rC with status text in the stream', { skip: !SEXYZ && 'sexyz not installed' }, async () => {
    await weReceive('sexyz sX', 'allbytes', 'xmodem', { blockPad: 128, mergeStderr: true });
    await weSend('sexyz rC', 'allbytes', 'xmodem-1k', { blockPad: 128, mergeStderr: true });
});

test('us -> sexyz ry, cancelled from our side mid-file: both ends stop, sexyz fails', { skip: !SEXYZ && 'sexyz not installed' }, async () => {
    const dir = tmpdir();
    let engine;
    const res = await runPeer(
        peerCommand('sexyz ry', dir),
        io => (engine = new XySender('ymodem', [src('big.bin', random(4 << 20))], io.send, { ...quietEv(), done: x => io.done(x) }, { now: tick })),
        { onBytes: n => n > 500_000 && !engine.finished && engine.cancel('test') },
    );
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual([res.result.ok, res.result.cancelled], [false, 'local']);
    assert.notEqual(res.exit.code, 0, 'the board sees a failed transfer');
    assert.ok(res.ms < 20_000, `took ${res.ms} ms`);
});

test('sexyz sY -> us, the board aborts mid-file (SIGINT): we stop with a remote cancel or a clean error', { skip: !SEXYZ && 'sexyz not installed' }, async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'big.bin'), random(4 << 20));
    const r = sink();
    let killed = false;
    const res = await runPeer(peerCommand('sexyz sY', dir), io => new XyReceiver('ymodem', io.send, { ...r.ev, done: x => io.done(x) }, { now: tick }), {
        onBytes: (n, io) => {
            if (n > 500_000 && !killed) {
                killed = true;
                io.kill('SIGINT');
            }
        },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(res.result.ok, false);
    assert.ok(!res.result.hung, 'the receiver did not hang');
    assert.equal(r.files.at(-1)?.ok, false, 'the partial file is reported as abandoned');
});

test('receiver: a screen after more than 64 KB of noise is still the one shown', () => {
    const ev = sink().ev;
    const m = manual((send, now) => new XyReceiver('ymodem', send, ev, { now }));
    m.feed(new Array(200_000).fill(0x2e)); // text that is not the protocol
    m.feed('\x1b[2J\x1b[1;1H\x1b[0;1mMain\x1b[0m\x1b[5;5Hcmd: ');
    assert.equal(ev.result?.error, BOARD_LEFT);
    const rest = m.e.takeTrailing();
    assert.ok(rest.length <= 65536 + 64, `kept ${rest.length} bytes`);
    assert.ok(new TextDecoder().decode(rest).endsWith('\x1b[2J\x1b[1;1H\x1b[0;1mMain\x1b[0m\x1b[5;5Hcmd: '), 'the whole screen');
});

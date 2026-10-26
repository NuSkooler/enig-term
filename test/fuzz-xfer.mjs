// Fuzzer for the transfer engines' receive paths: what a board (or line
// noise, or a hostile board) can send. Valid sessions are recorded by
// running each engine against its counterpart, then mutated (bytes flipped,
// runs of CAN, ZDLE, ANSI and status text inserted, ranges dropped,
// repeated or cut short), split into random chunks and fed back with a
// clock that jumps about. Every engine must end (done() once, no hang once
// time runs on), never throw, never deliver more than its limit, and the
// ZModem WASM must never trap. The ZModem start detector must partition its
// input losslessly.
//
//   node test/fuzz-xfer.mjs [seconds=30] [seed]
//
// The unit tests run a short fixed-seed pass (transfer.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rng } from './fuzz-core.mjs';
import { XyReceiver, XySender } from '../src/transfer/xymodem.ts';
import { ZmodemEngine, loadZmodem } from '../src/transfer/zmodem.ts';
import { ZmodemDetector } from '../src/transfer/detect.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadZmodem(fs.readFileSync(path.join(here, '..', 'build', 'wasm-zmodem', 'enig_term_zmodem_bg.wasm')));

const enc = s => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
const concat = parts => {
    const n = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
};

function files(r) {
    const n = 1 + r.int(3);
    return Array.from({ length: n }, (_, i) => {
        const size = r.pick([0, 1, 127, 128, 129, 1000, 1024, 3000, 9000]);
        const data = new Uint8Array(size).map(() => r.int(256));
        return { name: `f${i}.bin`, size, read: (o, k) => data.subarray(o, o + k) };
    });
}

const quiet = () => ({ fileStart() {}, data() {}, fileEnd() {}, fileSkipped() {}, progress() {}, done() {} });

/** Run engine a against engine b on a perfect line with a fake clock; record what each sent. */
async function record(makeA, makeB) {
    let now = 0;
    const clock = () => now;
    const toB = [];
    const toA = [];
    const sentA = [];
    const sentB = [];
    const a = makeA(x => (toB.push(x.slice()), sentA.push(x.slice())), clock);
    const b = makeB(x => (toA.push(x.slice()), sentB.push(x.slice())), clock);
    for (let i = 0; i < 20000 && !(a.finished && b.finished); i++) {
        await null;
        now += 10;
        for (const x of toB.splice(0)) b.feed(x);
        for (const x of toA.splice(0)) a.feed(x);
        a.tick();
        b.tick();
    }
    return { fromA: concat(sentA), fromB: concat(sentB) };
}

const NOISE = [
    enc('\r\nKByte: 12/70  1024/CRC-16  Time: 0:01  CPS 100%\r\n'),
    enc('Synchronet External X/Y/ZMODEM  Copyright Rob Swindell\r\n'),
    enc('\x1b[2J\x1b[1;1H\x1b[0;1;33mMain menu\x1b[0m\r\n\x1b[5;10Hchoice: '),
    Uint8Array.from([0x18, 0x18, 0x18, 0x18, 0x18]),
    Uint8Array.from([0x18, 0x18, 0x18, 0x18, 0x18, 0x08, 0x08, 0x08, 0x08, 0x08]),
    enc('**\x18B0100000023be50\r\x8a\x11'),
    enc('**\x18B00000000000000\r\x8a\x11'),
    Uint8Array.from([0x18, 0x68, 0x18, 0x69, 0x18, 0x6a, 0x18, 0x6b]), // ZDLE frame ends
    Uint8Array.from([0x01, 0x00, 0xff]),
    Uint8Array.from([0x02, 0x05, 0xfa]),
    Uint8Array.from([0x04, 0x04, 0x06, 0x15, 0x43]),
];

function mutate(r, b) {
    let out = b.slice();
    const n = r.int(6);
    for (let i = 0; i < n; i++) {
        const at = r.int(out.length + 1);
        switch (r.int(7)) {
            case 0: // flip bytes
                for (let k = 0; k < 1 + r.int(4) && out.length; k++) out[r.int(out.length)] ^= 1 + r.int(255);
                break;
            case 1: // insert noise
                out = concat([out.subarray(0, at), r.pick(NOISE), out.subarray(at)]);
                break;
            case 2: // drop a range
                out = concat([out.subarray(0, at), out.subarray(Math.min(out.length, at + r.int(2000)))]);
                break;
            case 3: // repeat a range
                out = concat([out.subarray(0, at + 1), out.subarray(Math.max(0, at - r.int(1500)), at + 1), out.subarray(at + 1)]);
                break;
            case 4: // cut short
                out = out.subarray(0, at);
                break;
            case 5: // random bytes
                out = concat([out.subarray(0, at), new Uint8Array(r.int(300)).map(() => r.int(256)), out.subarray(at)]);
                break;
            default:
                break;
        }
    }
    return out;
}

/** Feed `input` to an engine in random chunks with a jumping clock; then let time run out. */
export async function drive(r, make, input, limit) {
    let now = 0;
    let dones = 0;
    let delivered = 0;
    let sent = 0;
    let ok = null;
    let cur = null;
    const complete = [];
    const ev = {
        ...quiet(),
        fileStart: f => (cur = { name: f.name, parts: [] }),
        data: c => {
            delivered += c.length;
            if (cur && delivered <= 4 * limit) cur.parts.push(c.slice());
        },
        fileEnd: good => {
            if (cur && good) complete.push({ name: cur.name, data: concat(cur.parts) });
            cur = null;
        },
        done: r => {
            dones++;
            ok = r.ok;
        },
    };
    const e = make(x => (sent += x.length), () => now, ev);
    let off = 0;
    while (off < input.length) {
        const n = 1 + r.int(r.next() < 0.5 ? 64 : 4096);
        e.feed(input.subarray(off, off + n));
        off += n;
        now += r.next() < 0.1 ? r.int(15000) : r.int(30);
        e.tick();
        if (r.next() < 0.3) await null;
    }
    // No more input: every engine must give up by itself.
    for (let t = 0; t < 400 && !e.finished; t++) {
        now += 1000;
        e.tick();
        await null;
    }
    return { finished: e.finished, dones, ok, delivered, sent, trailing: e.takeTrailing().length, complete };
}

let recorded = null;
const fixed = sizes =>
    sizes.map((size, i) => {
        const data = new Uint8Array(size).map((_, k) => (k * 131 + i * 7) & 0xff);
        return { name: `s${i}.bin`, size, read: (o, k) => data.subarray(o, o + k) };
    });

export async function sessions() {
    if (recorded) return recorded;
    const fs1 = fixed([3000, 0, 20000]);
    const ymodem = await record(
        (s, now) => new XySender('ymodem', fs1, s, quiet(), { now }),
        (s, now) => new XyReceiver('ymodem', s, quiet(), { now }),
    );
    const xmodem = await record(
        (s, now) => new XySender('xmodem-1k', fixed([5000]), s, quiet(), { now }),
        (s, now) => new XyReceiver('xmodem', s, quiet(), { now }),
    );
    const zmodem = await record(
        (s, now) => new ZmodemEngine('send', fs1, s, quiet(), { now }),
        (s, now) => new ZmodemEngine('receive', [], s, quiet(), { now }),
    );
    const byName = fs => new Map(fs.map(f => [f.name, f.read(0, f.size)]));
    const pad = b => concat([b, new Uint8Array((128 - (b.length % 128)) % 128).fill(0x1a)]);
    // (the XModem receiver names its file 'download.bin')
    recorded = { ymodem: { ...ymodem, files: byName(fs1) }, xmodem: { ...xmodem, files: new Map([['download.bin', pad(fixed([5000])[0].read(0, 5000))]]) }, zmodem: { ...zmodem, files: byName(fs1) } };
    return recorded;
}

const LIMIT = 50_000;

export async function fuzzXfer({ seconds = 20, seed = 1, cases = Infinity, log = () => {} } = {}) {
    const s = await sessions();
    if (!s.zmodem.fromA.length || !s.zmodem.fromB.length) throw new Error('could not record a ZModem session');
    const end = Date.now() + seconds * 1000;
    const failures = [];
    const stats = {};
    let done = 0;
    for (; done < cases && Date.now() < end; done++) {
        const caseSeed = (seed + done * 0x9e3779b1) >>> 0;
        const r = rng(caseSeed);
        const kind = r.pick(['y-recv', 'x-recv', 'y-send', 'z-recv', 'z-send', 'detect']);
        try {
            if (kind === 'detect') {
                const det = new ZmodemDetector();
                const input = mutate(r, concat([enc('text * ** *'), r.pick([s.zmodem.fromA, s.zmodem.fromB]).subarray(0, 200), enc('tail')]));
                const out = [];
                let started = false;
                for (let off = 0; off < input.length && !started; ) {
                    const n = 1 + r.int(20);
                    const res = det.scan(input.subarray(off, off + n));
                    out.push(res.screen);
                    if (res.start) {
                        out.push(res.start.bytes);
                        started = true;
                        out.push(input.subarray(off + n));
                    }
                    off += n;
                }
                if (!started) out.push(det.flush());
                const got = concat(out);
                if (got.length !== input.length || got.some((v, i) => v !== input[i])) throw new Error('detector lost or changed bytes');
                continue;
            }
            const input =
                kind === 'y-recv' ? mutate(r, s.ymodem.fromA) : kind === 'x-recv' ? mutate(r, s.xmodem.fromA) : kind === 'y-send' ? mutate(r, s.ymodem.fromB) : kind === 'z-recv' ? mutate(r, s.zmodem.fromA) : mutate(r, s.zmodem.fromB);
            const make = (send, now, ev) => {
                const fs1 = files(rng(caseSeed ^ 0x5555));
                if (kind === 'y-recv') return new XyReceiver('ymodem', send, ev, { now, maxBytes: LIMIT });
                if (kind === 'x-recv') return new XyReceiver('xmodem', send, ev, { now, maxBytes: LIMIT });
                if (kind === 'y-send') return new XySender('ymodem', fs1, send, ev, { now });
                if (kind === 'z-recv') return new ZmodemEngine('receive', [], send, ev, { now, maxBytes: LIMIT });
                return new ZmodemEngine('send', fs1, send, ev, { now });
            };
            const res = await drive(r, make, input, LIMIT);
            const st = (stats[kind] ??= { cases: 0, ok: 0, bytes: 0 });
            st.cases++;
            st.ok += res.ok ? 1 : 0;
            st.bytes += input.length;
            if (!res.finished) throw new Error('did not end');
            if (res.dones !== 1) throw new Error(`done() called ${res.dones} times`);
            if (res.delivered > LIMIT + 8192) throw new Error(`delivered ${res.delivered} bytes past the limit`);
            if (res.trailing > input.length + 65536) throw new Error(`trailing ${res.trailing} bytes`);
            // Every file a receiver calls complete is byte-identical (a replay cannot repair damage, so damage must be caught).
            const want = kind === 'y-recv' ? s.ymodem.files : kind === 'x-recv' ? s.xmodem.files : kind === 'z-recv' ? s.zmodem.files : null;
            // (XModem has no size: a file cut short at a block boundary, then EOT, cannot be told
            // from a shorter file; it must still be a prefix of what was sent.)
            for (const f of want ? res.complete : []) {
                const w = want.get(f.name);
                const n = kind === 'x-recv' ? f.data.length : w?.length;
                if (!w || f.data.length !== n || n > w.length || f.data.some((v, i) => v !== w[i])) throw new Error(`${f.name} complete but wrong (${f.data.length} bytes, want ${w?.length})`);
            }
        } catch (e) {
            failures.push({ seed: caseSeed, kind, message: String(e?.message ?? e) });
            log(`FAIL seed=${caseSeed} ${kind}: ${e?.message ?? e}`);
        }
    }
    return { cases: done, failures, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const seconds = Number(process.argv[2] ?? 30);
    const seed = process.argv[3] !== undefined ? Number(process.argv[3]) : (Date.now() & 0xffffffff) >>> 0;
    console.log(`fuzz-xfer: ${seconds}s, seed ${seed}`);
    const res = await fuzzXfer({ seconds, seed, log: m => console.log(m) });
    console.log(`fuzz-xfer: ${res.cases} cases, ${res.failures.length} failures`);
    for (const [k, v] of Object.entries(res.stats)) console.log(`  ${k}: ${v.cases} cases, ${v.ok} ended ok, ${v.bytes} bytes fed`);
    process.exit(res.failures.length ? 1 : 0);
}

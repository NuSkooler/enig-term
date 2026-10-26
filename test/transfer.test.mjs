// The transfer pieces outside the protocol engines: the ZModem start
// detector, the text-after-protocol filter, reading a picked File in
// pieces, and a fixed-seed pass of the transfer fuzzer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ZmodemDetector } from '../src/transfer/detect.ts';
import { fileSource } from '../src/transfer/save.ts';
import { textTail } from '../src/transfers.ts';

const enc = s => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
const dec = b => String.fromCharCode(...b);
// lrzsz's real ZRQINIT and ZRINIT (CRCs included).
const ZRQINIT = '**\x18B00000000000000\r\x8a\x11';
const ZRINIT = '**\x18B0100000023be50\r\x8a\x11';

test('detector: ZRQINIT is a download, ZRINIT an upload; text before it goes to the screen', () => {
    const d = new ZmodemDetector();
    const r = d.scan(enc(`rz\r${ZRQINIT}more`));
    assert.equal(dec(r.screen), 'rz\r');
    assert.equal(r.start?.kind, 'download');
    assert.equal(dec(r.start.bytes), `${ZRQINIT}more`);
    const u = new ZmodemDetector().scan(enc(`Ready.\r\n${ZRINIT}`));
    assert.deepEqual([dec(u.screen), u.start?.kind], ['Ready.\r\n', 'upload']);
});

test('detector: a header split over chunks (at every point) is still found; nothing of it is drawn', () => {
    const s = `text *${ZRQINIT}tail`;
    for (let cut = 0; cut <= s.length; cut++) {
        const d = new ZmodemDetector();
        const a = d.scan(enc(s.slice(0, cut)));
        const b = a.start ? null : d.scan(enc(s.slice(cut)));
        const start = a.start ?? b?.start;
        assert.equal(start?.kind, 'download', `cut ${cut}`);
        const screen = dec(a.screen) + (b ? dec(b.screen) : '');
        assert.equal(screen, 'text *', `cut ${cut}`);
        assert.equal(dec(start.bytes) + (a.start ? s.slice(cut) : ''), `${ZRQINIT}tail`, `cut ${cut}`);
    }
});

test('detector: look-alikes are text (bad CRC, other header types, stars), and a held prefix comes out on flush', () => {
    const d = new ZmodemDetector();
    for (const t of ['**\x18B00000000000001\r', '**\x18B0400000000a1b2\r', '***** stars *****', '**\x18Bxyz', '*\x18B00']) {
        const r = d.scan(enc(t));
        assert.equal(r.start, undefined, JSON.stringify(t));
        assert.equal(dec(r.screen) + dec(d.flush()), t);
    }
    const h = new ZmodemDetector();
    assert.equal(dec(h.scan(enc('prompt **\x18B0')).screen), 'prompt ');
    assert.equal(h.holding, true);
    assert.equal(dec(h.flush()), '**\x18B0');
});

test('textTail: the text after the last protocol byte', () => {
    assert.equal(dec(textTail(enc('\x18h\x00\x02binary\x05\r\n\x1b[1;33mBack at the menu\x1b[0m\r\n'))), '\r\n\x1b[1;33mBack at the menu\x1b[0m\r\n');
    assert.equal(textTail(enc('\x01\x02\x03')).length, 0);
    assert.equal(dec(textTail(enc('plain text'))), 'plain text');
});

test('fileSource reads a File a piece at a time, one piece ahead, and serves blocks from it', async () => {
    const data = new Uint8Array(3 << 20).map((_, i) => (i * 7) & 0xff);
    const file = new File([data], 'big.bin');
    let reads = 0;
    const slice = file.slice.bind(file);
    file.slice = (...a) => (reads++, slice(...a));
    const src = fileSource(file);
    assert.deepEqual([src.name, src.size], ['big.bin', data.length]);
    for (let off = 0; off < data.length; off += 1024) {
        const b = await src.read(off, 1024);
        assert.equal(b.length, 1024);
        if (off % 65536 === 0) assert.deepEqual(Array.from(b.subarray(0, 4)), Array.from(data.subarray(off, off + 4)), `at ${off}`);
    }
    assert.ok(reads <= 4, `${reads} reads for 3 MB`);
    // a seek back (a ZRPOS) and a read across a piece boundary
    assert.deepEqual(Array.from(await src.read(10, 3)), Array.from(data.subarray(10, 13)));
    assert.deepEqual(Array.from(await src.read((1 << 20) - 2, 4)), Array.from(data.subarray((1 << 20) - 2, (1 << 20) + 2)));
});

test('fuzz smoke: 600 fixed-seed cases through the X/YModem and ZModem engines and the detector', async () => {
    const { fuzzXfer } = await import('./fuzz-xfer.mjs');
    const res = await fuzzXfer({ seconds: 120, seed: 2026, cases: 600 });
    assert.equal(res.cases, 600);
    assert.deepEqual(res.failures, []);
});

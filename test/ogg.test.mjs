// Node tests for the bundled Ogg fallback decoders (src/audio/ogg.ts): the
// demuxer and the limits that keep a hostile file from freezing the tab or
// exhausting its memory. The decoders themselves are covered in the browser
// (audio.spec.ts, "the bundled Ogg Vorbis and Opus decoders work here").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeOgg, demux, MAX_CHANNELS } from '../src/audio/ogg.ts';

const fixture = f => new Uint8Array(fs.readFileSync(new URL(`./fixtures/audio/${f}`, import.meta.url)));

/** One Ogg page (the demuxer does not check the CRC, so it is left 0). */
function page(seq, granule, packets, flags = 0) {
    const lacing = [];
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
    return Buffer.concat([h, ...packets.map(p => Buffer.from(p))]);
}

/** An Opus file of `channels` mono streams, each packet 60 ms of SILK silence per stream. */
function opusFile(channels, packets) {
    const head = Buffer.alloc(21 + channels);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1;
    head[9] = channels;
    head.writeUInt32LE(48000, 12);
    head[18] = 255;
    head[19] = channels;
    for (let i = 0; i < channels; i++) head[21 + i] = i;
    // Self-delimited frames for all but the last stream: TOC, length 0.
    const pk = Buffer.alloc((channels - 1) * 2 + 1);
    for (let s = 0; s < channels - 1; s++) pk[s * 2] = 3 << 3;
    pk[(channels - 1) * 2] = 3 << 3;
    const pages = [page(0, 0, [head], 2), page(1, 0, [Buffer.from('OpusTags\0\0\0\0\0\0\0\0', 'latin1')])];
    for (let i = 0; i < packets; i++) pages.push(page(2 + i, 2880 * (i + 1), [pk]));
    return new Uint8Array(Buffer.concat(pages));
}

const pcmBytes = r => r.channelData.length * r.channelData[0].length * 4;
/** Channels decoded (0: refused); not the result itself, which assert would print in full. */
const channels = async b => (await decodeOgg(b))?.channelData.length ?? 0;

test('the fixtures decode in full under the default budget', async () => {
    const v = await decodeOgg(fixture('vorbis.ogg'));
    assert.equal(v.channelData.length, 1);
    assert.equal(v.channelData[0].length, 6000);
    const o = await decodeOgg(fixture('opus.opus'));
    assert.equal(o.channelData.length, 1);
    assert.equal(o.channelData[0].length, 12000);
});

test('decoded PCM stops at the byte budget (samples x channels x 4)', async () => {
    for (const f of ['vorbis.ogg', 'opus.opus']) {
        const r = await decodeOgg(fixture(f), 8000);
        assert.ok(r, f);
        assert.ok(pcmBytes(r) <= 8000, `${f}: ${pcmBytes(r)} B`);
        assert.ok(r.channelData[0].length > 0, f);
    }
    // An 8-channel Opus file: the budget counts every channel.
    const r = await decodeOgg(opusFile(8, 20), 8 * 4 * 10000);
    assert.equal(r.channelData.length, 8);
    assert.ok(r.channelData[0].length <= 10000, String(r.channelData[0].length));
});

test(`more than ${MAX_CHANNELS} channels is refused before decoding (the 255-channel Opus bomb)`, async () => {
    assert.equal(MAX_CHANNELS, 8);
    const t = performance.now();
    assert.equal(await channels(opusFile(255, 40)), 0);
    assert.equal(await channels(opusFile(9, 4)), 0);
    assert.ok(performance.now() - t < 1000);
    // A Vorbis identification header that claims 9 channels.
    const v = fixture('vorbis.ogg');
    const at = Buffer.from(v).indexOf('\x01vorbis', 0, 'latin1');
    v[at + 11] = 9;
    assert.equal(await channels(v), 0);
});

test('pages and packets are capped, and empty packets cost nothing', () => {
    // Pages of 255 empty packets each (no body): 15 million packets in 16 MB before.
    const empty = new Uint8Array(27 + 255);
    empty.set([0x4f, 0x67, 0x67, 0x53, 0]);
    empty[26] = 255;
    const n = Math.floor((4 << 20) / empty.length);
    const b = new Uint8Array(n * empty.length);
    for (let i = 0; i < n; i++) b.set(empty, i * empty.length);
    let t = performance.now();
    assert.equal(demux(b)?.packets.length ?? 0, 0);
    assert.ok(performance.now() - t < 1000, `${performance.now() - t} ms`);
    // 300000 pages of one 1-byte packet each: over both caps.
    const tiny = Buffer.from(page(0, 0, [Buffer.from([1])]));
    const many = new Uint8Array(tiny.length * 300000);
    for (let i = 0; i < 300000; i++) many.set(tiny, i * tiny.length);
    t = performance.now();
    assert.equal(demux(many)?.packets.length ?? 0, 0);
    assert.ok(performance.now() - t < 2000, `${performance.now() - t} ms`);
});

test('a Vorbis file of 200000 small packets decodes (no spread of every packet into Math.max)', async () => {
    const s = demux(fixture('vorbis.ogg'));
    const pk = s.packets[4];
    const pages = [page(0, 0, [s.packets[0]], 2), page(1, 0, [s.packets[1], s.packets[2]])];
    for (let i = 0; i < 1000; i++) pages.push(page(2 + i, 6000 * (i + 1), Array.from({ length: 200 }, () => pk)));
    const r = await decodeOgg(new Uint8Array(Buffer.concat(pages)), 1 << 16);
    assert.ok(r && r.channelData[0].length > 0);
    assert.ok(pcmBytes(r) <= 1 << 16);
});

// Ogg Vorbis and Ogg Opus decoding for browsers whose decodeAudioData cannot
// (older Safari). Loaded only when the browser's own decoder refused an Ogg
// file (dist/enig-term-ogg.js), as a module Worker so the engine can stop a
// decode that runs too long (see the end of this file), or imported where a
// Worker is not available.
//
// The codecs are libvorbis and libopus compiled to WebAssembly by eshaz's
// wasm-audio-decoders (@wasm-audio-decoders/ogg-vorbis, opus-decoder; MIT,
// the libraries BSD-3-Clause). Their Ogg demuxing package (codec-parser) is
// LGPL, so it is not used: the small Ogg page reader below is enig-term's own.

// @ts-expect-error: the package's types do not declare the class (it is exported).
import { WASMAudioDecoderCommon } from '@wasm-audio-decoders/common';
import { OpusDecoder } from 'opus-decoder';
// The package exports only its codec-parser (LGPL) based wrapper; the WASM module itself is MIT.
// @ts-expect-error: no types for the generated module.
import VorbisWASM from '../../node_modules/@wasm-audio-decoders/ogg-vorbis/src/EmscriptenWasm.js';

export interface Decoded {
    channelData: Float32Array[];
    sampleRate: number;
}

/** Most samples per channel decoded (about 300 s at 48 kHz, plus a margin); the engine refuses longer anyway. */
const MAX_SAMPLES = 48000 * 301;
/** Most channels decoded (7.1); a file with more is refused, not mixed down. */
export const MAX_CHANNELS = 8;
/** Default PCM budget (the engine passes its audioMemory). */
const MAX_BYTES = 192 << 20;

/**
 * Most pages and packets read from one file (more is refused). 300 s of Opus
 * in 2.5 ms frames is 120000 packets; a hostile file of empty pages or
 * packets would otherwise cost memory per page or packet, not per byte.
 */
const MAX_PAGES = 1 << 18;
const MAX_PACKETS = 1 << 18;

interface Stream {
    packets: Uint8Array[];
    /** Granule position of the last page that had one (-1: none). */
    granule: number;
}

/** Read the first logical stream's packets out of an Ogg file. */
export function demux(b: Uint8Array): Stream | null {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let off = 0;
    let serial: number | null = null;
    const packets: Uint8Array[] = [];
    const partial: Uint8Array[] = [];
    let granule = -1;
    let total = 0;
    let pages = 0;
    while (off + 27 <= b.length) {
        if (b[off] !== 0x4f || b[off + 1] !== 0x67 || b[off + 2] !== 0x67 || b[off + 3] !== 0x53 || b[off + 4] !== 0) {
            // Resync on the next capture pattern.
            off++;
            continue;
        }
        const lo = dv.getUint32(off + 6, true);
        const hi = dv.getInt32(off + 10, true);
        const ser = dv.getUint32(off + 14, true);
        const nseg = b[off + 26];
        if (off + 27 + nseg > b.length) break;
        let size = 0;
        for (let i = 0; i < nseg; i++) size += b[off + 27 + i];
        const body = off + 27 + nseg;
        if (body + size > b.length) break;
        if (++pages > MAX_PAGES) return null;
        if (serial === null) serial = ser;
        if (ser === serial) {
            if (hi !== -1 || lo !== 0xffffffff) granule = hi * 2 ** 32 + lo;
            let p = body;
            for (let i = 0; i < nseg; i++) {
                const len = b[off + 27 + i];
                if (len) partial.push(b.subarray(p, p + len));
                p += len;
                // An empty packet carries nothing to decode (Opus treats it as a lost one).
                if (len < 255 && partial.length) {
                    const n = partial.reduce((s, x) => s + x.length, 0);
                    const pkt = new Uint8Array(n);
                    let o = 0;
                    for (const x of partial) {
                        pkt.set(x, o);
                        o += x.length;
                    }
                    packets.push(pkt);
                    partial.length = 0;
                    total += n;
                    if (total > 64 << 20 || packets.length > MAX_PACKETS) return null;
                }
            }
        }
        off = body + size;
    }
    return packets.length ? { packets, granule } : null;
}

const ascii = (p: Uint8Array, at: number, n: number) => String.fromCharCode(...p.subarray(at, at + n));

/**
 * Decode an Ogg Vorbis or Opus file. `maxBytes` bounds the decoded PCM
 * (samples x channels x 4 bytes): decoding stops there, so a small file that
 * claims many channels or a long stream cannot allocate more.
 */
export async function decodeOgg(bytes: Uint8Array, maxBytes = MAX_BYTES): Promise<Decoded | null> {
    const s = demux(bytes);
    if (!s) return null;
    const first = s.packets[0];
    if (first.length >= 16 && first[0] === 1 && ascii(first, 1, 6) === 'vorbis') return decodeVorbis(s, maxBytes);
    if (first.length >= 19 && ascii(first, 0, 8) === 'OpusHead') return decodeOpus(s, maxBytes);
    return null;
}

/** Samples per channel that fit both MAX_SAMPLES and the byte budget. */
const sampleCap = (channels: number, maxBytes: number) => Math.min(MAX_SAMPLES, Math.floor(maxBytes / (channels * 4)));

function concat(parts: Float32Array[][], channels: number, limit: number): Float32Array[] {
    let n = 0;
    for (const p of parts) n += p[0]?.length ?? 0;
    n = Math.min(n, limit);
    const out = Array.from({ length: channels }, () => new Float32Array(n));
    let at = 0;
    for (const p of parts) {
        const len = Math.min(p[0]?.length ?? 0, n - at);
        if (len <= 0) break;
        for (let c = 0; c < channels; c++) out[c].set((p[c] ?? p[0]).subarray(0, len), at);
        at += len;
    }
    return out;
}

interface Common {
    wasm: Record<string, (...a: number[]) => number> & { HEAP: ArrayBuffer };
    allocateTypedArray<T extends Uint8Array | Uint32Array | Int32Array>(len: number, t: { new (b: ArrayBuffer, o: number, l: number): T }): { ptr: number; buf: T };
    free(): void;
}

async function decodeVorbis(s: Stream, maxBytes: number): Promise<Decoded | null> {
    if (s.packets.length < 3) return null;
    const [id, , setup] = s.packets;
    // Identification header: channel count at 11.
    const declared = id[11];
    if (!declared || declared > MAX_CHANNELS) return null;
    const cap = sampleCap(declared, maxBytes);
    const common = (await new (WASMAudioDecoderCommon as unknown as new () => { instantiate(w: unknown, m: unknown): Promise<Common> })().instantiate(VorbisWASM, undefined)) as Common;
    // (A loop: spreading every packet into Math.max overflows the stack.)
    let maxIn = 128 * 1024;
    for (const p of s.packets) if (p.length > maxIn) maxIn = p.length;
    const input = common.allocateTypedArray(maxIn, Uint8Array);
    const inputLen = common.allocateTypedArray(1, Uint32Array);
    const outPtr = common.allocateTypedArray(1, Uint32Array);
    const channels = common.allocateTypedArray(1, Uint32Array);
    const rate = common.allocateTypedArray(1, Uint32Array);
    const samples = common.allocateTypedArray(1, Uint32Array);
    const errors = common.allocateTypedArray(256, Uint32Array);
    const errLen = common.allocateTypedArray(1, Int32Array);
    const w = common.wasm;
    const dec = w.create_decoder(input.ptr, inputLen.ptr, outPtr.ptr, channels.ptr, rate.ptr, samples.ptr, errors.ptr, errLen.ptr, 256);
    const send = (p: Uint8Array) => {
        input.buf.set(p);
        inputLen.buf[0] = p.length;
    };
    try {
        // The identification and setup headers (the comment header is not needed).
        send(id);
        w.send_setup(dec, 1);
        send(setup);
        w.send_setup(dec, 0);
        w.init_dsp(dec);
        const parts: Float32Array[][] = [];
        let total = 0;
        let nch = 0;
        for (let i = 3; i < s.packets.length && total < cap; i++) {
            send(s.packets[i]);
            w.decode_packets(dec);
            errLen.buf[0] = 0;
            const n = samples.buf[0];
            nch = channels.buf[0];
            if (!n || !nch) continue;
            if (nch > declared) return null;
            const ptrs = new Uint32Array(w.HEAP, outPtr.buf[0], nch);
            parts.push(Array.from({ length: nch }, (_, c) => new Float32Array(w.HEAP, ptrs[c], n).slice()));
            total += n;
        }
        if (!total || !nch) return null;
        // The last granule position is the stream's length in samples.
        const limit = s.granule > 0 ? Math.min(s.granule, cap) : cap;
        return { channelData: concat(parts, nch, limit), sampleRate: rate.buf[0] || 44100 };
    } finally {
        w.destroy_decoder(dec);
        common.free();
    }
}

async function decodeOpus(s: Stream, maxBytes: number): Promise<Decoded | null> {
    const h = s.packets[0];
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    const channels = h[9];
    const preSkip = dv.getUint16(10, true);
    const gainDb = dv.getInt16(16, true) / 256;
    const family = h[18];
    let streamCount = 1;
    let coupledStreamCount = channels === 2 ? 1 : 0;
    let channelMappingTable = channels === 2 ? [0, 1] : [0];
    if (family !== 0) {
        if (h.length < 21 + channels) return null;
        streamCount = h[19];
        coupledStreamCount = h[20];
        channelMappingTable = Array.from(h.subarray(21, 21 + channels));
    }
    if (!channels || channels > MAX_CHANNELS) return null;
    // Every stream is decoded, whether or not the mapping uses it, so streams cost time the
    // channel count and the PCM budget do not bound: 255 streams of 1 channel make every
    // output sample 255 times as expensive. A real file has at most one stream per channel.
    if (streamCount > MAX_CHANNELS || coupledStreamCount > streamCount) return null;
    const cap = sampleCap(channels, maxBytes);
    const dec = new OpusDecoder({ channels, streamCount, coupledStreamCount, channelMappingTable, preSkip, sampleRate: 48000 } as never) as unknown as {
        ready: Promise<void>;
        decodeFrame(f: Uint8Array): { channelData: Float32Array[]; samplesDecoded: number };
        free(): void;
    };
    await dec.ready;
    try {
        const parts: Float32Array[][] = [];
        let total = 0;
        // Packet 0 is OpusHead, 1 OpusTags.
        for (let i = 2; i < s.packets.length && total < cap; i++) {
            const r = dec.decodeFrame(s.packets[i]);
            if (!r.samplesDecoded) continue;
            parts.push(r.channelData.map(c => c.slice(0, r.samplesDecoded)));
            total += r.samplesDecoded;
        }
        if (!total) return null;
        const nch = parts[0].length;
        const limit = s.granule > preSkip ? Math.min(s.granule - preSkip, cap) : cap;
        const out = concat(parts, nch, limit);
        if (gainDb) {
            const g = Math.pow(10, gainDb / 20);
            for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= g;
        }
        return { channelData: out, sampleRate: 48000 };
    } finally {
        dec.free();
    }
}

// As a module Worker: 'ready' once loaded, then one message { bytes, maxBytes }
// per decode, answered with the result (its channels transferred) or null.
declare const WorkerGlobalScope: { new (): unknown } | undefined;
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
    const scope = globalThis as unknown as {
        onmessage: ((e: MessageEvent<{ bytes: Uint8Array; maxBytes: number }>) => void) | null;
        postMessage(m: unknown, transfer: Transferable[]): void;
    };
    scope.onmessage = async e => {
        const r = await decodeOgg(e.data.bytes, e.data.maxBytes).catch(() => null);
        scope.postMessage(r, r ? r.channelData.map(c => c.buffer as ArrayBuffer) : []);
    };
    scope.postMessage('ready', []);
}

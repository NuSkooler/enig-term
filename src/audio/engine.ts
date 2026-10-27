// The CTerm audio engine: takes the core's audio inputs in stream order
// (APC strings, `CSI = 7` requests, "ANSI" music) and runs them, one at a
// time, against the mixer model, the file cache and the decoder. Replies go
// back in the same order. Loaded on demand (dist/enig-term-audio.js) the
// first time a board uses audio; sound.ts in the main bundle owns the
// AudioContext, the settings and the UI.
//
// Limits (host input is untrusted): one stored or decoded file at most
// `maxFile` bytes, the cache at most `cacheBytes` (LRU), decoded audio held in
// slots and on channels at most `memoryBytes`, 300 s per buffer, `decodeMs`
// per decode, 64 buffers per channel and 128 in all.

import { parseApc, type Command } from './apc.ts';
import { AudioStore } from './cache.ts';
import { listMatches } from './glob.ts';
import { md5hex } from './md5.ts';
import { PROBES } from './probes.ts';
import { Mixer, type Buf, type Renderer } from './mixer.ts';
import { renderMusic, synthShape, type MusicTone } from './synth.ts';
import { WebAudioOut } from './webaudio.ts';

export type AudioInput =
    | { kind: 'apc'; body: Uint8Array }
    /** An audio APC longer than the limit (dropped by the core). */
    | { kind: 'over'; bytes: number }
    | { kind: 'report'; params: number[] }
    | { kind: 'music'; notes: number[]; fg: boolean; audible: boolean };

export interface EngineHost {
    /** Bytes for the host (a reply or an asynchronous report). */
    reply(s: string): void;
    log(s: string): void;
    /** Board key for the file cache (see cache.ts boardKey). */
    board(): string;
    /** The cache fell back to memory (shown once). */
    notice?(text: string): void;
}

export interface EngineOptions {
    maxFile: number;
    cacheBytes: number;
    memoryBytes: number;
    decodeMs: number;
    musicTone: MusicTone;
    /** Test hook: decode Ogg with the bundled fallback decoders even when the browser can. */
    forceFallback?: boolean;
    /** Test hook: model clock for an OfflineAudioContext. */
    clock?: () => number;
    /** The audio may not run yet (a test hook that simulates the autoplay lock). */
    lockedHook?: () => boolean;
    /** Where the fallback Ogg decoders are (default: next to this module). */
    oggUrl?: string | URL;
}

const MAX_SECONDS = 300;

/** The stream waits for this (A;Wait, foreground music). */
interface Hold {
    hold: Promise<void>;
}
const ESC = String.fromCharCode(0x1b);
const APC = ESC + '_';
const ST = ESC + '\\';
const CSI = ESC + '[';

/**
 * libsndfile major;subtype pairs this terminal can decode, at most. The
 * format query answers yes only for those the browser actually decodes: each
 * is tried once on a tiny sample (WAV made here, FLAC and MP3 in probes.ts).
 * Ogg Vorbis and Opus always work (the bundled decoders cover browsers that
 * lack them). Checked against real files in every browser by test/audio.spec.ts.
 */
export const FORMATS: ReadonlySet<string> = new Set([
    // WAV: PCM U8, 16, 24, 32 bit, float
    '1;5',
    '1;2',
    '1;3',
    '1;4',
    '1;6',
    // FLAC: 16, 24 bit
    '23;2',
    '23;3',
    // Ogg Vorbis, Ogg Opus (with the fallback decoders where the browser lacks them)
    '32;96',
    '32;100',
    // MPEG layer III
    '35;130',
]);

/** What the engine plays through (WebAudioOut in the browser; a recorder in Node tests). */
export interface Output extends Renderer {
    now(): number;
    check(): void;
    setMaster(gain: number): void;
    onRunning: ((running: boolean) => void) | null;
}

/** Platform pieces, so the engine runs in Node tests too. */
export interface EngineDeps {
    out: Output;
    sampleRate: number;
    /** A buffer from mono PCM at `rate`. */
    mono(pcm: Float32Array, rate: number): Buf;
    /** The platform's decoder (null: it cannot decode this). */
    native(data: Uint8Array, timeoutMs: number): Promise<Buf | null>;
    /** A buffer from decoded channels (the Ogg fallback's output). */
    fromChannels(ch: Float32Array[], rate: number): Buf;
    /** The file cache (default: a new AudioStore; tests share one between sessions). */
    store?: AudioStore;
}

interface OggModule {
    decodeOgg(bytes: Uint8Array, maxBytes: number): Promise<{ channelData: Float32Array[]; sampleRate: number } | null>;
}

declare const __ENIG_TERM_OGG_HASH__: string | undefined;
const OGG_QUERY = typeof __ENIG_TERM_OGG_HASH__ === 'string' && __ENIG_TERM_OGG_HASH__ ? `?v=${__ENIG_TERM_OGG_HASH__}` : '';

export class AudioEngine {
    readonly out: Output;
    readonly mixer: Mixer;
    readonly store: AudioStore;
    private chain: Promise<unknown> = Promise.resolve();
    private timer: ReturnType<typeof setTimeout> | 0 = 0;
    /** Decoded files, so a replay does not decode again: name -> md5 + buffer. */
    private decoded = new Map<string, { md5: string; buf: Buf }>();
    private decodedBytes = 0;
    private ogg: Promise<OggModule | null> | null = null;
    private generation = 0;
    /** Counters (tests, diagnostics). */
    readonly stats = { commands: 0, rejected: 0, decodes: 0, fallbackDecodes: 0, decodeFailures: 0, dropped: 0, errors: 0 };

    private readonly host: EngineHost;
    opts: EngineOptions;
    private readonly deps: EngineDeps;

    // (No parameter properties: Node's type stripping runs these modules in tests.)
    constructor(host: EngineHost, opts: EngineOptions, deps: EngineDeps) {
        this.host = host;
        this.opts = opts;
        this.deps = deps;
        this.out = deps.out;
        this.mixer = new Mixer(this.out.now, this.out, s => this.host.reply(s));
        this.out.onRunning = () => this.schedule();
        this.store = deps.store ?? new AudioStore({ capBytes: opts.cacheBytes, maxFile: opts.maxFile });
        this.store.onFallback = why => {
            this.host.log(`audio cache: IndexedDB unavailable (${why}); keeping files in memory`);
            this.host.notice?.('Sounds from this board cannot be saved in this browser; they are kept until the page is closed.');
        };
    }

    /**
     * Run an input after everything before it. Resolves when it is done; for
     * `A;Wait` and foreground music, when the stream may go on (the channel
     * is idle, or the music has played).
     */
    run(input: AudioInput): Promise<void> {
        const gen = this.generation;
        let hold: Promise<void> = Promise.resolve();
        const step = this.chain.then(async () => {
            if (gen !== this.generation) return;
            const t0 = performance.now();
            // (A hold is wrapped: an async function would adopt the promise and
            // stall the queue until the channel idles.)
            hold = (await this.exec(input, gen))?.hold ?? Promise.resolve();
            const ms = performance.now() - t0;
            if (ms > 100) this.host.log(`audio: ${describe(input)} took ${Math.round(ms)} ms`);
            this.schedule();
        });
        this.chain = step.catch(e => {
            this.stats.errors++;
            this.host.log(`audio: error: ${(e as Error)?.message ?? e}`);
        });
        return this.chain.then(() => hold);
    }

    private async exec(input: AudioInput, gen: number): Promise<Hold | void> {
        switch (input.kind) {
            case 'over':
                this.stats.dropped++;
                this.host.log(`audio: APC of ${input.bytes} B over the limit, dropped`);
                return;
            case 'report':
                this.host.reply(this.mixer.stateReport(input.params));
                return;
            case 'music':
                return this.music(input.notes, input.fg, input.audible);
            case 'apc': {
                this.stats.commands++;
                const cmd = parseApc(input.body);
                if (cmd.k === 'reject') {
                    this.stats.rejected++;
                    this.host.log(`audio: ignored (${cmd.why})`);
                    return;
                }
                return this.command(cmd, gen);
            }
        }
    }

    private async command(c: Command, gen: number): Promise<Hold | void> {
        const m = this.mixer;
        // After anything that waits, a reset (new session) may have happened.
        const stale = () => gen !== this.generation;
        switch (c.k) {
            case 'qsndfile':
                this.host.reply(`${CSI}=7;100;1n`);
                return;
            case 'qformat': {
                const ok = await this.formatSupported(c.major, c.subtype);
                this.host.reply(`${CSI}=7;101;${c.major};${c.subtype};${ok ? 1 : 0}n`);
                return;
            }
            case 'store': {
                const ok = await this.store.put(this.host.board(), c.name, c.data);
                this.decoded.delete(c.name);
                this.host.log(`audio: store ${c.name} (${c.data.length} B)${ok ? '' : ': refused (too large)'}`);
                return;
            }
            case 'list': {
                const entries = await this.store.list(this.host.board());
                if (stale()) return;
                const md5 = new Map(entries.map(e => [e.name, e.md5]));
                const { files, dirs } = listMatches(md5.keys(), c.glob);
                let s = `${APC}SyncTERM:C;L\n`;
                for (const f of files) s += `${f}\t${md5.get(f)}\n`;
                for (const d of dirs) s += `${d}\t\n`;
                this.host.reply(s + ST);
                return;
            }
            case 'load': {
                const data = await this.store.get(this.host.board(), c.name);
                if (!data) {
                    this.host.log(`audio: load ${c.name}: not in the cache`);
                    return;
                }
                const buf = await this.decodeCached(c.name, data);
                if (!stale()) this.fill(c.slot, buf);
                return;
            }
            case 'loadBlob': {
                if (c.data.length > this.opts.maxFile) return;
                const buf = await this.decode(c.data);
                if (!stale()) this.fill(c.slot, buf);
                return;
            }
            case 'synth': {
                if (!(c.seconds > 0)) {
                    m.setSlot(c.slot, null);
                    return;
                }
                const rate = this.deps.sampleRate;
                const pcm = synthShape(c.shape, c.freq, Math.min(c.seconds, MAX_SECONDS), rate);
                this.fill(c.slot, pcm.length ? this.deps.mono(pcm, rate) : null);
                return;
            }
            case 'copy':
                m.copy(c.src, c.dst);
                return;
            case 'queue':
                if (!m.queue(c)) this.host.log(`audio: queue C=${c.ch} S=${c.slot}: ${m.slots[c.slot] ? 'limit' : 'empty slot'}`);
                return;
            case 'flush':
                m.flush(c.ch, c.fadeOut);
                return;
            case 'volume':
                m.volume(c.ch, c.volL, c.volR, c.ramp);
                return;
            case 'update':
                m.update(c.ch);
                return;
            case 'wait':
                return { hold: m.wait(c.ch) };
        }
    }

    /** Put a decoded buffer in a slot, within the memory budget (else the slot is left as it was). */
    private fill(slot: number, buf: Buf | null): void {
        if (!buf) return;
        if (this.mixer.residentBytes(slot) + buf.bytes > this.opts.memoryBytes) {
            this.stats.dropped++;
            this.host.log(`audio: slot ${slot}: over the memory budget, not loaded`);
            return;
        }
        this.mixer.setSlot(slot, buf);
    }

    // --- "ANSI" music (channel 0) ------------------------------------------------------

    private music(notes: number[], fg: boolean, audible: boolean): Hold | void {
        // Music that cannot be heard (sound muted, or not allowed yet) is
        // skipped, and does not hold the stream: it belongs to the moment
        // its screen is shown.
        if (!audible || !notes.length) return;
        const rate = this.deps.sampleRate;
        const pcm = renderMusic(notes, rate, this.opts.musicTone);
        if (!pcm.length) return;
        this.mixer.append(0, this.deps.mono(pcm, rate));
        if (fg) return { hold: this.mixer.wait(0) };
    }

    // --- decoding -------------------------------------------------------------------------

    private async decodeCached(name: string, data: Uint8Array): Promise<Buf | null> {
        const sum = md5hex(data);
        const hit = this.decoded.get(name);
        if (hit && hit.md5 === sum) {
            // Most recently used last.
            this.decoded.delete(name);
            this.decoded.set(name, hit);
            return hit.buf;
        }
        const buf = await this.decode(data);
        if (buf) {
            this.decoded.delete(name);
            this.decoded.set(name, { md5: sum, buf });
            this.decodedBytes = [...this.decoded.values()].reduce((n, e) => n + e.buf.bytes, 0);
            for (const [k, v] of this.decoded) {
                if (this.decodedBytes <= this.opts.memoryBytes / 2) break;
                this.decoded.delete(k);
                this.decodedBytes -= v.buf.bytes;
            }
        }
        return buf;
    }

    private formats = new Map<string, Promise<boolean>>();

    /** Can this browser (with the Ogg fallback) decode libsndfile format major;subtype? */
    formatSupported(major: number, subtype: number): Promise<boolean> {
        const key = `${major};${subtype}`;
        if (!FORMATS.has(key)) return Promise.resolve(false);
        if (key === '32;96' || key === '32;100') return Promise.resolve(true);
        let p = this.formats.get(key);
        if (!p) {
            const sample = key.startsWith('1;') ? probeWav(subtype) : PROBES[key] ? b64(PROBES[key]) : null;
            p = sample ? this.deps.native(sample, this.opts.decodeMs).then(b => !!b && b.duration > 0.02) : Promise.resolve(false);
            this.formats.set(key, p);
        }
        return p;
    }

    /** Decode a file: the browser's decoder, then the bundled Ogg decoders. */
    async decode(data: Uint8Array): Promise<Buf | null> {
        this.stats.decodes++;
        const ogg = data.length > 4 && data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53;
        let buf: Buf | null = null;
        if (!(ogg && this.opts.forceFallback)) buf = await this.deps.native(data, this.opts.decodeMs);
        // (Some decoders "succeed" with nothing: WebKitGTK on 8- and 24-bit WAV.)
        if (buf && !(buf.duration > 0)) buf = null;
        if (!buf && ogg) buf = await this.fallback(data);
        if (!buf) {
            this.stats.decodeFailures++;
            this.host.log(`audio: could not decode ${data.length} B (${sniff(data)})`);
            return null;
        }
        if (buf.duration > MAX_SECONDS) {
            this.host.log(`audio: ${buf.duration.toFixed(1)} s is longer than ${MAX_SECONDS} s, not loaded`);
            return null;
        }
        return buf;
    }

    private async fallback(data: Uint8Array): Promise<Buf | null> {
        if (!this.ogg) {
            const url = this.opts.oggUrl ?? new URL(`./enig-term-ogg.js${OGG_QUERY}`, import.meta.url);
            this.ogg = import(/* @vite-ignore */ String(url)).then(
                m => m as OggModule,
                e => {
                    this.host.log(`audio: the Ogg decoders could not be loaded: ${(e as Error)?.message ?? e}`);
                    this.ogg = null;
                    return null;
                },
            );
        }
        const mod = await this.ogg;
        if (!mod) return null;
        const r = await withTimeout(mod.decodeOgg(data, this.opts.memoryBytes).catch(() => null), this.opts.decodeMs);
        if (!r || !r.channelData.length || !r.channelData[0].length) return null;
        this.stats.fallbackDecodes++;
        const len = Math.min(r.channelData[0].length, Math.ceil(MAX_SECONDS * r.sampleRate) + 1);
        return this.deps.fromChannels(r.channelData.slice(0, 8).map(c => c.subarray(0, len)), r.sampleRate);
    }

    // --- time ---------------------------------------------------------------------------

    /** Wake up when the next buffer ends (idle reports, waiters). */
    schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = 0;
        if (this.opts.clock) return; // tests drive the clock
        const next = this.mixer.nextEvent();
        if (next === Infinity) return;
        const ms = Math.max(0, (next - this.out.now()) * 1000) + 2;
        this.timer = setTimeout(() => {
            this.timer = 0;
            this.mixer.tick();
            this.schedule();
        }, Math.min(ms, 2 ** 31 - 1));
    }

    /** A new session with the host: stop everything, forget slots and levels (the cache stays). */
    reset(): void {
        this.generation++;
        this.chain = Promise.resolve();
        this.mixer.reset();
        this.schedule();
    }

    setTone(t: MusicTone): void {
        this.opts.musicTone = t;
    }
}

function b64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** 50 ms of 440 Hz at 8 kHz as a WAV of libsndfile subtype 5 (U8), 2, 3, 4 (16/24/32-bit) or 6 (float). */
function probeWav(subtype: number): Uint8Array | null {
    const bits = { 5: 8, 2: 16, 3: 24, 4: 32, 6: 32 }[subtype];
    if (!bits) return null;
    const float = subtype === 6;
    const n = 400;
    const bps = bits / 8;
    const b = new Uint8Array(44 + n * bps);
    const dv = new DataView(b.buffer);
    const str = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
    str(0, 'RIFF');
    dv.setUint32(4, 36 + n * bps, true);
    str(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, float ? 3 : 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, 8000, true);
    dv.setUint32(28, 8000 * bps, true);
    dv.setUint16(32, bps, true);
    dv.setUint16(34, bits, true);
    str(36, 'data');
    dv.setUint32(40, n * bps, true);
    for (let i = 0; i < n; i++) {
        const v = Math.sin((2 * Math.PI * 440 * i) / 8000) * 0.5;
        const o = 44 + i * bps;
        if (float) dv.setFloat32(o, v, true);
        else if (bits === 8) b[o] = Math.round(128 + v * 127);
        else if (bits === 16) dv.setInt16(o, Math.round(v * 32767), true);
        else if (bits === 24) {
            const x = Math.round(v * 8388607);
            b[o] = x & 0xff;
            b[o + 1] = (x >> 8) & 0xff;
            b[o + 2] = (x >> 16) & 0xff;
        } else dv.setInt32(o, Math.round(v * 2147483647), true);
    }
    return b;
}

function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
    return new Promise(res => {
        const t = setTimeout(() => res(null), ms);
        p.then(
            v => {
                clearTimeout(t);
                res(v);
            },
            () => {
                clearTimeout(t);
                res(null);
            },
        );
    });
}

function describe(i: AudioInput): string {
    if (i.kind !== 'apc') return i.kind;
    return String.fromCharCode(...i.body.subarray(0, Math.min(40, i.body.length))).replace(/;[^;]*$/, '');
}

function sniff(d: Uint8Array): string {
    const s = String.fromCharCode(...d.subarray(0, 4));
    if (s === 'OggS') return 'Ogg';
    if (s === 'RIFF') return 'WAV';
    if (s === 'fLaC') return 'FLAC';
    if (s.startsWith('ID3') || (d[0] === 0xff && (d[1] & 0xe0) === 0xe0)) return 'MP3';
    return 'unknown format';
}

/** Factory the main bundle calls after importing this module. */
export function createEngine(ctx: BaseAudioContext, host: EngineHost, opts: EngineOptions): AudioEngine {
    return new AudioEngine(host, opts, browserDeps(ctx, opts));
}

/** WebAudio output and decoding on `ctx` (also an OfflineAudioContext, for tests). */
export function browserDeps(ctx: BaseAudioContext, opts: Pick<EngineOptions, 'clock' | 'lockedHook'>): EngineDeps {
    const asBuf = (ab: AudioBuffer): Buf => ({ duration: ab.duration, bytes: ab.length * ab.numberOfChannels * 4, data: ab });
    return {
        out: new WebAudioOut(ctx, { clock: opts.clock, lockedHook: opts.lockedHook }),
        sampleRate: ctx.sampleRate,
        mono(pcm, rate) {
            const ab = ctx.createBuffer(1, pcm.length, rate);
            ab.getChannelData(0).set(pcm);
            return asBuf(ab);
        },
        fromChannels(chs, rate) {
            const ab = ctx.createBuffer(chs.length, chs[0].length, rate);
            chs.forEach((c, i) => ab.getChannelData(i).set(c));
            return asBuf(ab);
        },
        native(data, ms) {
            // decodeAudioData takes (and detaches) its own copy.
            const copy = data.slice().buffer;
            return withTimeout(
                new Promise<Buf | null>(res => {
                    try {
                        const p = ctx.decodeAudioData(
                            copy,
                            b => res(asBuf(b)),
                            () => res(null),
                        );
                        p?.catch?.(() => res(null));
                    } catch {
                        res(null);
                    }
                }),
                ms,
            );
        },
    };
}

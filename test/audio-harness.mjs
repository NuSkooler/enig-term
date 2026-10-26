// Node harness for the audio engine: the real WASM core and the real
// AudioEngine (mixer, APC parser, file cache, synthesis), with WebAudio
// replaced by a recorder and decoding by a WAV reader. `NodeTerm` is a
// terminal on the wire: give its `socket` to ansi-bbs-utils' Terminal as
// FakeCTerm's is given, and it answers the way enig-term does in a browser.
import { createRequire } from 'node:module';
import { loadCore } from './core-harness.mjs';
import { AudioEngine } from '../src/audio/engine.ts';
import { AudioStore } from '../src/audio/cache.ts';
import { replyFor } from '../src/replies.ts';

const require = createRequire(import.meta.url);
export const abu = require('ansi-bbs-utils');

const { Core } = await loadCore();

/** A PCM16 WAV of `seconds` (a sine at `freq`, or silence). */
export function wav(seconds, { rate = 8000, channels = 1, freq = 440 } = {}) {
    const n = Math.round(seconds * rate);
    const data = n * channels * 2;
    const b = Buffer.alloc(44 + data);
    b.write('RIFF', 0);
    b.writeUInt32LE(36 + data, 4);
    b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(channels, 22);
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * channels * 2, 28);
    b.writeUInt16LE(channels * 2, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36);
    b.writeUInt32LE(data, 40);
    for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 16000), 44 + (i * channels + c) * 2);
    return new Uint8Array(b);
}

/** Duration of a PCM WAV, or null (what "decoding" means here). */
function wavDuration(d) {
    const b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    if (b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
    const ch = b.readUInt16LE(22);
    const rate = b.readUInt32LE(24);
    const bits = b.readUInt16LE(34);
    const len = b.readUInt32LE(40);
    if (!ch || !rate || !bits) return null;
    return len / (ch * rate * (bits / 8));
}

/** Renderer stand-in: records what the engine asked for. */
export class Recorder {
    constructor(clock) {
        this.t0 = performance.now();
        this.clock = clock ?? (() => (performance.now() - this.t0) / 1000);
        this.log = [];
        this.onRunning = null;
        this.master = 1;
        this.now = () => this.clock();
    }
    add(it) {
        this.log.push(['add', it.ch, it.id]);
    }
    change(it) {
        this.log.push(['change', it.ch, it.id]);
    }
    remove(it) {
        this.log.push(['remove', it.ch, it.id]);
    }
    ended(it) {
        this.log.push(['ended', it.ch, it.id]);
    }
    volume(ch, v) {
        this.log.push(['volume', ch, v]);
    }
    check() {}
    setMaster(g) {
        this.master = g;
    }
}

export function nodeDeps({ store, clock } = {}) {
    const out = new Recorder(clock);
    return {
        out,
        sampleRate: 8000,
        mono: (pcm, rate) => ({ duration: pcm.length / rate, bytes: pcm.length * 4, data: pcm }),
        fromChannels: (chs, rate) => ({ duration: chs[0].length / rate, bytes: chs.length * chs[0].length * 4, data: chs }),
        native: async d => {
            const s = wavDuration(d);
            return s === null ? null : { duration: s, bytes: Math.round(s * 8000 * 4), data: d };
        },
        store,
    };
}

export const ENGINE_OPTS = { maxFile: 16 << 20, cacheBytes: 64 << 20, memoryBytes: 192 << 20, decodeMs: 5000, musicTone: 'square' };

/** enig-term on the wire, in Node: core + engine, answering what the browser shell answers. */
export class NodeTerm {
    constructor({ store, clock, holdCap = Infinity } = {}) {
        this.core = new Core(80, 25, 'ansi');
        this.holdCap = holdCap;
        this.replies = [];
        this.received = [];
        this.apcs = [];
        this.listeners = new Set();
        this.store = store ?? new AudioStore({ capBytes: ENGINE_OPTS.cacheBytes, maxFile: ENGINE_OPTS.maxFile });
        this.logs = [];
        this.engine = new AudioEngine(
            {
                reply: s => this.reply(s),
                log: s => this.logs.push(s),
                board: () => 'wss://bbs.example:443/',
            },
            { ...ENGINE_OPTS },
            nodeDeps({ store: this.store, clock }),
        );
        this.pending = Promise.resolve();
        this.socket = {
            writable: true,
            write: (data, cb) => {
                const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
                this.received.push(b);
                this.pending = this.pending.then(() => this.feed(new Uint8Array(b)));
                if (cb) process.nextTick(cb, null);
                return true;
            },
            cork() {},
            uncork() {},
        };
    }

    reply(s) {
        this.replies.push(s);
        const b = Buffer.from(s, 'latin1');
        setImmediate(() => this.listeners.forEach(f => f(b)));
    }

    onReply(f) {
        this.listeners.add(f);
    }

    async feed(b) {
        while (b.length) {
            const n = this.core.feed(b);
            const events = n ? JSON.parse(this.core.take_events()) : [];
            const holds = [];
            for (const ev of events) {
                if (ev.t === 'req' && ev.k === 'audio') holds.push(this.engine.run({ kind: 'report', params: ev.params }));
                else if (ev.t === 'req') {
                    const r = replyFor(ev, { links: true });
                    if (r) this.reply(r);
                } else if (ev.t === 'apc' && 'n' in ev) {
                    if (ev.over) continue;
                    const body = this.core.take_apc();
                    this.apcs.push(Buffer.from(body.subarray(0, Math.min(body.length, 200))).toString('latin1'));
                    holds.push(this.engine.run({ kind: 'apc', body }));
                } else if (ev.t === 'music') holds.push(this.engine.run({ kind: 'music', notes: ev.n, fg: ev.fg, audible: true }));
            }
            const fed = this.core.fed();
            b = b.subarray(fed);
            // Like the shell: what follows a Wait or foreground music waits for it.
            if (b.length && holds.length) await Promise.race([Promise.all(holds), sleep(this.holdCap)]);
        }
    }

    /** A Terminal (ansi-bbs-utils) wired both ways to this terminal. */
    static connect(opts = {}) {
        const node = new NodeTerm(opts);
        const term = new abu.Terminal(node.socket);
        term.setTerminalType('syncterm');
        node.onReply(b => term.feed(b));
        return { node, term };
    }

    running(ch) {
        return this.engine.mixer.isRunning(ch);
    }

    destroy() {
        this.engine.reset();
    }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// WebAudio output for the mixer model (mixer.ts).
//
// Graph: each item  source -> fade-in -> [fade-out] -> [decay]... -> its own
// L/R level -> the channel; each channel  base L/R level (ramps) -> the
// master; master  soft clip (tanh, as SyncTERM's mixer does when the sum
// passes full scale) -> volume/mute -> destination. Every gain envelope is
// automated once on its own node (WebAudio refuses overlapping curves), so
// a later change (a loop that gets an end, a crossfade, a faded flush) adds
// a node to the item's chain instead of rescheduling one.
//
// The model runs on its own clock. While the context runs, model time is
// the context's time plus an offset; while it cannot run (the browser has
// not allowed audio yet, or suspended it) model time follows the wall
// clock, nothing is rendered, and items keep "playing" in the model. When
// the context runs again, everything still in progress starts where it
// would be now, after a short fade-in.

import type { Item, Renderer, Vol } from './mixer.ts';
import { CHANNELS } from './mixer.ts';

const db = (v: number) => Math.pow(10, Math.max(-100, Math.min(24, v)) / 20);
/** Lead for "now" scheduling, so a start is never in the past by the time the audio thread sees it. */
const LEAD = 0.005;
const RESUME_FADE = 0.05;
const CURVE_POINTS = 64;

interface ItemNodes {
    src: AudioBufferSourceNode;
    /** Last in the chain: closed when the item is removed before its end. */
    gate: GainNode;
    last: AudioNode;
    out: AudioNode;
    stopAt: number; // ctx time stop() was called for, or Infinity
    stages: number;
    hasFadeOut: boolean;
    overlayKey: string;
    started: boolean;
}

interface ChanNodes {
    input: GainNode;
    l: GainNode;
    r: GainNode;
    vol: Vol | null;
}

/** sin-shaped rise (from 0 to 1) or cos-shaped fall (1 to 0), between phases p0 and p1 of the whole fade. */
function curve(rise: boolean, p0: number, p1: number, scale = 1): Float32Array {
    const c = new Float32Array(CURVE_POINTS);
    for (let i = 0; i < CURVE_POINTS; i++) {
        const p = p0 + ((p1 - p0) * i) / (CURVE_POINTS - 1);
        c[i] = scale * (rise ? Math.sin((p * Math.PI) / 2) : Math.cos((p * Math.PI) / 2));
    }
    return c;
}

export class WebAudioOut implements Renderer {
    readonly ctx: BaseAudioContext;
    /** Everything mixed, after the soft clip and before volume and mute (a tap for tests). */
    readonly mix: GainNode;
    readonly master: GainNode;
    private readonly chans: ChanNodes[] = [];
    private readonly nodes = new Map<number, ItemNodes>();
    private readonly live = new Map<number, Item>();
    /** model time = ctx.currentTime + offset (while running); = wall seconds + wallOffset otherwise. */
    private offset = 0;
    private wallOffset: number;
    private runningNow: boolean;
    private readonly manualClock: (() => number) | null;
    onRunning: ((running: boolean) => void) | null = null;

    /**
     * `clock`: for an OfflineAudioContext (tests), model time is whatever it
     * returns and maps 1:1 onto context time.
     */
    constructor(ctx: BaseAudioContext, opts: { clock?: () => number; lockedHook?: () => boolean } = {}) {
        this.ctx = ctx;
        this.manualClock = opts.clock ?? null;
        this.lockedHook = opts.lockedHook ?? null;
        this.wallOffset = -performance.now() / 1000;
        const pre = ctx.createGain();
        pre.gain.value = 0.25;
        const clip = ctx.createWaveShaper();
        const n = 2048;
        const c = new Float32Array(n);
        for (let i = 0; i < n; i++) c[i] = Math.tanh(4 * ((i / (n - 1)) * 2 - 1));
        clip.curve = c;
        this.mix = ctx.createGain();
        this.master = ctx.createGain();
        pre.connect(clip).connect(this.mix).connect(this.master).connect(ctx.destination);
        for (let ch = 0; ch < CHANNELS; ch++) {
            const input = ctx.createGain();
            input.channelCount = 2;
            input.channelCountMode = 'explicit';
            input.channelInterpretation = 'speakers';
            const split = ctx.createChannelSplitter(2);
            const merge = ctx.createChannelMerger(2);
            const l = ctx.createGain();
            const r = ctx.createGain();
            input.connect(split);
            split.connect(l, 0).connect(merge, 0, 0);
            split.connect(r, 1).connect(merge, 0, 1);
            merge.connect(pre);
            l.gain.value = r.gain.value = db(-12);
            this.chans.push({ input, l, r, vol: null });
        }
        this.runningNow = this.isRunning();
        if (this.runningNow && !this.manualClock) this.offset = -(ctx as AudioContext).currentTime;
        ctx.addEventListener?.('statechange', () => this.check());
    }

    private readonly lockedHook: (() => boolean) | null;

    private isRunning(): boolean {
        if (this.manualClock) return true;
        return this.ctx.state === 'running' && !(this.lockedHook?.() ?? false);
    }

    /** Model time. */
    now = (): number => {
        if (this.manualClock) return this.manualClock();
        return this.runningNow ? this.ctx.currentTime + this.offset : performance.now() / 1000 + this.wallOffset;
    };

    private ctxTime(model: number): number {
        return this.manualClock ? model : model - this.offset;
    }

    get running(): boolean {
        return this.runningNow;
    }

    /** Re-check whether the context runs (statechange, a resume, the lock hook). */
    check(): void {
        const r = this.isRunning();
        if (r === this.runningNow) return;
        const t = this.now();
        if (r) {
            this.offset = t - (this.ctx as AudioContext).currentTime;
            this.runningNow = true;
            // Whatever is still in progress starts where it would be now.
            for (const it of this.live.values()) this.build(it, true);
            for (let ch = 0; ch < CHANNELS; ch++) {
                const v = this.chans[ch].vol;
                if (v) this.volume(ch, v);
            }
        } else {
            this.wallOffset = t - performance.now() / 1000;
            this.runningNow = false;
            for (const id of [...this.nodes.keys()]) this.drop(id);
        }
        this.onRunning?.(r);
    }

    setMaster(gain: number): void {
        const t = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(t);
        this.master.gain.setTargetAtTime(gain, t, 0.015);
    }

    // --- Renderer ---------------------------------------------------------------------

    add(it: Item): void {
        this.live.set(it.id, it);
        if (this.runningNow) this.build(it, false);
    }

    change(it: Item): void {
        if (!this.live.has(it.id)) return;
        const n = this.nodes.get(it.id);
        if (!n) return;
        const now = this.now();
        // A loop that got an end: stop there, with the final pass's fade-out.
        if (n.stopAt === Infinity && it.end !== Infinity) {
            n.stopAt = this.ctxTime(it.end);
            try {
                n.src.stop(Math.max(this.ctx.currentTime, n.stopAt));
            } catch {
                /* already stopped */
            }
        }
        if (!n.hasFadeOut && it.fadeOutAt !== Infinity && it.fadeOutDur > 0) {
            n.hasFadeOut = true;
            this.stage(n, g => this.fall(g.gain, it.fadeOutAt, it.fadeOutDur, 1, now));
        }
        const ov = it.overlay;
        const key = ov ? `${ov.at}:${ov.dur}:${ov.from}` : '';
        if (ov && key !== n.overlayKey) {
            n.overlayKey = key;
            this.stage(n, g => this.fall(g.gain, ov.at, ov.dur, ov.from, now));
        }
    }

    remove(it: Item): void {
        this.live.delete(it.id);
        const n = this.nodes.get(it.id);
        if (!n) return;
        // Stop at the model's "now" (an OfflineAudioContext renders later).
        const t = this.at(this.now());
        n.gate.gain.setValueAtTime(0, t);
        try {
            if (n.stopAt > t) n.src.stop(t);
        } catch {
            /* a second stop() is refused by some browsers; the gate is closed anyway */
        }
        n.stopAt = Math.min(n.stopAt, t);
        if (!this.manualClock) setTimeout(() => this.drop(it.id), 100);
    }

    ended(it: Item): void {
        // Its source stops by itself (and drops its nodes when it does).
        this.live.delete(it.id);
        if (this.manualClock) return;
        const n = this.nodes.get(it.id);
        if (n && this.ctx.currentTime > n.stopAt + 0.5) this.drop(it.id);
    }

    volume(ch: number, v: Vol): void {
        const c = this.chans[ch];
        c.vol = v;
        if (!this.runningNow) return;
        const now = this.now();
        const t = this.at(now);
        for (const [g, a, b] of [
            [c.l.gain, v.l0, v.l1],
            [c.r.gain, v.r0, v.r1],
        ] as const) {
            g.cancelScheduledValues(t);
            if (v.t1 > v.t0 && v.t1 > now) {
                // dB-linear = exponential in amplitude.
                const k = Math.max(0, Math.min(1, (now - v.t0) / (v.t1 - v.t0)));
                g.setValueAtTime(db(a + (b - a) * k), t);
                g.exponentialRampToValueAtTime(db(b), this.ctxTime(v.t1));
            } else g.setValueAtTime(db(b), t);
        }
    }

    // --- items ------------------------------------------------------------------------

    private build(it: Item, resumed: boolean): void {
        this.drop(it.id);
        const ctx = this.ctx;
        const now = this.now();
        if (it.end <= now) return;
        const buf = it.buf.data as AudioBuffer;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = it.loop;
        const head = ctx.createGain();
        head.channelCount = 2;
        head.channelCountMode = 'explicit';
        head.channelInterpretation = 'speakers';
        src.connect(head);
        // Per-buffer level, each side.
        let out: AudioNode;
        if (it.volL === it.volR) {
            const g = ctx.createGain();
            g.gain.value = db(it.volL);
            out = g;
        } else {
            const split = ctx.createChannelSplitter(2);
            const merge = ctx.createChannelMerger(2);
            const l = ctx.createGain();
            const r = ctx.createGain();
            l.gain.value = db(it.volL);
            r.gain.value = db(it.volR);
            split.connect(l, 0).connect(merge, 0, 0);
            split.connect(r, 1).connect(merge, 0, 1);
            (split as AudioNode & { _out?: AudioNode })._out = merge;
            out = split;
        }
        const tail = (out as AudioNode & { _out?: AudioNode })._out ?? out;
        const gate = ctx.createGain();
        tail.connect(gate).connect(this.chans[it.ch].input);
        const n: ItemNodes = { src, gate, last: head, out, stopAt: Infinity, stages: 0, hasFadeOut: false, overlayKey: '', started: false };
        head.connect(out);
        this.nodes.set(it.id, n);

        // Fade-in (first pass), or a short one when resuming mid-item.
        const elapsed = now - it.start;
        if (it.fadeIn > 0 && elapsed < it.fadeIn) this.rise(head.gain, it.start, it.fadeIn, now);
        else if (resumed && elapsed > 0) this.rise(head.gain, now, RESUME_FADE, now);
        if (it.fadeOutAt !== Infinity && it.fadeOutDur > 0) {
            n.hasFadeOut = true;
            this.stage(n, g => this.fall(g.gain, it.fadeOutAt, it.fadeOutDur, 1, now));
        }
        if (it.overlay) {
            const ov = it.overlay;
            n.overlayKey = `${ov.at}:${ov.dur}:${ov.from}`;
            this.stage(n, g => this.fall(g.gain, ov.at, ov.dur, ov.from, now));
        }

        const d = buf.duration;
        const t0 = this.ctx instanceof OfflineAudioContext ? 0 : this.ctx.currentTime + LEAD;
        let when = this.ctxTime(it.start);
        let offset = 0;
        if (elapsed > 0) {
            // In progress (a resume, or a start a little in the past).
            offset = it.loop ? elapsed % d : elapsed;
            when = this.ctxTime(now);
        }
        if (!this.manualClock) when = Math.max(when, t0);
        if (offset >= d && !it.loop) return;
        src.start(when, offset);
        n.started = true;
        if (it.end !== Infinity) {
            n.stopAt = this.ctxTime(it.end);
            src.stop(Math.max(when, n.stopAt));
        }
        src.onended = () => {
            if (this.nodes.get(it.id) === n) this.drop(it.id);
        };
    }

    /** Add a gain node at the end of an item's chain, automated by `fn`. */
    private stage(n: ItemNodes, fn: (g: GainNode) => void): void {
        if (n.stages >= 6) return; // the end still comes from stop()
        const g = this.ctx.createGain();
        fn(g);
        n.last.disconnect(n.out);
        n.last.connect(g);
        g.connect(n.out);
        n.last = g;
        n.stages++;
    }

    /** sin rise 0 -> 1 over [t, t + dur] (model time), from wherever it is at `now`. */
    private rise(p: AudioParam, t: number, dur: number, now: number): void {
        const a = Math.max(0, (now - t) / dur);
        if (a >= 1) return;
        const from = Math.max(t, now);
        p.setValueCurveAtTime(curve(true, a, 1), this.at(from), Math.max(1e-3, t + dur - from));
    }

    /** cos fall `scale` -> 0 over [t, t + dur], from wherever it is at `now`. */
    private fall(p: AudioParam, t: number, dur: number, scale: number, now: number): void {
        const a = Math.max(0, (now - t) / dur);
        if (a >= 1) {
            p.value = 0;
            return;
        }
        const from = Math.max(t, now);
        if (from > now) p.setValueAtTime(scale, this.at(now));
        p.setValueCurveAtTime(curve(false, a, 1, scale), this.at(from), Math.max(1e-3, t + dur - from));
    }

    private at(model: number): number {
        const t = this.ctxTime(model);
        return this.manualClock ? t : Math.max(t, this.ctx.currentTime);
    }

    private drop(id: number): void {
        const n = this.nodes.get(id);
        if (!n) return;
        this.nodes.delete(id);
        n.src.onended = null;
        try {
            if (n.started) n.src.stop();
        } catch {
            /* never started or already stopped */
        }
        n.src.disconnect();
        n.out.disconnect();
        ((n.out as AudioNode & { _out?: AudioNode })._out ?? n.out).disconnect();
        n.gate.disconnect();
    }

    /** Live AudioBufferSourceNodes (tests, limits). */
    get voices(): number {
        return this.nodes.size;
    }
}

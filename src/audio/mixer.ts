// The CTerm audio model: 256 patch slots and 16 channels, as the "Audio
// APCs" section of the CTerm manual describes them. No WebAudio here: the
// model keeps the timeline (when each buffer starts, stops, fades) on an
// abstract clock and tells a Renderer what to play. That keeps it testable
// in Node, and lets the host-visible state (`CSI = 7 n`, `Update` reports,
// `Wait`) stay right while the browser has not let audio start yet.
//
// Semantics (manual first; where it is silent, SyncTERM's mixer):
// - Queue moves a slot's buffer onto a channel's FIFO; the slot is empty
//   afterwards. Buffers play back to back without gaps.
// - L loops the buffer. A later Queue ends the loop at the end of the pass
//   in progress and plays after it (the manual: "A subsequent Queue (plain
//   or crossfade) ends the loop"; SyncTERM's mixer and IcyTerm keep looping
//   and never reach it).
// - X with I > 0: the last buffer on the channel decays (equal-power) over I
//   while the new one fades in over I; both sound during the overlap. On an
//   empty channel it is a plain fade-in. (SyncTERM applies the decay to the
//   tail of the FIFO, which is the playing buffer in the usual case.)
// - I fades in the first pass; O fades out the last I/O of the final pass;
//   when I + O exceed the buffer they are scaled to fit.
// - Flush drains the channel; with O > 0 what is sounding fades out over O
//   first (SyncTERM fades the FIFO tail and keeps the rest queued, which is
//   not what the manual says).
// - Volume sets the channel's base level (dB, default -12 dB on every
//   channel), with T a dB-linear ramp from the current level; a side not
//   given keeps its current value. Per-Queue volumes add to the base.
// - Wait resolves when the channel is idle or its head buffer loops.
// - Update arms a one-shot `CSI = 7 ; ch ; 0 n` for the channel's next
//   running-to-stopped transition.

/** A decoded buffer (an AudioBuffer in the browser). Immutable once made. */
export interface Buf {
    /** Seconds. */
    duration: number;
    /** Memory it holds (for the budget). */
    bytes: number;
    data: unknown;
}

export interface Item {
    id: number;
    ch: number;
    buf: Buf;
    /** Model time it starts sounding. */
    start: number;
    /** Model time it stops (Infinity while looping with no end yet). */
    end: number;
    loop: boolean;
    /** Fade-in over the first `fadeIn` seconds of the first pass. */
    fadeIn: number;
    /** Intrinsic fade-out: from `fadeOutAt` for `fadeOutDur` seconds (Infinity: none). */
    fadeOutAt: number;
    fadeOutDur: number;
    /** The O= asked for, applied to the final pass once a loop ends. */
    fadeOutWanted: number;
    /** A decay laid over everything else (crossfade or faded flush): gain `from` -> 0 over [at, at + dur]. */
    overlay: { at: number; dur: number; from: number } | null;
    /** Per-buffer level, dB. */
    volL: number;
    volR: number;
}

export interface Vol {
    l0: number;
    r0: number;
    l1: number;
    r1: number;
    t0: number;
    t1: number;
}

export interface Renderer {
    /** A new item; its start may be in the past (after a resume). */
    add(it: Item): void;
    /** An item's end, fade-out or overlay changed. */
    change(it: Item): void;
    /** Stop an item now (Flush, a new session) and forget it. */
    remove(it: Item): void;
    /** An item reached its end (it stops by itself); forget it. */
    ended(it: Item): void;
    /** A channel's base level changes (dB-linear from t0 to t1; t1 <= t0: at once). */
    volume(ch: number, v: Vol): void;
}

export interface MixerLimits {
    /** Items (queued or sounding) per channel. */
    perChannel: number;
    /** Items on all channels together. */
    total: number;
}

export const BASE_DB = -12;
export const CHANNELS = 16;
export const SLOTS = 256;
/** A Queue behind a loop that is about to wrap waits for the following pass instead (scheduling margin). */
const LOOP_MARGIN = 0.03;

interface Chan {
    items: Item[];
    vol: Vol;
    armed: boolean;
    running: boolean;
    waiters: (() => void)[];
}

/** Equal-power decay gain of an overlay at time t. */
export function overlayGain(o: { at: number; dur: number; from: number }, t: number): number {
    if (t <= o.at) return o.from;
    if (t >= o.at + o.dur) return 0;
    return o.from * Math.cos(((t - o.at) / o.dur) * (Math.PI / 2));
}

/** dB value of a ramp at time t (dB-linear). */
export function volAt(v: Vol, t: number): [number, number] {
    if (t >= v.t1 || v.t1 <= v.t0) return [v.l1, v.r1];
    if (t <= v.t0) return [v.l0, v.r0];
    const k = (t - v.t0) / (v.t1 - v.t0);
    return [v.l0 + (v.l1 - v.l0) * k, v.r0 + (v.r1 - v.r0) * k];
}

export class Mixer {
    readonly slots: (Buf | null)[] = new Array(SLOTS).fill(null);
    private readonly chans: Chan[] = [];
    private nextId = 1;
    /** Commands dropped by a limit (diagnostics, tests). */
    dropped = 0;

    private readonly clock: () => number;
    private readonly r: Renderer;
    /** Bytes for the host: an asynchronous `CSI = 7 ; ch ; 0 n`. */
    private readonly report: (s: string) => void;
    private readonly limits: MixerLimits;

    constructor(clock: () => number, r: Renderer, report: (s: string) => void, limits: MixerLimits = { perChannel: 64, total: 128 }) {
        this.clock = clock;
        this.r = r;
        this.report = report;
        this.limits = limits;
        for (let c = 0; c < CHANNELS; c++) this.chans.push({ items: [], vol: flat(BASE_DB, 0), armed: false, running: false, waiters: [] });
    }

    get now(): number {
        return this.clock();
    }

    /** Items alive on a channel (for the renderer and tests). */
    items(ch: number): readonly Item[] {
        return this.chans[ch].items;
    }

    allItems(): Item[] {
        return this.chans.flatMap(c => c.items);
    }

    channelVolume(ch: number): Vol {
        return this.chans[ch].vol;
    }

    isRunning(ch: number, t = this.now): boolean {
        return this.chans[ch].items.some(it => it.end > t);
    }

    /** Distinct buffers held in slots and on channels. */
    residentBytes(exceptSlot = -1): number {
        const seen = new Set<Buf>();
        this.slots.forEach((b, i) => b && i !== exceptSlot && seen.add(b));
        for (const it of this.allItems()) seen.add(it.buf);
        let n = 0;
        for (const b of seen) n += b.bytes;
        return n;
    }

    setSlot(slot: number, buf: Buf | null): void {
        this.slots[slot] = buf;
    }

    copy(src: number, dst: number): void {
        const b = this.slots[src];
        if (b) this.slots[dst] = b; // buffers are immutable: share it
    }

    // --- Queue -------------------------------------------------------------------

    queue(o: { ch: number; slot: number; fadeIn: number; fadeOut: number; crossfade: boolean; loop: boolean; volL: number; volR: number }): Item | null {
        const buf = this.slots[o.slot];
        if (o.ch < 2 || o.ch >= CHANNELS || !buf || !(buf.duration > 0)) return null;
        this.slots[o.slot] = null; // Queue moves the buffer
        return this.append(o.ch, buf, o);
    }

    /** Terminal-owned channels (0: "ANSI" music) append directly. */
    append(
        ch: number,
        buf: Buf,
        o: { fadeIn?: number; fadeOut?: number; crossfade?: boolean; loop?: boolean; volL?: number; volR?: number } = {},
    ): Item | null {
        const now = this.now;
        this.expire(now);
        const c = this.chans[ch];
        if (c.items.length >= this.limits.perChannel || this.allItems().length >= this.limits.total) {
            this.dropped++;
            return null;
        }
        const dur = buf.duration;
        let fi = Math.min(o.fadeIn ?? 0, dur);
        let fo = Math.min(o.fadeOut ?? 0, dur);
        if (fi + fo > dur) {
            const k = dur / (fi + fo);
            fi *= k;
            fo = dur - fi;
        }
        const tail = c.items.length ? c.items[c.items.length - 1] : null;
        let start = now;
        if (tail && o.crossfade && (o.fadeIn ?? 0) > 0) {
            const at = Math.max(now, tail.start);
            this.decay(tail, at, o.fadeIn ?? 0);
            start = at;
        } else if (tail) {
            if (tail.end === Infinity) this.endLoop(tail, now);
            start = tail.end;
        }
        const loop = !!o.loop;
        const it: Item = {
            id: this.nextId++,
            ch,
            buf,
            start,
            end: loop ? Infinity : start + dur,
            loop,
            fadeIn: fi,
            fadeOutAt: !loop && fo > 0 ? start + dur - fo : Infinity,
            fadeOutDur: !loop ? fo : 0,
            fadeOutWanted: fo,
            overlay: null,
            volL: o.volL ?? 0,
            volR: o.volR ?? 0,
        };
        c.items.push(it);
        c.running = true;
        this.r.add(it);
        return it;
    }

    /** A loop ends at the end of the pass in progress (or of its first pass, if it has not started). */
    private endLoop(it: Item, now: number): void {
        const d = it.buf.duration;
        const base = Math.max(now + LOOP_MARGIN, it.start);
        const k = Math.max(1, Math.ceil((base - it.start) / d - 1e-9));
        it.end = it.start + k * d;
        if (it.fadeOutWanted > 0) {
            it.fadeOutAt = Math.max(now, it.end - it.fadeOutWanted);
            it.fadeOutDur = it.end - it.fadeOutAt;
        }
        this.r.change(it);
    }

    /** Lay a decay over an item from `at` for `dur` (ends it then, at the latest). */
    private decay(it: Item, at: number, dur: number): void {
        if (it.end <= at) return;
        const from = it.overlay ? overlayGain(it.overlay, at) : 1;
        const endsAt = at + dur;
        if (it.overlay && it.overlay.at + it.overlay.dur <= endsAt) return; // already gone sooner
        it.overlay = { at, dur, from };
        it.end = Math.min(it.end, endsAt);
        this.r.change(it);
    }

    // --- Flush, Volume, Wait, Update ------------------------------------------------

    flush(ch: number, fadeOut: number): void {
        const now = this.now;
        this.expire(now);
        const c = this.chans[ch];
        const keep: Item[] = [];
        for (const it of c.items) {
            if (fadeOut > 0 && it.start <= now && it.end > now) {
                this.decay(it, now, fadeOut);
                keep.push(it);
            } else this.r.remove(it);
        }
        c.items = keep;
        this.settle(ch, now);
    }

    volume(ch: number, l: number | null, r: number | null, ramp: number): void {
        const now = this.now;
        const c = this.chans[ch];
        const [cl, cr] = volAt(c.vol, now);
        c.vol = { l0: cl, r0: cr, l1: l ?? cl, r1: r ?? cr, t0: now, t1: now + Math.max(0, ramp) };
        this.r.volume(ch, c.vol);
    }

    update(ch: number): void {
        this.chans[ch].armed = true;
    }

    /** Resolves when the channel is idle or its head buffer is a loop with no end. */
    wait(ch: number): Promise<void> {
        this.expire(this.now);
        if (this.waitDone(ch)) return Promise.resolve();
        return new Promise(res => this.chans[ch].waiters.push(res));
    }

    private waitDone(ch: number): boolean {
        const now = this.now;
        const live = this.chans[ch].items.filter(it => it.end > now);
        if (!live.length) return true;
        const head = live[0];
        return head.end === Infinity && !head.overlay && head.start <= now;
    }

    /** `CSI = 7 [; ch] n` answer. */
    stateReport(params: number[]): string {
        const CSI = '\x1b[';
        const now = this.now;
        this.expire(now);
        if (params.length < 2) {
            let s = `${CSI}=7`;
            for (let ch = 0; ch < CHANNELS; ch++) if (this.isRunning(ch, now)) s += `;${ch};1`;
            return s + 'n';
        }
        const id = params[1];
        const st = id < CHANNELS ? (this.isRunning(id, now) ? 1 : 0) : id === 100 ? 1 : 0;
        return `${CSI}=7;${id};${st}n`;
    }

    // --- time ------------------------------------------------------------------------

    /** Next model time something ends or a waiter may be released (Infinity: nothing pending). */
    nextEvent(): number {
        const now = this.now;
        let t = Infinity;
        for (const c of this.chans) {
            for (const it of c.items) {
                if (it.end > now && it.end < t) t = it.end;
                // a loop reaching the head releases a Wait
                if (c.waiters.length && it.end === Infinity && it.start > now && it.start < t) t = it.start;
            }
        }
        return t;
    }

    /** Process everything due by now: items that ended, idle reports, waiters. */
    tick(): void {
        const now = this.now;
        this.expire(now);
        for (let ch = 0; ch < CHANNELS; ch++) this.settle(ch, now);
    }

    private expire(now: number): void {
        for (const c of this.chans) {
            if (!c.items.length) continue;
            const live: Item[] = [];
            for (const it of c.items) {
                if (it.end > now) live.push(it);
                else this.r.ended(it);
            }
            c.items = live;
        }
    }

    private settle(ch: number, now: number): void {
        const c = this.chans[ch];
        const running = c.items.some(it => it.end > now);
        if (c.running && !running && c.armed) {
            c.armed = false;
            this.report(`\x1b[=7;${ch};0n`);
        }
        c.running = running;
        if (c.waiters.length && this.waitDone(ch)) {
            const w = c.waiters;
            c.waiters = [];
            for (const f of w) f();
        }
    }

    /** A new session: everything stops, slots empty, levels back to default. */
    reset(): void {
        for (let ch = 0; ch < CHANNELS; ch++) {
            const c = this.chans[ch];
            for (const it of c.items) this.r.remove(it);
            c.items = [];
            c.armed = false;
            c.running = false;
            const w = c.waiters;
            c.waiters = [];
            for (const f of w) f();
            c.vol = flat(BASE_DB, this.now);
            this.r.volume(ch, c.vol);
        }
        this.slots.fill(null);
    }
}

function flat(db: number, t: number): Vol {
    return { l0: db, r0: db, l1: db, r1: db, t0: t, t1: t };
}

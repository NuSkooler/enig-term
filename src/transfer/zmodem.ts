// ZModem through the enig-term-zmodem WASM: icy_net's ZModem (icy_board,
// Apache-2.0) behind a push-model wrapper (crates/enig-term-zmodem).
//
// The WASM session is polled, not run: feed() queues the remote's bytes,
// tick() gives it the time, and pump() polls it and moves what it produced
// (bytes for the remote, file events, requests for file data) out. Sending
// is paced by `canSend` (the WebSocket's buffer): the session is only polled
// while output can go out, and it yields every 64 KB. Upload data is read on
// request (a window at a time, from a Blob in the browser), and received
// data goes to the sink as it arrives; a sink that returns a promise holds
// the session until it settles.
//
// icy_net has no inactivity timeout of its own: the driver gives up after
// `idleTimeout` without traffic either way. And when the program on the
// board has gone (it crashed, or the board killed it) the board draws its
// menu again, which the protocol would skip as line noise for ever. So
// input that is evidently a screen (ANSI sequences: a ZModem receiver never
// sends them, and a sender's data is framed) ends the transfer, and those
// bytes go back to the screen.
//
// A panic in the WASM is a trap that leaves the instance unusable: the
// transfer fails, and the next one instantiates the module again.
import init, { ZSession, last_panic, __enigModule, __enigReset } from '../../build/wasm-zmodem/enig_term_zmodem.js';
import { BOARD_LEFT, type SourceFile, type TransferEnd, type TransferEngine, type TransferEvents } from './types.ts';
import { CANCEL_SEQ, concat, safeName } from './xymodem.ts';

let loading: Promise<void> | null = null;

/** Load (once) or, after a trap, instantiate again. `src`: the .wasm URL or its bytes. */
export function loadZmodem(src: string | URL | BufferSource): Promise<void> {
    if (!loading) {
        const mod = __enigModule();
        loading = init({ module_or_path: mod ?? src }).then(
            () => undefined,
            e => {
                loading = null;
                throw e;
            },
        );
    }
    return loading;
}

export interface ZmodemOptions {
    now: () => number;
    /** Subpacket size when sending: 1024 (ZModem) or 8192 (ZedZap, the default). */
    blockLen?: number;
    /** Largest file accepted when receiving, bytes; larger ones are skipped (0: any). */
    maxBytes?: number;
    /** Give up after this long without a byte either way, ms. */
    idleTimeout?: number;
    /** May more output go out now (the WebSocket's buffer is not full)? */
    canSend?: () => boolean;
    log?: (s: string) => void;
}

const IDLE_MS = 60_000;
/** Polls per pump before handing back to the event loop. */
const PUMP_MAX = 64;
/** ANSI sequences that make the input a screen rather than the protocol. */
const SCREEN_CSI = 4;
/** ... and, receiving (file data may hold them), this long a pause after them. */
const SCREEN_QUIET_MS = 3000;
const WINDOW_MAX = 65536;

export class ZmodemEngine implements TransferEngine {
    finished = false;
    private s: ZSession | null;
    private index = 0;
    private doneFiles = 0;
    private received = 0;
    /** The size the sender announced for the file being received. */
    private announced: number | null = null;
    private lastProgress = -1;
    private lastInput: number;
    private lastActivity: number;
    private queued: Uint8Array[] = [];
    private trailing: Uint8Array[] = [];
    private blocked = false;
    private reading = false;
    /** Input since the protocol last showed a sign of life, and the ANSI sequences in it. */
    private win: number[] = [];
    private csi = 0;
    private esc = false;
    private readonly sendFiles: SourceFile[];
    private readonly mode: 'send' | 'receive';
    private readonly out: (b: Uint8Array) => void;
    private readonly ev: TransferEvents;
    private readonly opts: ZmodemOptions;

    constructor(mode: 'send' | 'receive', files: SourceFile[], send: (b: Uint8Array) => void, ev: TransferEvents, opts: ZmodemOptions, initial?: Uint8Array) {
        this.mode = mode;
        this.sendFiles = files;
        this.out = send;
        this.ev = ev;
        this.opts = opts;
        this.lastInput = this.lastActivity = opts.now();
        this.s = new ZSession(mode, opts.now(), opts.blockLen ?? 8192, opts.maxBytes ?? 0);
        for (const f of files) this.s.add_file(f.name, f.size, f.mtime ?? 0);
        this.guard(s => {
            s.start();
            if (initial?.length) s.feed(initial);
        });
        this.pump();
    }

    private log(s: string): void {
        this.opts.log?.(`zmodem ${this.mode}: ${s}`);
    }

    /** Call into the WASM; a trap ends the transfer (and the instance). */
    private guard<T>(f: (s: ZSession) => T): T | undefined {
        const s = this.s;
        if (!s) return undefined;
        try {
            return f(s);
        } catch (e) {
            const why = last_panic() || String((e as Error)?.message ?? e);
            this.s = null;
            __enigReset();
            loading = null;
            this.out(CANCEL_SEQ);
            this.end({ ok: false, files: this.doneFiles, error: `the ZModem engine failed (${why})` });
            return undefined;
        }
    }

    feed(bytes: Uint8Array): void {
        if (!bytes.length) return;
        if (this.finished) {
            this.trailing.push(bytes.slice());
            return;
        }
        this.lastInput = this.lastActivity = this.opts.now();
        this.watch(bytes);
        if (this.finished) return;
        if (this.blocked) {
            this.queued.push(bytes.slice());
            return;
        }
        this.guard(s => s.feed(bytes));
        this.pump();
    }

    /** Keep the input since the last sign of the protocol; a screen ends the transfer. */
    private watch(bytes: Uint8Array): void {
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            if (this.win.length < WINDOW_MAX) this.win.push(b);
            if (this.esc && b === 0x5b) this.csi++;
            this.esc = b === 0x1b;
        }
        // A receiver of our files never sends ANSI sequences.
        if (this.mode === 'send' && this.csi >= SCREEN_CSI) this.boardLeft();
    }

    private alive(): void {
        this.win.length = 0;
        this.csi = 0;
        this.esc = false;
    }

    private boardLeft(): void {
        this.log('the board is showing a screen again: transfer over');
        const screen = Uint8Array.from(this.win);
        this.alive();
        this.guard(s => s.take_input()); // part of the screen, kept above
        this.trailing = [screen, ...this.queued.splice(0), ...this.trailing];
        this.end({ ok: false, files: this.doneFiles, error: BOARD_LEFT, cancelled: 'remote' });
    }

    tick(): void {
        if (this.finished || !this.s) return;
        const now = this.opts.now();
        this.guard(s => s.tick(now));
        this.pump();
        if (this.finished) return;
        if (this.mode === 'receive' && this.csi >= SCREEN_CSI && now - this.lastInput >= SCREEN_QUIET_MS) {
            this.boardLeft();
            return;
        }
        const idle = this.opts.idleTimeout ?? IDLE_MS;
        if (now - this.lastActivity > idle) this.cancel(`nothing from the board for ${Math.round(idle / 1000)} s`, false);
    }

    /** Poll the session while it has work (and, sending, while output can go out); move its results out. */
    private pump(): void {
        for (let i = 0; i < PUMP_MAX && this.s && !this.finished; i++) {
            const paced = this.mode === 'send' && this.opts.canSend && !this.opts.canSend();
            if (!this.blocked && !paced) this.guard(s => s.poll());
            const out = this.guard(s => s.take_output());
            if (out?.length) {
                this.lastActivity = this.opts.now();
                if (this.mode === 'receive') this.alive();
                this.out(out);
            }
            if (this.opts.log) for (const l of this.guard(s => s.take_log()) ?? []) this.opts.log(`zmodem ${this.mode}: ${l}`);
            if (!this.drainEvents()) return; // a sink write holds the session
            this.requestData();
            if (this.mode === 'send') {
                const p = this.guard(s => s.progress_bytes()) ?? 0;
                if (p !== this.lastProgress) {
                    this.lastProgress = p;
                    this.lastActivity = this.opts.now();
                    this.ev.progress(p);
                }
            }
            const st = this.guard(s => s.status()) ?? 2;
            if (st !== 0) {
                this.finish(st === 1 ? null : (this.guard(s => s.error()) ?? 'failed'));
                return;
            }
            if (paced || !(this.guard(s => s.wants_poll()) ?? false)) return; // tick() and feed() come back
        }
    }

    /** Hand file events to the listener. False while a sink write holds the session. */
    private drainEvents(): boolean {
        for (;;) {
            const e = this.guard(s => s.next_event());
            if (!e) return !!this.s;
            const kind = e.kind;
            if (kind !== 'data' || this.mode === 'receive') this.alive();
            try {
                switch (kind) {
                    case 'start':
                        this.received = 0;
                        this.announced = e.size;
                        this.ev.fileStart({
                            name: this.mode === 'receive' ? safeName(e.name) : e.name,
                            size: e.size,
                            index: this.index++,
                            count: this.mode === 'send' ? this.sendFiles.length : null,
                        });
                        break;
                    case 'data': {
                        const chunk = e.take_data();
                        this.received += chunk.length;
                        const r = this.ev.data?.(chunk);
                        this.ev.progress(this.received);
                        if (r && typeof (r as Promise<void>).then === 'function') {
                            this.blocked = true;
                            (r as Promise<void>).then(
                                () => {
                                    this.blocked = false;
                                    for (const q of this.queued.splice(0)) this.guard(s => s.feed(q));
                                    this.pump();
                                },
                                err => this.cancel(`could not save the file: ${(err as Error)?.message ?? err}`),
                            );
                            return false;
                        }
                        break;
                    }
                    case 'end': {
                        // Received: complete only at the size the sender announced.
                        const ok = this.mode === 'send' || this.announced === null || this.received === this.announced;
                        if (!ok) this.log(`file ended at ${this.received} of ${this.announced} bytes`);
                        if (ok) this.doneFiles++;
                        this.ev.fileEnd(ok);
                        break;
                    }
                    case 'discard':
                        this.ev.fileEnd(false);
                        break;
                    case 'skipped':
                        this.log(`skipped ${e.name} (${e.size} bytes)`);
                        this.ev.fileSkipped?.({ name: safeName(e.name), size: e.size, reason: 'too large' });
                        break;
                }
            } finally {
                e.free();
            }
        }
    }

    /** The sender waits for file data: read it (a Blob slice takes a moment) and provide it. */
    private requestData(): void {
        if (this.reading || !this.s) return;
        const idx = this.guard(s => s.need_file()) ?? -1;
        if (idx < 0) return;
        const off = this.guard(s => s.need_offset()) ?? 0;
        const len = this.guard(s => s.need_len()) ?? 0;
        const f = this.sendFiles[idx];
        if (!f) {
            this.cancel('the board asked for a file that is not being sent');
            return;
        }
        this.reading = true;
        const give = (data: Uint8Array) => {
            this.reading = false;
            if (this.finished || !this.s) return;
            this.guard(s => s.provide(idx, off, data));
            this.pump();
        };
        const bad = (err: unknown) => {
            this.reading = false;
            this.cancel(`could not read ${f.name}: ${(err as Error)?.message ?? err}`);
        };
        try {
            const r = f.read(off, len);
            if (r instanceof Uint8Array) give(r);
            else r.then(give, bad);
        } catch (err) {
            bad(err);
        }
    }

    private finish(error: string | null): void {
        if (this.finished) return;
        const rest = this.guard(s => s.take_input());
        if (rest?.length) this.trailing.unshift(rest);
        this.trailing.push(...this.queued.splice(0));
        if (error === null) this.end({ ok: true, files: this.doneFiles });
        else {
            const remote = /CAN bytes|abort|cancel/i.test(error);
            this.end({ ok: false, files: this.doneFiles, error: remote ? 'the board cancelled the transfer' : error, cancelled: remote ? 'remote' : undefined });
        }
    }

    /** Cancel from this side: the abort sequence goes out. `local: false` for a timeout. */
    cancel(reason = 'cancelled', local = true): void {
        if (this.finished) return;
        if (this.s) {
            this.guard(s => s.cancel());
            const out = this.guard(s => s.take_output());
            if (out?.length) this.out(out);
            this.drainEvents();
            const rest = this.guard(s => s.take_input());
            if (rest?.length) this.trailing.unshift(rest);
        } else this.out(CANCEL_SEQ);
        this.trailing.push(...this.queued.splice(0));
        this.end({ ok: false, files: this.doneFiles, error: reason, cancelled: local ? 'local' : undefined });
    }

    /** The connection closed: nothing more will come. */
    close(): void {
        if (this.finished) return;
        this.guard(s => s.close());
        this.pump();
        this.end({ ok: false, files: this.doneFiles, error: 'the connection closed' });
    }

    private end(r: TransferEnd): void {
        if (this.finished) return;
        // An abandoned file still gets its fileEnd(false): dropping the
        // protocol (cancel, without sending what it says) emits "discard".
        if (this.s) {
            if (this.guard(s => s.status()) === 0) this.guard(s => s.cancel());
            this.drainEvents();
        }
        this.finished = true;
        try {
            this.s?.free();
        } catch {
            /* a trapped instance */
        }
        this.s = null;
        this.ev.done(r);
    }

    takeTrailing(): Uint8Array {
        return concat(this.trailing.splice(0));
    }
}

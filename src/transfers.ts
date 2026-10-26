// File transfers for the terminal. ZModem starts by itself: the board's sz
// or rz announces it in the stream (detect.ts), and a download begins at
// once (or after asking, `zmodemDetect: "ask"`), an upload asks for files.
// The user can also prepare one from the Files panel (it waits for the
// board). XModem and YModem cannot announce themselves, so they start from
// the panel.
//
// While a transfer runs it owns the stream: what the board sends goes to the
// protocol engine, not the screen, and what the user types is not sent. The
// engine's output goes out through the terminal (which escapes Telnet IAC).
// When it ends, whatever came after it goes back to the screen.
//
// This part is in the main bundle: state, detection, saving, progress. The
// engines (X/YModem, ZModem and its WASM) are loaded the first time a
// transfer starts (dist/enig-term-xfer.js).
import { ZmodemDetector, type ZmodemStart } from './transfer/detect.ts';
import { BlobSaver, FolderSaver, canPickFolder, fileSource, pickFolder, type FileSink, type SavedFile, type Saver } from './transfer/save.ts';
import { BOARD_LEFT, type FileInfo, type SourceFile, type TransferEnd, type TransferEngine, type TransferEvents } from './transfer/types.ts';
import type * as Engines from './transfer/index.ts';

export type TransferProtocol = 'zmodem' | 'ymodem' | 'xmodem';
export type TransferDirection = 'download' | 'upload';
/**
 * idle: nothing. armed: prepared from the panel, waiting for the board to
 * start ZModem. offer: the board started ZModem, waiting for the user.
 * loading: the engine is being fetched. running. done, failed, cancelled:
 * the last transfer's outcome (the stream is the screen's again).
 */
export type TransferPhase = 'idle' | 'armed' | 'offer' | 'loading' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TransferStatus {
    phase: TransferPhase;
    direction: TransferDirection | null;
    protocol: TransferProtocol | null;
    /** The file in progress. */
    file: FileInfo | null;
    /** Bytes of that file so far. */
    fileBytes: number;
    /** Bytes of the whole batch, when known. */
    totalBytes: number | null;
    /** Bytes done in the batch (files finished and the current one). */
    doneBytes: number;
    /** Bytes per second, recent. */
    rate: number;
    /** Seconds left, when it can be told. */
    eta: number | null;
    /** Files finished (saved, for downloads; sent, for uploads), in order. */
    files: (SavedFile & { ok: boolean })[];
    skipped: { name: string; size: number; reason: string }[];
    error: string | null;
    /** What the UI should say (what the transfer waits for). */
    message: string | null;
}

export interface TransfersHost {
    /** Bytes for the board (the terminal escapes Telnet IAC). */
    send(bytes: Uint8Array): void;
    /** Bytes for the screen (the bytes after a transfer, text before one). */
    screen(bytes: Uint8Array): void;
    /** The WebSocket's buffer has room. */
    canSend(): boolean;
    log(s: string): void;
    notice(level: 'info' | 'warn' | 'error', text: string): void;
    status(s: TransferStatus): void;
    /** Where a download link goes for its click. */
    container(): HTMLElement;
}

export interface TransfersOptions {
    /** Transfers at all (false: no detection, no panel). */
    transfers: boolean;
    /** A ZModem download the board starts: begin at once, ask first, or ignore it (shown as text). */
    zmodemDetect: 'auto' | 'ask' | 'off';
    /** Largest file saved through a browser download, MB (a folder has no limit). */
    transferMaxFile: number;
}

declare const __ENIG_TERM_XFER_HASH__: string | undefined;
const XFER_QUERY = typeof __ENIG_TERM_XFER_HASH__ === 'string' && __ENIG_TERM_XFER_HASH__ ? `?v=${__ENIG_TERM_XFER_HASH__}` : '';

/** Engines bundle (shared by every terminal on the page). */
let engines: Promise<typeof Engines> | null = null;
function loadEngines(): Promise<typeof Engines> {
    if (!engines) {
        engines = import(/* @vite-ignore */ new URL(`enig-term-xfer.js${XFER_QUERY}`, import.meta.url).href) as Promise<typeof Engines>;
        engines.catch(() => (engines = null));
    }
    return engines;
}

const TICK_MS = 50;
/** A held possible header start goes to the screen after this without more data. */
const HOLD_MS = 40;
/** An offer nobody answers is refused after this (the board's side gives up too). */
const OFFER_MS = 90_000;
/** Bytes kept while an offer waits or the engine loads. */
const BUFFER_MAX = 1 << 20;
/** Status updates at most this often while running. */
const STATUS_MS = 150;
/** The ZModem abort sequence (eight CANs, ten backspaces), to refuse an offer before any engine is loaded. */
const ZABORT = Uint8Array.from([24, 24, 24, 24, 24, 24, 24, 24, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
const MB = 1 << 20;
/** After a failed transfer, data still in flight is dropped until the line is this quiet... */
const DRAIN_QUIET_MS = 500;
/** ...or for at most this long. */
const DRAIN_MAX_MS = 120_000;
/** While protocol data keeps coming, the abort goes out again this often (some senders only look now and then)... */
const DRAIN_ABORT_MS = 1000;
/** ...this many times. */
const DRAIN_ABORTS = 10;
/** The tail of the drained data kept, for the text that follows it. */
const DRAIN_KEEP = 65536;

/** Not text: a C0 control other than BEL, BS, HT, LF, FF, CR, SO, SI and ESC (protocol data is full of them). */
function binary(b: number): boolean {
    return (b < 0x20 && !(b >= 0x07 && b <= 0x0a) && b !== 0x0c && b !== 0x0d && b !== 0x0e && b !== 0x0f && b !== 0x1b) || b === 0x7f;
}

/** What follows the last protocol-looking byte: the board's text after a failed transfer. */
export function textTail(b: Uint8Array): Uint8Array {
    let i = b.length - 1;
    while (i >= 0 && !binary(b[i])) i--;
    return b.subarray(i + 1);
}

interface Armed {
    direction: TransferDirection;
    files: File[];
}

export class Transfers {
    private readonly host: TransfersHost;
    private opts: TransfersOptions;
    private readonly detector = new ZmodemDetector();
    private holdTimer = 0;
    private ticker = 0;
    private engine: TransferEngine | null = null;
    private armed: Armed | null = null;
    private offer: { kind: ZmodemStart; since: number } | null = null;
    private buffered: Uint8Array[] = [];
    private bufferedBytes = 0;
    private cancelPending = false;
    private folder: FolderSaver | null = null;
    private saver: Saver;
    private sink: FileSink | null = null;
    private st: TransferStatus = blank();
    private samples: [number, number][] = [];
    private doneBefore = 0;
    private lastStatus = 0;
    private statusTimer = 0;
    private destroyed = false;
    /** After a failed transfer: what arrives until the line goes quiet. */
    private drain: { until: number; last: number; parts: Uint8Array[]; kept: number; dropped: number; binaryAt: number; abortAt: number; aborts: number } | null = null;

    constructor(host: TransfersHost, opts: TransfersOptions) {
        this.host = host;
        this.opts = { ...opts };
        this.saver = new BlobSaver(() => host.container());
    }

    set(o: Partial<TransfersOptions>): void {
        Object.assign(this.opts, o);
    }

    get status(): TransferStatus {
        return this.st;
    }

    /** A transfer owns the stream (an offer waiting, loading, running). */
    get busy(): boolean {
        return this.st.phase === 'offer' || this.st.phase === 'loading' || this.st.phase === 'running';
    }

    get folderName(): string | null {
        return this.folder ? this.folder.dir.name : null;
    }

    get canPickFolder(): boolean {
        return canPickFolder();
    }

    // --- the stream ---------------------------------------------------------------

    /** Every chunk from the board (Telnet decoded) comes here first. */
    incoming(data: Uint8Array): void {
        if (!data.length) return;
        if (this.engine) {
            this.engine.feed(data);
            return;
        }
        if (this.drain) {
            this.drained(data);
            return;
        }
        if (this.st.phase === 'offer' || this.st.phase === 'loading') {
            this.keep(data);
            return;
        }
        if (!this.detecting) {
            this.host.screen(data);
            return;
        }
        clearTimeout(this.holdTimer);
        const r = this.detector.scan(data);
        if (r.screen.length) this.host.screen(r.screen);
        if (r.start) {
            this.zmodemStart(r.start.kind, r.start.bytes);
            return;
        }
        if (this.detector.holding)
            this.holdTimer = window.setTimeout(() => {
                const b = this.detector.flush();
                if (b.length) this.host.screen(b);
            }, HOLD_MS);
    }

    private get detecting(): boolean {
        return this.opts.transfers && (this.opts.zmodemDetect !== 'off' || this.armed !== null);
    }

    private keep(data: Uint8Array): void {
        if (this.bufferedBytes + data.length > BUFFER_MAX) return; // the start is what matters
        this.buffered.push(data.slice());
        this.bufferedBytes += data.length;
    }

    private takeBuffered(): Uint8Array {
        const n = this.bufferedBytes;
        const out = new Uint8Array(n);
        let o = 0;
        for (const b of this.buffered.splice(0)) {
            out.set(b, o);
            o += b.length;
        }
        this.bufferedBytes = 0;
        return out;
    }

    /** The board started ZModem. */
    private zmodemStart(kind: ZmodemStart, bytes: Uint8Array): void {
        this.host.log(`zmodem: the board ${kind === 'download' ? 'sends (ZRQINIT)' : 'waits for files (ZRINIT)'}`);
        const armed = this.armed;
        if (armed && armed.direction === kind && (kind === 'download' || armed.files.length)) {
            this.armed = null;
            this.keep(bytes);
            void this.start(kind, 'zmodem', armed.files);
            return;
        }
        if (kind === 'download' && this.opts.zmodemDetect === 'auto' && !armed) {
            this.keep(bytes);
            void this.start('download', 'zmodem', []);
            return;
        }
        // Ask: an upload needs files, a download the user's yes.
        this.offer = { kind, since: performance.now() };
        this.keep(bytes);
        this.update({
            ...blank(),
            phase: 'offer',
            direction: kind,
            protocol: 'zmodem',
            message: kind === 'upload' ? 'The board is ready to receive files (ZModem).' : 'The board wants to send files (ZModem).',
        });
        this.startTicker();
    }

    // --- what the user (or the API) asks for ------------------------------------------

    /** Receive: ZModem waits for the board (or takes its offer); X/YModem starts now. */
    download(protocol: TransferProtocol, name = 'download.bin'): boolean {
        if (!this.ready()) return false;
        if (protocol === 'zmodem') {
            if (this.offer?.kind === 'download') return this.accept([]);
            this.armed = { direction: 'download', files: [] };
            this.update({ ...blank(), phase: 'armed', direction: 'download', protocol, message: 'Waiting for the board to start sending (ZModem)…' });
            return true;
        }
        void this.start('download', protocol, [], name);
        return true;
    }

    /** Send files: ZModem waits for the board's receiver (or takes its offer); X/YModem starts now. */
    upload(files: File[], protocol: TransferProtocol): boolean {
        if (!files.length || !this.ready()) return false;
        if (protocol === 'xmodem' && files.length > 1) {
            this.host.notice('warn', 'XModem sends one file at a time; choose YModem or ZModem for several.');
            return false;
        }
        if (protocol === 'zmodem') {
            if (this.offer?.kind === 'upload') return this.accept(files);
            this.armed = { direction: 'upload', files };
            this.update({ ...blank(), phase: 'armed', direction: 'upload', protocol, message: 'Waiting for the board to start receiving (ZModem)…' });
            return true;
        }
        void this.start('upload', protocol, files);
        return true;
    }

    /** Take the board's ZModem offer (files: for an upload). */
    accept(files: File[]): boolean {
        const o = this.offer;
        if (!o) return false;
        if (o.kind === 'upload' && !files.length) return false;
        this.offer = null;
        void this.start(o.kind, 'zmodem', files);
        return true;
    }

    /** Cancel whatever is going on (an offer is refused, a prepared transfer forgotten). */
    cancel(reason = 'cancelled'): void {
        if (this.engine) {
            this.engine.cancel(reason);
            return;
        }
        if (this.st.phase === 'loading') {
            this.cancelPending = true;
            return;
        }
        if (this.offer) {
            this.offer = null;
            this.host.send(ZABORT);
            this.buffered.length = 0;
            this.bufferedBytes = 0;
            this.stopTicker();
            this.update({ ...this.st, phase: 'cancelled', message: null, error: 'refused' });
            return;
        }
        if (this.armed) {
            this.armed = null;
            this.update(blank());
        }
    }

    /** Let downloads go into a folder (Chromium; call from a click). */
    async chooseFolder(): Promise<string | null> {
        const dir = await pickFolder();
        if (!dir) return null;
        this.folder = new FolderSaver(dir, s => this.host.log(s));
        return dir.name;
    }

    forgetFolder(): void {
        this.folder = null;
    }

    /** Clear the last outcome (the UI closed it). */
    dismiss(): void {
        if (this.busy || this.st.phase === 'armed') return;
        this.saver.release();
        this.update(blank());
    }

    /** The connection closed. */
    connectionClosed(): void {
        clearTimeout(this.holdTimer);
        this.detector.flush();
        if (this.drain) {
            this.drain = null;
            this.stopTicker();
        }
        this.armed = null;
        if (this.engine) {
            const e = this.engine as TransferEngine & { close?: () => void };
            if (e.close) e.close();
            else e.cancel('the connection closed');
            return;
        }
        if (this.busy || this.st.phase === 'armed') {
            this.offer = null;
            this.buffered.length = 0;
            this.bufferedBytes = 0;
            this.stopTicker();
            this.update({ ...this.st, phase: this.st.phase === 'armed' ? 'idle' : 'failed', error: this.st.phase === 'armed' ? null : 'the connection closed', message: null });
        }
    }

    private ready(): boolean {
        if (!this.opts.transfers) return false;
        if (this.busy) {
            this.host.notice('info', 'A file transfer is already in progress.');
            return false;
        }
        return true;
    }

    // --- running a transfer -------------------------------------------------------------

    private async start(direction: TransferDirection, protocol: TransferProtocol, files: File[], name?: string): Promise<void> {
        this.offer = null;
        this.armed = null;
        this.cancelPending = false;
        const total = direction === 'upload' ? files.reduce((n, f) => n + f.size, 0) : null;
        this.samples = [];
        this.doneBefore = 0;
        this.update({ ...blank(), phase: 'loading', direction, protocol, totalBytes: total, message: 'Starting…' });
        this.startTicker();
        let mod: typeof Engines;
        try {
            mod = await loadEngines();
            if (protocol === 'zmodem') await mod.loadZmodem(mod.zmodemWasmUrl());
        } catch (e) {
            this.host.log(`transfer: could not load the engines: ${(e as Error)?.message ?? e}`);
            if (protocol === 'zmodem') this.host.send(ZABORT);
            this.finished({ ok: false, files: 0, error: 'the transfer code could not be loaded' });
            return;
        }
        if (this.destroyed) return;
        if (this.st.phase !== 'loading') return; // the connection closed meanwhile
        const saver = this.folder ?? this.saver;
        const maxBytes = saver.kind === 'folder' ? 0 : this.opts.transferMaxFile * MB;
        const now = () => performance.now();
        const send = (b: Uint8Array) => this.host.send(b);
        const ev = this.events(direction);
        const log = (s: string) => this.host.log(s);
        const sources: SourceFile[] = files.map(fileSource);
        try {
            if (protocol === 'zmodem') {
                this.engine = new mod.ZmodemEngine(direction === 'download' ? 'receive' : 'send', sources, send, ev, { now, maxBytes, canSend: () => this.host.canSend(), log }, this.takeBuffered());
            } else if (direction === 'download') {
                this.engine = new mod.XyReceiver(protocol, send, ev, { now, name, maxBytes, log });
            } else {
                this.engine = new mod.XySender(protocol === 'xmodem' ? 'xmodem-1k' : 'ymodem', sources, send, ev, { now, log });
            }
        } catch (e) {
            this.finished({ ok: false, files: 0, error: String((e as Error)?.message ?? e) });
            return;
        }
        if (this.engine && !this.engine.finished) {
            this.update({
                ...this.st,
                phase: 'running',
                message:
                    protocol === 'zmodem'
                        ? null
                        : direction === 'download'
                          ? `Waiting for the board to send (${label(protocol)})…`
                          : `Waiting for the board to receive (${label(protocol)})…`,
            });
            // X/YModem: anything that came while loading is the board's.
            const early = this.takeBuffered();
            if (early.length) this.engine.feed(early);
            if (this.cancelPending) this.engine.cancel('cancelled');
        }
    }

    private events(direction: TransferDirection): TransferEvents {
        return {
            log: s => this.host.log(s),
            fileStart: f => {
                if (direction === 'download') this.sink = (this.folder ?? this.saver).begin(f.name, f.size);
                const total = this.st.totalBytes ?? (f.batchBytes != null ? f.batchBytes + this.doneBefore : null);
                this.update({ ...this.st, file: f, fileBytes: 0, totalBytes: total, message: null }, true);
            },
            data: chunk => this.sink?.write(chunk),
            progress: bytes => {
                this.st.fileBytes = bytes;
                this.st.doneBytes = this.doneBefore + bytes;
                this.update(this.st);
            },
            fileEnd: ok => {
                const f = this.st.file;
                let saved: (SavedFile & { ok: boolean }) | null = null;
                if (direction === 'download') {
                    const s = this.sink?.end(ok) ?? null;
                    this.sink = null;
                    saved = s ? { ...s, ok } : f ? { name: f.name, size: this.st.fileBytes, where: 'download', ok: false } : null;
                } else if (f) saved = { name: f.name, size: f.size ?? this.st.fileBytes, where: 'download', ok };
                this.doneBefore += this.st.fileBytes;
                this.update({ ...this.st, files: saved ? [...this.st.files, saved] : this.st.files }, true);
            },
            fileSkipped: f => {
                this.host.notice('warn', `${f.name} (${size(f.size)}) was skipped: it is larger than this browser saves (${this.opts.transferMaxFile} MB).`);
                this.update({ ...this.st, skipped: [...this.st.skipped, f] }, true);
            },
            done: r => queueMicrotask(() => this.finished(r)),
        };
    }

    private finished(r: TransferEnd): void {
        const e = this.engine;
        this.engine = null;
        this.sink = null;
        this.stopTicker();
        const phase: TransferPhase = r.ok ? 'done' : r.cancelled === 'local' ? 'cancelled' : 'failed';
        this.update({ ...this.st, phase, error: r.ok ? null : r.error, message: null, rate: 0, eta: null }, true);
        const rest = e?.takeTrailing() ?? new Uint8Array(0);
        const early = this.takeBuffered();
        if (!r.ok && r.error !== BOARD_LEFT) {
            // Data the board had already sent is still on its way, and a
            // sender may not have seen the abort yet: drop protocol data until
            // the line is quiet (saying abort again while it keeps coming),
            // then show the text that came after it.
            const now = performance.now();
            this.drain = { until: now + DRAIN_MAX_MS, last: now, parts: [], kept: 0, dropped: 0, binaryAt: 0, abortAt: now, aborts: 0 };
            this.drained(rest);
            this.drained(early);
            this.startTicker();
            return;
        }
        if (rest.length) this.incoming(rest);
        if (early.length) this.incoming(early);
    }

    /** Keep the tail of what arrives while draining; note when it is protocol data. */
    private drained(data: Uint8Array): void {
        const d = this.drain;
        if (!d || !data.length) return;
        const now = performance.now();
        d.last = now;
        for (let i = 0; i < data.length; i++)
            if (binary(data[i])) {
                d.binaryAt = now;
                break;
            }
        d.parts.push(data.slice());
        d.kept += data.length;
        while (d.parts.length > 1 && d.kept - d.parts[0].length >= DRAIN_KEEP) {
            d.kept -= d.parts[0].length;
            d.dropped += d.parts.shift()!.length;
        }
    }

    private drainTick(now: number): void {
        const d = this.drain!;
        if (now - d.last >= DRAIN_QUIET_MS || now > d.until) {
            this.endDrain();
            return;
        }
        // Protocol data still flowing: the sender has not taken the abort yet.
        if (d.binaryAt && now - d.binaryAt < DRAIN_ABORT_MS && now - d.abortAt >= DRAIN_ABORT_MS && d.aborts < DRAIN_ABORTS) {
            d.abortAt = now;
            d.aborts++;
            this.host.send(ZABORT);
        }
    }

    private endDrain(): void {
        const d = this.drain;
        if (!d) return;
        this.drain = null;
        this.stopTicker();
        const all = new Uint8Array(d.kept);
        let o = 0;
        for (const p of d.parts) {
            all.set(p, o);
            o += p.length;
        }
        const text = textTail(all);
        const dropped = d.dropped + all.length - text.length;
        if (dropped) this.host.log(`transfer: dropped ${dropped} bytes of protocol data after the end${d.aborts ? ` (abort sent again ${d.aborts} times)` : ''}`);
        if (text.length) this.incoming(text);
    }

    // --- clock and status ------------------------------------------------------------------

    private startTicker(): void {
        if (!this.ticker) this.ticker = window.setInterval(() => this.tick(), TICK_MS);
    }

    private stopTicker(): void {
        clearInterval(this.ticker);
        this.ticker = 0;
    }

    private tick(): void {
        if (this.drain) {
            this.drainTick(performance.now());
            return;
        }
        if (this.engine) this.engine.tick();
        if (this.offer && performance.now() - this.offer.since > OFFER_MS) this.cancel('no answer');
        if (this.st.phase === 'running') this.update(this.st);
    }

    private update(s: TransferStatus, force = false): void {
        this.st = s;
        const now = performance.now();
        if (s.phase === 'running') {
            this.samples.push([now, s.doneBytes]);
            while (this.samples.length > 2 && now - this.samples[0][0] > 3000) this.samples.shift();
            const [t0, b0] = this.samples[0];
            s.rate = now - t0 > 250 ? ((s.doneBytes - b0) * 1000) / (now - t0) : s.rate;
            const total = s.totalBytes ?? (s.file?.size != null ? this.doneBefore + s.file.size : null);
            s.eta = total !== null && s.rate > 0 ? Math.max(0, (total - s.doneBytes) / s.rate) : null;
        }
        if (!force && s.phase === 'running' && now - this.lastStatus < STATUS_MS) {
            if (!this.statusTimer) this.statusTimer = window.setTimeout(() => ((this.statusTimer = 0), this.update(this.st, true)), STATUS_MS);
            return;
        }
        clearTimeout(this.statusTimer);
        this.statusTimer = 0;
        this.lastStatus = now;
        this.host.status({ ...s, files: [...s.files], skipped: [...s.skipped] });
    }

    destroy(): void {
        this.destroyed = true;
        this.engine?.cancel('closed');
        this.engine = null;
        this.stopTicker();
        clearTimeout(this.holdTimer);
        clearTimeout(this.statusTimer);
        this.saver.release();
    }
}

function blank(): TransferStatus {
    return { phase: 'idle', direction: null, protocol: null, file: null, fileBytes: 0, totalBytes: null, doneBytes: 0, rate: 0, eta: null, files: [], skipped: [], error: null, message: null };
}

export function label(p: TransferProtocol | null): string {
    return p === 'zmodem' ? 'ZModem' : p === 'ymodem' ? 'YModem' : p === 'xmodem' ? 'XModem' : '';
}

/** 1536 -> "1.5 KB". */
export function size(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < MB) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    if (n < 1024 * MB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
    return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

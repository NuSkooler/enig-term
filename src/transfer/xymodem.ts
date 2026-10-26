// X/YModem for file transfers with a BBS: XModem (128-byte blocks, checksum
// or CRC-16), XModem-1K, and YModem batch (block 0 headers, the
// end-of-batch null block). Pure state machines: the remote's bytes go in
// through feed(), ours go out through `send`, and a clock (`now`) drives the
// timeouts on tick(). No DOM: the Node tests run them as they are.
//
// From Chuck Forsberg's "XMODEM/YMODEM Protocol Reference" (1988), checked
// against the remote ends ENiGMA runs (Synchronet's sexyz, lrzsz's
// sx/rx/sb/rb):
//
// - A receiver asks for a mode with 'C' (CRC-16) or NAK (checksum). sexyz's
//   `ry` sends 'C' every 3 s, falls back to NAK after three tries and gives
//   up after about 30 s, so a sender must answer promptly and take either.
// - A receiver NAKs the first EOT (Forsberg's double-EOT check) and ACKs the
//   second; a sender sends EOT again on NAK.
// - A YModem batch ends with an empty block 0 (the null block), never CAN:
//   CAN fails the receiver's whole run, files received or not (ENiGMA #914).
// - On a pty, sexyz writes its status text into the same stream as the
//   protocol ("Copyright", "CRC-16", progress lines). So a sender takes a 'C'
//   or NAK as a mode request only once the line has been quiet after it, and
//   a receiver skips bytes that cannot start a block; a block spoiled by text
//   fails its check and is sent again.
// - Before each block it waits for, sexyz throws away whatever input is
//   waiting. A block sent on a false start is lost that way and the receiver
//   asks again: a 'C' or NAK while block 0 or 1 is unacknowledged means
//   "send it again".
import { BOARD_LEFT, type FileInfo, type SourceFile, type TransferEnd, type TransferEngine, type TransferEvents } from './types.ts';

export const SOH = 0x01;
export const STX = 0x02;
export const EOT = 0x04;
export const ACK = 0x06;
export const BS = 0x08;
export const NAK = 0x15;
export const CAN = 0x18;
export const SUB = 0x1a;
export const CRC_REQ = 0x43; // 'C'

/** Cancel: ten CANs (receivers need two in a row), then backspaces that erase them on a screen. */
export const CANCEL_SEQ = Uint8Array.from([...new Array(10).fill(CAN), ...new Array(10).fill(BS)]);

/**
 * What goes out when a transfer ends because the board is showing a screen
 * again: its program has gone, so what this side sent since the protocol was
 * last heard (requests, headers, data) reached the board's prompt as typing.
 * The abort's CANs are dropped there; enough backspaces to rub out that
 * typing follow (a prompt's field holds little, hence the cap).
 */
export function boardLeftAbort(sent: number): Uint8Array {
    const bs = Math.max(10, Math.min(sent, 256));
    return Uint8Array.from([...new Array(8).fill(CAN), ...new Array(bs).fill(BS)]);
}

/** Silence after a 'C' or NAK before a sender takes it as a mode request. */
export const QUIET_MS = 100;
/** A receiver asks for the start of a file this often. */
export const REQUEST_MS = 3000;
/** Longest wait for an acknowledgement, or for the next block (sexyz uses 10 s). */
export const ACK_MS = 10_000;
/** A block that stops arriving half-way is dropped after this. */
export const BYTE_MS = 3000;
/** After a bad block, the line must be quiet this long before the NAK. */
export const PURGE_MS = 200;
/** Retries of one block (or request) before giving up. */
export const MAX_ERRORS = 10;
/** Wait for the ACK of the end-of-batch block; without one the batch is still done. */
export const FIN_MS = 1500;
/** Default wait for the other end to start, ms. */
export const START_MS = 60_000;

const CRC_TABLE = (() => {
    const t = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i << 8;
        for (let j = 0; j < 8; j++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
        t[i] = c & 0xffff;
    }
    return t;
})();

/** CRC-16/XMODEM (polynomial 0x1021, initial 0, not reflected). */
export function crc16(data: Uint8Array, crc = 0): number {
    for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff;
    return crc;
}

/** The 8-bit arithmetic checksum of classic XModem. */
export function checksum(data: Uint8Array): number {
    let s = 0;
    for (let i = 0; i < data.length; i++) s = (s + data[i]) & 0xff;
    return s;
}

/** One block: SOH/STX, number, its complement, the payload padded to `size` with `pad`, CRC-16 or checksum. */
export function encodeBlock(num: number, payload: Uint8Array, size: 128 | 1024, crc: boolean, pad = SUB): Uint8Array {
    if (payload.length > size) throw new RangeError('payload larger than the block');
    const out = new Uint8Array(3 + size + (crc ? 2 : 1));
    out[0] = size === 1024 ? STX : SOH;
    out[1] = num & 0xff;
    out[2] = ~num & 0xff;
    out.set(payload, 3);
    out.fill(pad, 3 + payload.length, 3 + size);
    const data = out.subarray(3, 3 + size);
    if (crc) {
        const c = crc16(data);
        out[3 + size] = c >> 8;
        out[4 + size] = c & 0xff;
    } else out[3 + size] = checksum(data);
    return out;
}

/** A file name as it goes out: the last path segment, printable ASCII only. */
export function wireName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? '';
    const s = base.replace(/[^\x21-\x7e ]/g, '_').trim();
    return s || 'file';
}

/** A received file name made safe to save: no path, no control characters, not empty. */
export function safeName(raw: string, fallback = 'download.bin'): string {
    const base = raw.split(/[\\/]/).pop() ?? '';
    const s = base.replace(/[\x00-\x1f\x7f"*:<>?|]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
    return s || fallback;
}

/**
 * YModem block 0 payload: name NUL, then "size mtime mode serial files bytes"
 * (decimal size, octal mtime and mode, as lrzsz and sexyz write and read it).
 */
export function ymodemHeader(f: { name: string; size: number; mtime?: number }, filesLeft: number, bytesLeft: number): Uint8Array {
    const name = wireName(f.name);
    const mtime = Math.max(0, Math.floor((f.mtime ?? 0) / 1000));
    const info = `${f.size} ${mtime.toString(8)} 100644 0 ${filesLeft} ${bytesLeft}`;
    const s = `${name}\0${info}\0`;
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

export interface YHeader {
    name: string;
    size: number | null;
    mtime: number | null;
    files: number | null;
    bytes: number | null;
}

/** Parse block 0. Null for the end-of-batch block (an empty name). */
export function parseYmodemHeader(data: Uint8Array): YHeader | null {
    if (!data.length || data[0] === 0) return null;
    let i = 0;
    let name = '';
    while (i < data.length && data[i] !== 0) name += String.fromCharCode(data[i++]);
    i++;
    let rest = '';
    while (i < data.length && data[i] !== 0 && rest.length < 200) rest += String.fromCharCode(data[i++]);
    const f = rest.trim().split(/\s+/);
    const num = (s: string | undefined, radix: number) => {
        if (s === undefined || !(radix === 8 ? /^[0-7]+$/ : /^\d+$/).test(s)) return null;
        const n = parseInt(s, radix);
        return Number.isSafeInteger(n) ? n : null;
    };
    return { name, size: num(f[0], 10), mtime: num(f[1], 8), files: num(f[4], 10), bytes: num(f[5], 10) };
}

/**
 * Bytes that are not the protocol. sexyz's status lines are plain text; a
 * board's screen is not: after a few ANSI sequences the transfer program has
 * evidently gone and the board is drawing its menu again. Those bytes are
 * the screen's, so they are kept (bounded) to hand back.
 */
const JUNK_MAX = 65536;

class Junk {
    bytes: number[] = [];
    /** Bytes this side sent since the protocol was last heard. */
    sent = 0;
    private esc = false;
    private csi = 0;
    /** Returns true when the board looks to be drawing a screen again. */
    add(b: number): boolean {
        // The newest bytes are kept: a screen comes at the end.
        this.bytes.push(b);
        if (this.bytes.length >= 2 * JUNK_MAX) this.bytes.splice(0, this.bytes.length - JUNK_MAX);
        if (this.esc && b === 0x5b) this.csi++;
        this.esc = b === 0x1b;
        return this.csi >= 4;
    }
    /** The newest bytes (a screen, when the board has moved on). */
    take(): Uint8Array {
        return Uint8Array.from(this.bytes.slice(-JUNK_MAX));
    }
    clear(): void {
        this.bytes.length = 0;
        this.sent = 0;
        this.esc = false;
        this.csi = 0;
    }
}

export interface XyOptions {
    /** Clock, ms (performance.now in the shell, a fake one in tests). */
    now: () => number;
    /** How long to wait for the other end to start, ms. */
    startTimeout?: number;
    log?: (s: string) => void;
}

export type XySendProtocol = 'xmodem' | 'xmodem-1k' | 'ymodem';
export type XyRecvProtocol = 'xmodem' | 'ymodem';

type SendState = 'start' | 'ack0' | 'data' | 'reading' | 'ack' | 'eot' | 'fin' | 'done';

/** Sends files: XModem (one file) or YModem (a batch). */
export class XySender implements TransferEngine {
    finished = false;
    private st: SendState = 'start';
    private crc = true;
    private fileIdx = 0;
    private filesDone = 0;
    private block = 1;
    private offset = 0;
    private pkt: Uint8Array | null = null;
    private pktLen = 0;
    private errors = 0;
    private cans = 0;
    private waitSince: number;
    private sentAt = 0;
    private pending: { byte: number; at: number } | null = null;
    /** A 'C' while block 0 or 1 waits for its ACK: a request to send it again, once the line is quiet. */
    private resendAt = 0;
    private trailing: Uint8Array[] = [];
    private junk = new Junk();
    private readonly ymodem: boolean;
    private readonly use1k: boolean;
    private readonly startTimeout: number;
    private readonly proto: XySendProtocol;
    private readonly files: SourceFile[];
    private readonly out: (b: Uint8Array) => void;
    private readonly ev: TransferEvents;
    private readonly opts: XyOptions;

    constructor(proto: XySendProtocol, files: SourceFile[], send: (b: Uint8Array) => void, ev: TransferEvents, opts: XyOptions) {
        this.proto = proto;
        this.files = files;
        this.out = b => {
            this.junk.sent += b.length;
            send(b);
        };
        this.ev = ev;
        this.opts = opts;
        this.ymodem = proto === 'ymodem';
        this.use1k = proto !== 'xmodem';
        this.startTimeout = opts.startTimeout ?? START_MS;
        this.waitSince = opts.now();
        if (!files.length) throw new Error('nothing to send');
        if (!this.ymodem && files.length > 1) throw new Error('XModem sends one file');
    }

    private log(s: string): void {
        this.opts.log?.(`${this.proto} send: ${s}`);
    }

    feed(bytes: Uint8Array): void {
        for (let i = 0; i < bytes.length; i++) {
            if (this.finished) {
                this.trailing.push(bytes.slice(i));
                return;
            }
            this.byte(bytes[i]);
        }
    }

    private byte(b: number): void {
        if (b === CAN) {
            if (++this.cans >= 2) this.end({ ok: false, files: this.filesDone, error: 'the board cancelled the transfer', cancelled: 'remote' });
            return;
        }
        this.cans = 0;
        const now = this.opts.now();
        let used = true;
        if (b !== CRC_REQ) this.resendAt = 0;
        switch (this.st) {
            case 'start':
            case 'data':
                // A mode request counts once the line is quiet after it (see the top).
                this.pending = b === CRC_REQ || b === NAK ? { byte: b, at: now } : null;
                used = this.pending !== null;
                break;
            case 'ack0':
                if (b === ACK) {
                    this.errors = 0;
                    this.st = 'data';
                    this.waitSince = now;
                    this.pending = null;
                } else if (b === NAK) this.resend('block 0 refused');
                else if (b === CRC_REQ) this.resendAt = now;
                else used = false;
                break;
            case 'ack':
                if (b === ACK) {
                    this.errors = 0;
                    this.offset += this.pktLen;
                    this.ev.progress(this.offset);
                    this.block = (this.block + 1) & 0xff;
                    this.next();
                } else if (b === NAK) this.resend(`block ${this.block} refused`);
                else if (b === CRC_REQ && this.offset === 0) this.resendAt = now;
                else used = false;
                break;
            case 'eot':
                if (b === ACK) this.fileDone();
                else if (b === NAK) this.resend('EOT answered with NAK');
                else used = false;
                break;
            case 'fin':
                if (b === ACK) this.end({ ok: true, files: this.filesDone });
                else if (b === NAK || b === CRC_REQ) this.resend('end-of-batch block refused');
                else used = false;
                break;
            default:
                used = false;
                break;
        }
        if (used) this.junk.clear();
        else if (this.junk.add(b)) this.boardLeft();
    }

    /** The board is drawing its screen again: the transfer program has gone. */
    private boardLeft(): void {
        if (this.st === 'fin') {
            // Every file was acknowledged and the batch's end sent: the board
            // has moved on (sexyz exits right after the null block, and its
            // ACK can be lost on the way out).
            this.log('the board is showing a screen after the end of the batch: done');
            this.end({ ok: true, files: this.filesDone });
            return;
        }
        this.log('the board is showing a screen again: transfer over');
        this.out(boardLeftAbort(this.junk.sent));
        this.end({ ok: false, files: this.filesDone, error: BOARD_LEFT, cancelled: 'remote' });
    }

    tick(): void {
        if (this.finished) return;
        const now = this.opts.now();
        if (this.st === 'start' || this.st === 'data') {
            if (this.pending && now - this.pending.at >= QUIET_MS) {
                const req = this.pending.byte;
                this.pending = null;
                this.crc = req === CRC_REQ;
                this.log(`receiver asks for ${this.crc ? 'CRC-16' : 'checksum'}`);
                if (this.st === 'data') this.startData();
                else if (this.fileIdx >= this.files.length) this.sendNull();
                else if (this.ymodem) this.sendHeader();
                else {
                    this.startFile();
                    this.startData();
                }
                return;
            }
            const limit = this.fileIdx === 0 && this.st === 'start' ? this.startTimeout : START_MS;
            if (now - this.waitSince > limit) this.fail(this.fileIdx === 0 && this.st === 'start' ? 'the board did not start receiving' : 'the board stopped asking for blocks');
            return;
        }
        if (this.resendAt && now - this.resendAt >= QUIET_MS) {
            this.resendAt = 0;
            if (this.st === 'ack0' || (this.st === 'ack' && this.offset === 0)) this.resend(`block ${this.st === 'ack0' ? 0 : this.block} asked for again`);
        }
        if (this.st === 'fin' && now - this.sentAt > FIN_MS) {
            // Every file was acknowledged, only the end of the batch was not:
            // sexyz exits right after it ACKs the null block, and the ACK can
            // be lost on the way out.
            this.log('no answer to the end-of-batch block; done');
            this.end({ ok: true, files: this.filesDone });
            return;
        }
        if ((this.st === 'ack0' || this.st === 'ack' || this.st === 'eot') && now - this.sentAt > ACK_MS) this.resend('no answer');
    }

    private resend(why: string): void {
        if (!this.pkt) return;
        if (++this.errors > MAX_ERRORS) {
            this.fail(`too many errors (${why})`);
            return;
        }
        this.log(`${why}: sending again (${this.errors})`);
        this.sendPkt(this.pkt);
    }

    private sendPkt(p: Uint8Array): void {
        this.pkt = p;
        this.sentAt = this.opts.now();
        this.out(p);
    }

    private startFile(): void {
        const f = this.files[this.fileIdx];
        const info: FileInfo = { name: f.name, size: f.size, index: this.fileIdx, count: this.files.length };
        this.ev.fileStart(info);
    }

    private sendHeader(): void {
        this.startFile();
        let left = 0;
        for (let i = this.fileIdx; i < this.files.length; i++) left += this.files[i].size;
        const f = this.files[this.fileIdx];
        const payload = ymodemHeader(f, this.files.length - this.fileIdx, left);
        const size = payload.length <= 128 ? 128 : 1024;
        this.st = 'ack0';
        this.errors = 0;
        this.sendPkt(encodeBlock(0, payload.subarray(0, size), size, this.crc, 0));
    }

    private sendNull(): void {
        this.st = 'fin';
        this.errors = 0;
        this.sendPkt(encodeBlock(0, new Uint8Array(0), 128, this.crc, 0));
    }

    private startData(): void {
        this.block = 1;
        this.offset = 0;
        this.errors = 0;
        this.next();
    }

    /** Send the block at `offset`, or EOT at the end of the file. */
    private next(): void {
        const f = this.files[this.fileIdx];
        const left = f.size - this.offset;
        if (left <= 0) {
            this.st = 'eot';
            this.errors = 0;
            this.sendPkt(Uint8Array.of(EOT));
            return;
        }
        // 1K blocks only with CRC (classic checksum receivers expect 128).
        const size: 128 | 1024 = this.use1k && this.crc && left > 896 ? 1024 : 128;
        const want = Math.min(size, left);
        const got = f.read(this.offset, want);
        const go = (data: Uint8Array) => {
            if (this.finished) return;
            if (data.length !== want) {
                this.fail(`could not read ${f.name}`);
                return;
            }
            this.pktLen = want;
            this.st = 'ack';
            this.sendPkt(encodeBlock(this.block, data, size, this.crc));
        };
        if (got instanceof Uint8Array) go(got);
        else {
            this.st = 'reading';
            got.then(go, e => this.fail(`could not read ${f.name}: ${(e as Error)?.message ?? e}`));
        }
    }

    private fileDone(): void {
        this.ev.fileEnd(true);
        this.filesDone++;
        this.fileIdx++;
        this.pkt = null;
        if (!this.ymodem) {
            this.end({ ok: true, files: this.filesDone });
            return;
        }
        this.st = 'start';
        this.waitSince = this.opts.now();
        this.pending = null;
    }

    private inFile(): boolean {
        return this.st === 'ack' || this.st === 'reading' || this.st === 'eot' || this.st === 'data' || this.st === 'ack0';
    }

    cancel(reason = 'cancelled'): void {
        if (this.finished) return;
        this.out(CANCEL_SEQ);
        this.end({ ok: false, files: this.filesDone, error: reason, cancelled: 'local' });
    }

    private fail(error: string): void {
        if (this.finished) return;
        this.log(`failed: ${error}`);
        this.out(CANCEL_SEQ);
        this.end({ ok: false, files: this.filesDone, error });
    }

    private end(r: TransferEnd): void {
        if (this.finished) return;
        if (!r.ok && this.inFile()) this.ev.fileEnd(false);
        this.finished = true;
        this.st = 'done';
        // Text since the last of the protocol (status lines, the board's own) is the screen's.
        if (this.junk.bytes.length) this.trailing.unshift(this.junk.take());
        this.junk.clear();
        this.ev.done(r);
    }

    takeTrailing(): Uint8Array {
        return concat(this.trailing.splice(0));
    }
}

type RecvState = 'start' | 'block' | 'purge' | 'write' | 'done';

export interface XyRecvOptions extends XyOptions {
    /** XModem carries no file name: the name to report. */
    name?: string;
    /** Largest file accepted, bytes (0: no limit). */
    maxBytes?: number;
}

/** Receives files: XModem (one file, with or without 1K blocks) or a YModem batch. */
export class XyReceiver implements TransferEngine {
    finished = false;
    private st: RecvState = 'start';
    private crc = true;
    /** Expecting block 0 (a YModem header) rather than file data. */
    private header: boolean;
    private expect: number;
    private gotData = false;
    private buf = new Uint8Array(1029);
    private have = 0;
    private size: 128 | 1024 = 128;
    private eot = false;
    private errors = 0;
    private cans = 0;
    private requests = 0;
    /** The sender has started a block: it is there, and has chosen its mode. */
    private sawStart = false;
    private lastByte = 0;
    private lastSent = 0;
    private phaseSince: number;
    private filesDone = 0;
    private fileIndex = 0;
    private fileSize: number | null = null;
    private received = 0;
    private inFile = false;
    private queued: Uint8Array[] = [];
    private trailing: Uint8Array[] = [];
    private junk = new Junk();
    private readonly ymodem: boolean;
    private readonly startTimeout: number;
    private readonly proto: XyRecvProtocol;
    private readonly out: (b: Uint8Array) => void;
    private readonly ev: TransferEvents;
    private readonly opts: XyRecvOptions;

    constructor(proto: XyRecvProtocol, send: (b: Uint8Array) => void, ev: TransferEvents, opts: XyRecvOptions) {
        this.proto = proto;
        this.out = b => {
            this.junk.sent += b.length;
            send(b);
        };
        this.ev = ev;
        this.opts = opts;
        this.ymodem = proto === 'ymodem';
        this.header = this.ymodem;
        this.expect = this.ymodem ? 0 : 1;
        this.startTimeout = opts.startTimeout ?? START_MS;
        this.phaseSince = opts.now();
        this.request();
    }

    private log(s: string): void {
        this.opts.log?.(`${this.proto} receive: ${s}`);
    }

    /** Ask for the next block 0 or 1: 'C' for CRC-16, or NAK for a checksum. */
    private request(): void {
        // Three unanswered 'C's: maybe a checksum-only XModem sender (as sexyz
        // falls back). Never once a sender has started a block (it chose CRC,
        // and a checksum compared with its CRC passes one block in 256 whatever
        // it holds), and never for YModem, which is CRC by definition.
        if (this.crc && this.requests >= 3 && !this.ymodem && !this.sawStart && !this.gotData && this.filesDone === 0) {
            this.crc = false;
            this.log('no answer to C: asking for checksum blocks');
        }
        this.requests++;
        this.send(this.crc ? CRC_REQ : NAK);
    }

    private send(b: number): void {
        this.lastSent = this.opts.now();
        this.out(Uint8Array.of(b));
    }

    /** Waiting for the first block of a phase (a header, or block 1). */
    private get starting(): boolean {
        return this.header || (this.expect === 1 && !this.gotData);
    }

    private get writing(): boolean {
        return this.st === 'write';
    }

    feed(bytes: Uint8Array): void {
        if (!bytes.length) return;
        this.lastByte = this.opts.now();
        if (this.st === 'write') {
            this.queued.push(bytes.slice());
            return;
        }
        for (let i = 0; i < bytes.length; i++) {
            if (this.finished) {
                this.trailing.push(bytes.slice(i));
                return;
            }
            if (this.writing) {
                // byte() handed a block to an asynchronous sink: hold the rest.
                this.queued.push(bytes.slice(i));
                return;
            }
            this.byte(bytes[i]);
        }
    }

    private byte(b: number): void {
        if (this.have) {
            this.buf[this.have++] = b;
            if (this.have === 3 + this.size + (this.crc ? 2 : 1)) this.onBlock();
            return;
        }
        if (b === CAN) {
            if (++this.cans >= 2) this.end({ ok: false, files: this.filesDone, error: 'the board cancelled the transfer', cancelled: 'remote' });
            return;
        }
        this.cans = 0;
        if (this.st === 'purge') return;
        if (b === SOH || b === STX) {
            this.size = b === STX ? 1024 : 128;
            this.buf[0] = b;
            this.have = 1;
            this.sawStart = true;
        } else if (b === EOT && !this.header && this.gotData) {
            if (!this.eot) {
                // Forsberg's double EOT: a line hit cannot fake two.
                this.eot = true;
                this.send(NAK);
            } else {
                this.send(ACK);
                this.fileDone();
            }
        } else if (b === EOT && !this.header && this.expect === 1 && !this.gotData) {
            // An empty file: no blocks, only EOT.
            this.gotData = true;
            if (!this.ymodem) this.beginFile({ name: safeName(this.opts.name ?? ''), size: null, index: 0, count: 1 });
            this.byte(b);
        } else if (this.junk.add(b)) {
            // Not the protocol: status text on the line is skipped, but a
            // screen means the transfer program has gone.
            this.log('the board is showing a screen again: transfer over');
            this.out(boardLeftAbort(this.junk.sent));
            this.end({ ok: false, files: this.filesDone, error: BOARD_LEFT, cancelled: 'remote' });
        }
    }

    private onBlock(): void {
        const size = this.size;
        const num = this.buf[1];
        const data = this.buf.subarray(3, 3 + size);
        const valid =
            num === (~this.buf[2] & 0xff) &&
            (this.crc ? crc16(data) === ((this.buf[3 + size] << 8) | this.buf[4 + size]) : checksum(data) === this.buf[3 + size]);
        this.have = 0;
        if (!valid) {
            // A checksum where the sender's CRC high byte sits: it sends CRC blocks.
            if (!this.crc && num === (~this.buf[2] & 0xff) && crc16(data) >> 8 === this.buf[3 + size]) {
                this.crc = true;
                this.log('the sender sends CRC-16 blocks: asking for CRC-16 again');
            }
            this.bad(`block ${num} failed its check`);
            return;
        }
        this.junk.clear();
        if (this.header) {
            if (num !== 0) {
                this.fail(`expected a YModem header, got block ${num} (is the board sending XModem?)`);
                return;
            }
            this.onHeader(data);
            return;
        }
        if (num === this.expect) {
            this.errors = 0;
            this.eot = false;
            if (!this.gotData) {
                this.gotData = true;
                if (!this.ymodem) this.beginFile({ name: safeName(this.opts.name ?? ''), size: null, index: 0, count: 1 });
            }
            const take = this.fileSize === null ? size : Math.max(0, Math.min(size, this.fileSize - this.received));
            this.received += take;
            this.expect = (this.expect + 1) & 0xff;
            const max = this.opts.maxBytes ?? 0;
            if (max && this.received > max) {
                this.fail(`the file is larger than this terminal accepts (${max} bytes)`);
                return;
            }
            const r = take ? this.ev.data?.(data.slice(0, take)) : undefined;
            this.ev.progress(this.received);
            this.st = 'block';
            if (r && typeof (r as Promise<void>).then === 'function') {
                this.st = 'write';
                (r as Promise<void>).then(
                    () => {
                        if (this.finished) return;
                        this.st = 'block';
                        this.send(ACK);
                        for (const q of this.queued.splice(0)) this.feed(q);
                    },
                    e => this.fail(`could not save the file: ${(e as Error)?.message ?? e}`),
                );
            } else this.send(ACK);
        } else if (num === ((this.expect - 1) & 0xff)) {
            // Our ACK was lost and the sender repeated the block.
            this.send(ACK);
        } else if (num === 0 && this.ymodem && this.expect === 1 && !this.gotData) {
            // The header again (our ACK was lost): acknowledge it and ask for data.
            this.send(ACK);
            this.send(this.crc ? CRC_REQ : NAK);
        } else this.fail(`lost block sync (block ${num}, expected ${this.expect})`);
    }

    private onHeader(data: Uint8Array): void {
        const h = parseYmodemHeader(data);
        this.errors = 0;
        if (!h) {
            this.send(ACK);
            this.log('end of batch');
            this.end({ ok: true, files: this.filesDone });
            return;
        }
        const max = this.opts.maxBytes ?? 0;
        if (max && h.size !== null && h.size > max) {
            this.fail(`${safeName(h.name)} is ${h.size} bytes, larger than this terminal accepts (${max} bytes)`);
            return;
        }
        this.fileSize = h.size;
        this.received = 0;
        this.beginFile({ name: safeName(h.name), size: h.size, index: this.fileIndex, count: h.files, batchBytes: h.bytes });
        this.header = false;
        this.expect = 1;
        this.gotData = false;
        this.eot = false;
        this.requests = 0;
        this.phaseSince = this.opts.now();
        this.send(ACK);
        this.request();
    }

    private beginFile(f: FileInfo): void {
        this.inFile = true;
        this.ev.fileStart(f);
    }

    private fileDone(): void {
        this.inFile = false;
        // With a size in the header, a file that ends short is not complete.
        const whole = this.fileSize === null || this.received >= this.fileSize;
        if (!whole) this.log(`short file: ${this.received} of ${this.fileSize} bytes`);
        this.ev.fileEnd(whole);
        if (whole) this.filesDone++;
        this.fileIndex++;
        if (!this.ymodem) {
            this.end({ ok: true, files: this.filesDone });
            return;
        }
        this.header = true;
        this.expect = 0;
        this.fileSize = null;
        this.gotData = false;
        this.eot = false;
        this.requests = 0;
        this.st = 'start';
        this.phaseSince = this.opts.now();
        this.request();
    }

    /** A spoiled block: wait for the line to go quiet, then ask again. */
    private bad(why: string): void {
        if (++this.errors > MAX_ERRORS) {
            this.fail(`too many errors (${why})`);
            return;
        }
        this.log(`${why}; asking again (${this.errors})`);
        this.st = 'purge';
        this.lastByte = this.opts.now();
    }

    tick(): void {
        if (this.finished || this.st === 'write') return;
        const now = this.opts.now();
        if (this.st === 'purge') {
            if (now - this.lastByte >= PURGE_MS) {
                this.st = this.starting ? 'start' : 'block';
                if (this.starting) this.send(this.crc ? CRC_REQ : NAK);
                else this.send(NAK);
            }
            return;
        }
        if (this.have && now - this.lastByte > BYTE_MS) {
            this.have = 0;
            this.bad('block stopped half-way');
            return;
        }
        if (this.have) return;
        if (this.starting) {
            const limit = this.filesDone === 0 && this.header === this.ymodem && !this.gotData ? this.startTimeout : START_MS;
            if (now - this.phaseSince > limit) {
                this.fail(this.filesDone === 0 ? 'the board did not start sending' : 'the board stopped sending');
                return;
            }
            if (now - this.lastSent >= REQUEST_MS) this.request();
            return;
        }
        if (now - Math.max(this.lastSent, this.lastByte) > ACK_MS) {
            if (++this.errors > MAX_ERRORS) {
                this.fail('the board stopped sending');
                return;
            }
            this.log(`no block for ${ACK_MS / 1000} s: NAK (${this.errors})`);
            this.send(NAK);
        }
    }

    cancel(reason = 'cancelled'): void {
        if (this.finished) return;
        this.out(CANCEL_SEQ);
        this.end({ ok: false, files: this.filesDone, error: reason, cancelled: 'local' });
    }

    private fail(error: string): void {
        if (this.finished) return;
        this.log(`failed: ${error}`);
        this.out(CANCEL_SEQ);
        this.end({ ok: false, files: this.filesDone, error });
    }

    private end(r: TransferEnd): void {
        if (this.finished) return;
        if (this.inFile) this.ev.fileEnd(false);
        this.inFile = false;
        this.finished = true;
        this.st = 'done';
        // Text since the last block (status lines, the board's own), and what
        // arrived while a write was pending, are the screen's.
        if (this.junk.bytes.length) this.trailing.unshift(this.junk.take());
        this.junk.clear();
        this.trailing.push(...this.queued.splice(0));
        this.ev.done(r);
    }

    takeTrailing(): Uint8Array {
        return concat(this.trailing.splice(0));
    }
}

export function concat(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0];
    const n = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

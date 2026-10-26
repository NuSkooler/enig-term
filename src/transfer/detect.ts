// Finds the start of a ZModem session in the host stream, so the terminal
// can take it over before any of it is drawn:
//
//   ZRQINIT  "**" ZDLE "B" "00" + 8 hex + CRC   the board's sz wants to send (a download)
//   ZRINIT   "**" ZDLE "B" "01" + 8 hex + CRC   the board's rz waits for files (an upload)
//
// A hex header is 18 bytes and carries a CRC-16 of its type and data, so
// text cannot set it off by chance. A header can straddle two chunks: the
// bytes that may begin one are held back (flush() lets them out if nothing
// follows). Pure: no DOM; the Node tests use it as is.

export type ZmodemStart = 'download' | 'upload';

const ZPAD = 0x2a; // '*'
const ZDLE = 0x18;
const ZHEX = 0x42; // 'B'
const HEADER_LEN = 18;

function hexVal(b: number): number {
    if (b >= 0x30 && b <= 0x39) return b - 0x30;
    if (b >= 0x61 && b <= 0x66) return b - 0x57;
    if (b >= 0x41 && b <= 0x46) return b - 0x37;
    return -1;
}

/** CRC-16/XMODEM, as ZModem's 16-bit headers use it. */
function crc16(bytes: number[]): number {
    let crc = 0;
    for (const b of bytes) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}

/** Whether `p` (a prefix of a header, all of it when complete) can still be one. */
function prefixOk(p: number[]): boolean {
    const i = p.length - 1;
    const b = p[i];
    if (i < 2) return b === ZPAD;
    if (i === 2) return b === ZDLE;
    if (i === 3) return b === ZHEX;
    if (i === 4) return b === 0x30; // type 00 or 01
    if (i === 5) return b === 0x30 || b === 0x31;
    return hexVal(b) >= 0;
}

/** A complete header's start kind, or null when its CRC does not match. */
function headerKind(p: number[]): ZmodemStart | null {
    const v: number[] = [];
    for (let i = 4; i < HEADER_LEN; i += 2) v.push((hexVal(p[i]) << 4) | hexVal(p[i + 1]));
    // v: type, 4 data bytes, CRC high, CRC low
    if (crc16(v.slice(0, 5)) !== ((v[5] << 8) | v[6])) return null;
    return v[0] === 0 ? 'download' : 'upload';
}

export interface ScanResult {
    /** Bytes for the screen. */
    screen: Uint8Array;
    /** A session starts: the header and everything after it in the chunk. */
    start?: { kind: ZmodemStart; bytes: Uint8Array };
}

export class ZmodemDetector {
    private pend: number[] = [];

    /** Bytes held back as a possible start of a header. */
    get holding(): boolean {
        return this.pend.length > 0;
    }

    scan(chunk: Uint8Array): ScanResult {
        // Fast path: nothing held and no '*' in the chunk.
        if (!this.pend.length && chunk.indexOf(ZPAD) < 0) return { screen: chunk };
        const screen: number[] = [];
        for (let i = 0; i < chunk.length; i++) {
            const hit = this.step(chunk[i], screen);
            if (!hit) continue;
            const head = [...this.pend.splice(0), ...hit.after];
            const rest = chunk.subarray(i + 1);
            const bytes = new Uint8Array(head.length + rest.length);
            bytes.set(head);
            bytes.set(rest, head.length);
            return { screen: Uint8Array.from(screen), start: { kind: hit.kind, bytes } };
        }
        return { screen: Uint8Array.from(screen) };
    }

    /**
     * One byte. On a mismatch the first held byte was text, and the rest are
     * looked at again (a header may begin inside them, as in "***").
     */
    private step(b: number, screen: number[]): { kind: ZmodemStart; after: number[] } | null {
        const queue = [b];
        while (queue.length) {
            const c = queue.shift()!;
            if (!this.pend.length) {
                if (c === ZPAD) this.pend.push(c);
                else screen.push(c);
                continue;
            }
            this.pend.push(c);
            const complete = this.pend.length === HEADER_LEN;
            const kind = complete && prefixOk(this.pend) ? headerKind(this.pend) : null;
            if (!prefixOk(this.pend) || (complete && !kind)) {
                const p = this.pend.splice(0);
                screen.push(p[0]);
                queue.unshift(...p.slice(1));
                continue;
            }
            if (kind) return { kind, after: queue };
        }
        return null;
    }

    /** Give up on a held prefix (no more data came): it was text. */
    flush(): Uint8Array {
        return Uint8Array.from(this.pend.splice(0));
    }
}

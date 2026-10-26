// Shared shapes of the file transfer engines (X/YModem in xymodem.ts, ZModem
// in zmodem.ts). Pure types: no DOM, so the Node tests load the engines as is.

/** A file offered for sending. `read` may be asynchronous (a Blob slice). */
export interface SourceFile {
    name: string;
    size: number;
    /** Modification time, ms since the epoch (YModem and ZModem send it). */
    mtime?: number;
    read(offset: number, length: number): Promise<Uint8Array> | Uint8Array;
}

export interface FileInfo {
    name: string;
    /** Bytes, when the protocol says (YModem, ZModem); null for XModem. */
    size: number | null;
    /** 0-based position in the batch. */
    index: number;
    /** Files in the batch when the sender said (null: unknown). */
    count: number | null;
    /** Bytes left in the batch, this file included, when the sender said. */
    batchBytes?: number | null;
}

/** The error of a transfer that ended because the board was drawing its screen again. */
export const BOARD_LEFT = 'the board ended the transfer';

export type TransferEnd =
    | { ok: true; files: number }
    | { ok: false; files: number; error: string; cancelled?: 'local' | 'remote' };

export interface TransferEvents {
    log?(s: string): void;
    /** A file begins (receiving: as the sender describes it; sending: the one being sent). */
    fileStart(f: FileInfo): void;
    /**
     * Receiving: the next bytes of the current file, in order. A returned
     * promise holds the protocol (no acknowledgement) until it settles, so a
     * slow sink keeps memory bounded; a rejection fails the transfer.
     */
    data?(chunk: Uint8Array): void | Promise<void>;
    /** Receiving: an offered file was refused (skipped) without ending the batch. */
    fileSkipped?(f: { name: string; size: number; reason: string }): void;
    /** The current file ended: received or sent completely (ok), or abandoned. */
    fileEnd(ok: boolean): void;
    /** Bytes of the current file done so far. */
    progress(bytes: number): void;
    /** The transfer is over. Called once. */
    done(r: TransferEnd): void;
}

/** One running transfer. The driver feeds it the remote's bytes and ticks its clock. */
export interface TransferEngine {
    /** Bytes from the remote (Telnet already decoded). */
    feed(bytes: Uint8Array): void;
    /** Let timers run (call every 50-100 ms). */
    tick(): void;
    /** Abort from this side: the protocol's cancel sequence goes out, done() follows. */
    cancel(reason?: string): void;
    /** Bytes received after the end of the transfer (they belong to the screen). */
    takeTrailing(): Uint8Array;
    readonly finished: boolean;
}

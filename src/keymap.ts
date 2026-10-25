// ANSI-BBS keyboard map: browser key events to the bytes a BBS expects.
//
// The sequences are the ones in ENiGMA's client.js key table and what
// SyncTERM sends in its ANSI-BBS mode:
//   arrows CSI A/B/C/D, Home CSI H, End CSI K, Insert CSI @, PgUp CSI V,
//   PgDn CSI U, F1-F4 ESC O P..S, F5-F12 CSI 15~ .. CSI 24~, Shift+Tab CSI Z.
// Backspace and Delete follow the DOS/Windows convention (mTelnet, SyncTERM):
// Backspace is ^H (destructive), Delete is DEL 0x7F. The vault note "Terminal
// Emulation & Key Handling Notes" records that Linux/BSD consoles swap them;
// `backspace: 'del'` gives that swapped behaviour for hosts that want it.
import { CSI, ESC } from './replies.ts';

export type BackspaceMode = 'bs' | 'del';

export interface KeymapOptions {
    backspace?: BackspaceMode;
}

const BS = String.fromCharCode(0x08);
const DEL = String.fromCharCode(0x7f);

const BASE: Record<string, string> = {
    Enter: '\r',
    Tab: '\t',
    Escape: ESC,
    ArrowUp: CSI + 'A',
    ArrowDown: CSI + 'B',
    ArrowRight: CSI + 'C',
    ArrowLeft: CSI + 'D',
    Home: CSI + 'H',
    End: CSI + 'K',
    Insert: CSI + '@',
    PageUp: CSI + 'V',
    PageDown: CSI + 'U',
    F1: ESC + 'OP',
    F2: ESC + 'OQ',
    F3: ESC + 'OR',
    F4: ESC + 'OS',
    F5: CSI + '15~',
    F6: CSI + '17~',
    F7: CSI + '18~',
    F8: CSI + '19~',
    F9: CSI + '20~',
    F10: CSI + '21~',
    F11: CSI + '23~',
    F12: CSI + '24~',
};

/** The sequence for a named key (as KeyboardEvent.key spells it), or undefined. */
export function keySequence(key: string, opts: KeymapOptions = {}): string | undefined {
    if (key === 'Backspace') return opts.backspace === 'del' ? DEL : BS;
    if (key === 'Delete') return opts.backspace === 'del' ? BS : DEL;
    return BASE[key];
}

export interface KeyLike {
    key: string;
    code?: string;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    metaKey?: boolean;
}

/** Ctrl+<key> as a C0 control: Ctrl+A..Z, Ctrl+[ \ ] ^ _, Ctrl+@ / Ctrl+Space as NUL. */
export function ctrlChar(key: string, code?: string): string | undefined {
    if (key === ' ' || code === 'Space' || key === '@' || key === '2') return String.fromCharCode(0);
    if (key === '/' ) return String.fromCharCode(0x1f);
    if (key === '6') return String.fromCharCode(0x1e);
    if (key.length !== 1) {
        // Some layouts report a dead or composed key; fall back to the physical key.
        const m = code?.match(/^Key([A-Z])$/);
        return m ? String.fromCharCode(m[1].charCodeAt(0) & 0x1f) : undefined;
    }
    const c = key.toUpperCase().charCodeAt(0);
    if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c & 0x1f);
    if (c === 0x3f) return DEL; // Ctrl+?
    const m = code?.match(/^Key([A-Z])$/);
    return m ? String.fromCharCode(m[1].charCodeAt(0) & 0x1f) : undefined;
}

/**
 * Map a key event to host text, or undefined to let it through (printable
 * text then arrives through the textarea's input events, which also carry IME
 * and soft-keyboard text).
 *   - Alt+<key> sends ESC then the key (the "meta sends escape" convention).
 *   - Meta (Cmd/Win) combinations are left to the browser and OS.
 *   - AltGr (Ctrl+Alt on Windows layouts) that produces a printable character
 *     is left alone so it types that character.
 */
export function mapKey(e: KeyLike, opts: KeymapOptions = {}): string | undefined {
    if (e.metaKey) return undefined;
    const named = keySequence(e.key, opts);
    if (named !== undefined) {
        let seq = named;
        if (e.key === 'Tab' && e.shiftKey) seq = CSI + 'Z';
        return e.altKey && !e.ctrlKey ? ESC + seq : seq;
    }
    if (e.ctrlKey && e.altKey) {
        // AltGr on Windows arrives as Ctrl+Alt with the produced character.
        if (e.key.length === 1 && !/^[a-z]$/i.test(e.key)) return undefined;
        const c = ctrlChar(e.key, e.code);
        return c === undefined ? undefined : ESC + c;
    }
    if (e.ctrlKey) return ctrlChar(e.key, e.code);
    if (e.altKey && e.key.length === 1) {
        // macOS Option produces characters (Option+e is a dead key); only treat
        // Alt as ESC-prefix when the key is plain ASCII.
        const cp = e.key.charCodeAt(0);
        if (cp >= 0x20 && cp < 0x7f) return ESC + e.key;
    }
    return undefined;
}

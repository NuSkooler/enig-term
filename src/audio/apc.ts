// CTerm audio APC strings (SyncTERM:A, SyncTERM:Q, SyncTERM:C;S and C;L),
// parsed into commands. Pure: no DOM, no WebAudio (Node tests use it as is).
//
// Grammar from the "Audio APCs" section of the CTerm manual (CTerm 1.332,
// https://syncterm.bbsdev.net/cterm.html). Where the manual is silent, the
// parse follows SyncTERM's: `;K=V` tokens in any order, the last one wins,
// unknown ones are skipped, and an invalid value makes the command a no-op
// ("Errors are silent").

/** SyncTERM's mixer rate: `f` durations count frames at this rate. */
export const CTERM_RATE = 44100;

/** Durations parse into seconds; 0 means "none" (also for any parse error). */
export function parseDuration(s: string | undefined, freqHz = 0, allowPeriods = false): number {
    if (s === undefined) return 0;
    const m = /^(\d+)(ms|f|p)?$/.exec(s);
    if (!m) return 0;
    const n = Number(m[1]);
    if (!Number.isSafeInteger(n)) return 0;
    switch (m[2]) {
        case undefined:
        case 'ms':
            return n / 1000;
        case 'f':
            return n / CTERM_RATE;
        case 'p':
            // Whole periods of F; only Synth's T allows them.
            return allowPeriods && freqHz > 0 ? n / freqHz : 0;
    }
    return 0;
}

/** Volume in dB: 0..100 linear (100 = 0 dB, 0 = the -60 dB floor) or "<float>dB". Parse errors are 0 dB. */
export function parseVolume(s: string | undefined): number {
    if (s === undefined) return 0;
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(dB)?$/i.exec(s.trim());
    if (!m) {
        // strtof semantics: a leading number still counts ("50%" is 50).
        const lead = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(s.trim());
        if (!lead) return 0;
        return pctToDb(Number(lead[0]));
    }
    const v = Number(m[1]);
    if (!Number.isFinite(v)) return 0;
    if (m[2]) return v;
    return pctToDb(v);
}

function pctToDb(v: number): number {
    if (!(v > 0)) return -60;
    return 20 * Math.log10(Math.min(v, 100) / 100);
}

/** Integers as C's strtoul with base 0 reads them (decimal, 0x hex, leading-0 octal). */
export function parseUlong(s: string): number | null {
    const t = s.trim();
    let m: RegExpExecArray | null;
    if ((m = /^0[xX]([0-9a-fA-F]+)$/.exec(t))) return parseInt(m[1], 16);
    if (/^0[0-7]*$/.test(t)) return parseInt(t, 8) || 0;
    if (/^[1-9]\d*$/.test(t)) return Number(t);
    return null;
}

export type Shape = 'SIN' | 'SAW' | 'SQ' | 'SINE_HARM' | 'SINE_SAW' | 'SINE_SAW_CHORD' | 'SINE_SAW_HARM' | 'SILENCE';
export const SHAPES: readonly Shape[] = ['SIN', 'SAW', 'SQ', 'SINE_HARM', 'SINE_SAW', 'SINE_SAW_CHORD', 'SINE_SAW_HARM', 'SILENCE'];

export type Command =
    | { k: 'store'; name: string; data: Uint8Array }
    | { k: 'list'; glob: string }
    | { k: 'qsndfile' }
    | { k: 'qformat'; major: number; subtype: number }
    | { k: 'load'; slot: number; name: string }
    | { k: 'loadBlob'; slot: number; data: Uint8Array }
    /** seconds: 0 empties the slot ("Synth with T=0 just produces an empty slot"). */
    | { k: 'synth'; slot: number; shape: Shape; freq: number; seconds: number }
    | { k: 'copy'; src: number; dst: number }
    | {
          k: 'queue';
          ch: number;
          slot: number;
          fadeIn: number;
          fadeOut: number;
          crossfade: boolean;
          loop: boolean;
          /** Per-buffer dB, each side (0 = unity). */
          volL: number;
          volR: number;
      }
    | { k: 'flush'; ch: number; fadeOut: number }
    | { k: 'volume'; ch: number; volL: number | null; volR: number | null; ramp: number }
    | { k: 'wait'; ch: number }
    | { k: 'update'; ch: number };

/** Why a string was not a command (diagnostics). */
export interface Rejected {
    k: 'reject';
    why: string;
}

const enc = new TextDecoder('latin1');

/** Cache file names: path segments of printable ASCII without traversal. */
export function validName(name: string): boolean {
    if (!name || name.length > 255 || name.startsWith('/') || name.endsWith('/')) return false;
    for (const seg of name.split('/')) {
        if (!seg || seg === '.' || seg === '..') return false;
        if (!/^[\x20-\x7e]+$/.test(seg) || /[\\:*?"<>|]/.test(seg)) return false;
        if (seg !== seg.trim()) return false;
    }
    return true;
}

/** Parse `;K=V;FLAG;...` (the part after the verb) into a map; bare tokens collect in `rest`. */
function tokens(s: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const t of s.split(';')) {
        if (!t) continue;
        const eq = t.indexOf('=');
        if (eq < 0) m.set(t, '');
        else m.set(t.slice(0, eq), t.slice(eq + 1));
    }
    return m;
}

function intParam(v: string | undefined, max: number): number | null {
    if (v === undefined || !/^\d+$/.test(v)) return null;
    const n = Number(v);
    return n <= max ? n : null;
}

/**
 * Parse an audio APC body (without `ESC _` and `ST`). `body` is the raw
 * bytes: uploads are base64 and can be megabytes, so the data parts are
 * decoded straight from the bytes.
 */
export function parseApc(body: Uint8Array): Command | Rejected {
    // The header part is short; the payload of C;S and LoadBlob is not.
    const headEnd = Math.min(body.length, 512);
    const head = enc.decode(body.subarray(0, headEnd));
    if (head.startsWith('SyncTERM:C;S;')) {
        const semi = head.indexOf(';', 13);
        if (semi < 0) return { k: 'reject', why: 'store: no data' };
        const name = head.slice(13, semi);
        if (!validName(name)) return { k: 'reject', why: `store: bad name ${JSON.stringify(name)}` };
        const data = base64Decode(body.subarray(semi + 1));
        if (!data) return { k: 'reject', why: 'store: bad base64' };
        return { k: 'store', name, data };
    }
    if (head === 'SyncTERM:C;L' || head.startsWith('SyncTERM:C;L;')) {
        const all = enc.decode(body);
        return { k: 'list', glob: all.length > 13 ? all.slice(13) : '*' };
    }
    if (head.startsWith('SyncTERM:Q;')) {
        const q = enc.decode(body.subarray(11, Math.min(body.length, 200)));
        if (q === 'libsndfile') return { k: 'qsndfile' };
        if (q.startsWith('libsndfileFormat;')) {
            const parts = q.slice(17).split(';');
            if (parts.length !== 2) return { k: 'reject', why: 'format query: two numbers' };
            const major = parseUlong(parts[0]);
            const subtype = parseUlong(parts[1]);
            if (major === null || subtype === null || major > 0xffffffff || subtype > 0xffffffff || parts[0] !== parts[0].trimStart() || parts[1] !== parts[1].trim())
                return { k: 'reject', why: 'format query: bad number' };
            return { k: 'qformat', major, subtype };
        }
        return { k: 'reject', why: `unknown query ${JSON.stringify(q.slice(0, 40))}` };
    }
    if (!head.startsWith('SyncTERM:A;')) return { k: 'reject', why: 'not an audio APC' };
    const rest = head.slice(11);
    const semi = rest.indexOf(';');
    const verb = semi < 0 ? rest : rest.slice(0, semi);
    const args = semi < 0 ? '' : rest.slice(semi + 1);
    switch (verb) {
        case 'LoadBlob': {
            // S= tokens, then the base64 data.
            let off = 11 + 'LoadBlob'.length;
            let slot: number | null = null;
            for (;;) {
                if (body[off] !== 0x3b) return { k: 'reject', why: 'loadblob: no data' };
                if (body[off + 1] === 0x53 && body[off + 2] === 0x3d) {
                    let e = off + 3;
                    while (e < body.length && body[e] !== 0x3b) e++;
                    slot = intParam(enc.decode(body.subarray(off + 3, e)), 255);
                    off = e;
                    continue;
                }
                break;
            }
            if (slot === null) return { k: 'reject', why: 'loadblob: slot' };
            const data = base64Decode(body.subarray(off + 1));
            if (!data || !data.length) return { k: 'reject', why: 'loadblob: bad base64' };
            return { k: 'loadBlob', slot, data };
        }
        case 'Load': {
            // S= tokens, then the file name (everything after them).
            const all = enc.decode(body.subarray(11 + 5));
            let slot: number | null = null;
            let i = 0;
            const parts = all.split(';');
            while (i < parts.length && parts[i].startsWith('S=')) slot = intParam(parts[i++].slice(2), 255);
            const name = parts.slice(i).join(';');
            if (slot === null) return { k: 'reject', why: 'load: slot' };
            if (!validName(name)) return { k: 'reject', why: `load: bad name ${JSON.stringify(name)}` };
            return { k: 'load', slot, name };
        }
        case 'Synth': {
            const t = tokens(args);
            const slot = intParam(t.get('S'), 255);
            const shape = t.get('W') as Shape | undefined;
            if (slot === null) return { k: 'reject', why: 'synth: slot' };
            if (!shape || !SHAPES.includes(shape)) return { k: 'reject', why: 'synth: shape' };
            const f = Number(t.get('F') ?? '0');
            const freq = Number.isFinite(f) && f > 0 ? Math.min(f, 96_000) : 0;
            return { k: 'synth', slot, shape, freq: shape === 'SILENCE' ? 0 : freq, seconds: parseDuration(t.get('T'), freq, true) };
        }
        case 'Copy': {
            const t = tokens(args);
            const src = intParam(t.get('S'), 255);
            const dst = intParam(t.get('D'), 255);
            if (src === null || dst === null) return { k: 'reject', why: 'copy: slots' };
            return { k: 'copy', src, dst };
        }
        case 'Queue': {
            const t = tokens(args);
            const ch = intParam(t.get('C'), 15);
            const slot = intParam(t.get('S'), 255);
            if (ch === null || ch < 2) return { k: 'reject', why: 'queue: channel (2-15)' };
            if (slot === null) return { k: 'reject', why: 'queue: slot' };
            let volL = 0;
            let volR = 0;
            if (t.has('V')) volL = volR = parseVolume(t.get('V'));
            if (t.has('VL')) volL = parseVolume(t.get('VL'));
            if (t.has('VR')) volR = parseVolume(t.get('VR'));
            return {
                k: 'queue',
                ch,
                slot,
                fadeIn: parseDuration(t.get('I')),
                fadeOut: parseDuration(t.get('O')),
                crossfade: t.has('X') && t.get('X') === '',
                loop: t.has('L') && t.get('L') === '',
                volL,
                volR,
            };
        }
        case 'Flush': {
            const t = tokens(args);
            const ch = intParam(t.get('C'), 15);
            if (ch === null) return { k: 'reject', why: 'flush: channel' };
            return { k: 'flush', ch, fadeOut: parseDuration(t.get('O')) };
        }
        case 'Volume': {
            const t = tokens(args);
            const ch = intParam(t.get('C'), 15);
            if (ch === null) return { k: 'reject', why: 'volume: channel' };
            let volL: number | null = null;
            let volR: number | null = null;
            if (t.has('V')) volL = volR = parseVolume(t.get('V'));
            if (t.has('VL')) volL = parseVolume(t.get('VL'));
            if (t.has('VR')) volR = parseVolume(t.get('VR'));
            if (volL === null && volR === null) return { k: 'reject', why: 'volume: no V, VL or VR' };
            return { k: 'volume', ch, volL, volR, ramp: parseDuration(t.get('T')) };
        }
        case 'Wait':
        case 'Update': {
            const ch = intParam(tokens(args).get('C'), 15);
            if (ch === null) return { k: 'reject', why: `${verb.toLowerCase()}: channel` };
            return verb === 'Wait' ? { k: 'wait', ch } : { k: 'update', ch };
        }
        default:
            return { k: 'reject', why: `unknown verb ${JSON.stringify(verb.slice(0, 20))}` };
    }
}

const B64 = new Int16Array(256).fill(-1);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => (B64[c.charCodeAt(0)] = i));
// Also the URL-safe alphabet: some hosts send it.
B64[0x2d] = 62;
B64[0x5f] = 63;

/** Decode base64 from bytes (line breaks and spaces ignored, padding optional); null on bad input. */
export function base64Decode(src: Uint8Array): Uint8Array | null {
    const out = new Uint8Array(Math.floor((src.length * 3) / 4) + 3);
    let acc = 0;
    let bits = 0;
    let n = 0;
    let pad = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === 0x3d) {
            pad = true;
            continue;
        }
        if (c === 0x0a || c === 0x0d || c === 0x20 || c === 0x09) continue;
        const v = B64[c];
        if (v < 0 || pad) return null;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[n++] = (acc >> bits) & 0xff;
        }
    }
    if (bits >= 6) return null; // one stray character
    return out.subarray(0, n);
}

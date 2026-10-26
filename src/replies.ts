// Replies to host queries. The WASM core reports each request (with the state
// captured at the moment it was parsed); the shell decides what to answer.
//
// References: the CTerm manual (https://syncterm.bbsdev.net/cterm.html, read
// 2026-10-25), bansi.txt for CSI 255 n.

export const ESC = String.fromCharCode(0x1b);
export const CSI = ESC + '[';

declare const __ENIG_TERM_VERSION__: string | undefined;

export interface Version {
    major: number;
    minor: number;
    patch: number;
}

export function parseVersion(v: string): Version {
    const [major, minor, patch] = v.split(/[.-]/).map(n => parseInt(n, 10) || 0);
    return { major: major ?? 0, minor: minor ?? 0, patch: patch ?? 0 };
}

/** package.json's version, injected by the bundler (scripts/build-js.mjs). */
export const VERSION_STRING: string = typeof __ENIG_TERM_VERSION__ === 'string' ? __ENIG_TERM_VERSION__ : '0.0.0';
export const VERSION = parseVersion(VERSION_STRING);

/** "enig-term" as decimal ASCII, CTerm-shaped: CSI = 101;110;...;maj;min;patch c */
export function daReply(v: Version = VERSION): string {
    const name = Array.from('enig-term', c => c.charCodeAt(0)).join(';');
    return `${CSI}=${name};${v.major};${v.minor};${v.patch}c`;
}

/**
 * CTerm Device Attributes (CTDA, CSI < c), numbered as in the current CTerm
 * manual (Table 4). Only what this build does and the tests verify:
 *   1 - loadable fonts via DCS             (core.test.mjs "dcs font")
 *   2 - bright background, CSI ? 33 h      (render tests: iCE testcard, SAUCE iCE)
 *   3 - palette changes via OSC            (core.test.mjs "osc palette")
 *   5 - font select via CSI Ps1 ; Ps2 SP D (core.test.mjs "font select 42")
 * Not claimed: 4 pixel operations (sixel and PPM are in the engine but inline
 * images are off, see the core's set_inline_images), 6 extended palette, 7
 * mouse, 8 key press/release reports.
 * (The spike claimed 1;2;4 from an older cterm.txt with different numbering.)
 */
export const CTDA_FEATURES = [1, 2, 3, 5];
export function ctdaReply(): string {
    return `${CSI}<0;${CTDA_FEATURES.join(';')}c`;
}

export type CoreEvent =
    | { t: 'req'; k: 'da' | 'da2' | 'ctda' | 'dsr' }
    | { t: 'req'; k: 'cpr'; row: number; col: number }
    | { t: 'req'; k: 'size'; rows: number; cols: number }
    | { t: 'req'; k: 'fontstate'; first: number; result: number; slots: number[] }
    | { t: 'req'; k: 'fontmode'; modes: number[] }
    | { t: 'req'; k: 'fontdim'; h: number; w: number }
    | { t: 'req'; k: 'ctsmrr'; n: number }
    /** CSI = 7 [; Pn ...] n: the CTerm audio state report (answered by the audio engine). */
    | { t: 'req'; k: 'audio'; params: number[] }
    /** APC SyncTERM:Q;JXL. */
    | { t: 'req'; k: 'jxl' }
    | { t: 'req'; k: 'other'; dbg: string }
    /** CSI Ps1 ; Ps2 SP D: slot = Ps1 (0-3), font = Ps2; reason when refused: slot | font | missing. */
    | { t: 'font'; slot: number; font: number; ok: boolean; height: number; reason?: 'slot' | 'font' | 'missing' }
    | { t: 'fontload'; slot: number; bytes: number; ok: boolean; height?: number; width?: number }
    /** The screen mode's cell height changed; `missing` slots need fonts of that height. */
    | { t: 'fontheight'; height: number; missing: number[] }
    | { t: 'bell' }
    | { t: 'link'; uri: string }
    | { t: 'title'; text: string }
    /** An APC string that is not audio (shown in the log only). */
    | { t: 'apc'; data: string }
    /** An audio APC string of `n` bytes: take it with takeApc() (over: longer than the limit, dropped). */
    | { t: 'apc'; n: number; over?: boolean }
    /** CTerm "ANSI" music: [note, on ms, off ms, ...]; fg: CTerm holds the stream until it has played. */
    | { t: 'music'; fg: boolean; n: number[] };

/**
 * TEST HOOK ONLY: a CTerm-shaped DA ("CTerm" + a version) for ENiGMA builds
 * that gate their CSI = 6 n probe on termClient === 'cterm'. Never on by
 * default; enabled with ?debugDa=cterm on the standalone page.
 */
export const DEBUG_CTERM_DA = `${CSI}=67;84;101;114;109;1;0c`;

export interface ReplyState {
    debugCtermDa?: boolean;
    /** OSC 8 links can be followed (the `CSI = 6 n` answer). */
    links?: boolean;
    /** CTerm Last Column Flag mode, for `CSI = 4 n`. */
    lastColumnFlag?: boolean;
}

/** Returns the reply string for a request event, or null if none is due. */
export function replyFor(ev: CoreEvent, st: ReplyState = {}): string | null {
    if (ev.t !== 'req') return null;
    switch (ev.k) {
        case 'da':
            return st.debugCtermDa ? DEBUG_CTERM_DA : daReply();
        case 'ctda':
            return ctdaReply();
        case 'dsr':
            return `${CSI}0n`;
        case 'cpr':
            return `${CSI}${ev.row};${ev.col}R`;
        case 'size':
            // bansi.txt: the screen size comes back as a CPR.
            return `${CSI}${ev.rows};${ev.cols}R`;
        case 'fontstate':
            // CSI = 1 ; pF ; pR ; pS0 ; pS1 ; pS2 ; pS3 n. pF: first DCS-loadable slot;
            // pR: 0 = the last selection worked, 1 = it was refused (no such font
            // at this cell height), 99 = none yet; pS0-3: the attribute slots.
            return `${CSI}=1;${ev.first};${ev.result};${ev.slots.join(';')}n`;
        case 'fontmode':
            // "If no modes are currently set, an empty parameter will be included."
            return ev.modes.length ? `${CSI}=2;${ev.modes.join(';')}n` : `${CSI}=2;n`;
        case 'fontdim':
            return `${CSI}=3;${ev.h};${ev.w}n`;
        case 'jxl':
            // CTerm APC state report: JPEG XL is not available (inline images are off).
            return `${CSI}=1;0-n`;
        case 'ctsmrr':
            switch (ev.n) {
                case 4: // LCF enabled
                    return `${CSI}=4;${st.lastColumnFlag ? 1 : 0}n`;
                case 5: // LCF forced: never
                    return `${CSI}=5;0n`;
                case 6: // OSC 8 hyperlinks
                    return `${CSI}=6;${st.links ? 1 : 0}n`;
                default:
                    // 7 (audio) is answered by the audio engine; others are unknown.
                    // A terminal that lacks a report sends nothing.
                    return null;
            }
        default:
            return null;
    }
}

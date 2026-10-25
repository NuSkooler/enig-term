// Replies to host queries. The WASM core reports each request (with the state
// captured at the moment it was parsed); the shell decides what to answer.
//
// References: CTerm manual (syncterm.net/cterm.html; local copy
// ansi-bbs-utils/docs/reference/cterm.txt), bansi.txt for CSI 255 n.

export const ESC = String.fromCharCode(0x1b);
export const CSI = ESC + '[';

export const VERSION = { major: 0, minor: 1, patch: 0 };

/** "enig-term" as decimal ASCII, CTerm-shaped: CSI = 101;110;...;maj;min;patch c */
export function daReply(): string {
    const name = Array.from('enig-term', c => c.charCodeAt(0)).join(';');
    return `${CSI}=${name};${VERSION.major};${VERSION.minor};${VERSION.patch}c`;
}

/**
 * CTerm Device Attributes (CTDA, CSI < c). Only features verified in this
 * build are listed (numbering per the local cterm.txt):
 *   1 - loadable fonts via DCS          (verified: test/core.test.mjs "dcs font")
 *   2 - palette changes via OSC         (verified: "osc palette")
 *   4 - font select via CSI Ps1;Ps2 SP D (verified: "font select")
 * Not claimed: 3 pixel ops (engine has sixel, untested here), 5/6 extended
 * palette, 7 mouse (no mouse reporting in the shell yet).
 */
export const CTDA_FEATURES = [1, 2, 4];
export function ctdaReply(): string {
    return `${CSI}<0;${CTDA_FEATURES.join(';')}c`;
}

/** CTerm state/mode capability answers for `CSI = Ps n` outside 1..3. */
export const CTERM_CAPS: Record<number, number> = {
    // 6 = OSC 8 hyperlinks: icy_engine parses OSC 8 (text stays clean, link
    // is recorded and underlined). Clicking is not in the spike.
    6: 1,
};

export type CoreEvent =
    | { t: 'req'; k: 'da' | 'da2' | 'ctda' | 'dsr' }
    | { t: 'req'; k: 'cpr'; row: number; col: number }
    | { t: 'req'; k: 'size'; rows: number; cols: number }
    | { t: 'req'; k: 'fontstate'; result: number; slots: number[] }
    | { t: 'req'; k: 'fontmode'; modes: number[] }
    | { t: 'req'; k: 'fontdim'; h: number; w: number }
    | { t: 'req'; k: 'ctsmrr'; n: number }
    | { t: 'req'; k: 'other'; dbg: string }
    | { t: 'font'; slot: number; font: number; ok: boolean }
    | { t: 'fontload'; slot: number; bytes: number }
    | { t: 'bell' }
    | { t: 'link'; uri: string }
    | { t: 'apc'; data: string }
    | { t: 'music'; actions: number };

/** First slot available for DCS-loaded fonts (SyncTERM numbering). */
const FIRST_LOADABLE_SLOT = 43;

/** Returns the reply string for a request event, or null if none is due. */
export function replyFor(ev: CoreEvent): string | null {
    if (ev.t !== 'req') return null;
    switch (ev.k) {
        case 'da':
            return daReply();
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
            // CSI = 1 ; pF ; pR ; pS0 ; pS1 ; pS2 ; pS3 n
            return `${CSI}=1;${FIRST_LOADABLE_SLOT};${ev.result};${ev.slots.join(';')}n`;
        case 'fontmode':
            return ev.modes.length ? `${CSI}=2;${ev.modes.join(';')}n` : `${CSI}=2;n`;
        case 'fontdim':
            return `${CSI}=3;${ev.h};${ev.w}n`;
        case 'ctsmrr': {
            const v = CTERM_CAPS[ev.n];
            return `${CSI}=${ev.n};${v ?? 0}n`;
        }
        default:
            return null;
    }
}

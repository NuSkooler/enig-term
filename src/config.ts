// config.json (schema v1), option precedence and persisted user settings.
//
// Precedence, lowest first:
//   1. built-in defaults                         (DEFAULTS)
//   2. config.json                               (operator; ENiGMA generates it)
//   3. element attributes / EnigTerm.mount() options (the embedding page)
//   4. URL parameters                            (standalone page only; a
//                                                 short list, see URL_KEYS)
//   5. user settings in localStorage             (only keys in USER_KEYS, and
//                                                 never a key the config locks)
// `lockEndpoint` additionally stops levels 4 and 5 (and the host input) from
// changing the endpoint.

import { DEFAULT_LINK_SCHEMES } from './links.ts';
import { AMIGA_PALETTE_NAMES, type AmigaPaletteName } from './palettes.ts';

/** "auto": PC, switching to Amiga while the host's font is an Amiga one (SyncTERM 37-42). */
export type Profile = 'auto' | 'pc' | 'amiga';
export type KeyBarMode = 'auto' | 'on' | 'off';
export type ScaleMode = 'fit' | 'integer';

/** Everything the terminal reads. config.json uses the same key names. */
export interface Options {
    /** Schema version of config.json. */
    version: number;
    /** wss:// URL of the board (ws:// only for loopback hosts or with allowInsecure). null: ask. */
    endpoint: string | null;
    /** Shown in the page title and the toolbar. */
    title: string;
    /** The user cannot change the endpoint (host input read-only, URL parameter ignored). */
    lockEndpoint: boolean;
    /** Connect as soon as the page loads, if there is an endpoint. */
    autoConnect: boolean;
    cols: number;
    rows: number;
    /**
     * Look profile: "pc", "amiga" (Ami/X: Amiga palette, aspect, cursor and
     * optional geometry), or "auto" (PC, Amiga while the host's normal font
     * is an Amiga font). "pc" and "amiga" lock it.
     */
    profile: Profile;
    /** Fonts directory (its manifest.json), relative to the bundle. */
    fonts: string;
    /** Amiga fonts directory, relative to the bundle; "" = none installed. */
    amigaFonts: string;
    /** Amiga profile palette. */
    amigaPalette: AmigaPaletteName;
    /** Amiga profile pixel aspect (height:width of a hires pixel): "pal" 1.875, "ntsc" 2.4, or a number 1-3. */
    amigaAspect: 'pal' | 'ntsc' | number;
    /** Amiga profile rows (e.g. 24, 25 or 32; NAWS follows), or null to keep `rows`. */
    amigaRows: number | null;
    /** Font the explicit Amiga profile selects (SyncTERM 37-42; 42 = Topaz), when installed. */
    amigaFont: number;
    /** Amiga profile honours the host's CSI ? 33 h (iCE colours). */
    amigaIce: boolean;
    /** Amiga profile blinks text (SGR 5). */
    amigaBlink: boolean;
    /** Amiga profile cursor: "block", or "host" (whatever the host sets). */
    amigaCursor: 'block' | 'host';
    /** 4:3 aspect correction. */
    aspect: boolean;
    /** CRT effect. */
    crt: boolean;
    /** Scale to fit the width, or only by whole multiples. */
    scale: ScaleMode;
    /** Sharp-bilinear (true) or plain bilinear sampling. */
    sharp: boolean;
    /** On-screen key bar: auto = shown on touch (coarse pointer) devices. */
    keyBar: KeyBarMode;
    /** Scrollback lines kept (cells). 0 disables scrollback. */
    scrollback: number;
    /** Keep the screen in scrollback when the host clears it. */
    scrollbackOnClear: boolean;
    /** Reconnect with backoff after an unexpected close. */
    autoReconnect: boolean;
    /** Text and cursor blink (off only for tests/screenshots). */
    blink: boolean;
    /** Backspace sends ^H ("bs", DOS/SyncTERM) or DEL ("del"). */
    backspace: 'bs' | 'del';
    /** Allowed OSC 8 link schemes. */
    linkSchemes: string[];
    /** Allow ws:// to hosts other than loopback (development only). */
    allowInsecure: boolean;
    /** TTYPE answer. */
    termType: string;
    /** Renderer: webgl2 (default) or 2d. */
    renderer: 'webgl2' | '2d';
    /** Setting names the user may not change (on top of lockEndpoint). */
    lock: string[];
    /** Read URL parameters (standalone page). */
    urlParams: boolean;
    /** Remember user settings in localStorage. */
    persist: boolean;
    /** Show the toolbar (host input, connect, settings). */
    toolbar: boolean;
    /** Sound at all: CTerm audio (APC) and "ANSI" music. false: the terminal answers no audio queries. */
    sound: boolean;
    /** The user's mute. */
    mute: boolean;
    /** Master volume, 0-100. */
    volume: number;
    /** "ANSI" music voice: a PC-speaker square, SyncTERM's timbre, or a sine. */
    musicTone: 'square' | 'syncterm' | 'sine';
    /** Board sounds kept in this browser (IndexedDB, all boards together), MB. */
    audioCache: number;
    /** Largest sound file a board may store or play, MB. */
    audioMaxFile: number;
    /** Decoded audio held at once (slots and channels), MB. */
    audioMemory: number;
    /** File transfers (ZModem, YModem, XModem): the Files panel and ZModem detection. */
    transfers: boolean;
    /** A ZModem download the board starts: "auto" begins it, "ask" asks first, "off" leaves it on screen as text. */
    zmodemDetect: 'auto' | 'ask' | 'off';
    /** Largest file saved through a browser download, MB (larger ones are refused; a chosen folder has no limit). */
    transferMaxFile: number;
}

export const DEFAULTS: Readonly<Options> = Object.freeze({
    version: 1,
    endpoint: null,
    title: 'enig-term',
    lockEndpoint: false,
    autoConnect: false,
    cols: 80,
    rows: 25,
    profile: 'auto',
    fonts: 'fonts/',
    amigaFonts: 'fonts/amiga/',
    amigaPalette: 'ncomm',
    amigaAspect: 'pal',
    amigaRows: null,
    amigaFont: 42,
    amigaIce: false,
    amigaBlink: true,
    amigaCursor: 'block',
    aspect: true,
    crt: false,
    scale: 'fit',
    sharp: true,
    keyBar: 'auto',
    scrollback: 2000,
    scrollbackOnClear: true,
    autoReconnect: false,
    blink: true,
    backspace: 'bs',
    linkSchemes: [...DEFAULT_LINK_SCHEMES],
    allowInsecure: false,
    termType: 'ansi-bbs',
    renderer: 'webgl2',
    lock: [],
    urlParams: false,
    persist: true,
    toolbar: true,
    sound: true,
    mute: false,
    volume: 70,
    musicTone: 'square',
    audioCache: 64,
    audioMaxFile: 16,
    audioMemory: 192,
    transfers: true,
    zmodemDetect: 'auto',
    transferMaxFile: 512,
}) as Options;

/** Settings a user can change from the UI (and that are persisted). */
export const USER_KEYS = ['aspect', 'crt', 'scale', 'keyBar', 'autoReconnect', 'backspace', 'sharp', 'profile', 'amigaPalette', 'amigaAspect', 'mute', 'volume', 'musicTone', 'zmodemDetect'] as const;
export type UserKey = (typeof USER_KEYS)[number];
export type UserSettings = Partial<Pick<Options, UserKey>>;

const BOOL_KEYS = ['lockEndpoint', 'autoConnect', 'aspect', 'crt', 'sharp', 'scrollbackOnClear', 'autoReconnect', 'blink', 'allowInsecure', 'urlParams', 'persist', 'toolbar', 'amigaIce', 'amigaBlink', 'sound', 'mute', 'transfers'] as const;

/** Pixel aspect (height:width) of the Amiga presets: PAL hires 640x256 and NTSC 640x200 shown at 4:3. */
export const AMIGA_ASPECT = { pal: 1.875, ntsc: 2.4 } as const;

/**
 * Validate a partial options object (config.json, attributes, JS options):
 * keep known keys with valid values, drop the rest with a warning. Unknown
 * keys are ignored silently (operators may pass extras through).
 */
export function sanitize(src: Record<string, unknown> | null | undefined, warn: (m: string) => void = () => {}): Partial<Options> {
    const out: Partial<Options> = {};
    if (!src || typeof src !== 'object') return out;
    const o = out as Record<string, unknown>;
    const bad = (k: string) => warn(`enig-term: ignoring invalid ${k}: ${JSON.stringify(src[k])}`);
    for (const k of BOOL_KEYS) {
        if (!(k in src)) continue;
        const v = src[k];
        if (typeof v === 'boolean') o[k] = v;
        else if (v === 'true' || v === '1' || v === '' || v === 'on') o[k] = true;
        else if (v === 'false' || v === '0' || v === 'off') o[k] = false;
        else bad(k);
    }
    if ('version' in src) {
        const v = Number(src.version);
        if (Number.isInteger(v) && v >= 1) {
            o.version = v;
            if (v > 1) warn(`enig-term: config version ${v} is newer than this build understands (1); reading the keys it knows`);
        } else bad('version');
    }
    if ('endpoint' in src) {
        const v = src.endpoint;
        if (v === null || v === '') o.endpoint = null;
        else if (typeof v === 'string') o.endpoint = v.trim();
        else bad('endpoint');
    }
    for (const k of ['fonts', 'amigaFonts'] as const) {
        if (!(k in src)) continue;
        const v = src[k];
        if (typeof v === 'string' && v.length <= 1000) o[k] = v.trim();
        else if (k === 'amigaFonts' && (v === false || v === null)) o[k] = '';
        else bad(k);
    }
    if ('amigaRows' in src) {
        const v = src.amigaRows;
        const n = Number(v);
        if (v === null || v === '' || v === 'off') o.amigaRows = null;
        else if (Number.isInteger(n) && n >= 10 && n <= 255) o.amigaRows = n;
        else bad('amigaRows');
    }
    if ('amigaFont' in src) {
        const n = Number(src.amigaFont);
        if (Number.isInteger(n) && n >= 37 && n <= 42) o.amigaFont = n;
        else bad('amigaFont');
    }
    if ('amigaAspect' in src) {
        const v = src.amigaAspect;
        const n = Number(v);
        if (v === 'pal' || v === 'ntsc') o.amigaAspect = v;
        else if (v !== '' && v !== null && Number.isFinite(n) && n >= 1 && n <= 3) o.amigaAspect = n;
        else bad('amigaAspect');
    }
    for (const k of ['title', 'termType'] as const) {
        if (!(k in src)) continue;
        if (typeof src[k] === 'string') o[k] = String(src[k]).slice(0, 200);
        else bad(k);
    }
    for (const [k, lo, hi] of [
        ['cols', 20, 255],
        ['rows', 10, 255],
        ['scrollback', 0, 100000],
        ['volume', 0, 100],
        ['audioCache', 0, 4096],
        ['audioMaxFile', 1, 64],
        ['audioMemory', 16, 2048],
        ['transferMaxFile', 1, 4096],
    ] as const) {
        if (!(k in src)) continue;
        const v = Number(src[k]);
        if (Number.isInteger(v) && v >= lo && v <= hi) o[k] = v;
        else bad(k);
    }
    const oneOf = <K extends keyof Options>(k: K, values: readonly string[]) => {
        if (!(k in src)) return;
        const v = src[k];
        if (typeof v === 'string' && values.includes(v)) o[k] = v;
        else if (k === 'keyBar' && typeof v === 'boolean') o[k] = v ? 'on' : 'off';
        else bad(k);
    };
    oneOf('profile', ['auto', 'pc', 'amiga']);
    oneOf('amigaPalette', AMIGA_PALETTE_NAMES);
    oneOf('amigaCursor', ['block', 'host']);
    oneOf('keyBar', ['auto', 'on', 'off']);
    oneOf('scale', ['fit', 'integer']);
    oneOf('backspace', ['bs', 'del']);
    oneOf('renderer', ['webgl2', '2d']);
    oneOf('musicTone', ['square', 'syncterm', 'sine']);
    oneOf('zmodemDetect', ['auto', 'ask', 'off']);
    for (const k of ['linkSchemes', 'lock'] as const) {
        if (!(k in src)) continue;
        const v = src[k];
        const list = typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : v;
        if (Array.isArray(list) && list.every(x => typeof x === 'string')) o[k] = list as string[];
        else bad(k);
    }
    return out;
}

/**
 * Options the URL may set (standalone page). A link can come from anyone, so
 * only looks and the endpoint: nothing that lets a board do more (sound,
 * ZModem auto-start), and an endpoint from the URL never connects by itself
 * (see startAction).
 */
const URL_KEYS = ['endpoint', 'autoConnect', 'aspect', 'crt', 'sharp', 'blink', 'renderer', 'cols', 'rows', 'scale', 'keyBar', 'profile', 'scrollback', 'autoReconnect', 'amigaPalette', 'amigaAspect', 'amigaRows', 'musicTone'] as const;

/**
 * Map URL parameters (standalone page) to options. Harmless test hooks are
 * returned separately; the debug hooks are never read from the URL (see
 * TestHooks in terminal.ts).
 */
export function fromUrlParams(q: URLSearchParams): { opts: Record<string, unknown>; hooks: Record<string, string> } {
    const opts: Record<string, unknown> = {};
    const map: Record<string, string> = { connect: 'autoConnect', keys: 'keyBar' };
    for (const [k, v] of q) {
        const key = map[k] ?? k;
        if ((URL_KEYS as readonly string[]).includes(key)) opts[key] = v;
    }
    const hooks: Record<string, string> = {};
    for (const k of ['naws', 'audioLock', 'audioFallback']) {
        const v = q.get(k);
        if (v !== null) hooks[k] = v;
    }
    return { opts, hooks };
}

/** Apply the precedence rules. `url` is only used when the merged options allow it. */
export function resolve(layers: {
    config?: Partial<Options>;
    page?: Partial<Options>;
    url?: Partial<Options>;
    user?: UserSettings;
}): Options {
    const merged: Options = { ...DEFAULTS, linkSchemes: [...DEFAULTS.linkSchemes], lock: [] };
    Object.assign(merged, layers.config ?? {}, layers.page ?? {});
    const locked = new Set(merged.lock);
    if (merged.urlParams && layers.url) {
        // URL parameters may not unlock anything, change locked settings, or
        // set anything outside URL_KEYS.
        const url: Record<string, unknown> = {};
        for (const k of URL_KEYS) if (layers.url[k] !== undefined && !locked.has(k)) url[k] = layers.url[k];
        if (merged.lockEndpoint) delete url.endpoint;
        Object.assign(merged, url);
    }
    for (const k of USER_KEYS) {
        const v = layers.user?.[k];
        if (v !== undefined && !locked.has(k)) (merged as unknown as Record<string, unknown>)[k] = v;
    }
    return merged;
}

/**
 * What to do on load: connect, ask first, or nothing. An endpoint that came
 * from the URL (not from config.json, attributes or mount() options) never
 * connects by itself: a crafted link could point the operator's own page at a
 * hostile board. The user is asked, naming the host.
 */
export function startAction(opts: Options, layers: { config?: Partial<Options>; page?: Partial<Options> }): 'connect' | 'ask' | null {
    if (!opts.autoConnect || !opts.endpoint) return null;
    const trusted = layers.page?.endpoint !== undefined ? layers.page.endpoint : (layers.config?.endpoint ?? null);
    return opts.endpoint === trusted ? 'connect' : 'ask';
}

/** Is this setting one the user may change? */
export function userMayChange(opts: Options, key: string): boolean {
    if (key === 'endpoint') return !opts.lockEndpoint;
    return (USER_KEYS as readonly string[]).includes(key) && !opts.lock.includes(key);
}

// --- persisted user settings ------------------------------------------------

const STORE_KEY = 'enig-term:settings:v1';

/** Read saved settings. Every storage access is guarded: it can throw (privacy modes, sandboxed frames). */
export function loadUserSettings(): UserSettings {
    try {
        const raw = globalThis.localStorage?.getItem(STORE_KEY);
        if (!raw) return {};
        const parsed = sanitize(JSON.parse(raw));
        const out: UserSettings = {};
        for (const k of USER_KEYS) if (parsed[k] !== undefined) (out as Record<string, unknown>)[k] = parsed[k];
        return out;
    } catch {
        return {};
    }
}

export function saveUserSettings(s: UserSettings): boolean {
    try {
        globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(s));
        return true;
    } catch {
        return false;
    }
}

// --- endpoints ----------------------------------------------------------------

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i;

export interface EndpointCheck {
    ok: boolean;
    url: string;
    reason?: string;
}

/**
 * Normalise what the user typed ("bbs.example.com:8443", "wss://...") and
 * enforce wss://. ws:// is accepted only for loopback hosts, or anywhere when
 * `allowInsecure` is set (development).
 */
export function checkEndpoint(input: string, allowInsecure = false): EndpointCheck {
    let s = input.trim();
    if (!s) return { ok: false, url: s, reason: 'no host given' };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'wss://' + s;
    let u: URL;
    try {
        u = new URL(s);
    } catch {
        return { ok: false, url: s, reason: 'not a valid address' };
    }
    if (u.protocol === 'wss:') return { ok: true, url: u.href };
    if (u.protocol === 'ws:') {
        if (LOOPBACK.test(u.hostname) || allowInsecure) return { ok: true, url: u.href };
        return { ok: false, url: u.href, reason: 'only secure (wss://) connections are allowed' };
    }
    return { ok: false, url: u.href, reason: `${u.protocol} is not a WebSocket address` };
}

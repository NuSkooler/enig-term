// Fonts for the engine. None are compiled into the WASM: they are PSF2 files
// next to the bundle, described by manifests, and fetched when first needed.
//
//   fonts/manifest.json        PC fonts (int10h / VileR, CC BY-SA 4.0), shipped in dist/
//   fonts/amiga/manifest.json  Amiga fonts (SyncTERM 37-42), installed by the operator
//                              with tools/fetch-amiga-fonts.mjs; absent by default
//
// Manifest file paths are relative to the manifest. File URLs carry
// ?v=<first 16 hex digits of the file's SHA-256>, so they can be cached for
// good. A typical CP437 session fetches the manifest and one 4 KB file.

export interface SlotEntry {
    name: string;
    codepage?: string;
    /** Cell height ("8", "14", "16") -> file, relative to the manifest. */
    files?: Record<string, string>;
    /** Why the slot has no font (it is refused). */
    refused?: string;
    license?: string;
    substitute?: string;
}

export interface FontManifest {
    version: number;
    slots: Record<string, SlotEntry>;
    files: Record<string, { sha256: string; bytes: number }>;
}

/** SyncTERM font numbers of the Amiga fonts (operator-installed; ISO-8859-1 glyph order). */
export const AMIGA_SLOTS: ReadonlySet<number> = new Set([37, 38, 39, 40, 41, 42]);

export const AMIGA_SLOT_NAMES: Record<number, string> = {
    37: "P0T NOoDLE (Amiga)",
    38: "mO'sOul (Amiga)",
    39: 'MicroKnight Plus (Amiga)',
    40: 'Topaz Plus (Amiga)',
    41: 'MicroKnight (Amiga)',
    42: 'Topaz (Amiga)',
};

/** Cell height of a screen of `rows` rows (as the core decides it: 50 rows 8, 28/43 rows 14, else 16). */
export function modeHeight(rows: number): number {
    return rows === 50 ? 8 : rows === 28 || rows === 43 ? 14 : 16;
}

export interface LoadedFont {
    slot: number;
    height: number;
    name: string;
    data: Uint8Array;
}

declare const __ENIG_TERM_FONTS_HASH__: string | undefined;
const FONTS_QUERY = typeof __ENIG_TERM_FONTS_HASH__ === 'string' && __ENIG_TERM_FONTS_HASH__ ? `?v=${__ENIG_TERM_FONTS_HASH__}` : '';

/** fetch() results, shared by every terminal on the page. */
const cache = new Map<string, Promise<unknown>>();

function fetchOnce<T>(url: string, how: (r: Response) => Promise<T>, init?: RequestInit): Promise<T | null> {
    let p = cache.get(url) as Promise<T | null> | undefined;
    if (!p) {
        p = fetch(url, { credentials: 'same-origin', ...init })
            .then(r => (r.ok ? how(r) : null))
            .catch(() => null);
        cache.set(url, p);
        // A failure is not cached for good: a later request tries again.
        p.then(v => v === null && setTimeout(() => cache.delete(url), 10_000));
    }
    return p;
}

function validManifest(m: unknown): FontManifest | null {
    const o = m as FontManifest;
    return o && typeof o === 'object' && o.version === 1 && o.slots && typeof o.slots === 'object' && o.files && typeof o.files === 'object' ? o : null;
}

export class FontStore {
    private pc: FontManifest | null = null;
    private amiga: FontManifest | null | undefined = undefined; // undefined: not fetched yet
    readonly pcUrl: URL;
    readonly amigaUrl: URL | null;

    /** `base`: the fonts directory; `amigaBase`: the Amiga fonts directory, or null (none). */
    constructor(base: URL, amigaBase: URL | null) {
        this.pcUrl = new URL(`manifest.json${FONTS_QUERY}`, base);
        this.amigaUrl = amigaBase ? new URL('manifest.json', amigaBase) : null;
    }

    async loadPcManifest(): Promise<FontManifest | null> {
        if (!this.pc) this.pc = validManifest(await fetchOnce(this.pcUrl.href, r => r.json()));
        return this.pc;
    }

    /** The Amiga manifest, fetched (revalidated: the operator may install fonts later) once per page. */
    async loadAmigaManifest(): Promise<FontManifest | null> {
        if (this.amiga === undefined) {
            this.amiga = this.amigaUrl ? validManifest(await fetchOnce(this.amigaUrl.href, r => r.json(), { cache: 'no-cache' })) : null;
        }
        return this.amiga;
    }

    /**
     * Whether `slot` might have a font of this height: true when a manifest
     * lists one, or when it is an Amiga slot and the Amiga manifest has not
     * been read yet. False means the engine refuses the selection at once.
     */
    mayHave(slot: number, height: number): boolean {
        if (AMIGA_SLOTS.has(slot)) {
            if (!this.amigaUrl) return false;
            if (this.amiga === undefined) return true;
            return !!this.amiga?.slots[slot]?.files?.[height];
        }
        return !!this.pc?.slots[slot]?.files?.[height];
    }

    /** Whether the operator installed Amiga fonts: unknown until their manifest has been asked for. */
    get amigaInstalled(): boolean | undefined {
        if (!this.amigaUrl) return false;
        return this.amiga === undefined ? undefined : !!this.amiga;
    }

    /** Slot description from the manifests (refusal reasons included). */
    describe(slot: number): SlotEntry | null {
        if (AMIGA_SLOTS.has(slot)) return this.amiga?.slots[slot] ?? { name: AMIGA_SLOT_NAMES[slot], refused: 'Amiga fonts are not installed' };
        return this.pc?.slots[slot] ?? null;
    }

    /** Fetch the font for `slot` at `height`, or null if there is none. */
    async font(slot: number, height: number): Promise<LoadedFont | null> {
        const amiga = AMIGA_SLOTS.has(slot);
        const m = amiga ? await this.loadAmigaManifest() : await this.loadPcManifest();
        const entry = m?.slots[slot];
        const file = entry?.files?.[height];
        if (!m || !entry || !file) return null;
        const info = m.files[file];
        const base = amiga ? this.amigaUrl! : this.pcUrl;
        const url = new URL(file, base);
        url.search = info?.sha256 ? `?v=${info.sha256.slice(0, 16)}` : '';
        const data = await fetchOnce(url.href, async r => new Uint8Array(await r.arrayBuffer()));
        if (!data || (info?.bytes && data.length !== info.bytes)) return null;
        return { slot, height, name: entry.name, data };
    }
}

/**
 * Finds `CSI Ps1 ; Ps2 SP D` (font selection) in the host stream, across
 * chunks. The terminal holds the stream at the final byte while it fetches a
 * font the host selects, so the selection succeeds instead of being refused.
 */
export class FontSelectScan {
    private state = 0;
    private params: number[] = [];
    private cur = 0;
    private digits = false;

    clone(): FontSelectScan {
        const c = new FontSelectScan();
        c.state = this.state;
        c.params = [...this.params];
        c.cur = this.cur;
        c.digits = this.digits;
        return c;
    }

    /** Returns [Ps1, Ps2] when a font selection ends at this byte. */
    step(b: number): [number, number] | null {
        if (b === 0x1b) {
            this.state = 1;
            return null;
        }
        switch (this.state) {
            case 1:
                if (b === 0x5b) {
                    this.state = 2;
                    this.params = [];
                    this.cur = 0;
                    this.digits = false;
                } else this.state = 0;
                break;
            case 2:
                if (b >= 0x30 && b <= 0x39) {
                    this.cur = Math.min(65535, this.cur * 10 + (b - 0x30));
                    this.digits = true;
                } else if (b === 0x3b && this.params.length < 8) {
                    this.params.push(this.digits ? this.cur : 0);
                    this.cur = 0;
                    this.digits = false;
                } else if (b === 0x20) {
                    this.params.push(this.digits ? this.cur : 0);
                    this.state = 3;
                } else this.state = 0;
                break;
            case 3:
                this.state = 0;
                if (b === 0x44 && this.params.length <= 2) return [this.params[0] ?? 0, this.params[1] ?? 0];
                break;
            default:
                break;
        }
        return null;
    }
}

/** What a SAUCE font name (TInfoS) asks for: our SyncTERM font, or null for the default (slot 0). */
export interface SauceFont {
    /** SyncTERM font number to select, or null: we have no such font (the default is used). */
    slot: number | null;
    /** Cell height the name implies (VGA 16, VGA50 8, VGA25G 19, EGA 14, EGA43 8, Amiga 8). */
    height: number | null;
}

/** SAUCE code page suffix -> our font of that code page (the plain, not "thin", variant). */
const SAUCE_CODEPAGES: Record<string, number> = {
    '437': 0,
    '819': 24, // ISO-8859-1
    '850': 18,
    '858': 18, // CP850 with the euro at 0xD5: drawn with CP850 (dotless i there)
    '865': 28,
    '866': 25,
};

const SAUCE_PC_HEIGHTS: Record<string, number> = { vga: 16, vga50: 8, vga25g: 19, ega: 14, ega43: 8 };

/**
 * Amiga SAUCE names, lower case with everything but letters, digits and "+"
 * dropped and 0 read as o ("P0T-NOoDLE", "mO'sOul"). Topaz 1 and 2 are
 * whichever Kickstart's Topaz the operator installed.
 */
const SAUCE_AMIGA: Record<string, number> = {
    topaz1: 42,
    topaz2: 42,
    topaz: 42,
    'topaz1+': 40,
    'topaz2+': 40,
    'topaz+': 40,
    potnoodle: 37,
    microknight: 41,
    'microknight+': 39,
    mosoul: 38,
};

/**
 * Map a SAUCE font name (the spec's TInfoS list: "IBM VGA", "IBM EGA43 850",
 * "Amiga Topaz 2+", ...) to one of our fonts. Case, spacing and the usual
 * spelling variants are ignored. Code pages and designs we do not have (737,
 * 852, C64 PETSCII, Atari ATASCII, unknown names) give slot null.
 */
export function sauceFont(name: string): SauceFont {
    const n = name.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
    const pc = /^ibm ?(vga ?50|vga ?25g|vga|ega ?43|ega)(?: (\w+))?$/.exec(n);
    if (pc) {
        const slot = SAUCE_CODEPAGES[pc[2] ?? '437'];
        return { slot: slot ?? null, height: SAUCE_PC_HEIGHTS[pc[1].replace(' ', '')] };
    }
    const amiga = n.replace(/[^a-z0-9+]/g, '').replace(/0/g, 'o').replace(/plus$/, '+');
    const slot = SAUCE_AMIGA[amiga.replace(/^amiga/, '')];
    return slot === undefined ? { slot: null, height: null } : { slot, height: 8 };
}

/** The font name (TInfoS) of a file's SAUCE record, for character and binary text files; null without one. */
export function sauceFontName(file: Uint8Array): string | null {
    if (file.length < 128) return null;
    const rec = file.subarray(file.length - 128);
    if (String.fromCharCode(...rec.subarray(0, 7)) !== 'SAUCE00') return null;
    if (rec[94] !== 1 && rec[94] !== 5) return null; // DataType: Character or BinaryText
    const s = rec.subarray(106, 128);
    const end = s.indexOf(0);
    const name = String.fromCharCode(...(end < 0 ? s : s.subarray(0, end))).trim();
    return name || null;
}

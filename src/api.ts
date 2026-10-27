// Embedding API: EnigTerm.mount(el, options) and the handle it returns.
import {
    fromUrlParams,
    loadUserSettings,
    resolve,
    sanitize,
    startAction,
    type Options,
    type UserSettings,
} from './config.ts';
import { Chrome } from './ui.ts';
import { Terminal, type TermEventName, type TermEvents, type TestHooks } from './terminal.ts';
import type { TransferProtocol, TransferStatus } from './transfers.ts';
import { VERSION_STRING } from './replies.ts';

export interface MountOptions extends Partial<Options> {
    /**
     * config.json to read: a URL (resolved against the document) or an object.
     * Its keys rank below these options.
     */
    config?: string | URL | Record<string, unknown> | null;
    /** Where the WASM is. Default: enig_term_core_bg.wasm next to this script. */
    wasmUrl?: string | URL;
    /** Fit the terminal to the height of the element too (standalone page). */
    fill?: boolean;
}

export interface EnigTermHandle {
    readonly version: string;
    /** Connect to the configured endpoint, or to `endpoint`. Returns false if it was refused (see the state event). */
    connect(endpoint?: string): boolean;
    disconnect(): void;
    /** Change an option at run time (crt, aspect, scale, keyBar, autoReconnect, backspace, scrollback, endpoint, title, ...). */
    setOption<K extends keyof Options>(key: K, value: Options[K]): void;
    getOption<K extends keyof Options>(key: K): Options[K];
    /** Subscribe to an event: state, title, bell, link, notice, recovered, scroll, selection, profile, sound, transfer. Returns an unsubscribe function. */
    on<K extends TermEventName>(event: K, fn: (ev: TermEvents[K]) => void): () => void;
    /** Send text to the host as if typed. */
    send(text: string): void;
    paste(text: string): void;
    /** Feed bytes to the screen as if they came from the host. */
    write(data: Uint8Array | string): void;
    copySelection(): Promise<boolean>;
    focus(): void;
    resize(cols: number, rows: number): void;
    toggleFullscreen(): Promise<void>;
    /** Sound: off, idle (not used yet), locked (waiting for a click), on or muted. */
    readonly soundState: string;
    /** Let sound start (call from a user gesture, e.g. your own "enable sound" button). */
    enableSound(): void;
    /** Forget the sounds boards stored in this browser (all boards). */
    clearSoundCache(): Promise<{ files: number; bytes: number }>;
    /**
     * Receive files: "zmodem" waits for the board to start sending (ZModem
     * downloads also start by themselves); "ymodem"/"xmodem" start now (start
     * the board's side first). `name`: what an XModem file is saved as.
     */
    download(protocol?: TransferProtocol, name?: string): boolean;
    /** Send files: "zmodem" waits for the board's receiver; "ymodem"/"xmodem" start now (XModem: one file). */
    upload(files: File[] | FileList, protocol?: TransferProtocol): boolean;
    /** Cancel the transfer (or refuse the board's offer, or forget a prepared one). */
    cancelTransfer(): void;
    /** The current or last transfer. */
    readonly transfer: TransferStatus;
    readonly state: string;
    /** The terminal object itself (advanced use and tests; not a stable API). */
    readonly terminal: Terminal;
    destroy(): void;
}

async function readConfig(src: MountOptions['config'], warn: (m: string) => void): Promise<Partial<Options>> {
    if (!src) return {};
    if (typeof src === 'object' && !(src instanceof URL)) return sanitize(src, warn);
    try {
        const url = new URL(String(src), document.baseURI);
        const r = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' });
        if (!r.ok) {
            if (r.status !== 404) warn(`enig-term: ${url.href}: HTTP ${r.status}`);
            return {};
        }
        return sanitize(await r.json(), warn);
    } catch (e) {
        warn(`enig-term: could not read config: ${(e as Error)?.message ?? e}`);
        return {};
    }
}

/** Mount a terminal into `el` (inside a shadow root, so the page's CSS and ours stay apart). */
export async function mount(el: HTMLElement, options: MountOptions = {}): Promise<EnigTermHandle> {
    const warn = (m: string) => console.warn(m);
    const { config: configSrc, wasmUrl, fill, ...pageRaw } = options;
    const config = await readConfig(configSrc, warn);
    const page = sanitize(pageRaw as Record<string, unknown>, warn);
    // Callbacks or values sanitize() does not know about pass straight through.
    const urlEnabled = page.urlParams ?? config.urlParams ?? false;
    let url: Partial<Options> = {};
    // The debug hooks come only from a global a test sets before the page
    // loads, never from the URL: a link must not be able to turn them on.
    const g = (globalThis as { __enigTermTestHooks?: TestHooks }).__enigTermTestHooks;
    let hooks: TestHooks = { debugCtermDa: g?.debugCtermDa === true, debugPanic: g?.debugPanic === true };
    if (urlEnabled) {
        const q = fromUrlParams(new URLSearchParams(location.search));
        url = sanitize(q.opts, warn);
        hooks = {
            ...hooks,
            naws: q.hooks.naws === undefined ? undefined : q.hooks.naws !== '0',
            audioLock: q.hooks.audioLock === '1',
            audioFallback: q.hooks.audioFallback === '1',
        };
    }
    const persist = page.persist ?? config.persist ?? true;
    const user: UserSettings = persist ? loadUserSettings() : {};
    const opts = resolve({ config, page, url, user });

    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const chrome = new Chrome(el, shadow, opts, user, !!fill);
    const term = await Terminal.create(chrome.term, opts, hooks, wasmUrl);
    chrome.attach(term);
    el.dataset.enigTermReady = '1';

    const handle: EnigTermHandle = {
        version: VERSION_STRING,
        connect: endpoint => {
            const ok = term.connect(endpoint ?? (opts.lockEndpoint ? opts.endpoint : null) ?? undefined);
            return ok;
        },
        disconnect: () => term.disconnect(),
        setOption: (key, value) => {
            const clean = sanitize({ [key]: value } as Record<string, unknown>, warn) as Partial<Options>;
            if (!(key in clean)) return;
            opts[key] = clean[key] as Options[typeof key];
            chrome.setOption(key, clean[key] as Options[typeof key]);
        },
        getOption: key => term.opts[key] ?? opts[key],
        on: (event, fn) => term.events.on(event, fn),
        send: text => term.sendText(text),
        paste: text => term.paste(text),
        write: data => term.write(data),
        copySelection: () => term.copySelection(),
        focus: () => term.input.focus(),
        resize: (cols, rows) => term.resize(cols, rows),
        toggleFullscreen: () => chrome.toggleFullscreen(),
        get soundState() {
            return term.sound.state;
        },
        enableSound: () => term.sound.gesture(true),
        clearSoundCache: () => term.sound.clearCache(),
        download: (protocol = 'zmodem', name) => term.transfers.download(protocol, name),
        upload: (files, protocol = 'zmodem') => term.transfers.upload(Array.from(files), protocol),
        cancelTransfer: () => term.transfers.cancel(),
        get transfer() {
            return term.transfers.status;
        },
        get state() {
            return term.state;
        },
        terminal: term,
        destroy: () => {
            chrome.destroy();
            term.destroy();
            shadow.replaceChildren();
            delete el.dataset.enigTermReady;
        },
    };
    const start = startAction(opts, { config, page });
    if (start === 'connect') term.connect(opts.endpoint!);
    else if (start === 'ask') chrome.confirmConnect(opts.endpoint!);
    return handle;
}

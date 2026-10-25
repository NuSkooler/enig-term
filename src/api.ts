// Embedding API: EnigTerm.mount(el, options) and the handle it returns.
import {
    fromUrlParams,
    loadUserSettings,
    resolve,
    sanitize,
    type Options,
    type UserSettings,
} from './config.ts';
import { Chrome } from './ui.ts';
import { Terminal, type TermEventName, type TermEvents, type TestHooks } from './terminal.ts';
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
    /** Subscribe to an event: state, title, bell, link, notice, recovered, scroll, selection. Returns an unsubscribe function. */
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
    let hooks: TestHooks = {};
    if (urlEnabled) {
        const q = fromUrlParams(new URLSearchParams(location.search));
        url = sanitize(q.opts, warn);
        hooks = {
            naws: q.hooks.naws === undefined ? undefined : q.hooks.naws !== '0',
            debugCtermDa: q.hooks.debugDa === 'cterm',
            debugPanic: q.hooks.debugPanic === '1',
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
    if (opts.autoConnect && opts.endpoint) term.connect(opts.endpoint);
    return handle;
}

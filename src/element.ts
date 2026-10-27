// <enig-term> custom element.
//
//   <enig-term endpoint="wss://bbs.example.com:8443" crt aspect="off" keybar="auto"></enig-term>
//
// Attributes (all optional; they rank above config.json):
//   config        URL of a config.json (relative to the page)
//   endpoint      wss:// URL;  lock-endpoint  the user cannot change it
//   auto-connect  connect on load
//   title, cols, rows, profile (auto|pc|amiga), scrollback
//   fonts, amiga-fonts (font directories), amiga-palette, amiga-aspect, amiga-rows
//   sound ("off": no audio at all), mute, volume (0-100), music-tone (square|syncterm|sine)
//   transfers ("off": no file transfers), zmodem-detect (ask|auto|off), transfer-max-file (MB)
//   crt, aspect   booleans: present / "on" / "true" = on, "off" / "false" = off
//   scale         fit | integer;   keybar  auto | on | off
//   toolbar       "off" hides the toolbar;  persist  "off" stops saving user settings
//   url-params    read endpoint/connect/... from the page URL (standalone page)
//   fill          fit the screen to the element's height too
// Events (CustomEvent, detail = the event object): state, title, bell, link
// (cancelable: preventDefault() skips the built-in confirmation), notice,
// recovered, scroll, selection, profile, sound, transfer.
import { mount, type EnigTermHandle, type MountOptions } from './api.ts';
import type { TermEventName } from './terminal.ts';

const ATTRS: Record<string, string> = {
    endpoint: 'endpoint',
    'lock-endpoint': 'lockEndpoint',
    'auto-connect': 'autoConnect',
    title: 'title',
    cols: 'cols',
    rows: 'rows',
    profile: 'profile',
    scrollback: 'scrollback',
    crt: 'crt',
    aspect: 'aspect',
    scale: 'scale',
    keybar: 'keyBar',
    toolbar: 'toolbar',
    persist: 'persist',
    'url-params': 'urlParams',
    renderer: 'renderer',
    blink: 'blink',
    'auto-reconnect': 'autoReconnect',
    backspace: 'backspace',
    fonts: 'fonts',
    'amiga-fonts': 'amigaFonts',
    'amiga-palette': 'amigaPalette',
    'amiga-aspect': 'amigaAspect',
    'amiga-rows': 'amigaRows',
    sound: 'sound',
    mute: 'mute',
    volume: 'volume',
    'music-tone': 'musicTone',
    transfers: 'transfers',
    'zmodem-detect': 'zmodemDetect',
    'transfer-max-file': 'transferMaxFile',
};
const RUNTIME = new Set(['endpoint', 'title', 'crt', 'aspect', 'scale', 'keyBar', 'toolbar', 'autoReconnect', 'backspace', 'blink', 'scrollback', 'profile', 'amigaPalette', 'amigaAspect', 'amigaRows', 'mute', 'volume', 'musicTone', 'transfers', 'zmodemDetect', 'transferMaxFile']);
const EVENTS: TermEventName[] = ['state', 'title', 'bell', 'link', 'notice', 'recovered', 'scroll', 'selection', 'profile', 'sound', 'transfer'];

export class EnigTermElement extends HTMLElement {
    static observedAttributes = Object.keys(ATTRS);
    handle: EnigTermHandle | null = null;
    /** Resolves when the terminal is up. */
    ready: Promise<EnigTermHandle>;
    private resolveReady!: (h: EnigTermHandle) => void;
    private mounting = false;

    constructor() {
        super();
        this.ready = new Promise(r => (this.resolveReady = r));
    }

    private attrOptions(): MountOptions {
        const o: Record<string, unknown> = {};
        for (const [attr, key] of Object.entries(ATTRS)) {
            if (!this.hasAttribute(attr)) continue;
            o[key] = this.getAttribute(attr) ?? '';
        }
        const opts = o as MountOptions;
        const cfg = this.getAttribute('config');
        if (cfg) opts.config = cfg;
        if (this.hasAttribute('fill')) opts.fill = true;
        return opts;
    }

    connectedCallback(): void {
        if (this.handle || this.mounting) return;
        this.mounting = true;
        mount(this, this.attrOptions()).then(
            h => {
                this.handle = h;
                this.mounting = false;
                for (const name of EVENTS) {
                    h.on(name, ev => {
                        const dom = new CustomEvent(name, { detail: ev, cancelable: name === 'link', bubbles: true, composed: true });
                        this.dispatchEvent(dom);
                        if (name === 'link' && dom.defaultPrevented) (ev as { preventDefault(): void }).preventDefault();
                    });
                }
                this.resolveReady(h);
            },
            e => {
                this.mounting = false;
                console.error('enig-term: mount failed', e);
                this.dispatchEvent(new CustomEvent('error', { detail: e }));
            },
        );
    }

    disconnectedCallback(): void {
        // Moving the element in the DOM fires this too; only tear down if it stays out.
        queueMicrotask(() => {
            if (!this.isConnected && this.handle) {
                this.handle.destroy();
                this.handle = null;
                this.ready = new Promise(r => (this.resolveReady = r));
            }
        });
    }

    attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
        const key = ATTRS[name];
        if (!this.handle || !key || !RUNTIME.has(key)) return;
        const v = value === null ? (key === 'endpoint' ? null : 'off') : value;
        this.handle.setOption(key as never, v as never);
    }

    connect(endpoint?: string): boolean {
        return this.handle?.connect(endpoint) ?? false;
    }
    disconnect(): void {
        this.handle?.disconnect();
    }
}

export function defineElement(name = 'enig-term'): void {
    if (typeof customElements !== 'undefined' && !customElements.get(name)) customElements.define(name, EnigTermElement);
}

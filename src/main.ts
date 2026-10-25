// Standalone page: reads config.json (and URL overrides), mounts EnigTerm,
// and wires a minimal toolbar and key bar.
import { EnigTerm, type EnigTermOptions } from './terminal.js';
import { ESC } from './replies.js';

interface PageConfig extends EnigTermOptions {
    endpoint?: string;
    autoConnect?: boolean;
}

const CSI = ESC + '[';
const BAR_KEYS: Record<string, string> = {
    esc: ESC,
    tab: '\t',
    up: CSI + 'A',
    down: CSI + 'B',
    right: CSI + 'C',
    left: CSI + 'D',
};

async function readConfig(): Promise<PageConfig> {
    let cfg: PageConfig = {};
    try {
        const r = await fetch('config.json', { cache: 'no-store' });
        if (r.ok) cfg = await r.json();
    } catch {
        /* no config: defaults */
    }
    const q = new URLSearchParams(location.search);
    const flag = (k: string) => (q.has(k) ? q.get(k) !== '0' : undefined);
    return {
        ...cfg,
        endpoint: q.get('endpoint') ?? cfg.endpoint,
        autoConnect: flag('connect') ?? cfg.autoConnect,
        aspect: flag('aspect') ?? cfg.aspect,
        crt: flag('crt') ?? cfg.crt,
        sharp: flag('sharp') ?? cfg.sharp,
        blink: flag('blink') ?? cfg.blink,
        renderer: (q.get('renderer') as 'webgl2' | '2d' | null) ?? cfg.renderer,
        cols: q.has('cols') ? Number(q.get('cols')) : cfg.cols,
        rows: q.has('rows') ? Number(q.get('rows')) : cfg.rows,
    };
}

async function main(): Promise<void> {
    const cfg = await readConfig();
    const statusEl = document.querySelector<HTMLElement>('[data-status]')!;
    const endpointEl = document.querySelector<HTMLInputElement>('[data-endpoint]')!;
    const connectBtn = document.querySelector<HTMLButtonElement>('[data-act="connect"]')!;
    endpointEl.value = cfg.endpoint ?? '';

    const term = await EnigTerm.create(document.querySelector<HTMLElement>('[data-term]')!, {
        ...cfg,
        onStatus: (state, detail) => {
            statusEl.dataset.state = state;
            statusEl.textContent = detail ? `${state}: ${detail}` : state;
            connectBtn.textContent = state === 'connected' || state === 'connecting' ? 'Disconnect' : 'Connect';
        },
    });
    (window as unknown as { enigTerm: EnigTerm }).enigTerm = term;
    document.body.dataset.renderer = term.renderer.kind;

    const toggle = (act: string, get: () => boolean, set: (v: boolean) => void) => {
        const b = document.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
        const sync = () => b.setAttribute('aria-pressed', String(get()));
        b.addEventListener('click', () => {
            set(!get());
            sync();
        });
        sync();
    };
    toggle('aspect', () => term.aspect, v => term.setAspect(v));
    toggle('crt', () => term.crt, v => term.setCrt(v));
    toggle('sharp', () => term.sharp, v => term.setSharp(v));
    const keys = document.querySelector<HTMLElement>('[data-keys]')!;
    toggle('keys', () => !keys.hidden, v => (keys.hidden = !v));

    connectBtn.addEventListener('click', () => {
        if (term.connected) term.disconnect();
        else if (endpointEl.value) term.connect(endpointEl.value);
    });
    keys.addEventListener('pointerdown', ev => {
        const k = (ev.target as HTMLElement).closest<HTMLElement>('[data-key]');
        if (!k) return;
        ev.preventDefault(); // keep focus (and the soft keyboard) on the terminal
        term.sendText(BAR_KEYS[k.dataset.key!] ?? '');
        term.input.focus();
    });

    if (cfg.autoConnect && cfg.endpoint) term.connect(cfg.endpoint);
    document.body.dataset.ready = '1';
}

main().catch(e => {
    console.error(e);
    document.body.dataset.ready = 'error';
});

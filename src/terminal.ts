// Terminal: ties the WASM core, the output pass, Telnet-over-WebSocket and
// input together. No chrome (that is ui.ts); framework-free.
import { CRT_DEFAULTS, type CrtSettings } from './crt.ts';
import { EngineCore, loadCore, type TrapInfo } from './core.ts';
import { checkEndpoint, type Options } from './config.ts';
import { charsetForFont, chunk, encode, fromLatin1, latin1, type Charset } from './encoding.ts';
import { Input } from './input.ts';
import { checkLink } from './links.ts';
import { CSI, replyFor, type CoreEvent } from './replies.ts';
import { createRenderer, type Renderer } from './renderer.ts';
import { ScrollbackView } from './scrollback.ts';
import { contains, normalize, selectionText, wordAt, type CellPos, type SelRange } from './selection.ts';
import { TelnetClient } from './telnet.ts';

export type ConnState = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export interface TermEvents {
    state: { state: ConnState; detail: string; endpoint: string | null; reconnectInMs?: number };
    title: { title: string };
    bell: Record<string, never>;
    /** An OSC 8 link was activated. Call preventDefault() to handle it yourself (no confirmation). */
    link: { url: string; allowed: boolean; reason?: string; preventDefault(): void; defaultPrevented: boolean };
    notice: { level: 'info' | 'warn' | 'error'; text: string };
    /** The engine trapped and was replaced. */
    recovered: TrapInfo;
    /** The scrollback view moved (0 = live). */
    scroll: { offset: number; lines: number };
    selection: { text: string | null };
}
export type TermEventName = keyof TermEvents;
type Listener<K extends TermEventName> = (ev: TermEvents[K]) => void;

export class Emitter {
    private map = new Map<string, Set<(ev: unknown) => void>>();
    on<K extends TermEventName>(name: K, fn: Listener<K>): () => void {
        let set = this.map.get(name);
        if (!set) this.map.set(name, (set = new Set()));
        set.add(fn as (ev: unknown) => void);
        return () => set!.delete(fn as (ev: unknown) => void);
    }
    emit<K extends TermEventName>(name: K, ev: TermEvents[K]): void {
        for (const fn of this.map.get(name) ?? []) {
            try {
                fn(ev);
            } catch (e) {
                console.error(`enig-term: ${name} listener failed`, e);
            }
        }
    }
}

export interface TestHooks {
    /** Refuse NAWS (makes ENiGMA fall back to CSI 255 n). */
    naws?: boolean;
    /** Answer DA as CTerm. */
    debugCtermDa?: boolean;
    /** Let CSI ? 2026 h reach the engine, which panics: exercises recovery. */
    debugPanic?: boolean;
}

export interface FrameStats {
    kind: number;
    rows: [number, number];
    engineMs: number;
    uploadMs: number;
    drawMs: number;
}

// Blink rates of VGA text mode, which CTerm/SyncTERM emulate: the character
// blink attribute toggles every 16 frames of the 70 Hz refresh, the cursor
// every 8.
export const TEXT_BLINK_MS = Math.round((16 * 1000) / 70);
export const CURSOR_BLINK_MS = Math.round((8 * 1000) / 70);

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const STABLE_MS = 10_000;
const PASTE_CHUNK = 256;
const REPLY_BURST = 8;
const PASTE_GAP_MS = 10;

export class Terminal {
    readonly el: HTMLElement;
    readonly canvas: HTMLCanvasElement;
    readonly core: EngineCore;
    readonly renderer: Renderer;
    readonly input: Input;
    readonly scroll: ScrollbackView;
    readonly events = new Emitter();
    /** Requests seen and replies sent, newest last (diagnostics and tests). Bounded. */
    readonly log: string[] = [];
    lastFrame: FrameStats | null = null;
    stats = { bytesIn: 0, bytesOut: 0, feedMs: 0, frames: 0 };

    opts: Options;
    crtSettings: CrtSettings;
    charset: Charset = 'cp437';
    state: ConnState = 'idle';
    title = '';

    private ws: WebSocket | null = null;
    private telnet: TelnetClient | null = null;
    private endpoint: string | null = null;
    private userClosed = false;
    private reconnectTimer = 0;
    private reconnectDelay = RECONNECT_MIN_MS;
    private needsDraw = true;
    private raf = 0;
    private textBlinkOn = true;
    private cursorOn = true;
    private devW = 0;
    private devH = 0;
    private fullscreen = false;
    private readonly t0 = performance.now();
    private lastFont = 0;
    private sel: { anchor: CellPos; head: CellPos } | null = null;
    private selPushed = 0;
    private pasteQueue: Uint8Array[] = [];
    private pasteTimer = 0;
    private hoverLink = '';
    private readonly ro: ResizeObserver[] = [];
    private destroyed = false;
    /** When not connected, host-bound bytes go here (tests, local echo). */
    onLocalReply: ((bytes: Uint8Array) => void) | null = null;

    static async create(el: HTMLElement, opts: Options, hooks: TestHooks = {}, wasmUrl?: string | URL): Promise<Terminal> {
        await loadCore(wasmUrl);
        return new Terminal(el, opts, hooks);
    }

    private constructor(
        el: HTMLElement,
        opts: Options,
        private readonly hooks: TestHooks,
    ) {
        this.el = el;
        this.opts = { ...opts };
        this.crtSettings = { ...CRT_DEFAULTS };
        this.core = new EngineCore({
            cols: opts.cols,
            rows: opts.rows,
            scrollback: opts.scrollback,
            scrollbackOnClear: opts.scrollbackOnClear,
            debugPanic: hooks.debugPanic,
        });
        this.core.onTrap = info => this.onTrap(info);
        this.core.onRebuilt = () => this.onRebuilt();
        this.core.onEvents = evs => evs.forEach(ev => this.onEvent(ev));

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'screen';
        this.canvas.setAttribute('role', 'img');
        this.canvas.setAttribute('aria-label', 'Terminal screen');
        el.appendChild(this.canvas);
        this.renderer = createRenderer(this.canvas, opts.renderer);
        this.input = new Input(el, {
            send: s => this.sendText(s),
            paste: t => this.paste(t),
            shortcut: e => this.shortcut(e),
            willSend: () => this.scroll.toLive(),
            backspace: () => this.opts.backspace,
        });
        this.scroll = new ScrollbackView(() => this.core.core);
        this.scroll.onChange = offset => {
            this.clearSelection();
            this.needsDraw = true;
            this.events.emit('scroll', { offset, lines: this.core.call(c => c.scrollback_len(), 0) });
        };
        this.bindPointer();

        // Device-pixel sizing: the exact device box where the browser reports it
        // (Chromium, Firefox); contentBox x devicePixelRatio elsewhere (Safari).
        const ro = new ResizeObserver(entries => {
            for (const e of entries) {
                const dp = e.devicePixelContentBoxSize?.[0];
                if (dp) this.setDeviceSize(dp.inlineSize, dp.blockSize);
                else {
                    const cb = e.contentBoxSize?.[0];
                    const dpr = window.devicePixelRatio || 1;
                    if (cb) this.setDeviceSize(Math.round(cb.inlineSize * dpr), Math.round(cb.blockSize * dpr));
                }
            }
        });
        try {
            ro.observe(this.canvas, { box: 'device-pixel-content-box' });
        } catch {
            ro.observe(this.canvas);
        }
        const ro2 = new ResizeObserver(() => this.layout());
        ro2.observe(el);
        this.ro.push(ro, ro2);
        window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.('change', () => this.layout());

        this.renderFrame(true);
        this.layout();
        this.loop();
    }

    // --- options ----------------------------------------------------------------

    /** Change a display or behaviour option at run time. */
    set<K extends keyof Options>(key: K, value: Options[K]): void {
        this.opts[key] = value;
        switch (key) {
            case 'aspect':
            case 'scale':
                this.layout();
                break;
            case 'crt':
            case 'sharp':
                this.needsDraw = true;
                break;
            case 'scrollback':
                this.core.setScrollback(value as number);
                break;
            case 'scrollbackOnClear':
                this.core.call(c => c.set_capture_on_clear(value as boolean), undefined);
                break;
            case 'blink':
                if (!value) {
                    this.textBlinkOn = this.cursorOn = true;
                    this.core.call(c => c.set_blink(true), undefined);
                }
                this.needsDraw = true;
                break;
            case 'autoReconnect':
                if (!value) this.cancelReconnect();
                break;
            default:
                break;
        }
    }

    // --- geometry ------------------------------------------------------------

    /** Vertical stretch for 4:3: an 80x25 frame of this cell size fills a 4:3 screen. */
    get yStretch(): number {
        if (!this.opts.aspect) return 1;
        const cw = this.core.call(c => c.cell_width(), 8);
        const ch = this.core.call(c => c.cell_height(), 16);
        return ((80 * cw) / (25 * ch)) * 0.75;
    }

    setFullscreen(on: boolean): void {
        this.fullscreen = on;
        this.layout();
    }

    /** Size the canvas so its CSS size times DPR is a whole number of device pixels. */
    layout(): void {
        if (this.destroyed) return;
        const fw = this.core.call(c => c.frame_width(), 0) || 640;
        const fh = this.core.call(c => c.frame_height(), 0) || 400;
        const dpr = window.devicePixelRatio || 1;
        const stretch = this.yStretch;
        const displayAspect = fw / (fh * stretch);
        const availW = this.el.clientWidth || fw;
        const fitH = this.fullscreen || this.el.dataset.fit === 'both';
        const availH = fitH && this.el.clientHeight > 0 ? this.el.clientHeight : Infinity;
        let devW: number;
        let devH: number;
        if (this.opts.scale === 'integer') {
            // Whole device pixels per source pixel across; height follows the aspect.
            const maxW = Math.min(availW * dpr, availH * dpr * displayAspect);
            const k = Math.floor(maxW / fw);
            if (k >= 1) {
                devW = fw * k;
                devH = Math.round(fh * k * stretch);
            } else {
                devW = Math.max(1, Math.floor(maxW));
                devH = Math.max(1, Math.round(devW / displayAspect));
            }
        } else {
            const cssW = Math.min(availW, availH * displayAspect);
            devW = Math.max(1, Math.floor(cssW * dpr));
            devH = Math.max(1, Math.round(devW / displayAspect));
        }
        this.canvas.style.width = `${devW / dpr}px`;
        this.canvas.style.height = `${devH / dpr}px`;
        // Set the backing store now; the device-pixel ResizeObserver corrects it if needed.
        this.setDeviceSize(devW, devH);
    }

    private setDeviceSize(w: number, h: number): void {
        if (w === this.devW && h === this.devH) return;
        this.devW = w;
        this.devH = h;
        this.canvas.width = w;
        this.canvas.height = h;
        this.needsDraw = true;
    }

    // --- frame loop ------------------------------------------------------------

    private loop = (): void => {
        if (this.destroyed) return;
        this.raf = requestAnimationFrame(this.loop);
        const now = performance.now() - this.t0;
        if (this.opts.blink) {
            const text = Math.floor(now / TEXT_BLINK_MS) % 2 === 0;
            if (text !== this.textBlinkOn) {
                this.textBlinkOn = text;
                this.core.call(c => c.set_blink(text), undefined);
                this.needsDraw = true;
            }
            const blinking = this.core.call(c => c.cursor_blinking(), true);
            const cur = !blinking || Math.floor(now / CURSOR_BLINK_MS) % 2 === 0;
            if (cur !== this.cursorOn) {
                this.cursorOn = cur;
                this.needsDraw = true;
            }
        }
        if (this.sel && this.scroll.offset === 0) {
            // Live output scrolled the selected text away: drop the selection.
            const pushed = this.core.call(c => c.lines_pushed(), 0);
            if (pushed !== this.selPushed) this.clearSelection();
        }
        const animated = this.opts.crt && this.crtSettings.noise;
        if (this.core.call(c => c.has_changes(), false) || this.needsDraw || animated) this.renderFrame(false);
    };

    /** Render and draw now. Returns timings (engine raster, upload, draw). */
    renderFrame(full: boolean): FrameStats {
        const t0 = performance.now();
        const r = this.core.render(full);
        const t1 = performance.now();
        if (r.kind && r.pixels) {
            this.renderer.upload(r.pixels, r.frameW, r.frameH, r.y, r.h);
            if (r.kind === 2) this.layout();
        }
        const t2 = performance.now();
        this.draw();
        const t3 = performance.now();
        this.needsDraw = false;
        this.stats.frames++;
        const rows: [number, number] = this.core.call(c => [c.rendered_row_start(), c.rendered_row_end()] as [number, number], [0, 0]);
        this.lastFrame = { kind: r.kind, rows, engineMs: t1 - t0, uploadMs: t2 - t1, drawMs: t3 - t2 };
        return this.lastFrame;
    }

    private draw(): void {
        const cw = this.core.call(c => c.cell_width(), 8);
        const ch = this.core.call(c => c.cell_height(), 16);
        let cursor = null;
        const visible = this.core.call(c => c.cursor_visible(), false);
        if (visible && this.scroll.offset === 0 && (this.cursorOn || !this.opts.blink)) {
            const x = this.core.call(c => c.cursor_x(), 0) * cw;
            const y = this.core.call(c => c.cursor_y(), 0) * ch;
            const shape = this.core.call(c => c.cursor_shape(), 0);
            if (shape === 1) cursor = { x, y: y + ch - Math.max(2, ch >> 3), w: cw, h: Math.max(2, ch >> 3) };
            else if (shape === 2) cursor = { x, y, w: Math.max(1, cw >> 3), h: ch };
            else cursor = { x, y, w: cw, h: ch };
        }
        this.renderer.draw({
            rect: { x: 0, y: 0, w: this.devW, h: this.devH },
            cursor,
            selection: this.selection,
            cell: { w: cw, h: ch },
            sharp: this.opts.sharp,
            crt: this.opts.crt,
            crtSettings: this.crtSettings,
            timeSec: (performance.now() - this.t0) / 1000,
        });
    }

    // --- data in ---------------------------------------------------------------

    /** Feed terminal data (already Telnet-decoded) and answer any host requests. */
    write(bytes: Uint8Array | string): void {
        const b = typeof bytes === 'string' ? fromLatin1(bytes) : bytes;
        const t = performance.now();
        const events = this.core.feed(b);
        this.stats.feedMs += performance.now() - t;
        this.stats.bytesIn += b.length;
        for (const ev of events) this.onEvent(ev);
    }

    private logLine(s: string): void {
        this.log.push(s);
        if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    }

    private onEvent(ev: CoreEvent): void {
        switch (ev.t) {
            case 'req': {
                if (!this.replyAllowed(ev.k)) {
                    this.logLine(`req ${JSON.stringify(ev)} -> (suppressed: answer loop?)`);
                    break;
                }
                const reply = replyFor(ev, {
                    debugCtermDa: this.hooks.debugCtermDa,
                    links: true,
                    lastColumnFlag: this.core.call(c => c.last_column_flag(), false),
                });
                this.logLine(`req ${JSON.stringify(ev)} -> ${reply === null ? '(none)' : JSON.stringify(reply)}`);
                if (reply !== null) this.sendRaw(fromLatin1(reply));
                break;
            }
            case 'font':
                this.logLine(`font ${ev.font} ok=${ev.ok}`);
                if (ev.ok) {
                    this.lastFont = ev.font;
                    this.charset = charsetForFont(ev.font);
                }
                this.layout();
                break;
            case 'bell':
                this.events.emit('bell', {});
                break;
            case 'title':
                this.title = ev.text;
                this.events.emit('title', { title: ev.text });
                break;
            case 'apc':
            case 'music':
                break; // audio is not in this build
            default:
                this.logLine(`${ev.t} ${JSON.stringify(ev)}`);
        }
    }

    /**
     * Answer-loop guard. A host that echoes what it receives (a line editor
     * before login, a misconfigured door) turns some replies into new
     * requests: our CTDA answer `CSI < 0;1;2;3;5 c` parses as another CTDA
     * request. Answer each kind of request at most REPLY_BURST times per
     * second; the rest are logged and dropped.
     */
    private replyAllowed(kind: string): boolean {
        const now = performance.now();
        const w = this.replyWindow.get(kind);
        if (!w || now - w.start > 1000) {
            this.replyWindow.set(kind, { start: now, n: 1 });
            return true;
        }
        return ++w.n <= REPLY_BURST;
    }
    private readonly replyWindow = new Map<string, { start: number; n: number }>();

    // --- engine recovery -------------------------------------------------------

    private onTrap(info: TrapInfo): void {
        this.logLine(`engine trap: ${info.message} (recovered: ${info.recovered})`);
        if (info.recovered) {
            this.events.emit('recovered', info);
            this.events.emit('notice', {
                level: 'warn',
                text: 'The terminal engine hit an error and was restarted. The screen was cleared; the connection is still open.',
            });
        } else {
            this.events.emit('notice', { level: 'error', text: 'The terminal engine failed repeatedly. Reload the page to continue.' });
            this.disconnect();
        }
    }

    private onRebuilt(): void {
        // Keep the font the host selected, so its output keeps rendering right.
        if (this.lastFont) this.core.feed(fromLatin1(`${CSI}0;${this.lastFont} D`));
        this.clearSelection();
        this.renderFrame(true);
        this.layout();
    }

    // --- data out --------------------------------------------------------------

    sendText(text: string): void {
        this.sendRaw(encode(text, this.charset));
    }

    /** Bytes for the host. They are Telnet-escaped when connected. */
    sendRaw(bytes: Uint8Array): void {
        this.stats.bytesOut += bytes.length;
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(TelnetClient.escape(bytes));
        else this.onLocalReply?.(bytes);
    }

    /** Paste text: encoded like typing (CP437, or Latin-1 under an Amiga font) and sent in chunks. */
    paste(text: string): void {
        if (!text) return;
        this.scroll.toLive();
        const bytes = encode(text.replace(/\r\n?/g, '\n'), this.charset);
        this.pasteQueue.push(...chunk(bytes, PASTE_CHUNK));
        if (!this.pasteTimer) this.pumpPaste();
    }

    private pumpPaste = (): void => {
        const next = this.pasteQueue.shift();
        if (!next) {
            this.pasteTimer = 0;
            return;
        }
        this.sendRaw(next);
        this.pasteTimer = window.setTimeout(this.pumpPaste, PASTE_GAP_MS);
    };

    // --- keyboard shortcuts ------------------------------------------------------

    private shortcut(e: KeyboardEvent): boolean {
        if (e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
            this.scroll.page(e.key === 'PageUp' ? 1 : -1);
            return true;
        }
        const k = e.key.toLowerCase();
        if (e.ctrlKey && e.shiftKey && !e.altKey && k === 'c') {
            void this.copySelection();
            return true;
        }
        if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'c' && this.sel) {
            // With a selection, Ctrl+C copies; without one it is ^C for the host.
            void this.copySelection();
            return true;
        }
        if (e.ctrlKey && !e.altKey && k === 'insert') {
            void this.copySelection();
            return true;
        }
        if ((e.ctrlKey && e.shiftKey && !e.altKey && k === 'v') || (e.shiftKey && !e.ctrlKey && k === 'insert')) {
            void this.pasteFromClipboard();
            return true;
        }
        if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return false;
        if (this.sel && !e.metaKey) this.clearSelection();
        return false;
    }

    // --- selection, copy, links ----------------------------------------------------

    get selection(): SelRange | null {
        return this.sel ? normalize(this.sel.anchor, this.sel.head) : null;
    }

    select(anchor: CellPos, head: CellPos): void {
        this.sel = { anchor, head };
        this.selPushed = this.core.call(c => c.lines_pushed(), 0);
        this.needsDraw = true;
    }

    clearSelection(): void {
        if (!this.sel) return;
        this.sel = null;
        this.needsDraw = true;
        this.events.emit('selection', { text: null });
    }

    selectionText(): string | null {
        const r = this.selection;
        if (!r) return null;
        const cols = this.core.cols;
        return selectionText(r, y => this.core.call(c => c.row_cells(y), new Uint32Array(cols)), cols);
    }

    /** Copy the selection to the clipboard. Returns false (and emits a notice) if that was refused. */
    async copySelection(): Promise<boolean> {
        const text = this.selectionText();
        if (!text) return false;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('no async clipboard');
            await navigator.clipboard.writeText(text);
            this.events.emit('notice', { level: 'info', text: 'Copied' });
            return true;
        } catch {
            // Fall back to a copy command on the textarea (works in a user gesture).
            const ta = this.input.textarea;
            const prev = ta.value;
            try {
                ta.value = text;
                ta.select();
                const ok = document.execCommand?.('copy');
                if (ok) {
                    this.events.emit('notice', { level: 'info', text: 'Copied' });
                    return true;
                }
            } catch {
                /* fall through */
            } finally {
                ta.value = prev;
            }
            this.events.emit('notice', { level: 'warn', text: 'The browser refused clipboard access. Select the text and use your browser’s copy command.' });
            return false;
        }
    }

    async pasteFromClipboard(): Promise<void> {
        try {
            if (!navigator.clipboard?.readText) throw new Error('no async clipboard');
            this.paste(await navigator.clipboard.readText());
        } catch {
            this.events.emit('notice', { level: 'warn', text: 'The browser refused clipboard access. Use your browser’s paste command (Ctrl+V or Cmd+V).' });
        }
        this.input.focus();
    }

    /** The cell under a client (CSS pixel) point, or null outside the screen. */
    cellAt(clientX: number, clientY: number): CellPos | null {
        const r = this.canvas.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        const fx = (clientX - r.left) / r.width;
        const fy = (clientY - r.top) / r.height;
        if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return null;
        const cols = this.core.cols;
        const rows = this.core.rows;
        return { x: Math.min(cols - 1, Math.floor(fx * cols)), y: Math.min(rows - 1, Math.floor(fy * rows)) };
    }

    linkAt(cell: CellPos | null): string {
        if (!cell) return '';
        return this.core.call(c => c.link_at(cell.x, cell.y), '');
    }

    /** Activate a link: emits 'link' (cancelable); the UI then asks before opening. */
    activateLink(url: string): void {
        const check = checkLink(url, this.opts.linkSchemes);
        let prevented = false;
        const ev = {
            url: check.href,
            allowed: check.ok,
            reason: check.reason,
            preventDefault: () => (prevented = true),
            get defaultPrevented() {
                return prevented;
            },
        };
        this.events.emit('link', ev);
        if (prevented) return;
        this.onLinkRequest?.(check.href, check.ok, check.reason);
    }

    /** Set by the UI: show the confirmation for a link. */
    onLinkRequest: ((href: string, allowed: boolean, reason?: string) => void) | null = null;

    /** Open a link the user confirmed. */
    openLink(href: string): void {
        const check = checkLink(href, this.opts.linkSchemes);
        if (!check.ok) return;
        const w = window.open(check.href, '_blank', 'noopener,noreferrer');
        if (w) w.opener = null;
    }

    private bindPointer(): void {
        const cv = this.canvas;
        let down: { id: number; type: string; x: number; y: number; cell: CellPos | null; moved: boolean; mode: 'none' | 'select' | 'scroll'; lastY: number; timer: number } | null = null;
        let clicks = 0;
        let lastClick = 0;
        const linePx = () => cv.getBoundingClientRect().height / Math.max(1, this.core.rows);

        cv.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            const cell = this.cellAt(e.clientX, e.clientY);
            const now = performance.now();
            clicks = now - lastClick < 400 ? clicks + 1 : 1;
            lastClick = now;
            down = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, cell, moved: false, mode: 'none', lastY: e.clientY, timer: 0 };
            if (e.pointerType === 'mouse') {
                if (cell && clicks >= 2) {
                    const cells = this.core.call(c => c.row_cells(cell.y), new Uint32Array(0));
                    if (clicks === 2) {
                        const [a, b] = wordAt(cells, cell.x);
                        this.select({ x: a, y: cell.y }, { x: b, y: cell.y });
                    } else this.select({ x: 0, y: cell.y }, { x: this.core.cols - 1, y: cell.y });
                    down.mode = 'none';
                    down.moved = true;
                    e.preventDefault();
                    return;
                }
                down.mode = 'select';
                try {
                    cv.setPointerCapture(e.pointerId);
                } catch {
                    /* not capturable */
                }
            } else {
                // Touch: drag scrolls back; a long press starts a selection.
                const d = down;
                d.timer = window.setTimeout(() => {
                    if (d.moved || !d.cell) return;
                    d.mode = 'select';
                    this.select(d.cell, d.cell);
                    navigator.vibrate?.(10);
                }, 450);
            }
        });
        cv.addEventListener('pointermove', e => {
            if (!down || e.pointerId !== down.id) {
                // Hover: show that a link is clickable.
                if (e.pointerType === 'mouse') {
                    const url = this.linkAt(this.cellAt(e.clientX, e.clientY));
                    if (url !== this.hoverLink) {
                        this.hoverLink = url;
                        cv.style.cursor = url ? 'pointer' : '';
                        if (url) cv.title = url;
                        else cv.removeAttribute('title');
                    }
                }
                return;
            }
            const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
            if (dist > 6) down.moved = true;
            if (down.mode === 'select') {
                const cell = this.cellAt(e.clientX, e.clientY) ?? this.clampCell(e.clientX, e.clientY);
                if (down.cell && down.moved) this.select(down.cell, cell);
            } else if (down.type !== 'mouse' && down.moved) {
                clearTimeout(down.timer);
                down.mode = 'scroll';
                this.scroll.drag(e.clientY - down.lastY, linePx());
                down.lastY = e.clientY;
                e.preventDefault();
            }
        });
        const end = (e: PointerEvent) => {
            if (!down || e.pointerId !== down.id) return;
            clearTimeout(down.timer);
            const d = down;
            down = null;
            if (d.moved) {
                if (this.sel) this.events.emit('selection', { text: this.selectionText() });
                return;
            }
            if (d.mode === 'select' && this.sel && d.type !== 'mouse') {
                this.events.emit('selection', { text: this.selectionText() });
                return;
            }
            // A tap or click without a drag.
            this.clearSelection();
            const url = this.linkAt(d.cell);
            if (url) this.activateLink(url);
            this.input.focus(); // raises the soft keyboard on touch devices (a user gesture)
        };
        cv.addEventListener('pointerup', end);
        // A press on the canvas must not take focus from the input: touch
        // devices send compatibility mouse events after pointerup, and a
        // mousedown on a non-focusable element would blur the textarea (and
        // drop the soft keyboard) right after we focused it.
        cv.addEventListener('mousedown', e => e.preventDefault());
        cv.addEventListener('pointercancel', e => {
            if (down && e.pointerId === down.id) {
                clearTimeout(down.timer);
                down = null;
            }
        });
        cv.addEventListener(
            'wheel',
            e => {
                const lines = this.core.call(c => c.scrollback_len(), 0);
                if (!lines) return;
                e.preventDefault();
                this.scroll.wheel(e.deltaY, e.deltaMode, linePx());
            },
            { passive: false },
        );
        // Touch scrolling of the page must not steal the drag.
        cv.style.touchAction = 'none';
    }

    private clampCell(clientX: number, clientY: number): CellPos {
        const r = this.canvas.getBoundingClientRect();
        const cols = this.core.cols;
        const rows = this.core.rows;
        const x = Math.floor(((clientX - r.left) / Math.max(1, r.width)) * cols);
        const y = Math.floor(((clientY - r.top) / Math.max(1, r.height)) * rows);
        return { x: Math.max(0, Math.min(cols - 1, x)), y: Math.max(0, Math.min(rows - 1, y)) };
    }

    isSelected(x: number, y: number): boolean {
        const r = this.selection;
        return !!r && contains(r, x, y);
    }

    // --- connection --------------------------------------------------------------

    private setState(state: ConnState, detail = '', reconnectInMs?: number): void {
        this.state = state;
        this.events.emit('state', { state, detail, endpoint: this.endpoint, reconnectInMs });
    }

    /** Connect to `endpoint` (or the configured one). Rejects anything but wss:// (ws:// on loopback). */
    connect(endpoint?: string | null): boolean {
        const target = endpoint ?? this.endpoint ?? this.opts.endpoint;
        if (!target) {
            this.setState('error', 'no host given');
            return false;
        }
        const check = checkEndpoint(target, this.opts.allowInsecure);
        if (!check.ok) {
            this.endpoint = check.url;
            this.setState('error', check.reason ?? 'invalid address');
            return false;
        }
        if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
            if (this.endpoint === check.url) return true;
            this.disconnect();
        }
        this.cancelReconnect();
        this.endpoint = check.url;
        this.userClosed = false;
        this.open(check.url, false);
        return true;
    }

    private open(url: string, isRetry: boolean): void {
        if (!isRetry) {
            this.core.call(c => c.reset(), undefined);
            this.charset = 'cp437';
            this.lastFont = 0;
            this.scroll.toLive();
        }
        const telnet = new TelnetClient({
            termType: this.opts.termType,
            getSize: () => ({ cols: this.core.cols, rows: this.core.rows }),
            naws: this.hooks.naws ?? true,
        });
        telnet.onLog = m => this.logLine(`telnet ${m}`);
        this.telnet = telnet;
        this.setState('connecting', url);
        let ws: WebSocket;
        try {
            ws = new WebSocket(url, 'telnet');
        } catch (e) {
            this.setState('error', String((e as Error)?.message ?? e));
            return;
        }
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        let openedAt = 0;
        ws.onopen = () => {
            if (ws !== this.ws) return;
            openedAt = performance.now();
            this.setState('connected', url);
            this.input.focus();
        };
        ws.onmessage = ev => {
            if (ws !== this.ws) return;
            if (!(ev.data instanceof ArrayBuffer)) return;
            const { data, reply } = telnet.receive(new Uint8Array(ev.data));
            if (reply.length && ws.readyState === WebSocket.OPEN) ws.send(reply);
            if (data.length) this.write(data);
        };
        let errored = false;
        ws.onerror = () => {
            errored = true;
        };
        ws.onclose = ev => {
            if (ws !== this.ws) return;
            this.ws = null;
            this.telnet = null;
            // A session that lasted resets the backoff; a host that accepts and
            // drops at once keeps backing off.
            if (openedAt && performance.now() - openedAt > STABLE_MS) this.reconnectDelay = RECONNECT_MIN_MS;
            if (this.userClosed) {
                this.setState('closed', 'disconnected');
                return;
            }
            const why = errored && ev.code === 1006 ? 'could not connect' : ev.code === 1000 || ev.code === 1005 ? 'the host closed the connection' : `connection lost (${ev.code})`;
            if (this.opts.autoReconnect) this.scheduleReconnect(why);
            else this.setState(errored ? 'error' : 'closed', why);
        };
    }

    private scheduleReconnect(why: string): void {
        // Exponential backoff with jitter, capped; reset after a good connection.
        const delay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay) * (0.8 + Math.random() * 0.4);
        this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
        this.setState('closed', why, Math.round(delay));
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = 0;
            if (this.endpoint && !this.userClosed) this.open(this.endpoint, true);
        }, delay);
    }

    private cancelReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = 0;
        }
    }

    disconnect(): void {
        this.userClosed = true;
        this.cancelReconnect();
        if (this.ws) this.ws.close(1000, 'user');
        else if (this.state === 'connecting' || this.state === 'connected') this.setState('closed', 'disconnected');
    }

    get connected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    get currentEndpoint(): string | null {
        return this.endpoint ?? this.opts.endpoint;
    }

    /** Change the terminal geometry and tell the host (NAWS). */
    resize(cols: number, rows: number): void {
        this.core.resize(cols, rows);
        this.opts.cols = cols;
        this.opts.rows = rows;
        const naws = this.telnet?.buildResize();
        if (naws && this.ws?.readyState === WebSocket.OPEN) this.ws.send(naws);
        this.clearSelection();
        this.renderFrame(true);
    }

    /** Show a SAUCE-tagged ANSI file locally. */
    showSauceArt(bytes: Uint8Array): Record<string, unknown> {
        const info = JSON.parse(this.core.call(c => c.load_sauce_art(bytes), '{}'));
        this.renderFrame(true);
        return info;
    }

    loadFont(slot: number, name: string, data: Uint8Array): string {
        const r = this.core.call(c => c.load_font(slot, name, data), '');
        this.renderFrame(true);
        return r;
    }

    destroy(): void {
        this.destroyed = true;
        cancelAnimationFrame(this.raf);
        this.disconnect();
        clearTimeout(this.pasteTimer);
        for (const r of this.ro) r.disconnect();
        this.core.destroy();
        this.el.replaceChildren();
    }

    /** Debug: bytes as a readable string. */
    static show(bytes: Uint8Array): string {
        return JSON.stringify(latin1(bytes));
    }
}

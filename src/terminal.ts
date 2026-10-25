// EnigTerm: ties the WASM core, the output pass, Telnet-over-WebSocket and
// input together. Framework-free; mount it into any element.
import { CRT_DEFAULTS, type CrtSettings } from './crt.js';
import { EngineCore, loadCore } from './core.js';
import { encode, latin1, fromLatin1, type Charset } from './encoding.js';
import { Input } from './input.js';
import { replyFor, type CoreEvent } from './replies.js';
import { createRenderer, type Renderer } from './renderer.js';
import { TelnetClient } from './telnet.js';

export interface EnigTermOptions {
    cols?: number;
    rows?: number;
    /** Display the frame at 4:3 (VGA 640x400 -> 1.2 vertical stretch). Default on. */
    aspect?: boolean;
    crt?: boolean;
    crtSettings?: Partial<CrtSettings>;
    /** Sharp-bilinear (default) or plain bilinear sampling. */
    sharp?: boolean;
    renderer?: 'webgl2' | '2d';
    termType?: string;
    /** Blink the cursor and blinking text. Off for deterministic screenshots. */
    blink?: boolean;
    wasmUrl?: string;
    onStatus?: (state: string, detail?: string) => void;
}

export interface FrameStats {
    kind: number;
    rows: [number, number];
    engineMs: number;
    uploadMs: number;
    drawMs: number;
}

/** First SyncTERM font numbers that are Amiga (ISO-8859-1) fonts. */
const AMIGA_FONTS = new Set([37, 38, 39, 40, 41, 42]);

export class EnigTerm {
    readonly el: HTMLElement;
    readonly canvas: HTMLCanvasElement;
    readonly core: EngineCore;
    readonly renderer: Renderer;
    readonly input: Input;
    /** Requests seen and replies sent, newest last (for diagnostics and tests). */
    readonly log: string[] = [];
    lastFrame: FrameStats | null = null;
    stats = { bytesIn: 0, feedMs: 0, frames: 0 };

    aspect: boolean;
    crt: boolean;
    sharp: boolean;
    crtSettings: CrtSettings;
    blink: boolean;
    charset: Charset = 'cp437';

    private ws: WebSocket | null = null;
    private telnet: TelnetClient | null = null;
    private readonly termType: string;
    private readonly onStatus?: (state: string, detail?: string) => void;
    private needsDraw = true;
    private raf = 0;
    private cursorOn = true;
    private devW = 0;
    private devH = 0;
    private readonly t0 = performance.now();

    static async create(el: HTMLElement, opts: EnigTermOptions = {}): Promise<EnigTerm> {
        const memory = await loadCore(opts.wasmUrl);
        return new EnigTerm(el, memory, opts);
    }

    private constructor(el: HTMLElement, memory: WebAssembly.Memory, opts: EnigTermOptions) {
        this.el = el;
        el.classList.add('enig-term');
        this.core = new EngineCore(memory, opts.cols ?? 80, opts.rows ?? 25);
        this.aspect = opts.aspect ?? true;
        this.crt = opts.crt ?? false;
        this.sharp = opts.sharp ?? true;
        this.blink = opts.blink ?? true;
        this.crtSettings = { ...CRT_DEFAULTS, ...opts.crtSettings };
        this.termType = opts.termType ?? 'ansi-bbs';
        this.onStatus = opts.onStatus;

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'enig-term__screen';
        el.appendChild(this.canvas);
        this.renderer = createRenderer(this.canvas, opts.renderer ?? 'webgl2');
        this.input = new Input(el, s => this.sendText(s));

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
        new ResizeObserver(() => this.layout()).observe(el);
        window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.('change', () => this.layout());

        this.renderFrame(true);
        this.layout();
        this.loop();
    }

    // --- geometry ------------------------------------------------------------

    /** Vertical stretch for 4:3: an 80x25 frame of this cell size fills a 4:3 screen. */
    get yStretch(): number {
        if (!this.aspect) return 1;
        const cw = this.core.core.cell_width();
        const ch = this.core.core.cell_height();
        return ((80 * cw) / (25 * ch)) * 0.75;
    }

    /** Size the canvas so its CSS size times DPR is a whole number of device pixels. */
    layout(): void {
        const fw = this.core.core.frame_width() || 640;
        const fh = this.core.core.frame_height() || 400;
        const dpr = window.devicePixelRatio || 1;
        const displayAspect = fw / (fh * this.yStretch);
        const availW = this.el.clientWidth || fw;
        const availH = this.el.clientHeight > 0 && this.el.dataset.fit === 'both' ? this.el.clientHeight : Infinity;
        let cssW = Math.min(availW, availH * displayAspect);
        const devW = Math.max(1, Math.floor(cssW * dpr));
        const devH = Math.max(1, Math.round(devW / displayAspect));
        cssW = devW / dpr;
        const cssH = devH / dpr;
        this.canvas.style.width = `${cssW}px`;
        this.canvas.style.height = `${cssH}px`;
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
        this.raf = requestAnimationFrame(this.loop);
        const now = performance.now() - this.t0;
        if (this.blink) {
            const phase = Math.floor(now / 500) % 2 === 0;
            if (phase !== this.cursorOn) {
                this.cursorOn = phase;
                this.core.core.set_blink(phase);
                this.needsDraw = true;
            }
        }
        const animated = this.crt && this.crtSettings.noise;
        if (this.core.core.has_changes() || this.needsDraw || animated) this.renderFrame(false);
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
        const c = this.core.core;
        this.lastFrame = { kind: r.kind, rows: [c.rendered_row_start(), c.rendered_row_end()], engineMs: t1 - t0, uploadMs: t2 - t1, drawMs: t3 - t2 };
        return this.lastFrame;
    }

    private draw(): void {
        const c = this.core.core;
        let cursor = null;
        if (c.cursor_visible() && (this.cursorOn || !this.blink)) {
            const cw = c.cell_width();
            const ch = c.cell_height();
            const x = c.cursor_x() * cw;
            const y = c.cursor_y() * ch;
            const shape = c.cursor_shape();
            if (shape === 1) cursor = { x, y: y + ch - Math.max(2, ch >> 3), w: cw, h: Math.max(2, ch >> 3) };
            else if (shape === 2) cursor = { x, y, w: Math.max(1, cw >> 3), h: ch };
            else cursor = { x, y, w: cw, h: ch };
        }
        this.renderer.draw({
            rect: { x: 0, y: 0, w: this.devW, h: this.devH },
            cursor,
            sharp: this.sharp,
            crt: this.crt,
            crtSettings: this.crtSettings,
            timeSec: (performance.now() - this.t0) / 1000,
        });
    }

    setAspect(on: boolean): void {
        this.aspect = on;
        this.layout();
    }
    setCrt(on: boolean): void {
        this.crt = on;
        this.needsDraw = true;
    }
    setSharp(on: boolean): void {
        this.sharp = on;
        this.needsDraw = true;
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

    private onEvent(ev: CoreEvent): void {
        if (ev.t === 'req') {
            const reply = replyFor(ev);
            this.log.push(`req ${JSON.stringify(ev)} -> ${reply === null ? '(none)' : JSON.stringify(reply)}`);
            if (reply !== null) this.sendRaw(fromLatin1(reply));
        } else if (ev.t === 'font') {
            this.log.push(`font ${ev.font} ok=${ev.ok}`);
            if (ev.ok) this.charset = AMIGA_FONTS.has(ev.font) ? 'latin1' : 'cp437';
            this.layout();
        } else if (ev.t !== 'apc') {
            this.log.push(`${ev.t} ${JSON.stringify(ev)}`);
        }
    }

    // --- data out --------------------------------------------------------------

    sendText(text: string): void {
        this.sendRaw(encode(text, this.charset));
    }

    /** Bytes for the host. They are Telnet-escaped when connected. */
    sendRaw(bytes: Uint8Array): void {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(TelnetClient.escape(bytes));
        else this.onLocalReply?.(bytes);
    }

    /** When not connected, replies go here (tests). */
    onLocalReply: ((bytes: Uint8Array) => void) | null = null;

    // --- connection --------------------------------------------------------------

    connect(endpoint: string): void {
        if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
        this.core.core.reset();
        this.charset = 'cp437';
        const telnet = new TelnetClient({
            termType: this.termType,
            getSize: () => ({ cols: this.core.cols, rows: this.core.rows }),
        });
        telnet.onLog = m => this.log.push(`telnet ${m}`);
        this.telnet = telnet;
        this.onStatus?.('connecting', endpoint);
        let ws: WebSocket;
        try {
            ws = new WebSocket(endpoint, 'telnet');
        } catch (e) {
            this.onStatus?.('error', String(e));
            return;
        }
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.onopen = () => {
            this.onStatus?.('connected', endpoint);
            this.input.focus();
        };
        ws.onmessage = ev => {
            const { data, reply } = telnet.receive(new Uint8Array(ev.data as ArrayBuffer));
            if (reply.length && ws.readyState === WebSocket.OPEN) ws.send(reply);
            if (data.length) this.write(data);
        };
        ws.onerror = () => this.onStatus?.('error', 'connection error');
        ws.onclose = ev => {
            this.onStatus?.('closed', ev.code === 1000 ? 'disconnected' : `closed (${ev.code})`);
            this.ws = null;
        };
    }

    disconnect(): void {
        this.ws?.close(1000, 'user');
    }

    get connected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    /** Change the terminal geometry and tell the host (NAWS). */
    resize(cols: number, rows: number): void {
        this.core.core.resize(cols, rows);
        const naws = this.telnet?.buildResize();
        if (naws && this.ws?.readyState === WebSocket.OPEN) this.ws.send(naws);
        this.renderFrame(true);
    }

    /** Show a SAUCE-tagged ANSI file locally. */
    showSauceArt(bytes: Uint8Array): Record<string, unknown> {
        const info = JSON.parse(this.core.core.load_sauce_art(bytes));
        this.renderFrame(true);
        return info;
    }

    loadFont(slot: number, name: string, data: Uint8Array): string {
        const r = this.core.core.load_font(slot, name, data);
        this.renderFrame(true);
        return r;
    }

    destroy(): void {
        cancelAnimationFrame(this.raf);
        this.disconnect();
        this.core.core.free();
        this.el.replaceChildren();
    }

    /** Debug: the bytes of the last replies, readable. */
    static show(bytes: Uint8Array): string {
        return JSON.stringify(latin1(bytes));
    }
}

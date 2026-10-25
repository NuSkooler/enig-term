// Output pass: takes the engine's RGBA frame and draws it into the canvas at
// the requested rectangle (device pixels). WebGL2 is the main path; a 2D
// canvas fallback covers browsers or devices without it.
import { CRT_DEFAULTS, FRAG, MONITOR_TINTS, VERT, type CrtSettings } from './crt.js';

export interface DrawParams {
    /** Target rectangle inside the canvas, device pixels, origin top-left. */
    rect: { x: number; y: number; w: number; h: number };
    /** Cursor in source pixels, or null when hidden / in its off phase. */
    cursor: { x: number; y: number; w: number; h: number } | null;
    sharp: boolean;
    crt: boolean;
    crtSettings: CrtSettings;
    timeSec: number;
}

export interface Renderer {
    readonly kind: 'webgl2' | '2d';
    /** Upload a full frame (y = 0, h = frame height) or a horizontal band. */
    upload(pixels: Uint8Array, frameW: number, frameH: number, y: number, h: number): void;
    draw(p: DrawParams): void;
    /** GPU time is not measurable portably; this blocks until the GPU is done (for benchmarks). */
    finish(): void;
}

export function createRenderer(canvas: HTMLCanvasElement, prefer: 'webgl2' | '2d' = 'webgl2'): Renderer {
    if (prefer === 'webgl2') {
        const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
        if (gl) {
            try {
                return new GlRenderer(gl);
            } catch (e) {
                console.warn('enig-term: WebGL2 setup failed, using 2D canvas', e);
            }
        }
    }
    return new Canvas2dRenderer(canvas);
}

class GlRenderer implements Renderer {
    readonly kind = 'webgl2' as const;
    private readonly prog: WebGLProgram;
    private readonly tex: WebGLTexture;
    private readonly loc: Record<string, WebGLUniformLocation | null> = {};
    private texW = 0;
    private texH = 0;

    constructor(private readonly gl: WebGL2RenderingContext) {
        this.prog = link(gl, VERT, FRAG);
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        this.tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        // LINEAR is what sharp-bilinear needs; the shader keeps texel interiors flat.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const n = gl.getProgramParameter(this.prog, gl.ACTIVE_UNIFORMS) as number;
        for (let i = 0; i < n; i++) {
            const name = gl.getActiveUniform(this.prog, i)!.name;
            this.loc[name] = gl.getUniformLocation(this.prog, name);
        }
    }

    upload(px: Uint8Array, frameW: number, frameH: number, y: number, h: number): void {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        if (frameW !== this.texW || frameH !== this.texH) {
            const whole = y === 0 && h === frameH;
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, frameW, frameH, 0, gl.RGBA, gl.UNSIGNED_BYTE, whole ? px : null);
            this.texW = frameW;
            this.texH = frameH;
            if (whole) return;
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, frameW, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }

    draw(p: DrawParams): void {
        const gl = this.gl;
        const cw = gl.drawingBufferWidth;
        const ch = gl.drawingBufferHeight;
        gl.viewport(0, 0, cw, ch);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!this.texW) return;
        // GL's viewport origin is bottom-left.
        gl.viewport(p.rect.x, ch - p.rect.y - p.rect.h, p.rect.w, p.rect.h);
        gl.useProgram(this.prog);
        const u = this.loc;
        const s = p.crtSettings ?? CRT_DEFAULTS;
        gl.uniform1i(u.u_tex, 0);
        gl.uniform2f(u.u_src, this.texW, this.texH);
        gl.uniform2f(u.u_dst, p.rect.w, p.rect.h);
        gl.uniform1f(u.u_sharp, p.sharp ? 1 : 0);
        const c = p.cursor;
        gl.uniform4f(u.u_cursor, c?.x ?? 0, c?.y ?? 0, c?.w ?? 0, c?.h ?? 0);
        gl.uniform1f(u.u_time, p.timeSec);
        gl.uniform1f(u.u_crt, p.crt ? 1 : 0);
        // Mapping from icy's MonitorSettings to shader units (icy shader.rs).
        gl.uniform1f(u.u_brightness, s.brightness);
        gl.uniform1f(u.u_contrast, s.contrast);
        gl.uniform1f(u.u_gamma, s.gamma);
        gl.uniform1f(u.u_saturation, s.saturation);
        gl.uniform1f(u.u_monitor_type, { color: 0, gray: 1, amber: 2, green: 3 }[s.monitor]);
        gl.uniform3fv(u.u_monitor_tint, MONITOR_TINTS[s.monitor]);
        gl.uniform1f(u.u_enable_curvature, s.curvature ? 1 : 0);
        gl.uniform1f(u.u_curvature_x, s.curvature ? (100 - s.curvatureX) / 10 : 0);
        gl.uniform1f(u.u_curvature_y, s.curvature ? (100 - s.curvatureY) / 10 : 0);
        gl.uniform1f(u.u_enable_scanlines, s.scanlines ? 1 : 0);
        gl.uniform1f(u.u_scanline_thickness, s.scanlineThickness);
        gl.uniform1f(u.u_scanline_sharpness, s.scanlineSharpness);
        gl.uniform1f(u.u_scanline_phase, 0);
        gl.uniform1f(u.u_enable_noise, s.noise ? 1 : 0);
        gl.uniform1f(u.u_noise_level, s.noise ? Math.min(1, s.noiseLevel / 100) : 0);
        gl.uniform1f(u.u_sync_wobble, s.noise ? Math.min(1, s.syncWobble / 100) : 0);
        gl.uniform1f(u.u_enable_bloom, s.bloom ? 1 : 0);
        gl.uniform1f(u.u_bloom_threshold, s.bloom ? Math.min(1, s.bloomThreshold / 100) : 1);
        gl.uniform1f(u.u_bloom_radius, s.bloom ? Math.max(0.5, s.bloomRadius / 10) : 0);
        gl.uniform1f(u.u_bloom_intensity, s.bloom ? Math.max(0, s.glowStrength / 50) : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    finish(): void {
        this.gl.finish();
    }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
    const mk = (type: number, src: string) => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
        return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link failed');
    return p;
}

/**
 * Fallback: keeps the frame in an offscreen canvas and scales it with
 * nearest-neighbour (imageSmoothingEnabled = false). No CRT, no sharp-bilinear
 * edge blending, so non-integer scales show uneven pixel widths.
 */
class Canvas2dRenderer implements Renderer {
    readonly kind = '2d' as const;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly frame = document.createElement('canvas');
    private readonly fctx: CanvasRenderingContext2D;

    constructor(private readonly canvas: HTMLCanvasElement) {
        this.ctx = canvas.getContext('2d', { alpha: false })!;
        this.fctx = this.frame.getContext('2d')!;
    }

    upload(px: Uint8Array, frameW: number, frameH: number, y: number, h: number): void {
        if (this.frame.width !== frameW || this.frame.height !== frameH) {
            this.frame.width = frameW;
            this.frame.height = frameH;
        }
        const img = new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, frameW * h * 4), frameW, h);
        this.fctx.putImageData(img, 0, y);
    }

    draw(p: DrawParams): void {
        const ctx = this.ctx;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.frame, p.rect.x, p.rect.y, p.rect.w, p.rect.h);
        if (p.cursor) {
            const sx = p.rect.w / this.frame.width;
            const sy = p.rect.h / this.frame.height;
            ctx.globalCompositeOperation = 'difference';
            ctx.fillStyle = '#fff';
            ctx.fillRect(p.rect.x + p.cursor.x * sx, p.rect.y + p.cursor.y * sy, p.cursor.w * sx, p.cursor.h * sy);
            ctx.globalCompositeOperation = 'source-over';
        }
    }

    finish(): void {}
}

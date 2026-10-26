// Sound for the terminal: CTerm audio (the audio APC) and "ANSI" music.
//
// This part is in the main bundle and stays small: it owns the AudioContext
// (so a click can resume it synchronously, as browsers require), the user's
// mute and volume, the "enable sound" prompt, and loads the engine
// (dist/enig-term-audio.js, src/audio/) the first time a board uses audio.
// Inputs reach the engine in stream order; while it loads they wait.
//
// Autoplay: browsers start audio only after a user gesture. Until then the
// engine keeps the host-visible state (what is playing, `CSI = 7 n`, idle
// reports) on the wall clock, and starts whatever is still in progress when
// sound is allowed (see audio/webaudio.ts). "ANSI" music that arrives while
// sound cannot be heard (not allowed yet, or muted) is skipped and does not
// hold the stream. A click on Connect, the prompt, the Sound button or any
// key or tap in the terminal allows sound.

import type { AudioEngine, AudioInput, EngineHost, EngineOptions } from './audio/engine.ts';

export type SoundState = 'off' | 'idle' | 'locked' | 'on' | 'muted';

export interface SoundOptions {
    sound: boolean;
    mute: boolean;
    volume: number;
    musicTone: 'square' | 'syncterm' | 'sine';
    audioCache: number;
    audioMaxFile: number;
    audioMemory: number;
}

export interface SoundHost {
    reply(s: string): void;
    log(s: string): void;
    board(): string;
    notice(level: 'info' | 'warn', text: string): void;
    state(s: SoundState): void;
}

export interface SoundHooks {
    /** Pretend the browser refuses audio until a gesture (tests). */
    lock?: boolean;
    /** Decode Ogg with the bundled decoders (tests). */
    fallback?: boolean;
}

/** The board a file cache belongs to: its endpoint without query, fragment or credentials. */
export function boardKey(endpoint: string | null): string {
    if (!endpoint) return 'local';
    try {
        const u = new URL(endpoint);
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return endpoint.slice(0, 500);
    }
}

declare const __ENIG_TERM_AUDIO_HASH__: string | undefined;
const AUDIO_QUERY = typeof __ENIG_TERM_AUDIO_HASH__ === 'string' && __ENIG_TERM_AUDIO_HASH__ ? `?v=${__ENIG_TERM_AUDIO_HASH__}` : '';
const MB = 1 << 20;
/** An unused context is suspended this long after Connect primed it. */
const IDLE_SUSPEND_MS = 15_000;

type Ctx = AudioContext & { webkitAudioContext?: never };

export class Sound {
    ctx: AudioContext | null = null;
    engine: AudioEngine | null = null;
    private loading: Promise<AudioEngine | null> | null = null;
    private used = false;
    private locked: boolean;
    private st: SoundState;
    private idleTimer = 0;
    private failed = false;

    constructor(
        private opts: SoundOptions,
        private readonly host: SoundHost,
        private readonly hooks: SoundHooks = {},
    ) {
        this.locked = !!hooks.lock;
        this.st = this.compute();
    }

    get supported(): boolean {
        return this.opts.sound && typeof globalThis.AudioContext === 'function' && !this.failed;
    }

    get state(): SoundState {
        return this.st;
    }

    private compute(): SoundState {
        if (!this.supported) return 'off';
        if (this.opts.mute) return 'muted';
        if (!this.used) return 'idle';
        return this.running ? 'on' : 'locked';
    }

    private setState(): void {
        const s = this.compute();
        if (s !== this.st) {
            this.st = s;
            this.host.state(s);
        }
    }

    private get running(): boolean {
        return !!this.ctx && this.ctx.state === 'running' && !this.locked;
    }

    /** Sound would be heard now. */
    get audible(): boolean {
        return this.supported && !this.opts.mute && this.running;
    }

    // --- context ------------------------------------------------------------------------

    private context(): AudioContext | null {
        if (this.ctx || !this.supported) return this.ctx;
        try {
            this.ctx = new (globalThis.AudioContext as unknown as new (o?: AudioContextOptions) => Ctx)({ latencyHint: 'interactive' });
        } catch (e) {
            this.failed = true;
            this.host.log(`sound: no AudioContext (${(e as Error)?.message ?? e})`);
            this.setState();
            return null;
        }
        this.ctx.addEventListener('statechange', () => {
            this.engine?.out.check();
            this.setState();
        });
        if (this.locked) void this.ctx.suspend().catch(() => {});
        this.applyVolume();
        return this.ctx;
    }

    /**
     * A user gesture (Connect, the Sound button, the prompt, a key or tap in
     * the terminal): let audio start. Must run inside the gesture's event.
     */
    gesture(explicit = false, create = explicit): void {
        if (!this.supported || this.opts.mute) return;
        if (!this.ctx && !create && !this.used) return;
        this.locked = false;
        const ctx = this.context();
        if (!ctx) return;
        if (explicit) {
            // iOS mutes Web Audio with the ring/silent switch unless the page
            // says it plays media; only when the user asked for sound.
            try {
                const s = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
                if (s) s.type = 'playback';
            } catch {
                /* not supported */
            }
        }
        if (ctx.state !== 'running') void ctx.resume().catch(() => {});
        this.engine?.out.check();
        this.setState();
    }

    /** Connect was clicked: start the context now, while the click counts as a gesture. */
    prime(): void {
        if (!this.supported || this.opts.mute) return;
        // Create and start the context, but leave iOS's audio session alone:
        // the user asked to connect, not for sound.
        this.gesture(false, true);
        clearTimeout(this.idleTimer);
        this.idleTimer = window.setTimeout(() => {
            if (!this.used && this.ctx?.state === 'running') void this.ctx.suspend().catch(() => {});
        }, IDLE_SUSPEND_MS);
    }

    // --- settings -----------------------------------------------------------------------

    set(o: Partial<SoundOptions>): void {
        const wasMuted = this.opts.mute;
        Object.assign(this.opts, o);
        if ('musicTone' in o) this.engine?.setTone(this.opts.musicTone);
        this.applyVolume();
        if (wasMuted && !this.opts.mute) this.gesture(true);
        this.setState();
    }

    get options(): Readonly<SoundOptions> {
        return this.opts;
    }

    private applyVolume(): void {
        const v = this.opts.mute ? 0 : Math.max(0, Math.min(100, this.opts.volume)) / 100;
        // A perceptual curve: the slider's middle is about -12 dB.
        this.engine?.out.setMaster(v * v);
    }

    // --- input -----------------------------------------------------------------------------

    private load(): Promise<AudioEngine | null> {
        if (!this.loading) {
            const ctx = this.context();
            if (!ctx) return (this.loading = Promise.resolve(null));
            const url = new URL(`./enig-term-audio.js${AUDIO_QUERY}`, import.meta.url);
            this.loading = import(/* @vite-ignore */ url.href).then(
                (m: { createEngine: (c: BaseAudioContext, h: EngineHost, o: EngineOptions) => AudioEngine }) => {
                    const e = m.createEngine(ctx, {
                        reply: s => this.host.reply(s),
                        log: s => this.host.log(s),
                        board: () => this.host.board(),
                        notice: text => this.host.notice('info', text),
                    }, {
                        maxFile: this.opts.audioMaxFile * MB,
                        cacheBytes: this.opts.audioCache * MB,
                        memoryBytes: this.opts.audioMemory * MB,
                        decodeMs: 15_000,
                        musicTone: this.opts.musicTone,
                        forceFallback: this.hooks.fallback,
                        lockedHook: () => this.locked,
                    });
                    this.engine = e;
                    this.applyVolume();
                    this.host.log('sound: engine loaded');
                    return e;
                },
                err => {
                    this.failed = true;
                    this.host.log(`sound: the audio engine could not be loaded: ${(err as Error)?.message ?? err}`);
                    this.setState();
                    return null;
                },
            );
        }
        return this.loading;
    }

    /**
     * An audio input from the core, in stream order. Returns a promise when
     * the stream must wait for it (`A;Wait`, foreground music), else null.
     */
    input(i: AudioInput, holds: boolean): Promise<void> | null {
        if (!this.supported) return null;
        if (!this.used) {
            this.used = true;
            clearTimeout(this.idleTimer);
            const ctx = this.context();
            if (ctx && ctx.state !== 'running' && !this.locked) void ctx.resume().catch(() => {});
            this.setState();
        }
        if (i.kind === 'music') i.audible = this.audible;
        const done = this.load().then(e => (e ? e.run(i) : undefined));
        return holds ? done : null;
    }

    /** A new session with the host. */
    reset(): void {
        this.engine?.reset();
    }

    async clearCache(): Promise<{ files: number; bytes: number }> {
        const e = this.engine ?? (this.supported ? await this.load() : null);
        if (!e) return { files: 0, bytes: 0 };
        return e.store.clear();
    }

    async cacheUsage(): Promise<{ files: number; bytes: number }> {
        const e = this.engine ?? (this.supported ? await this.load() : null);
        return e ? e.store.usage() : { files: 0, bytes: 0 };
    }

    destroy(): void {
        clearTimeout(this.idleTimer);
        this.engine?.reset();
        void this.ctx?.close().catch(() => {});
        this.ctx = null;
    }
}

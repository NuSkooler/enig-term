// The chrome around the screen, inside a shadow root: toolbar (host input,
// connect, copy/paste, settings, full screen), the settings panel, the
// on-screen key bar, notices and the link confirmation.
import { saveUserSettings, userMayChange, USER_KEYS, type KeyBarMode, type Options, type UserSettings } from './config.ts';
import { STYLES } from './styles.ts';
import type { ConnState, Terminal } from './terminal.ts';
import { label, size, type TransferDirection, type TransferProtocol, type TransferStatus } from './transfers.ts';

const html = String.raw;

const TEMPLATE = html`
<div class="root" part="root">
  <div class="toolbar" part="toolbar">
    <span class="title" data-title></span>
    <input class="host" data-host type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="wss://bbs.example.com:8443" aria-label="Host">
    <button type="button" data-act="connect">Connect</button>
    <span class="status" data-status data-state="idle" role="status" aria-live="polite">Not connected</span>
    <span class="spacer"></span>
    <button type="button" data-act="copy" title="Copy the selection (Ctrl+Shift+C)" disabled>Copy</button>
    <button type="button" data-act="paste" title="Paste (Ctrl+V)">Paste</button>
    <span class="soundctl" data-soundctl>
      <button type="button" data-act="sound" data-sound="idle" aria-pressed="true" title="Sound on or off">Sound</button>
      <input type="range" class="vol" data-set="volume" min="0" max="100" step="1" aria-label="Volume" title="Volume">
    </span>
    <button type="button" data-act="files" aria-expanded="false" aria-controls="et-files" title="Download or upload files (ZModem, YModem, XModem)">Files</button>
    <button type="button" data-act="settings" aria-expanded="false" aria-controls="et-settings">Settings</button>
    <button type="button" data-act="fullscreen" aria-pressed="false" title="Full screen">Full screen</button>
  </div>
  <div class="settings" id="et-settings" data-settings hidden>
    <label><input type="checkbox" data-set="crt"> CRT effect</label>
    <label><input type="checkbox" data-set="aspect"> 4:3 aspect</label>
    <label>Scale <select data-set="scale"><option value="fit">Fit</option><option value="integer">Whole multiples</option></select></label>
    <label>Key bar <select data-set="keyBar"><option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option></select></label>
    <label><input type="checkbox" data-set="autoReconnect"> Reconnect automatically</label>
    <label>Backspace sends <select data-set="backspace"><option value="bs">^H</option><option value="del">DEL</option></select></label>
    <label>Look <select data-set="profile" title="Auto: PC, Amiga while the board uses an Amiga font"><option value="auto">Auto</option><option value="pc">PC</option><option value="amiga">Amiga</option></select></label>
    <label>Amiga colours <select data-set="amigaPalette"><option value="ncomm">NComm</option><option value="term-ega">Term</option></select></label>
    <label>Amiga aspect <select data-set="amigaAspect"><option value="pal">PAL</option><option value="ntsc">NTSC</option></select></label>
    <span class="group" data-soundset>
      <label><input type="checkbox" data-set="mute"> Mute sound</label>
      <label>Volume <input type="range" data-set="volume" min="0" max="100" step="1"></label>
      <label>Music <select data-set="musicTone" title="The voice of ANSI music"><option value="square">PC speaker</option><option value="syncterm">SyncTERM</option><option value="sine">Sine</option></select></label>
      <button type="button" data-act="clear-sound" title="Forget the sounds boards stored in this browser">Clear sound cache</button>
      <span class="note" data-soundcache role="status" aria-live="polite"></span>
    </span>
    <a class="credits" data-credits target="_blank" rel="noopener">Credits and licences</a>
  </div>
  <div class="settings files" id="et-files" data-files hidden>
    <label>Transfer <select data-xf="dir"><option value="download">Download</option><option value="upload">Upload</option></select></label>
    <label>Protocol <select data-xf="proto"><option value="zmodem">ZModem</option><option value="ymodem">YModem</option><option value="xmodem">XModem</option></select></label>
    <span class="group" data-xf-up><button type="button" data-act="xf-pick">Choose files…</button><span class="note" data-xf-chosen>No files chosen</span></span>
    <label data-xf-namebox>Save as <input type="text" class="text" data-xf="name" value="download.bin" spellcheck="false" autocomplete="off" autocapitalize="off"></label>
    <button type="button" class="primary" data-act="xf-start">Start</button>
    <span class="group" data-xf-folderbox hidden><button type="button" data-act="xf-folder" title="Save downloads straight into a folder (no size limit)">Save into a folder…</button><span class="note" data-xf-folder></span></span>
    <label>ZModem downloads <select data-set="zmodemDetect"><option value="auto">Start by themselves</option><option value="ask">Ask first</option><option value="off">Off (shown as text)</option></select></label>
    <span class="note hint" data-xf-hint></span>
    <input type="file" data-xf-input multiple hidden>
  </div>
  <div class="stage" data-stage>
    <div class="term" data-term></div>
    <div class="scrollmark" data-scrollmark hidden><span data-scrolltext></span><button type="button" data-act="live">Live</button></div>
    <div class="toast" data-toast hidden role="status" aria-live="polite"><span data-toasttext></span><button type="button" data-act="toast-close" aria-label="Dismiss">&times;</button></div>
    <div class="xfer" data-xfer hidden role="dialog" aria-label="File transfer" part="transfer">
      <div class="xf-head"><strong data-xf-title></strong></div>
      <div class="note" data-xf-msg></div>
      <div class="xf-file" data-xf-file></div>
      <div class="xf-bar" data-xf-bar><span data-xf-fill></span></div>
      <div class="note xf-stats" data-xf-stats></div>
      <ul class="xf-list" data-xf-list></ul>
      <div class="xf-error" data-xf-error hidden></div>
      <div class="actions">
        <button type="button" data-act="xf-offer-files" class="primary" hidden>Choose files…</button>
        <button type="button" data-act="xf-offer-accept" class="primary" hidden>Receive</button>
        <button type="button" data-act="xf-cancel">Cancel</button>
        <button type="button" data-act="xf-close" hidden>Close</button>
      </div>
    </div>
    <div class="soundprompt" data-soundprompt hidden role="status"><button type="button" class="primary" data-act="sound-enable">This board plays sound: click to enable it</button><button type="button" data-act="sound-dismiss" aria-label="Dismiss">&times;</button></div>
  </div>
  <div class="keybar" data-keybar hidden part="keybar">
    <div class="row">
      <button type="button" tabindex="-1" data-key="Escape">Esc</button>
      <button type="button" tabindex="-1" data-key="Tab">Tab</button>
      <button type="button" tabindex="-1" data-mod="ctrl" aria-pressed="false">Ctrl</button>
      <button type="button" tabindex="-1" data-key="ArrowLeft" aria-label="Left">&larr;</button>
      <button type="button" tabindex="-1" data-key="ArrowUp" aria-label="Up">&uarr;</button>
      <button type="button" tabindex="-1" data-key="ArrowDown" aria-label="Down">&darr;</button>
      <button type="button" tabindex="-1" data-key="ArrowRight" aria-label="Right">&rarr;</button>
      <button type="button" tabindex="-1" data-fn aria-pressed="false">Fn</button>
    </div>
    <div class="row">
      <button type="button" tabindex="-1" data-key="Home">Home</button>
      <button type="button" tabindex="-1" data-key="End">End</button>
      <button type="button" tabindex="-1" data-key="PageUp">PgUp</button>
      <button type="button" tabindex="-1" data-key="PageDown">PgDn</button>
      <button type="button" tabindex="-1" data-key="Insert">Ins</button>
      <button type="button" tabindex="-1" data-key="Delete">Del</button>
      <button type="button" tabindex="-1" data-mod="alt" aria-pressed="false">Alt</button>
    </div>
    <div class="row" data-fnrow hidden>
      ${Array.from({ length: 12 }, (_, i) => `<button type="button" tabindex="-1" data-key="F${i + 1}">F${i + 1}</button>`).join('')}
    </div>
  </div>
  <dialog data-linkdialog aria-labelledby="et-link-h">
    <h2 id="et-link-h">Open this link?</h2>
    <code class="url" data-linkurl></code>
    <p class="why" data-linkwhy hidden></p>
    <div class="actions"><button type="button" data-act="link-cancel">Cancel</button><button type="button" class="primary" data-act="link-open">Open link</button></div>
  </dialog>
</div>`;

/** Seconds as m:ss (or h:mm:ss). */
function clock(sec: number): string {
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const STATE_TEXT: Record<ConnState, string> = {
    idle: 'Not connected',
    connecting: 'Connecting…',
    connected: 'Connected',
    closed: 'Disconnected',
    error: 'Error',
};

export class Chrome {
    readonly root: HTMLElement;
    readonly term: HTMLElement;
    private q<T extends Element = HTMLElement>(sel: string): T {
        return this.shadow.querySelector<T>(sel)!;
    }
    private keyBarShown = false;
    private toastTimer = 0;
    private pendingLink = '';
    private promptDismissed = false;
    /** Files chosen in the Files panel for the next upload. */
    private picked: File[] = [];
    /** What the file picker was opened for: the panel, or the board's ZModem offer. */
    private pickFor: 'panel' | 'offer' = 'panel';
    private xferTimer = 0;
    private coarse = window.matchMedia?.('(pointer: coarse)');
    private disposers: (() => void)[] = [];
    terminal: Terminal | null = null;
    /** Endpoint the host input should start with. */
    onConnectRequest: ((endpoint: string) => void) | null = null;

    constructor(
        private readonly host: HTMLElement,
        private readonly shadow: ShadowRoot,
        private opts: Options,
        private user: UserSettings,
        fill: boolean,
    ) {
        const style = document.createElement('style');
        style.textContent = STYLES;
        shadow.replaceChildren(style);
        const tpl = document.createElement('template');
        tpl.innerHTML = TEMPLATE;
        shadow.appendChild(tpl.content);
        this.root = this.q('.root');
        this.term = this.q('[data-term]');
        if (fill) this.term.dataset.fit = 'both';
    }

    /** Wire the chrome to a created terminal. */
    attach(t: Terminal): void {
        this.terminal = t;
        const o = this.opts;
        // Next to the bundle, wherever the embedding page lives.
        this.q<HTMLAnchorElement>('[data-credits]').href = new URL('credits.html', import.meta.url).href;
        this.q<HTMLElement>('.toolbar').hidden = !o.toolbar;
        this.q('[data-title]').textContent = o.title;
        const hostIn = this.q<HTMLInputElement>('[data-host]');
        hostIn.value = o.endpoint ?? '';
        hostIn.readOnly = o.lockEndpoint;
        if (o.lockEndpoint) hostIn.title = 'Set by the board';
        hostIn.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.connectFromInput();
            }
        });

        this.on('[data-act="connect"]', 'click', () => {
            if (t.state === 'connected' || t.state === 'connecting') t.disconnect();
            else {
                // The click is a user gesture: let sound start now, before the board needs it.
                t.sound.prime();
                this.connectFromInput();
            }
        });
        this.on('[data-act="sound"]', 'click', () => {
            if (t.sound.state === 'locked') t.sound.gesture(true);
            else this.setOption('mute', !this.opts.mute, true);
            t.input.focus();
        });
        this.on('[data-act="sound-enable"]', 'click', () => {
            t.sound.gesture(true);
            this.q('[data-soundprompt]').hidden = true;
            t.input.focus();
        });
        this.on('[data-act="sound-dismiss"]', 'click', () => {
            this.promptDismissed = true;
            this.q('[data-soundprompt]').hidden = true;
            t.input.focus();
        });
        this.on('[data-act="clear-sound"]', 'click', () => {
            const out = this.q('[data-soundcache]');
            out.textContent = 'Clearing…';
            void t.sound.clearCache().then(
                u => (out.textContent = u.files ? `Cleared ${u.files} file${u.files === 1 ? '' : 's'} (${Math.max(1, Math.round(u.bytes / 1024))} KB)` : 'Nothing stored'),
                () => (out.textContent = 'Could not clear'),
            );
        });
        if (!o.sound) {
            this.q('[data-soundctl]').hidden = true;
            this.q('[data-soundset]').hidden = true;
        }
        t.events.on('sound', ev => this.showSound(ev.state));
        this.showSound(t.sound.state);
        this.on('[data-act="copy"]', 'click', () => void t.copySelection());
        this.on('[data-act="paste"]', 'click', () => void t.pasteFromClipboard());
        this.on('[data-act="live"]', 'click', () => {
            t.scroll.toLive();
            t.input.focus();
        });
        this.on('[data-act="toast-close"]', 'click', () => this.hideToast());
        this.on('[data-act="settings"]', 'click', e => {
            const panel = this.q('[data-settings]');
            panel.hidden = !panel.hidden;
            (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!panel.hidden));
        });
        this.on('[data-act="fullscreen"]', 'click', () => void this.toggleFullscreen());
        const fsChange = () => {
            const on = this.fullscreenElement() === this.host;
            if (!on && this.root.classList.contains('pseudo-fs')) return;
            this.q('[data-act="fullscreen"]').setAttribute('aria-pressed', String(on));
            t.setFullscreen(on);
        };
        document.addEventListener('fullscreenchange', fsChange);
        document.addEventListener('webkitfullscreenchange', fsChange);
        this.disposers.push(() => {
            document.removeEventListener('fullscreenchange', fsChange);
            document.removeEventListener('webkitfullscreenchange', fsChange);
        });

        this.bindSettings();
        this.bindKeyBar();
        this.bindFiles();
        t.events.on('transfer', st => this.showTransfer(st));

        t.events.on('state', ev => this.showState(ev.state, ev.detail, ev.reconnectInMs));
        t.events.on('notice', ev => this.toast(ev.text, ev.level));
        t.events.on('bell', () => {
            const s = this.q('[data-stage]');
            s.classList.remove('bell');
            void s.offsetWidth;
            s.classList.add('bell');
        });
        t.events.on('scroll', ev => {
            const m = this.q('[data-scrollmark]');
            m.hidden = ev.offset === 0;
            this.q('[data-scrolltext]').textContent = `${ev.offset} of ${ev.lines} lines back · any key returns`;
        });
        t.events.on('selection', ev => {
            this.q<HTMLButtonElement>('[data-act="copy"]').disabled = !ev.text;
        });
        t.onLinkRequest = (href, allowed, reason) => this.confirmLink(href, allowed, reason);
        this.on('[data-act="link-cancel"]', 'click', () => this.closeLink());
        this.on('[data-act="link-open"]', 'click', () => {
            const href = this.pendingLink;
            this.closeLink();
            if (href) t.openLink(href);
        });
        this.showState(t.state, '');
    }

    private on(sel: string, type: string, fn: (e: Event) => void): void {
        this.q(sel).addEventListener(type, fn);
    }

    private connectFromInput(): void {
        const t = this.terminal!;
        const v = this.q<HTMLInputElement>('[data-host]').value.trim();
        const target = this.opts.lockEndpoint ? this.opts.endpoint : v || this.opts.endpoint;
        if (!target) {
            this.toast('Enter the address of a board to connect to.', 'info');
            this.q<HTMLInputElement>('[data-host]').focus();
            return;
        }
        t.connect(target);
    }

    showState(state: ConnState, detail: string, reconnectInMs?: number): void {
        const el = this.q('[data-status]');
        el.dataset.state = state;
        let text = STATE_TEXT[state];
        if (state === 'error' && detail) text = `Error: ${detail}`;
        else if (state === 'closed' && reconnectInMs !== undefined) text = `${detail}; reconnecting in ${Math.ceil(reconnectInMs / 1000)}s`;
        else if (state === 'closed' && detail && detail !== 'disconnected') text = `Disconnected: ${detail}`;
        el.textContent = text;
        const btn = this.q('[data-act="connect"]');
        btn.textContent = state === 'connected' || state === 'connecting' ? 'Disconnect' : state === 'closed' || state === 'error' ? 'Reconnect' : 'Connect';
        const ep = this.terminal?.currentEndpoint;
        if (ep && !this.opts.lockEndpoint && state === 'connecting') this.q<HTMLInputElement>('[data-host]').value = ep;
    }

    /** Reflect the sound state: the toolbar button and the "enable sound" prompt. */
    showSound(state: string): void {
        const b = this.q('[data-act="sound"]');
        b.dataset.sound = state;
        b.textContent = state === 'locked' ? 'Enable sound' : state === 'muted' ? 'Muted' : 'Sound';
        b.setAttribute('aria-pressed', String(state !== 'muted'));
        b.title = state === 'locked' ? 'This board plays sound: click to enable it' : state === 'muted' ? 'Sound is muted: click to unmute' : 'Click to mute';
        const p = this.q('[data-soundprompt]');
        p.hidden = state !== 'locked' || this.promptDismissed;
    }

    toast(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
        const el = this.q('[data-toast]');
        el.dataset.level = level;
        this.q('[data-toasttext]').textContent = text;
        el.hidden = false;
        clearTimeout(this.toastTimer);
        this.toastTimer = window.setTimeout(() => this.hideToast(), level === 'info' ? 2500 : level === 'warn' ? 8000 : 15000);
    }

    private hideToast(): void {
        this.q('[data-toast]').hidden = true;
    }

    // --- links ---------------------------------------------------------------------

    confirmLink(href: string, allowed: boolean, reason?: string): void {
        const d = this.q<HTMLDialogElement>('[data-linkdialog]');
        this.q('[data-linkurl]').textContent = href;
        const why = this.q('[data-linkwhy]');
        why.hidden = allowed;
        why.textContent = allowed ? '' : `This link cannot be opened: ${reason ?? 'not allowed'}.`;
        this.q<HTMLButtonElement>('[data-act="link-open"]').hidden = !allowed;
        this.pendingLink = allowed ? href : '';
        try {
            d.showModal();
        } catch {
            d.setAttribute('open', '');
        }
        (allowed ? this.q<HTMLButtonElement>('[data-act="link-open"]') : this.q<HTMLButtonElement>('[data-act="link-cancel"]')).focus();
    }

    private closeLink(): void {
        const d = this.q<HTMLDialogElement>('[data-linkdialog]');
        this.pendingLink = '';
        try {
            d.close();
        } catch {
            d.removeAttribute('open');
        }
        this.terminal?.input.focus();
    }

    // --- settings --------------------------------------------------------------------

    private bindSettings(): void {
        const t = this.terminal!;
        for (const el of this.shadow.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-set]')) {
            const key = el.dataset.set as keyof Options;
            const may = userMayChange(this.opts, key);
            el.disabled = !may;
            if (!may) el.title = 'Set by the board';
            const val = this.opts[key];
            const range = el instanceof HTMLInputElement && el.type === 'range';
            if (el instanceof HTMLInputElement && !range) el.checked = !!val;
            else el.value = String(val);
            el.addEventListener(range ? 'input' : 'change', () => {
                const v = range ? Number(el.value) : el instanceof HTMLInputElement ? el.checked : el.value;
                this.setOption(key, v as never, true);
            });
        }
        void t;
    }

    /** Reflect an option in the settings panel without applying it. */
    syncSetting(key: string, value: unknown): void {
        for (const el of this.shadow.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-set="${key}"]`)) {
            if (el instanceof HTMLInputElement && el.type !== 'range') el.checked = !!value;
            else el.value = String(value);
        }
    }

    /** Apply a setting (from the UI or the API); `fromUser` also persists it. */
    setOption<K extends keyof Options>(key: K, value: Options[K], fromUser = false): void {
        const t = this.terminal!;
        if (fromUser && !userMayChange(this.opts, key)) return;
        this.opts[key] = value;
        if (key === 'keyBar') this.updateKeyBar();
        else if (key === 'toolbar') this.q<HTMLElement>('.toolbar').hidden = !value;
        else if (key === 'transfers') {
            this.q('[data-act="files"]').hidden = !value;
            t.set(key, value);
        }
        else if (key === 'title') this.q('[data-title]').textContent = String(value);
        else if (key === 'endpoint') {
            if (!this.opts.lockEndpoint || !fromUser) this.q<HTMLInputElement>('[data-host]').value = String(value ?? '');
        } else t.set(key, value);
        this.syncSetting(key, value);
        if (fromUser && this.opts.persist && (USER_KEYS as readonly string[]).includes(key)) {
            (this.user as Record<string, unknown>)[key] = value;
            if (!saveUserSettings(this.user)) this.toast('Settings could not be saved in this browser.', 'info');
        }
    }

    // --- file transfers -----------------------------------------------------------------

    private bindFiles(): void {
        const t = this.terminal!;
        const panel = this.q('[data-files]');
        const btn = this.q('[data-act="files"]');
        const dir = this.q<HTMLSelectElement>('[data-xf="dir"]');
        const proto = this.q<HTMLSelectElement>('[data-xf="proto"]');
        const input = this.q<HTMLInputElement>('[data-xf-input]');
        btn.hidden = !this.opts.transfers;
        this.on('[data-act="files"]', 'click', () => {
            panel.hidden = !panel.hidden;
            btn.setAttribute('aria-expanded', String(!panel.hidden));
            this.syncFiles();
        });
        dir.addEventListener('change', () => this.syncFiles());
        proto.addEventListener('change', () => {
            if (proto.value === 'xmodem' && this.picked.length > 1) this.picked = this.picked.slice(0, 1);
            this.syncFiles();
        });
        this.on('[data-act="xf-pick"]', 'click', () => this.pickFiles('panel'));
        this.on('[data-act="xf-offer-files"]', 'click', () => this.pickFiles('offer'));
        input.addEventListener('change', () => {
            const files = Array.from(input.files ?? []);
            input.value = '';
            if (!files.length) return;
            if (this.pickFor === 'offer') t.transfers.accept(files);
            else {
                this.picked = proto.value === 'xmodem' ? files.slice(0, 1) : files;
                this.syncFiles();
            }
        });
        this.on('[data-act="xf-start"]', 'click', () => {
            const d = dir.value as TransferDirection;
            const p = proto.value as TransferProtocol;
            let ok: boolean;
            if (d === 'download') ok = t.transfers.download(p, this.q<HTMLInputElement>('[data-xf="name"]').value.trim() || 'download.bin');
            else if (!this.picked.length) {
                this.toast('Choose the files to send first.', 'info');
                ok = false;
            } else ok = t.transfers.upload(this.picked, p);
            if (!ok) return;
            panel.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
            if (d === 'upload') {
                this.picked = [];
                this.syncFiles();
            }
        });
        this.on('[data-act="xf-folder"]', 'click', () => {
            void t.transfers.chooseFolder().then(name => {
                if (name) this.q('[data-xf-folder]').textContent = `Saving into “${name}”`;
            });
        });
        this.on('[data-act="xf-offer-accept"]', 'click', () => t.transfers.accept([]));
        this.on('[data-act="xf-cancel"]', 'click', () => t.transfers.cancel());
        this.on('[data-act="xf-close"]', 'click', () => {
            t.transfers.dismiss();
            t.input.focus();
        });
        this.syncFiles();
    }

    /** Open the file picker (from a click: browsers require one). */
    private pickFiles(forWhat: 'panel' | 'offer'): void {
        const input = this.q<HTMLInputElement>('[data-xf-input]');
        this.pickFor = forWhat;
        input.multiple = !(forWhat === 'panel' && this.q<HTMLSelectElement>('[data-xf="proto"]').value === 'xmodem');
        input.click();
    }

    /** The Files panel shows what the chosen direction and protocol need. */
    private syncFiles(): void {
        const t = this.terminal!;
        const d = this.q<HTMLSelectElement>('[data-xf="dir"]').value as TransferDirection;
        const p = this.q<HTMLSelectElement>('[data-xf="proto"]').value as TransferProtocol;
        this.q('[data-xf-up]').hidden = d !== 'upload';
        this.q('[data-xf-namebox]').hidden = !(d === 'download' && p === 'xmodem');
        this.q('[data-xf-folderbox]').hidden = !(d === 'download' && t.transfers.canPickFolder);
        const folder = t.transfers.folderName;
        this.q('[data-xf-folder]').textContent = folder ? `Saving into “${folder}”` : '';
        const n = this.picked.length;
        this.q('[data-xf-chosen]').textContent = n ? (n === 1 ? `${this.picked[0].name} (${size(this.picked[0].size)})` : `${n} files (${size(this.picked.reduce((a, f) => a + f.size, 0))})`) : 'No files chosen';
        const start = this.q<HTMLButtonElement>('[data-act="xf-start"]');
        start.textContent = p === 'zmodem' ? (d === 'download' ? 'Wait for the board' : 'Send when the board is ready') : d === 'download' ? 'Receive' : 'Send';
        this.q('[data-xf-hint]').textContent =
            p === 'zmodem'
                ? d === 'download'
                    ? 'Choose the files on the board and start its ZModem download: it begins here by itself.'
                    : 'Choose files, then start the upload on the board (or start it on the board first: you will be asked for files).'
                : d === 'download'
                  ? `Start the ${label(p)} download on the board first, then press Receive.`
                  : `Choose ${p === 'xmodem' ? 'a file' : 'files'} and press Send, then start the ${label(p)} upload on the board within a minute.`;
    }

    /** The transfer card over the screen: an offer, progress, or the outcome. */
    showTransfer(st: TransferStatus): void {
        const t = this.terminal!;
        const card = this.q('[data-xfer]');
        clearTimeout(this.xferTimer);
        if (st.phase === 'idle') {
            card.hidden = true;
            return;
        }
        card.hidden = false;
        card.dataset.phase = st.phase;
        const up = st.direction === 'upload';
        const proto = label(st.protocol);
        const running = st.phase === 'loading' || st.phase === 'running';
        const over = st.phase === 'done' || st.phase === 'failed' || st.phase === 'cancelled';
        const titles: Record<string, string> = {
            armed: `${up ? 'Upload' : 'Download'} (${proto})`,
            offer: up ? 'The board is ready to receive files (ZModem)' : 'The board wants to send files (ZModem)',
            loading: `${up ? 'Uploading' : 'Downloading'} (${proto})`,
            running: `${up ? 'Uploading' : 'Downloading'} (${proto})`,
            done: `${up ? 'Upload' : 'Download'} complete`,
            failed: `${up ? 'Upload' : 'Download'} failed`,
            cancelled: st.error === 'refused' ? 'Transfer refused' : `${up ? 'Upload' : 'Download'} cancelled`,
        };
        this.q('[data-xf-title]').textContent = titles[st.phase] ?? '';
        this.q('[data-xf-msg]').textContent = st.message ?? '';
        const f = st.file;
        const nth = f ? (f.count && f.count > 1 ? ` · ${f.index + 1} of ${f.count}` : f.index > 0 ? ` · file ${f.index + 1}` : '') : '';
        this.q('[data-xf-file]').textContent = running && f ? `${f.name}${nth}` : '';
        const bar = this.q('[data-xf-bar]');
        bar.hidden = !(running && f);
        const frac = f && f.size ? Math.min(1, st.fileBytes / f.size) : f && f.size === 0 ? 1 : null;
        bar.classList.toggle('indeterminate', frac === null);
        this.q<HTMLElement>('[data-xf-fill]').style.width = frac === null ? '' : `${(frac * 100).toFixed(1)}%`;
        let stats = '';
        if (running && f) {
            stats = `${size(st.fileBytes)}${f.size != null ? ` of ${size(f.size)}` : ''}`;
            if (st.rate > 0) stats += ` · ${size(Math.round(st.rate))}/s`;
            if (st.eta != null && st.rate > 0) stats += ` · ${clock(st.eta)} left`;
        } else if (over && st.files.length) {
            const ok = st.files.filter(x => x.ok);
            stats = `${ok.length} file${ok.length === 1 ? '' : 's'}, ${size(ok.reduce((a, x) => a + x.size, 0))}${up ? ' sent' : ' received'}`;
        }
        this.q('[data-xf-stats]').textContent = stats;
        const list = this.q('[data-xf-list]');
        list.replaceChildren(
            ...[...st.files.map(x => ({ ...x, skipped: false })), ...st.skipped.map(x => ({ name: x.name, size: x.size, ok: false, url: undefined, where: 'download' as const, skipped: true }))].map(x => {
                const li = document.createElement('li');
                li.className = x.ok ? 'ok' : 'bad';
                const name = document.createElement('span');
                name.textContent = `${x.ok ? '✓' : '✗'} ${x.name} (${size(x.size)})${x.skipped ? ': skipped, too large' : x.ok ? (up ? '' : x.where === 'folder' ? ': saved in the folder' : '') : ': incomplete'}`;
                li.appendChild(name);
                if (x.ok && x.url) {
                    const a = document.createElement('a');
                    a.href = x.url;
                    a.download = x.name;
                    a.textContent = 'Save again';
                    li.append(' ', a);
                }
                return li;
            }),
        );
        const err = this.q('[data-xf-error]');
        err.hidden = !(over && st.error && st.error !== 'refused');
        err.textContent = st.error ? `${st.error[0].toUpperCase()}${st.error.slice(1)}.` : '';
        this.q('[data-act="xf-offer-files"]').hidden = !(st.phase === 'offer' && up);
        this.q('[data-act="xf-offer-accept"]').hidden = !(st.phase === 'offer' && !up);
        const cancel = this.q('[data-act="xf-cancel"]');
        cancel.hidden = over;
        cancel.textContent = st.phase === 'offer' ? 'Refuse' : 'Cancel';
        this.q('[data-act="xf-close"]').hidden = !over;
        if (over) {
            // The line is the terminal's again: so is the keyboard.
            t.input.focus();
            if (st.phase === 'done' || st.error === 'refused') this.xferTimer = window.setTimeout(() => t.transfers.dismiss(), 8000);
        }
    }

    // --- full screen -----------------------------------------------------------------

    private fullscreenElement(): Element | null {
        const d = document as Document & { webkitFullscreenElement?: Element };
        return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
    }

    async toggleFullscreen(): Promise<void> {
        const t = this.terminal!;
        const btn = this.q('[data-act="fullscreen"]');
        if (this.root.classList.contains('pseudo-fs')) {
            this.root.classList.remove('pseudo-fs');
            btn.setAttribute('aria-pressed', 'false');
            t.setFullscreen(false);
            return;
        }
        if (this.fullscreenElement()) {
            const d = document as Document & { webkitExitFullscreen?: () => void };
            if (document.exitFullscreen) await document.exitFullscreen().catch(() => {});
            else d.webkitExitFullscreen?.();
            return;
        }
        const h = this.host as HTMLElement & { webkitRequestFullscreen?: () => void };
        try {
            if (h.requestFullscreen) await h.requestFullscreen({ navigationUI: 'hide' });
            else if (h.webkitRequestFullscreen) h.webkitRequestFullscreen();
            else throw new Error('no fullscreen API');
        } catch {
            // iPhone Safari has no element fullscreen: cover the viewport instead.
            this.root.classList.add('pseudo-fs');
            btn.setAttribute('aria-pressed', 'true');
            t.setFullscreen(true);
        }
        t.input.focus();
    }

    // --- key bar -----------------------------------------------------------------------

    private bindKeyBar(): void {
        const t = this.terminal!;
        const bar = this.q('[data-keybar]');
        bar.addEventListener('pointerdown', ev => {
            const b = (ev.target as HTMLElement).closest<HTMLElement>('button');
            if (!b) return;
            ev.preventDefault(); // keep focus (and the soft keyboard) on the terminal
            if (b.dataset.mod) {
                const mod = b.dataset.mod as 'ctrl' | 'alt';
                t.input.setSticky(mod, !t.input.sticky[mod]);
            } else if (b.hasAttribute('data-fn')) {
                const row = this.q('[data-fnrow]');
                row.hidden = !row.hidden;
                b.setAttribute('aria-pressed', String(!row.hidden));
                this.placeKeyBar();
            } else if (b.dataset.key) {
                t.scroll.toLive();
                t.input.pressKey(b.dataset.key);
            }
            t.input.focus();
        });
        // A click without a preceding pointerdown (keyboard users, assistive tech).
        bar.addEventListener('click', ev => {
            if ((ev as PointerEvent).pointerType) return;
            const b = (ev.target as HTMLElement).closest<HTMLElement>('button[data-key]');
            if (b?.dataset.key) t.input.pressKey(b.dataset.key);
        });
        t.input.onStickyChange = () => {
            for (const b of bar.querySelectorAll<HTMLElement>('[data-mod]')) b.setAttribute('aria-pressed', String(t.input.sticky[b.dataset.mod as 'ctrl' | 'alt']));
        };
        const vv = window.visualViewport;
        const place = () => this.placeKeyBar();
        vv?.addEventListener('resize', place);
        vv?.addEventListener('scroll', place);
        window.addEventListener('resize', place);
        this.coarse?.addEventListener?.('change', () => this.updateKeyBar());
        this.disposers.push(() => {
            vv?.removeEventListener('resize', place);
            vv?.removeEventListener('scroll', place);
            window.removeEventListener('resize', place);
        });
        this.updateKeyBar();
    }

    get keyBarVisible(): boolean {
        return this.keyBarShown;
    }

    updateKeyBar(): void {
        const mode: KeyBarMode = this.opts.keyBar;
        const show = mode === 'on' || (mode === 'auto' && !!this.coarse?.matches);
        this.keyBarShown = show;
        this.q('[data-keybar]').hidden = !show;
        this.placeKeyBar();
    }

    /**
     * Keep the key bar on the bottom edge of the *visual* viewport, so it sits
     * just above the soft keyboard. iOS does not shrink the layout viewport
     * when the keyboard opens, so `bottom: 0` alone would hide it behind.
     */
    placeKeyBar(): void {
        const bar = this.q('[data-keybar]');
        if (bar.hidden) {
            this.root.style.paddingBottom = '';
            return;
        }
        const vv = window.visualViewport;
        const h = bar.offsetHeight;
        const top = vv ? vv.offsetTop + vv.height - h : window.innerHeight - h;
        bar.style.top = `${Math.max(0, Math.round(top))}px`;
        bar.style.left = vv ? `${Math.round(vv.offsetLeft)}px` : '0';
        bar.style.width = vv ? `${Math.round(vv.width)}px` : '100%';
        // Room below the screen so the bar never covers its last rows.
        this.root.style.paddingBottom = `${h}px`;
    }

    destroy(): void {
        for (const d of this.disposers) d();
        clearTimeout(this.toastTimer);
        clearTimeout(this.xferTimer);
    }
}

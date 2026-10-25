// Keyboard input: a hidden textarea collects text (IME, dead keys, predictive
// soft keyboards); keydown handles special keys with ANSI-BBS sequences.
import { ESC } from './replies.js';

const CSI = ESC + '[';

/** ANSI-BBS / CTerm key sequences (all are in ENiGMA's client.js key table). */
export const KEYS: Record<string, string> = {
    Enter: '\r',
    Backspace: '\b',
    Tab: '\t',
    Escape: ESC,
    ArrowUp: CSI + 'A',
    ArrowDown: CSI + 'B',
    ArrowRight: CSI + 'C',
    ArrowLeft: CSI + 'D',
    Home: CSI + 'H',
    End: CSI + 'K',
    Insert: CSI + '@',
    Delete: String.fromCharCode(0x7f),
    PageUp: CSI + 'V',
    PageDown: CSI + 'U',
    F1: ESC + 'OP',
    F2: ESC + 'OQ',
    F3: ESC + 'OR',
    F4: ESC + 'OS',
    F5: CSI + '15~',
    F6: CSI + '17~',
    F7: CSI + '18~',
    F8: CSI + '19~',
    F9: CSI + '20~',
    F10: CSI + '21~',
    F11: CSI + '23~',
    F12: CSI + '24~',
};

// Kept in the textarea so a soft-keyboard backspace always has something to
// delete (Gboard sends keyCode 229 and only a deleteContentBackward input).
const SENTINEL = '  ';

export class Input {
    readonly textarea: HTMLTextAreaElement;
    private last = SENTINEL;
    private composing = false;

    constructor(
        host: HTMLElement,
        private readonly send: (text: string) => void,
    ) {
        const ta = document.createElement('textarea');
        ta.className = 'enig-term__input';
        ta.setAttribute('autocapitalize', 'off');
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('spellcheck', 'false');
        ta.setAttribute('aria-label', 'Terminal input');
        ta.value = SENTINEL;
        // Off-screen but focusable; a zero-size element can be refused focus on iOS.
        Object.assign(ta.style, {
            position: 'absolute',
            left: '-9999px',
            top: '0',
            width: '1em',
            height: '1em',
            opacity: '0',
            resize: 'none',
        });
        host.appendChild(ta);
        this.textarea = ta;

        ta.addEventListener('keydown', e => this.onKeyDown(e));
        ta.addEventListener('compositionstart', () => (this.composing = true));
        ta.addEventListener('compositionend', () => {
            this.composing = false;
            this.flush();
        });
        ta.addEventListener('input', e => {
            if ((e as InputEvent).isComposing || this.composing) return;
            this.flush();
        });
        host.addEventListener('pointerdown', () => this.focus());
    }

    focus(): void {
        this.textarea.focus({ preventScroll: true });
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (e.isComposing || e.keyCode === 229) return; // IME owns it
        let seq: string | undefined;
        if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
            const c = e.key.toUpperCase().charCodeAt(0);
            if (c >= 0x40 && c <= 0x5f) seq = String.fromCharCode(c & 0x1f);
        } else if (!e.metaKey) {
            seq = KEYS[e.key];
            if (seq === KEYS.Tab && e.shiftKey) seq = CSI + 'Z';
        }
        if (seq !== undefined) {
            e.preventDefault();
            this.send(seq);
        }
    }

    /** Diff the textarea against what was sent: predictive text replaces whole words. */
    private flush(): void {
        const cur = this.textarea.value;
        let p = 0;
        const max = Math.min(cur.length, this.last.length);
        while (p < max && cur[p] === this.last[p]) p++;
        const deleted = this.last.length - p;
        const inserted = cur.slice(p).replace(/\r?\n/g, '\r');
        const out = '\b'.repeat(deleted) + inserted;
        if (out) this.send(out);
        if (cur.length > 64 || cur.length < SENTINEL.length) {
            this.textarea.value = SENTINEL;
            this.last = SENTINEL;
        } else {
            this.last = cur;
        }
    }
}

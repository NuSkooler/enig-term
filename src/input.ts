// Keyboard and text input.
//
// A hidden textarea is the input target on every platform. keydown handles
// the keys that have ANSI-BBS sequences (keymap.ts); everything else is text,
// read from the textarea itself:
//   * composition (IME, dead keys): nothing is sent until compositionend;
//   * soft keyboards (Gboard reports keyCode 229 and an "Unidentified" key for
//     every key, so keydown is useless there): the input event's effect on the
//     textarea is diffed against what was sent, so a predictive-text
//     replacement of a whole word becomes backspaces plus the new text;
//   * a two-space sentinel stays in the textarea so a soft-keyboard backspace
//     always has something to delete (and so fires an input event).
import { mapKey, keySequence, type BackspaceMode } from './keymap.ts';

const SENTINEL = '  ';

export interface InputHandlers {
    /** Text or key sequence for the host (encoded by the terminal). */
    send(text: string): void;
    /** Pasted text (the terminal encodes and chunks it). */
    paste(text: string): void;
    /**
     * Terminal-level shortcuts, before the keymap (copy, scrollback keys).
     * Return true when the key was handled and must not reach the host.
     */
    shortcut(e: KeyboardEvent): boolean;
    /** Called before anything goes to the host (leaves the scrollback view). */
    willSend(): void;
    backspace(): BackspaceMode;
}

export class Input {
    readonly textarea: HTMLTextAreaElement;
    private last = SENTINEL;
    private composing = false;
    /** Sticky modifiers from the key bar, applied to the next key or character. */
    sticky = { ctrl: false, alt: false };
    onStickyChange: (() => void) | null = null;

    constructor(
        host: HTMLElement,
        private readonly h: InputHandlers,
    ) {
        const ta = document.createElement('textarea');
        ta.className = 'input';
        ta.setAttribute('autocapitalize', 'off');
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('spellcheck', 'false');
        ta.setAttribute('enterkeyhint', 'send');
        ta.setAttribute('aria-label', 'Terminal input');
        ta.setAttribute('tabindex', '0');
        ta.value = SENTINEL;
        host.appendChild(ta);
        this.textarea = ta;
        this.resetCaret();

        ta.addEventListener('keydown', e => this.onKeyDown(e));
        ta.addEventListener('compositionstart', () => (this.composing = true));
        ta.addEventListener('compositionend', () => {
            this.composing = false;
            this.flush();
        });
        ta.addEventListener('beforeinput', e => this.onBeforeInput(e));
        ta.addEventListener('input', e => {
            if ((e as InputEvent).isComposing || this.composing) return;
            this.flush();
        });
        ta.addEventListener('paste', e => {
            const text = e.clipboardData?.getData('text/plain');
            e.preventDefault();
            if (text) this.h.paste(text);
        });
    }

    focus(): void {
        this.textarea.focus({ preventScroll: true });
    }

    get focused(): boolean {
        const root = this.textarea.getRootNode() as Document | ShadowRoot;
        return root.activeElement === this.textarea;
    }

    private resetCaret(): void {
        this.textarea.value = SENTINEL;
        this.last = SENTINEL;
        try {
            this.textarea.setSelectionRange(SENTINEL.length, SENTINEL.length);
        } catch {
            /* not focusable yet */
        }
    }

    /** A key sequence from the key bar or the API, with sticky modifiers applied. */
    pressKey(key: string): void {
        const e = { key, ctrlKey: this.sticky.ctrl, altKey: this.sticky.alt, shiftKey: false, metaKey: false };
        const seq = mapKey(e, { backspace: this.h.backspace() }) ?? (key.length === 1 ? key : undefined);
        this.clearSticky();
        if (seq !== undefined) this.out(seq);
    }

    setSticky(mod: 'ctrl' | 'alt', on: boolean): void {
        this.sticky[mod] = on;
        this.onStickyChange?.();
    }

    private clearSticky(): void {
        if (this.sticky.ctrl || this.sticky.alt) {
            this.sticky.ctrl = this.sticky.alt = false;
            this.onStickyChange?.();
        }
    }

    private out(s: string): void {
        this.h.willSend();
        this.h.send(s);
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (e.isComposing || e.keyCode === 229) return; // IME or a soft keyboard owns it
        if (this.h.shortcut(e)) {
            e.preventDefault();
            return;
        }
        // Ctrl+V (Cmd+V elsewhere) is the browser's paste: the paste event delivers it.
        if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') return;
        const ev = {
            key: e.key,
            code: e.code,
            ctrlKey: e.ctrlKey || this.sticky.ctrl,
            altKey: e.altKey || this.sticky.alt,
            shiftKey: e.shiftKey,
            metaKey: e.metaKey,
        };
        const seq = mapKey(ev, { backspace: this.h.backspace() });
        if (seq !== undefined) {
            e.preventDefault();
            this.clearSticky();
            this.out(seq);
        }
    }

    private onBeforeInput(e: InputEvent): void {
        switch (e.inputType) {
            case 'insertLineBreak':
            case 'insertParagraph':
                // Soft-keyboard Enter. Keep the textarea single-line.
                e.preventDefault();
                this.flush();
                this.out('\r');
                break;
            case 'insertFromPaste':
            case 'insertFromDrop':
                // Handled by the paste event (or not at all for drops).
                e.preventDefault();
                break;
            default:
                break;
        }
    }

    /** Diff the textarea against what was sent: predictive text replaces whole words. */
    private flush(): void {
        const cur = this.textarea.value;
        let p = 0;
        const max = Math.min(cur.length, this.last.length);
        while (p < max && cur[p] === this.last[p]) p++;
        const deleted = this.last.length - p;
        let inserted = cur.slice(p).replace(/\r?\n/g, '\r');
        this.last = cur;
        if (cur.length > 64 || cur.length < SENTINEL.length) this.resetCaret();
        if (!deleted && !inserted) return;
        // Sticky Ctrl/Alt from the key bar apply to the first typed character.
        if (inserted && (this.sticky.ctrl || this.sticky.alt)) {
            const first = inserted[0];
            const seq = mapKey({ key: first, ctrlKey: this.sticky.ctrl, altKey: this.sticky.alt }, { backspace: this.h.backspace() });
            this.clearSticky();
            if (seq !== undefined) inserted = seq + inserted.slice(1);
        }
        const bs = keySequence('Backspace', { backspace: this.h.backspace() })!;
        this.out(bs.repeat(deleted) + inserted);
    }
}

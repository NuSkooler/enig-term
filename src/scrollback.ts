// Scrollback view control: turns wheel, touch drag and keys into a view
// offset (lines back from live) on the core. The cells themselves live in the
// WASM core, which also keeps the view anchored while output scrolls.

export interface ScrollTarget {
    /** Lines held. */
    scrollback_len(): number;
    /** Set the offset; returns the offset actually set (clamped). */
    set_view_offset(n: number): number;
    view_offset(): number;
    rows(): number;
}

export class ScrollbackView {
    /** Fractional lines not yet applied (trackpads send small deltas). */
    private pending = 0;
    onChange: ((offset: number) => void) | null = null;

    private readonly target: () => ScrollTarget;

    // (No parameter properties: Node's type stripping loads this file in the unit tests.)
    constructor(target: () => ScrollTarget) {
        this.target = target;
    }

    get offset(): number {
        return this.target().view_offset();
    }

    get active(): boolean {
        return this.offset > 0;
    }

    /** Move by `lines` (positive = further back). Returns the new offset. */
    scrollBy(lines: number): number {
        const t = this.target();
        const before = t.view_offset();
        const next = Math.max(0, Math.min(t.scrollback_len(), before + lines));
        const now = t.set_view_offset(next);
        if (now !== before) this.onChange?.(now);
        return now;
    }

    page(dir: 1 | -1): number {
        return this.scrollBy(dir * Math.max(1, this.target().rows() - 1));
    }

    toLive(): void {
        this.pending = 0;
        if (this.offset !== 0) {
            this.target().set_view_offset(0);
            this.onChange?.(0);
        }
    }

    /**
     * A wheel event's delta in lines (deltaMode 0 = pixels, 1 = lines, 2 =
     * pages), positive = up/back. `linePx` is the on-screen height of a row.
     */
    wheel(deltaY: number, deltaMode: number, linePx: number): number {
        let lines: number;
        if (deltaMode === 1) lines = deltaY;
        else if (deltaMode === 2) lines = deltaY * this.target().rows();
        else lines = deltaY / Math.max(1, linePx);
        this.pending += -lines;
        const whole = this.pending > 0 ? Math.floor(this.pending) : Math.ceil(this.pending);
        if (!whole) return this.offset;
        this.pending -= whole;
        return this.scrollBy(whole);
    }

    /** Touch drag: `dyPx` since the last move, positive = finger moved down (= look back). */
    drag(dyPx: number, linePx: number): number {
        return this.wheel(-dyPx, 0, linePx);
    }
}

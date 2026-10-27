//! `CaptureScreen`: icy_engine's `TextScreen` with two things a terminal
//! shell needs and the engine does not provide in a usable form.
//!
//! * **Cell scrollback.** icy_engine keeps scrollback as RGBA strips (40 KB per
//!   scrolled line, 1 MB per clear). We keep the cells instead: the glyph byte,
//!   attributes and font slot of every line that scrolls off the top, bounded
//!   by a line count. Lines are re-rendered through the engine on demand, so
//!   they stay pixel-identical to the live screen.
//! * **Per-cell OSC 8 links.** icy_engine records a link as a start position and
//!   a length that do not move when the screen scrolls. We tag each cell written
//!   while a link is open with an interned link id, shift the tags with the
//!   scroll, and carry them into scrollback.
//!
//! The wrapper works because the scrolling logic lives in `EditableScreen`'s
//! *default* methods (`lf`, `print_single_cell`, `check_scrolling_on_caret_down`,
//! ...), which call `self.scroll_up()`. They run on the wrapper, so its
//! `scroll_up` sees every scroll. Everything `TextScreen` implements itself is
//! forwarded unchanged (delegate.rs, generated), except the handful of methods
//! below.
//!
//! It also bounds the decoded sixel images a screen holds (`add_sixel`):
//! icy_engine caps one image, but keeps every image that is not completely
//! covered by a later one.

use std::collections::{HashMap, VecDeque};

use icy_engine::{AttributedChar, EditableScreen, Line, Position, Screen, Sixel, TextPane, TextScreen};

/// One line of scrollback: the cells as they were when the line left the screen.
pub struct ScrollLine {
    pub cells: Vec<AttributedChar>,
    /// Link id per cell (0 = none). Empty when the line has no links.
    pub links: Vec<u32>,
}

/// Interned OSC 8 targets. Id 0 means "no link".
#[derive(Default)]
pub struct LinkTable {
    urls: Vec<String>,
    ids: HashMap<String, u32>,
}

/// The scrollback line limit when the shell does not set one.
pub const DEFAULT_SCROLLBACK_LINES: usize = 2000;

/// More distinct links than this in one session are not tracked (a host
/// cannot grow our memory without bound by sending fresh URLs).
const MAX_LINKS: usize = 8192;
/// Longest URL we keep.
const MAX_URL_LEN: usize = 2048;

/// Decoded sixel pixels (RGBA bytes) one screen keeps. A new image evicts the
/// oldest until the rest fit; an image larger than this alone is dropped.
/// (icy_engine allows 256 MB per image, and a few KB of sixel decode to that.)
pub const SIXEL_BUDGET: usize = 64 << 20;

impl LinkTable {
    pub fn intern(&mut self, url: &str) -> u32 {
        if let Some(&id) = self.ids.get(url) {
            return id;
        }
        if self.urls.len() >= MAX_LINKS || url.len() > MAX_URL_LEN {
            return 0;
        }
        self.urls.push(url.to_string());
        let id = self.urls.len() as u32;
        self.ids.insert(url.to_string(), id);
        id
    }

    pub fn get(&self, id: u32) -> Option<&str> {
        if id == 0 {
            return None;
        }
        self.urls.get(id as usize - 1).map(String::as_str)
    }
}

/// Link tag of one live cell: the id and the glyph it was written with. A tag
/// only counts while the cell still holds that glyph and is still underlined
/// (icy_engine underlines link text), so erases, insertions and deletions that
/// move cells without telling us simply drop the link instead of moving it.
#[derive(Clone, Copy, Default)]
struct LinkTag {
    id: u32,
    ch: char,
}

pub struct CaptureScreen {
    pub inner: TextScreen,
    pub scrollback: VecDeque<ScrollLine>,
    pub scrollback_limit: usize,
    /// Lines ever pushed (monotonic), so a view can stay anchored while output scrolls.
    pub pushed: u64,
    /// Also keep the non-blank part of the screen when it is cleared (CSI 2J, FF).
    pub capture_on_clear: bool,
    pub links: LinkTable,
    /// Link id of the OSC 8 span currently open (0 = none). Set by the sink:
    /// icy_engine keeps its own copy private.
    pub active_link: u32,
    /// Test hook: always let icy_engine scroll (to compare against fast_scroll).
    pub slow_scroll: bool,
    grid: Vec<LinkTag>,
    grid_dims: (i32, i32),
    any_link: bool,
}

impl CaptureScreen {
    pub fn new(inner: TextScreen) -> Self {
        CaptureScreen {
            inner,
            scrollback: VecDeque::new(),
            scrollback_limit: DEFAULT_SCROLLBACK_LINES,
            pushed: 0,
            capture_on_clear: true,
            links: LinkTable::default(),
            active_link: 0,
            slow_scroll: false,
            grid: Vec::new(),
            grid_dims: (0, 0),
            any_link: false,
        }
    }

    pub fn set_scrollback_limit(&mut self, lines: usize) {
        self.scrollback_limit = lines;
        while self.scrollback.len() > lines {
            self.scrollback.pop_front();
        }
    }

    fn ensure_grid(&mut self) {
        let dims = (self.inner.width().max(0), self.inner.height().max(0));
        if dims != self.grid_dims {
            self.grid = vec![LinkTag::default(); (dims.0 * dims.1) as usize];
            self.grid_dims = dims;
        }
    }

    fn grid_index(&self, x: i32, y: i32) -> Option<usize> {
        let (w, h) = self.grid_dims;
        (x >= 0 && y >= 0 && x < w && y < h).then(|| (y * w + x) as usize)
    }

    /// Link id of a live cell, validated against what the cell holds now.
    pub fn live_link(&self, x: i32, y: i32) -> u32 {
        if !self.any_link || self.grid_dims != (self.inner.width(), self.inner.height()) {
            return 0;
        }
        let Some(i) = self.grid_index(x, y) else { return 0 };
        let tag = self.grid[i];
        if tag.id == 0 {
            return 0;
        }
        let c = self.inner.char_at(Position::new(x, y));
        if c.ch == tag.ch && c.attribute.is_underlined() { tag.id } else { 0 }
    }

    fn row_links(&self, y: i32) -> Vec<u32> {
        if !self.any_link {
            return Vec::new();
        }
        let w = self.inner.width();
        let v: Vec<u32> = (0..w).map(|x| self.live_link(x, y)).collect();
        if v.iter().any(|&id| id != 0) { v } else { Vec::new() }
    }

    fn push_line(&mut self, cells: Vec<AttributedChar>, links: Vec<u32>) {
        self.pushed += 1;
        if self.scrollback_limit == 0 {
            return;
        }
        if self.scrollback.len() >= self.scrollback_limit {
            self.scrollback.pop_front();
        }
        self.scrollback.push_back(ScrollLine { cells, links });
    }

    fn row_cells(&self, y: i32) -> Vec<AttributedChar> {
        (0..self.inner.width()).map(|x| self.inner.char_at(Position::new(x, y))).collect()
    }

    fn row_is_blank(&self, y: i32) -> bool {
        (0..self.inner.width()).all(|x| {
            let c = self.inner.char_at(Position::new(x, y));
            (c.ch == ' ' || c.ch == '\0') && c.attribute.background() == 0 && !c.attribute.is_underlined()
        })
    }

    /// Shift link tags of rows `top..=bottom` by one row (up when `up`).
    fn shift_grid(&mut self, top: i32, bottom: i32, up: bool) {
        if !self.any_link {
            return;
        }
        self.ensure_grid();
        let w = self.grid_dims.0 as usize;
        let (top, bottom) = (top.max(0), bottom.min(self.grid_dims.1 - 1));
        if top >= bottom || w == 0 {
            return;
        }
        let (t, b) = (top as usize, bottom as usize);
        if up {
            self.grid.copy_within((t + 1) * w..(b + 1) * w, t * w);
            self.grid[b * w..(b + 1) * w].fill(LinkTag::default());
        } else {
            self.grid.copy_within(t * w..b * w, (t + 1) * w);
            self.grid[t * w..(t + 1) * w].fill(LinkTag::default());
        }
    }

    // --- the overridden EditableScreen methods ---------------------------------

    pub(crate) fn capture_set_char(&mut self, pos: Position, ch: AttributedChar) {
        self.inner.set_char(pos, ch);
        let id = self.active_link;
        if id == 0 && !self.any_link {
            return;
        }
        self.ensure_grid();
        self.any_link = true;
        if let Some(i) = self.grid_index(pos.x, pos.y) {
            self.grid[i] = LinkTag { id, ch: ch.ch };
        }
    }

    pub(crate) fn capture_print_char(&mut self, ch: AttributedChar) {
        if self.inner.unicode_width() {
            // Unicode (utf8ansi) printing scrolls inside TextScreen; those
            // scrolls bypass the wrapper. Not used by the ANSI-BBS profile.
            self.inner.print_char(ch);
        } else {
            EditableScreen::print_single_cell(self, ch);
        }
    }

    pub(crate) fn capture_scroll_up(&mut self) {
        let st = self.inner.terminal_state();
        let terminal = st.is_terminal_buffer;
        let margins = st.margins_top_bottom();
        let full_width = st.margins_left_right().is_none();
        let top = self.inner.first_editable_line();
        let bottom = self.inner.last_editable_line();
        // Lines leaving the top of the screen are scrollback, whether or not a
        // bottom margin is set (a status line under a scroll region).
        if terminal && full_width && top == 0 {
            let cells = self.row_cells(0);
            let links = self.row_links(0);
            self.push_line(cells, links);
        }
        if full_width {
            self.shift_grid(top, bottom, true);
        }
        if self.fast_scroll(top, bottom, true) {
            return;
        }
        // icy_engine rasterises the top line into its pixel scrollback when no
        // margins are set, even with a limit of 0. Margins equal to the whole
        // screen scroll identically and skip that raster.
        let h = self.inner.height();
        if terminal && margins.is_none() && h > 0 {
            self.inner.terminal_state_mut().set_margins_top_bottom(0, h - 1);
            self.inner.scroll_up();
            self.inner.terminal_state_mut().set_margins_top_bottom(1, 0); // top > bottom: None
        } else {
            self.inner.scroll_up();
        }
    }

    /// Scroll rows `top..=bottom` by moving whole lines instead of copying
    /// every cell (icy_engine copies cell by cell through `set_char`, about
    /// 80 us per scrolled 80x25 screen; this is a few hundred nanoseconds).
    /// Only for the plain case: full width, no Unicode graphemes, no sixels,
    /// an unlocked visible layer. Returns false when the engine must do it.
    fn fast_scroll(&mut self, top: i32, bottom: i32, up: bool) -> bool {
        if self.slow_scroll || self.inner.unicode_width() || self.inner.terminal_state().margins_left_right().is_some() {
            return false;
        }
        let w = self.inner.width();
        let blank = AttributedChar::new(' ', self.inner.caret.attribute);
        let cur = self.inner.current_layer;
        let Some(layer) = self.inner.buffer.layers.get(cur) else { return false };
        let p = &layer.properties;
        if !layer.sixels.is_empty() || p.is_locked || !p.is_visible || p.has_alpha_channel || top < 0 || bottom < top || bottom >= layer.height() {
            return false;
        }
        self.inner.end_grapheme();
        let layer = &mut self.inner.buffer.layers[cur];
        let (t, b) = (top as usize, bottom as usize);
        if layer.lines.len() <= b {
            layer.lines.resize(b + 1, Line::create(layer.size().width));
        }
        let mut fresh = Line::create(w);
        fresh.chars.fill(blank);
        if up {
            layer.lines.remove(t);
            layer.lines.insert(b, fresh);
        } else {
            layer.lines.remove(b);
            layer.lines.insert(t, fresh);
        }
        true
    }

    pub(crate) fn capture_scroll_down(&mut self) {
        if self.inner.terminal_state().margins_left_right().is_none() {
            let (top, bottom) = (self.inner.first_editable_line(), self.inner.last_editable_line());
            self.shift_grid(top, bottom, false);
            if self.fast_scroll(top, bottom, false) {
                return;
            }
        }
        self.inner.scroll_down();
    }

    pub(crate) fn capture_clear_screen(&mut self) {
        let terminal = self.inner.terminal_state().is_terminal_buffer;
        if terminal && self.capture_on_clear {
            let mut last = -1;
            for y in (0..self.inner.height()).rev() {
                if !self.row_is_blank(y) {
                    last = y;
                    break;
                }
            }
            for y in 0..=last {
                let cells = self.row_cells(y);
                let links = self.row_links(y);
                self.push_line(cells, links);
            }
        }
        if terminal {
            // Same as TextScreen::clear_screen, minus its 1 MB pixel scrollback
            // chunk: with is_terminal_buffer off it skips the chunk and the
            // resize, and we redo the resize.
            self.inner.terminal_state_mut().is_terminal_buffer = false;
            self.inner.clear_screen();
            self.inner.terminal_state_mut().is_terminal_buffer = true;
            let size = self.inner.terminal_state().size();
            self.inner.buffer.set_size(size);
        } else {
            self.inner.clear_screen();
        }
        self.grid.fill(LinkTag::default());
    }

    /// icy_engine's `scroll_left`/`scroll_right` index every line of the
    /// editable region and assume each is a full row wide; after a clear the
    /// line list is empty and they panic (`CSI 2J CSI SP @`). Pad first: an
    /// invisible cell reads the same as a missing one.
    pub(crate) fn capture_scroll_horizontal(&mut self, left: bool) {
        self.sanitize_margins();
        let h = self.inner.height().max(0) as usize;
        let w = self.inner.width().max(0) as usize + 1;
        let layer = self.inner.current_layer;
        if let Some(l) = self.inner.buffer.layers.get_mut(layer) {
            if l.lines.len() < h {
                l.lines.resize(h, Line::default());
            }
            for line in l.lines.iter_mut().take(h) {
                if line.chars.len() < w {
                    line.chars.resize(w, AttributedChar::invisible());
                }
            }
        } else {
            return;
        }
        if left { self.inner.scroll_left() } else { self.inner.scroll_right() }
    }

    /// icy_engine stores scroll margins unchecked (`CSI 1;9999 r`), and a
    /// resize can leave them outside the screen; row and column loops later
    /// index with them. Keep them inside the screen.
    pub fn sanitize_margins(&mut self) {
        let (w, h) = (self.inner.width(), self.inner.height());
        let st = self.inner.terminal_state_mut();
        if let Some((t, b)) = st.margins_top_bottom() {
            if b >= h || t < 0 || t >= h {
                st.set_margins_top_bottom(t.clamp(0, (h - 1).max(0)), b.min(h - 1));
            }
        }
        if let Some((l, r)) = st.margins_left_right() {
            if r >= w || l < 0 || l >= w {
                // set_margins_left_right is a no-op unless DECLRMM is on.
                let (l, r) = (l.clamp(0, (w - 1).max(0)), r.min(w - 1));
                st.clear_margins_left_right();
                if st.dec_left_right_margins() {
                    st.set_margins_left_right(l, r);
                }
            }
        }
    }

    pub(crate) fn capture_clear_scrollback(&mut self) {
        self.scrollback.clear();
        self.inner.clear_scrollback();
    }

    pub(crate) fn capture_add_sixel(&mut self, pos: Position, sixel: Sixel) {
        if sixel.picture_data.len() > SIXEL_BUDGET {
            return;
        }
        // TextScreen::add_sixel drops the images the new one covers, then appends it.
        self.inner.add_sixel(pos, sixel);
        let images = &mut self.inner.buffer.layers[0].sixels;
        let mut total: usize = images.iter().map(|s| s.picture_data.len()).sum();
        let mut evict = 0;
        while total > SIXEL_BUDGET && evict + 1 < images.len() {
            total -= images[evict].picture_data.len();
            evict += 1;
        }
        images.drain(..evict);
    }
}

/// Bodies of the methods CaptureScreen implements itself, spliced into the
/// generated `impl EditableScreen for CaptureScreen` in delegate.rs.
#[macro_export]
macro_rules! icy_capture_overrides {
    () => {
        fn set_char(&mut self, pos: Position, ch: AttributedChar) {
            self.capture_set_char(pos, ch)
        }
        fn print_char(&mut self, ch: AttributedChar) {
            self.capture_print_char(ch)
        }
        fn scroll_up(&mut self) {
            self.capture_scroll_up()
        }
        fn scroll_down(&mut self) {
            self.capture_scroll_down()
        }
        fn clear_screen(&mut self) {
            self.capture_clear_screen()
        }
        fn clear_scrollback(&mut self) {
            self.capture_clear_scrollback()
        }
        fn scroll_left(&mut self) {
            self.capture_scroll_horizontal(true)
        }
        fn scroll_right(&mut self) {
            self.capture_scroll_horizontal(false)
        }
        fn add_sixel(&mut self, pos: Position, sixel: icy_engine::Sixel) {
            self.capture_add_sixel(pos, sixel)
        }
    };
}

/// A plain screen of the same kind, for composing the scrollback view.
pub fn view_screen_from(live: &TextScreen) -> TextScreen {
    let mut v = live.clone();
    v.caret.visible = false;
    let _ = Screen::clear_selection(&mut v);
    v
}

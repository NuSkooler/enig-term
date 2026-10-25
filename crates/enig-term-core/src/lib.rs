//! enig-term-core: the emulation core of enig-term.
//!
//! A thin wasm-bindgen wrapper around icy_engine (MIT OR Apache-2.0, see NOTICE).
//! The engine owns the parser, the screen model and the CPU rasteriser. This
//! wrapper adds what a browser terminal needs on top of it:
//!
//! * incremental `feed()` (the icy parsers keep their state across calls, so a
//!   sequence split over two WebSocket frames is fine);
//! * a host-request event queue. icy_engine's `ScreenSink` ignores
//!   `CommandSink::request()` (icy_term answers DA/CPR itself in
//!   `terminal_thread.rs`), so we wrap the sink, capture each request together
//!   with the state needed to answer it *at the moment it was made*, and hand
//!   the events to the TypeScript shell, which owns every reply;
//! * dirty-line partial rendering into a reusable RGBA buffer;
//! * cursor, font and aspect getters;
//! * runtime font loading that takes priority over the embedded font table.

use std::collections::HashMap;

use icy_engine::{
    AttributedChar, BitFont, EditableScreen, FontSelectionState, IceMode, Position, Rectangle, RenderOptions, ScreenMode, ScreenSink, Size,
    TerminalEmulation,
};
use icy_parser_core::{
    AnsiMusic, CaretShape, CommandParser, CommandSink, DecMode, DeviceControlString, ErrorLevel, IgsCommand, OperatingSystemCommand, ParseError, RipCommand,
    SkypixCommand, TerminalCommand, TerminalRequest, ViewDataCommand,
};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

fn install_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            console_error(&format!("enig-term-core panic: {info}"));
        }));
    });
}

/// Highest SyncTERM font number with a built-in table entry in icy_engine.
const LAST_BUILTIN_FONT: usize = 42;

/// Wraps icy_engine's `ScreenSink` and intercepts what a terminal shell needs.
struct CoreSink<'a> {
    inner: ScreenSink<'a>,
    events: &'a mut Vec<Value>,
    fonts: &'a HashMap<usize, BitFont>,
    sync_output: &'a mut bool,
    passthrough_sync: bool,
    /// Set for changes that alter pixels without touching cells (palette, fonts, images).
    needs_full: &'a mut bool,
}

impl CoreSink<'_> {
    fn screen(&mut self) -> &mut dyn EditableScreen {
        self.inner.screen_mut()
    }

    /// Same bookkeeping icy_engine's private `set_font_selection_success` does.
    fn font_selected(&mut self, nr: usize) {
        let s = self.screen();
        s.terminal_state_mut().font_selection_state = FontSelectionState::Success;
        s.caret_mut().set_font_page(nr as u8);
        let attr = s.caret().attribute;
        let st = s.terminal_state_mut();
        match (attr.is_bold(), attr.is_blinking()) {
            (true, true) => st.high_intensity_blink_attribute_font_slot = nr,
            (false, true) => st.blink_attribute_font_slot = nr,
            (true, false) => st.high_intensity_attribute_font_slot = nr,
            (false, false) => st.normal_attribute_font_slot = nr,
        }
    }

    fn request_event(&mut self, req: &TerminalRequest) -> Option<Value> {
        let s = self.inner.screen();
        Some(match req {
            TerminalRequest::DeviceAttributes => json!({"t": "req", "k": "da"}),
            TerminalRequest::SecondaryDeviceAttributes => json!({"t": "req", "k": "da2"}),
            TerminalRequest::ExtendedDeviceAttributes => json!({"t": "req", "k": "ctda"}),
            TerminalRequest::DeviceStatusReport => json!({"t": "req", "k": "dsr"}),
            TerminalRequest::CursorPositionReport => {
                // Captured now: later bytes of the same chunk may move the caret.
                let p = s.caret_position();
                let y = p.y.min(s.height() - 1) + 1;
                let x = p.x.min(s.width() - 1) + 1;
                json!({"t": "req", "k": "cpr", "row": y, "col": x})
            }
            TerminalRequest::ScreenSizeReport => json!({"t": "req", "k": "size", "rows": s.height(), "cols": s.width()}),
            TerminalRequest::FontStateReport => {
                let st = s.terminal_state();
                let r = match st.font_selection_state {
                    FontSelectionState::NoRequest => 99,
                    FontSelectionState::Success => 0,
                    FontSelectionState::Failure => 1,
                };
                json!({"t": "req", "k": "fontstate", "result": r, "slots": [
                    st.normal_attribute_font_slot, st.high_intensity_attribute_font_slot,
                    st.blink_attribute_font_slot, st.high_intensity_blink_attribute_font_slot]})
            }
            TerminalRequest::FontModeReport => {
                let st = s.terminal_state();
                let mut modes: Vec<u32> = Vec::new();
                if st.origin_mode == icy_engine::OriginMode::WithinMargins {
                    modes.push(6);
                }
                if st.auto_wrap_mode == icy_engine::AutoWrapMode::AutoWrap {
                    modes.push(7);
                }
                if s.caret().visible {
                    modes.push(25);
                }
                if s.ice_mode() == IceMode::Ice {
                    modes.push(33);
                }
                if s.caret().blinking {
                    modes.push(35);
                }
                json!({"t": "req", "k": "fontmode", "modes": modes})
            }
            TerminalRequest::FontDimensionReport => {
                let d = s.font_dimensions();
                json!({"t": "req", "k": "fontdim", "h": d.height, "w": d.width})
            }
            other => json!({"t": "req", "k": "other", "dbg": format!("{other:?}")}),
        })
    }
}

impl CommandSink for CoreSink<'_> {
    fn print(&mut self, text: &[u8]) {
        self.inner.print(text);
    }

    fn emit(&mut self, cmd: TerminalCommand) {
        match cmd {
            TerminalCommand::CsiFontSelection { slot, font_number } => {
                let nr = font_number as usize;
                if let Some(font) = self.fonts.get(&nr) {
                    // Runtime-loaded font wins over the embedded table.
                    let f = font.clone();
                    self.screen().set_font(nr, f);
                    self.font_selected(nr);
                } else if nr > LAST_BUILTIN_FONT && self.inner.screen().font(nr).is_some() {
                    // DCS-loaded slot: icy_engine selects it but then reports
                    // Failure because the built-in lookup returns None.
                    self.font_selected(nr);
                } else {
                    self.inner.emit(cmd);
                }
                *self.needs_full = true; // the slot's glyphs may have changed under existing cells
                let ok = self.inner.screen().terminal_state().font_selection_state == FontSelectionState::Success;
                self.events.push(json!({"t": "font", "slot": slot, "font": nr, "ok": ok}));
            }
            TerminalCommand::CsiDecSetMode(DecMode::SynchronizedOutput, enabled) if !self.passthrough_sync => {
                // icy_engine stamps std::time::Instant::now() here, which panics
                // on wasm32-unknown-unknown. Track the mode ourselves.
                *self.sync_output = enabled;
            }
            TerminalCommand::Bell => {
                self.events.push(json!({"t": "bell"}));
            }
            _ => self.inner.emit(cmd),
        }
    }

    fn emit_rip(&mut self, cmd: RipCommand) {
        self.inner.emit_rip(cmd);
    }
    fn emit_skypix(&mut self, cmd: SkypixCommand) {
        self.inner.emit_skypix(cmd);
    }
    fn emit_igs(&mut self, cmd: IgsCommand) {
        self.inner.emit_igs(cmd);
    }
    fn emit_view_data(&mut self, cmd: ViewDataCommand) {
        self.inner.emit_view_data(cmd);
    }

    fn device_control(&mut self, dcs: DeviceControlString) {
        if let DeviceControlString::LoadFont(slot, data) = &dcs {
            self.events.push(json!({"t": "fontload", "slot": slot, "bytes": data.len()}));
        }
        *self.needs_full = true;
        self.inner.device_control(dcs);
    }

    fn operating_system_command(&mut self, osc: OperatingSystemCommand) {
        match &osc {
            OperatingSystemCommand::Hyperlink { uri, .. } if !uri.is_empty() => {
                self.events.push(json!({"t": "link", "uri": String::from_utf8_lossy(uri)}));
            }
            OperatingSystemCommand::SetPaletteColor(..) | OperatingSystemCommand::ResetPaletteColors(_) => *self.needs_full = true,
            _ => {}
        }
        self.inner.operating_system_command(osc);
    }

    fn aps(&mut self, data: &[u8]) {
        // CTerm audio and other APC strings: the shell owns audio.
        self.events.push(json!({"t": "apc", "data": String::from_utf8_lossy(data)}));
        *self.needs_full = true; // may be an inline image
        self.inner.aps(data);
    }

    fn play_music(&mut self, music: AnsiMusic) {
        self.events.push(json!({"t": "music", "actions": music.music_actions.len()}));
        self.inner.play_music(music);
    }

    fn request(&mut self, request: TerminalRequest) {
        if let Some(ev) = self.request_event(&request) {
            self.events.push(ev);
        }
        self.inner.request(request);
    }

    fn report_error(&mut self, error: ParseError, level: ErrorLevel) {
        // icy_parser_core has no TerminalRequest for `CSI = Ps n` beyond 1..3;
        // other values (ENiGMA's OSC 8 probe is `CSI = 6 n`) only surface as a
        // MalformedSequence error. Recover the request from it.
        if let ParseError::MalformedSequence { sequence: Some(seq), .. } = &error {
            if let Some(rest) = seq.strip_prefix("CSI = ") {
                if let Some(n) = rest.strip_suffix(" n").and_then(|v| v.trim().parse::<u32>().ok()) {
                    self.events.push(json!({"t": "req", "k": "ctsmrr", "n": n}));
                    return;
                }
            }
        }
        self.inner.report_error(error, level);
    }

    fn begin_igs_xor_mode(&mut self) {
        self.inner.begin_igs_xor_mode();
    }
    fn end_igs_xor_mode(&mut self) {
        self.inner.end_igs_xor_mode();
    }
}

fn emulation_from(name: &str) -> TerminalEmulation {
    match name {
        "utf8ansi" => TerminalEmulation::Utf8Ansi,
        "avatar" => TerminalEmulation::Avatar,
        "ascii" => TerminalEmulation::Ascii,
        _ => TerminalEmulation::Ansi,
    }
}

#[wasm_bindgen]
pub struct Core {
    screen: Box<dyn EditableScreen>,
    parser: Box<dyn CommandParser + Send>,
    emulation: TerminalEmulation,
    events: Vec<Value>,
    fonts: HashMap<usize, BitFont>,
    sync_output: bool,
    passthrough_sync: bool,

    frame: Vec<u8>,
    frame_w: u32,
    frame_h: u32,
    region_y: u32,
    region_h: u32,
    blink_on: bool,
    rendered_blink: bool,
    force_full: bool,
    last_rendered_rows: (u32, u32),
    /// Cells as of the last render. icy_engine's dirty-line tracking misses
    /// scrolls (scroll_up/down write cells through the layer without marking
    /// lines), so partial renders also diff against this snapshot.
    snapshot: Vec<AttributedChar>,
    snapshot_dims: (i32, i32),
    ice_rendered: bool,
}

#[wasm_bindgen]
impl Core {
    /// `emulation`: "ansi" (default), "utf8ansi", "avatar", "ascii".
    #[wasm_bindgen(constructor)]
    pub fn new(cols: u32, rows: u32, emulation: &str) -> Core {
        install_panic_hook();
        let emulation = emulation_from(emulation);
        let (mut screen, parser) = ScreenMode::Vga(cols as i32, rows as i32).create_screen(emulation, None);
        screen.terminal_state_mut().is_terminal_buffer = true;
        Core {
            screen,
            parser,
            emulation,
            events: Vec::new(),
            fonts: HashMap::new(),
            sync_output: false,
            passthrough_sync: false,
            frame: Vec::new(),
            frame_w: 0,
            frame_h: 0,
            region_y: 0,
            region_h: 0,
            blink_on: true,
            rendered_blink: true,
            force_full: true,
            last_rendered_rows: (0, 0),
            snapshot: Vec::new(),
            snapshot_dims: (0, 0),
            ice_rendered: false,
        }
    }

    /// Feed host bytes (after Telnet de-framing). Returns the number of queued events.
    pub fn feed(&mut self, bytes: &[u8]) -> u32 {
        let mut sink = CoreSink {
            inner: ScreenSink::new(&mut *self.screen),
            events: &mut self.events,
            fonts: &self.fonts,
            sync_output: &mut self.sync_output,
            passthrough_sync: self.passthrough_sync,
            needs_full: &mut self.force_full,
        };
        self.parser.parse(bytes, &mut sink);
        self.events.len() as u32
    }

    /// JSON array of events since the last call: host requests (`t:"req"`),
    /// font switches, bell, OSC 8 links, APC strings, ANSI music.
    pub fn take_events(&mut self) -> String {
        let out = Value::Array(std::mem::take(&mut self.events)).to_string();
        out
    }

    pub fn resize(&mut self, cols: u32, rows: u32) {
        let size = Size::new(cols as i32, rows as i32);
        self.screen.set_size(size);
        self.screen.terminal_state_mut().set_size(size);
        let p = self.screen.caret_position();
        let clamped = icy_engine::Position::new(p.x.min(cols as i32 - 1), p.y.min(rows as i32 - 1));
        self.screen.caret_mut().set_position(clamped);
        self.screen.mark_dirty();
        self.force_full = true;
    }

    /// Reset to a fresh terminal of the same size and emulation (also drops runtime fonts' selection).
    pub fn reset(&mut self) {
        let (c, r) = (self.cols(), self.rows());
        let (mut screen, parser) = ScreenMode::Vga(c as i32, r as i32).create_screen(self.emulation, None);
        screen.terminal_state_mut().is_terminal_buffer = true;
        self.screen = screen;
        self.parser = parser;
        self.force_full = true;
    }

    pub fn set_blink(&mut self, on: bool) {
        self.blink_on = on;
    }

    pub fn force_full_render(&mut self) {
        self.force_full = true;
    }

    /// Only for the spike's API-fit test: forward `CSI ? 2026 h` to icy_engine unmodified.
    pub fn debug_passthrough_sync(&mut self, on: bool) {
        self.passthrough_sync = on;
    }

    /// Render what changed. Returns 0 = nothing, 1 = partial (rows region_y..+region_h),
    /// 2 = full frame. The pixels are at `frame_ptr()`, `region_h * frame_width * 4` bytes.
    pub fn render(&mut self, full: bool) -> u32 {
        let (cw, ch) = self.cell_px();
        let (cols, rows) = (self.screen.width().max(1), self.screen.height().max(1));
        let w = cols as u32 * cw;
        let h = rows as u32 * ch;
        let dims_changed = w != self.frame_w || h != self.frame_h || self.snapshot_dims != (cols, rows);
        let blink_changed = self.blink_on != self.rendered_blink;
        let ice = self.ice_colors();
        let ice_changed = ice != self.ice_rendered;
        let engine_dirty = self.screen.get_dirty_lines();
        self.screen.clear_dirty_lines();

        let opts = |rect: Rectangle, blink: bool| RenderOptions {
            rect: rect.into(),
            blink_on: blink,
            ..Default::default()
        };
        let whole = Rectangle::from(0, 0, cols, rows);

        if full || self.force_full || dims_changed || blink_changed || ice_changed {
            let (size, px) = self.screen.render_to_rgba_raw(&opts(whole, self.blink_on));
            self.frame = px;
            self.frame_w = size.width as u32;
            self.frame_h = size.height as u32;
            self.region_y = 0;
            self.region_h = self.frame_h;
            self.force_full = false;
            self.rendered_blink = self.blink_on;
            self.ice_rendered = ice;
            self.last_rendered_rows = (0, rows as u32);
            self.take_snapshot(cols, rows, None);
            return 2;
        }

        // Rows the engine marked, widened by rows whose cells differ from the snapshot.
        let (mut lo, mut hi) = match engine_dirty {
            Some((a, b)) => (a.max(0), b.min(rows)),
            None => (rows, 0),
        };
        if let Some((a, b)) = self.diff_rows(cols, rows) {
            lo = lo.min(a);
            hi = hi.max(b);
        }
        if lo >= hi {
            return 0;
        }
        let px_rect = Rectangle::from(0, lo * ch as i32, w as i32, (hi - lo) * ch as i32);
        let (size, px) = self.screen.render_region_to_rgba_raw(px_rect, &opts(whole, self.blink_on));
        self.frame = px;
        self.region_y = lo as u32 * ch;
        self.region_h = size.height as u32;
        self.last_rendered_rows = (lo as u32, hi as u32);
        self.take_snapshot(cols, rows, Some((lo, hi)));
        1
    }

    /// Microseconds-cheap check for whether anything needs drawing (cells or forced).
    pub fn has_changes(&self) -> bool {
        if self.force_full || self.blink_on != self.rendered_blink || self.screen.get_dirty_lines().is_some() {
            return true;
        }
        let (cols, rows) = (self.screen.width().max(1), self.screen.height().max(1));
        self.snapshot_dims != (cols, rows) || self.diff_rows(cols, rows).is_some()
    }

    pub fn frame_ptr(&self) -> *const u8 {
        self.frame.as_ptr()
    }
    pub fn frame_len(&self) -> u32 {
        self.frame.len() as u32
    }
    pub fn frame_width(&self) -> u32 {
        self.frame_w
    }
    pub fn frame_height(&self) -> u32 {
        self.frame_h
    }
    pub fn region_y(&self) -> u32 {
        self.region_y
    }
    pub fn region_h(&self) -> u32 {
        self.region_h
    }
    pub fn rendered_row_start(&self) -> u32 {
        self.last_rendered_rows.0
    }
    pub fn rendered_row_end(&self) -> u32 {
        self.last_rendered_rows.1
    }

    pub fn cols(&self) -> u32 {
        self.screen.width() as u32
    }
    pub fn rows(&self) -> u32 {
        self.screen.height() as u32
    }

    // --- cursor ---------------------------------------------------------
    pub fn cursor_x(&self) -> i32 {
        self.screen.caret_position().x
    }
    pub fn cursor_y(&self) -> i32 {
        self.screen.caret_position().y
    }
    pub fn cursor_visible(&self) -> bool {
        self.screen.caret().visible
    }
    pub fn cursor_blinking(&self) -> bool {
        self.screen.caret().blinking
    }
    /// 0 = block, 1 = underline, 2 = bar.
    pub fn cursor_shape(&self) -> u32 {
        match self.screen.caret().shape {
            CaretShape::Block => 0,
            CaretShape::Underline => 1,
            CaretShape::Bar => 2,
        }
    }

    // --- fonts and geometry ---------------------------------------------
    /// The font page the caret writes with (SyncTERM font number after `CSI Ps1;Ps2 SP D`).
    pub fn font_page(&self) -> u32 {
        self.screen.caret().font_page() as u32
    }
    /// Raster cell width in pixels (9 when SAUCE letter spacing is on).
    pub fn cell_width(&self) -> u32 {
        self.cell_px().0
    }
    pub fn cell_height(&self) -> u32 {
        self.cell_px().1
    }
    pub fn font_name(&self, slot: u32) -> String {
        self.screen.font(slot as usize).map(|f| f.name().to_string()).unwrap_or_default()
    }
    pub fn font_size_of(&self, slot: u32) -> Vec<u32> {
        self.screen
            .font(slot as usize)
            .map(|f| vec![f.width as u32, f.height as u32])
            .unwrap_or_default()
    }
    /// icy_engine's legacy aspect stretch (Y factor), 1.0 unless SAUCE asked for it.
    pub fn engine_aspect_stretch(&self) -> f32 {
        if self.screen.use_aspect_ratio() { self.screen.aspect_ratio_stretch_factor() } else { 1.0 }
    }
    pub fn ice_colors(&self) -> bool {
        self.screen.ice_mode() == IceMode::Ice || self.screen.terminal_state().ice_colors
    }
    pub fn sync_output(&self) -> bool {
        self.sync_output
    }

    /// Load a bitmap font (PSF1/PSF2 or raw 8xN, as icy_engine's `BitFont::from_bytes`
    /// accepts) into `slot`. It takes priority over the embedded table for
    /// `CSI Ps1 ; slot SP D`. If `slot` is the active page it applies at once.
    pub fn load_font(&mut self, slot: u32, name: &str, data: &[u8]) -> Result<String, JsError> {
        let font = BitFont::from_bytes(name.to_string(), data).map_err(|e| JsError::new(&format!("{e}")))?;
        let info = format!("{}x{}", font.width, font.height);
        self.fonts.insert(slot as usize, font.clone());
        if slot == 0 || self.screen.font(slot as usize).is_some() {
            if slot == 0 {
                self.screen.set_font_dimensions(font.size());
            }
            self.screen.set_font(slot as usize, font);
        }
        self.screen.mark_dirty();
        self.force_full = true;
        Ok(info)
    }

    /// Display a SAUCE-tagged ANSI file the way a terminal would, honouring its
    /// SAUCE record (columns, rows, font, iCE, 9px, legacy aspect) via
    /// icy_engine's `apply_sauce`, then streaming the stripped bytes through the
    /// ANSI parser. Resets the screen first. Returns JSON describing the record.
    pub fn load_sauce_art(&mut self, data: &[u8]) -> Result<String, JsError> {
        let sauce = icy_sauce::SauceRecord::from_bytes(data).map_err(|e| JsError::new(&format!("{e}")))?;
        let body = icy_sauce::strip_sauce(data, icy_sauce::StripMode::All).to_vec();
        self.reset();
        let mut applied = (0u16, 0u16);
        if let Some(s) = &sauce {
            applied = self.screen.apply_sauce(s);
        }
        self.screen.caret_mut().visible = false;
        self.feed(&body);
        self.force_full = true;
        Ok(json!({
            "sauce": sauce.as_ref().map(|s| json!({"title": s.title().to_string(), "author": s.author().to_string()})),
            "applied": [applied.0, applied.1],
            "cols": self.screen.width(),
            "rows": self.screen.height(),
            "font": self.screen.font(0).map(|f| f.name().to_string()),
            "ice": self.ice_colors(),
            "letterSpacing": self.screen.use_letter_spacing(),
            "aspect": self.engine_aspect_stretch(),
        })
        .to_string())
    }

    /// Viewer path: load a whole art file through icy_engine's format loaders
    /// (SAUCE is parsed and applied: font, iCE, 9px, legacy aspect, size).
    /// Replaces the terminal screen. Returns JSON with what was applied.
    #[cfg(feature = "viewer")]
    pub fn load_document(&mut self, data: &[u8], ext: &str) -> Result<String, JsError> {
        let fmt = icy_engine::FileFormat::from_extension(ext).ok_or_else(|| JsError::new("unknown extension"))?;
        let doc = fmt.from_bytes(data, None).map_err(|e| JsError::new(&format!("{e}")))?;
        let sauce = doc.sauce_opt.as_ref().map(|s| {
            json!({
                "title": s.title().to_string(),
                "author": s.author().to_string(),
                "group": s.group().to_string(),
            })
        });
        let mut screen: Box<dyn EditableScreen> = Box::new(doc.screen);
        screen.caret_mut().visible = false;
        self.screen = screen;
        self.force_full = true;
        Ok(json!({
            "cols": self.screen.width(),
            "rows": self.screen.height(),
            "font": self.screen.font(0).map(|f| f.name().to_string()),
            "ice": self.ice_colors(),
            "letterSpacing": self.screen.use_letter_spacing(),
            "aspect": self.engine_aspect_stretch(),
            "sauce": sauce,
        })
        .to_string())
    }
}

impl Core {
    fn diff_rows(&self, cols: i32, rows: i32) -> Option<(i32, i32)> {
        if self.snapshot_dims != (cols, rows) {
            return Some((0, rows));
        }
        let (mut lo, mut hi) = (rows, 0);
        for y in 0..rows {
            let base = (y * cols) as usize;
            for x in 0..cols {
                if self.screen.char_at(Position::new(x, y)) != self.snapshot[base + x as usize] {
                    lo = lo.min(y);
                    hi = hi.max(y + 1);
                    break;
                }
            }
        }
        (lo < hi).then_some((lo, hi))
    }

    fn take_snapshot(&mut self, cols: i32, rows: i32, range: Option<(i32, i32)>) {
        if self.snapshot_dims != (cols, rows) || range.is_none() {
            self.snapshot.clear();
            self.snapshot.reserve((cols * rows) as usize);
            for y in 0..rows {
                for x in 0..cols {
                    self.snapshot.push(self.screen.char_at(Position::new(x, y)));
                }
            }
            self.snapshot_dims = (cols, rows);
            return;
        }
        let (lo, hi) = range.unwrap();
        for y in lo..hi {
            for x in 0..cols {
                self.snapshot[(y * cols + x) as usize] = self.screen.char_at(Position::new(x, y));
            }
        }
    }

    fn cell_px(&self) -> (u32, u32) {
        let f = self.screen.font(0).map(|f| (f.width as u32, f.height as u32)).unwrap_or((8, 16));
        let w = if self.screen.use_letter_spacing() && f.0 == 8 { 9 } else { f.0 };
        (w, f.1)
    }
}

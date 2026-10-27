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
//! * runtime font loading that takes priority over the embedded font table;
//! * cell scrollback and per-cell OSC 8 links (capture.rs), with a scrollback
//!   view rendered through the engine;
//! * CTerm audio: the APC strings the shell's audio engine needs, whole and
//!   as raw bytes (`take_apc`), `CSI = 7 n` requests, and CTerm "ANSI" music
//!   parsed here (scan.rs, music.rs). `feed` stops right after a music string
//!   or an `A;Wait`, so the shell can hold the rest of the stream (CTerm
//!   blocks there) and feed it again (`fed` says how far it got).

mod capture;
mod delegate;
mod fonts;
mod music;
mod scan;

use capture::{CaptureScreen, view_screen_from};
use fonts::{FontState, font_is_drawable, mode_height};
use music::MusicState;
use scan::{Found, Pass, Scan};
use std::collections::VecDeque;

use icy_engine::{
    AttributedChar, BitFont, EditableScreen, FontSelectionState, IceMode, Position, Rectangle, RenderOptions, Screen, ScreenMode, ScreenSink, Size,
    TerminalEmulation, TextPane, TextScreen,
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

/// The last panic message. wasm32 panics abort (a trap), so the shell reads
/// this from the dead instance before it replaces it.
static LAST_PANIC: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

fn install_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let msg = format!("{info}");
            if let Ok(mut last) = LAST_PANIC.try_lock() {
                last.clear();
                last.push_str(&msg);
            }
            console_error(&format!("enig-term-core panic: {msg}"));
        }));
    });
}

/// Message of the last panic in this instance ("" if none).
#[wasm_bindgen]
pub fn last_panic() -> String {
    LAST_PANIC.try_lock().map(|s| s.clone()).unwrap_or_default()
}


/// icy_engine's own scrollback keeps RGBA chunks (a 640x16 line is 40 KB; a full
/// clear is the whole 1 MB frame), up to gigabytes. We keep cells instead
/// (capture.rs), so the engine keeps none.
const ENGINE_SCROLLBACK_CHUNKS: usize = 0;

/// First CTerm font slot open to `DCS CTerm:Font` (reported as pF in `CSI = 1 n`).
/// The current CTerm manual defines built-in fonts up to 45 (43 Prestel,
/// 44 Atari ST, 45 RIPterm) and loadable ones above them; 43-45 have no
/// licensed font here, so a DCS load there is refused like any other
/// built-in slot, and a selection of them is refused (no font loaded).
const FIRST_LOADABLE_SLOT: usize = 46;

/// Default cap on one audio APC string kept for the shell (the shell sets its
/// own with `set_apc_limit`). icy_parser_core itself stops buffering a string
/// at 32 MiB.
const DEFAULT_APC_LIMIT: usize = 24 << 20;

/// APC strings the shell's audio engine handles: whole, as raw bytes.
fn is_audio_apc(d: &[u8]) -> bool {
    d.starts_with(b"SyncTERM:A;")
        || d.starts_with(b"SyncTERM:Q;")
        || d.starts_with(b"SyncTERM:C;S;")
        || d == b"SyncTERM:C;L"
        || d.starts_with(b"SyncTERM:C;L;")
}

/// `SyncTERM:A;Wait` blocks the stream in CTerm.
fn is_wait_apc(d: &[u8]) -> bool {
    d.strip_prefix(b"SyncTERM:A;Wait").is_some_and(|r| r.is_empty() || r[0] == b';')
}

/// State the sink shares with `Core` across feeds.
struct SinkState<'a> {
    events: &'a mut Vec<Value>,
    fonts: &'a mut FontState,
    sync_output: &'a mut bool,
    panic_on_sync: bool,
    /// Set for changes that alter pixels without touching cells (palette, fonts, images).
    needs_full: &'a mut bool,
    inline_images: bool,
    /// iCE colours as the host set them (`CSI ? 33 h/l`), and whether the
    /// profile lets them apply.
    host_ice: &'a mut bool,
    ice_allowed: bool,
    /// The profile's palette (ANSI order, 16 entries), restored by OSC 104.
    default_palette: Option<&'a [(u8, u8, u8)]>,
    /// CTerm music state (reset by RIS).
    music: &'a mut MusicState,
    /// Audio APC strings for the shell, and the size limit for one.
    apcs: &'a mut VecDeque<Vec<u8>>,
    apc_limit: usize,
    /// An APC asked to block the stream (`A;Wait`): `feed` stops after it.
    stop: &'a mut bool,
}

/// Wraps icy_engine's `ScreenSink` and intercepts what a terminal shell needs.
struct CoreSink<'a> {
    inner: ScreenSink<'a>,
    st: SinkState<'a>,
}

/// Set ANSI palette entries 0..16 (ANSI order) on a screen.
fn apply_palette(screen: &mut dyn EditableScreen, colors: &[(u8, u8, u8)], only: Option<&[u32]>) {
    for (i, &(r, g, b)) in colors.iter().enumerate().take(16) {
        if only.is_some_and(|o| !o.contains(&(i as u32))) {
            continue;
        }
        screen.palette_mut().set_color_rgb(icy_engine::ansi_to_internal_palette_index(i as u32), r, g, b);
    }
    screen.mark_dirty();
}

impl CoreSink<'_> {
    fn screen(&mut self) -> &mut dyn EditableScreen {
        self.inner.screen_mut()
    }

    /// Repeat counts beyond the screen size do nothing more on screen, but
    /// icy_engine loops over them: `CSI 65535 S` takes seconds.
    fn clamp_counts(&self, cmd: TerminalCommand) -> TerminalCommand {
        let s = self.inner.screen();
        let rows = s.height().clamp(1, u16::MAX as i32) as u16;
        let cols = s.width().clamp(1, u16::MAX as i32) as u16;
        use icy_parser_core::Direction;
        match cmd {
            TerminalCommand::CsiScroll(d @ (Direction::Up | Direction::Down), n) => TerminalCommand::CsiScroll(d, n.min(rows)),
            TerminalCommand::CsiScroll(d, n) => TerminalCommand::CsiScroll(d, n.min(cols)),
            TerminalCommand::CsiInsertCharacter(n) => TerminalCommand::CsiInsertCharacter(n.min(cols)),
            TerminalCommand::CsiDeleteCharacter(n) => TerminalCommand::CsiDeleteCharacter(n.min(cols)),
            TerminalCommand::CsiEraseCharacter(n) => TerminalCommand::CsiEraseCharacter(n.min(cols)),
            TerminalCommand::CsiInsertLine(n) => TerminalCommand::CsiInsertLine(n.min(rows)),
            TerminalCommand::CsiDeleteLine(n) => TerminalCommand::CsiDeleteLine(n.min(rows)),
            other => other,
        }
    }

    fn sanitize_margins(&mut self) {
        if let Some(cap) = self.capture() {
            cap.sanitize_margins();
        }
    }

    fn capture(&mut self) -> Option<&mut CaptureScreen> {
        self.inner.screen_mut().as_any_mut().downcast_mut::<CaptureScreen>()
    }

    /// `CSI Ps1 ; Ps2 SP D`. Only fonts the shell or a DCS has loaded at the
    /// current cell height are selectable; anything else is refused and the
    /// screen keeps its fonts (CTerm: "no action is taken").
    fn select_font(&mut self, ps1: u16, nr: u16) {
        let reason = if ps1 > 3 {
            Some("slot")
        } else if nr > 255 {
            Some("font")
        } else if !self.st.fonts.has(nr as u8) {
            Some("missing")
        } else {
            None
        };
        let ok = reason.is_none();
        if ok {
            let f = self.st.fonts.get(nr as u8).cloned().unwrap();
            let nr8 = nr as u8;
            self.st.fonts.slots[ps1 as usize] = nr8;
            let slots = self.st.fonts.slots;
            let s = self.screen();
            s.set_font(nr as usize, f);
            if ps1 == 0 {
                s.caret_mut().set_font_page(nr8);
            }
            let t = s.terminal_state_mut();
            t.font_selection_state = FontSelectionState::Success;
            t.normal_attribute_font_slot = slots[0] as usize;
            t.high_intensity_attribute_font_slot = slots[1] as usize;
            t.blink_attribute_font_slot = slots[2] as usize;
            t.high_intensity_blink_attribute_font_slot = slots[3] as usize;
            *self.st.needs_full = true; // the slot's glyphs may have changed under existing cells
        } else {
            self.screen().terminal_state_mut().font_selection_state = FontSelectionState::Failure;
        }
        let mut ev = json!({"t": "font", "slot": ps1, "font": nr, "ok": ok, "height": self.st.fonts.mode_h});
        if let Some(r) = reason {
            ev["reason"] = json!(r);
        }
        self.st.events.push(ev);
    }

    fn request_event(&mut self, req: &TerminalRequest) -> Option<Value> {
        let s = self.inner.screen();
        Some(match req {
            TerminalRequest::DeviceAttributes => json!({"t": "req", "k": "da"}),
            TerminalRequest::SecondaryDeviceAttributes => json!({"t": "req", "k": "da2"}),
            // Only `CSI < c` and `CSI < 0 c` are requests; with feature numbers
            // it is a reply (ours, echoed back) and is not answered.
            TerminalRequest::ExtendedDeviceAttributes(p) if matches!(p.as_slice(), [] | [0]) => json!({"t": "req", "k": "ctda"}),
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
                json!({"t": "req", "k": "fontstate", "first": FIRST_LOADABLE_SLOT, "result": r, "slots": self.st.fonts.slots})
            }
            TerminalRequest::FontModeReport => {
                // Modes set with CSI ? Pn h that CTerm reports, ascending.
                let st = s.terminal_state();
                let mut modes: Vec<u16> = Vec::new();
                if st.origin_mode == icy_engine::OriginMode::WithinMargins {
                    modes.push(6);
                }
                if st.auto_wrap_mode == icy_engine::AutoWrapMode::AutoWrap {
                    modes.push(7);
                }
                if s.caret().visible {
                    modes.push(25);
                }
                // CTerm's attribute modes (icy_engine applies them as text is written).
                for (m, on) in [
                    (31, st.bright_alt_charset),
                    (32, st.bright_intensity_disabled),
                    (33, *self.st.host_ice),
                    (34, st.blink_alt_charset),
                    (35, st.blink_disabled),
                ] {
                    if on {
                        modes.push(m);
                    }
                }
                json!({"t": "req", "k": "fontmode", "modes": modes})
            }
            TerminalRequest::FontDimensionReport => {
                let (w, h) = cell_px_of(s);
                json!({"t": "req", "k": "fontdim", "h": h, "w": w})
            }
            // APC SyncTERM:Q;JXL (icy_parser_core turns it into a request).
            TerminalRequest::JxlSupportReport => json!({"t": "req", "k": "jxl"}),
            // `CSI = 7 [; Pn ...] n` comes from the scanner, with all its
            // parameters as written (scan.rs).
            TerminalRequest::AudioChannelStateReport(_) | TerminalRequest::StateModeReport(7, _) => return None,
            // Other `CSI = Ps n` (ENiGMA's OSC 8 probe is `CSI = 6 n`). CTerm's
            // reports take no further parameters.
            TerminalRequest::StateModeReport(n, rest) if rest.is_empty() => json!({"t": "req", "k": "ctsmrr", "n": n}),
            other => json!({"t": "req", "k": "other", "dbg": format!("{other:?}")}),
        })
    }
}

/// Cell size in pixels: slot 0's font (icy_engine renders every cell at that
/// size), 9 wide when SAUCE letter spacing is on.
fn cell_px_of(s: &dyn Screen) -> (u32, u32) {
    let f = s.font(0).map(|f| (f.width as u32, f.height as u32)).unwrap_or((8, 16));
    let w = if s.use_letter_spacing() && f.0 == 8 { 9 } else { f.0 };
    (w, f.1)
}

impl CommandSink for CoreSink<'_> {
    fn print(&mut self, text: &[u8]) {
        // CTerm's alternate fonts (CSI ? 31 h, ? 34 h) and intensity/blink
        // disables (? 32 h, ? 35 h) are applied by icy_engine as it writes,
        // from the attribute slots select_font sets.
        self.inner.print(text);
    }

    fn emit(&mut self, cmd: TerminalCommand) {
        let cmd = self.clamp_counts(cmd);
        match cmd {
            TerminalCommand::CsiFontSelection { slot, font_number } => self.select_font(slot, font_number),
            TerminalCommand::CsiDecSetMode(DecMode::SynchronizedOutput, enabled) => {
                // The shell holds rendering while it is on (and owns the timeout).
                if self.st.panic_on_sync {
                    panic!("debug panic: CSI ? 2026 h (debug_panic_on_sync)");
                }
                *self.st.sync_output = enabled;
            }
            TerminalCommand::CsiDecSetMode(DecMode::IceColors, enabled) => {
                *self.st.host_ice = enabled;
                let on = enabled && self.st.ice_allowed;
                self.inner.emit(TerminalCommand::CsiDecSetMode(DecMode::IceColors, on));
            }
            TerminalCommand::EscReset => {
                self.inner.emit(cmd);
                self.st.fonts.reset_modes();
                *self.st.host_ice = false;
                *self.st.music = MusicState::default();
                let slot0 = self.st.fonts.get(0).cloned().unwrap_or_else(|| fonts::placeholder(self.st.fonts.mode_h));
                self.screen().set_font(0, slot0);
                if let Some(p) = self.st.default_palette {
                    apply_palette(self.inner.screen_mut(), p, None);
                }
                *self.st.needs_full = true;
            }
            TerminalCommand::Bell => {
                self.st.events.push(json!({"t": "bell"}));
            }
            _ => {
                self.inner.emit(cmd);
                self.sanitize_margins();
            }
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
            // Only CTerm's loadable slots, and only fonts the renderer can draw:
            // icy_engine takes any slot (0 replaces the font that sets the cell
            // size) and any size (a 0-high or 33+-high font panics the renderer).
            // The font is kept at its own height, so it can be selected while
            // the screen mode has that cell height (as in SyncTERM).
            let font = (FIRST_LOADABLE_SLOT..=255)
                .contains(slot)
                .then(|| BitFont::from_bytes(format!("DCS {slot}"), data).ok())
                .flatten()
                .filter(font_is_drawable);
            let mut ev = json!({"t": "fontload", "slot": slot, "bytes": data.len(), "ok": font.is_some()});
            if let Some(f) = font {
                let (slot8, h) = (*slot as u8, f.height);
                ev["height"] = json!(h);
                ev["width"] = json!(f.width);
                // Reloading a slot in use changes what its cells show at once.
                if h == self.st.fonts.mode_h && self.inner.screen().font(*slot).is_some() {
                    self.screen().set_font(*slot, f.clone());
                    *self.st.needs_full = true;
                }
                self.st.fonts.fonts.insert((slot8, h), f);
            }
            self.st.events.push(ev);
            return;
        }
        *self.st.needs_full = true;
        self.inner.device_control(dcs);
    }

    fn operating_system_command(&mut self, osc: OperatingSystemCommand) {
        let is_link = matches!(osc, OperatingSystemCommand::Hyperlink { .. });
        let mut reset_palette: Option<Vec<u32>> = None;
        match &osc {
            OperatingSystemCommand::SetTitle(t) | OperatingSystemCommand::SetWindowTitle(t) => {
                self.st.events.push(json!({"t": "title", "text": String::from_utf8_lossy(t)}));
            }
            OperatingSystemCommand::SetPaletteColor(..) => *self.st.needs_full = true,
            OperatingSystemCommand::ResetPaletteColors(idx) => {
                *self.st.needs_full = true;
                reset_palette = Some(idx.iter().map(|&i| i as u32).collect());
            }
            _ => {}
        }
        self.inner.operating_system_command(osc);
        if let (Some(idx), Some(p)) = (reset_palette, self.st.default_palette) {
            // OSC 104 resets to the profile's palette, not icy_engine's VGA one.
            apply_palette(self.inner.screen_mut(), p, if idx.is_empty() { None } else { Some(&idx) });
        }
        if is_link {
            // icy_engine decided whether the OSC 8 opened, closed or was ignored
            // (both parts must be UTF-8; an empty URI closes); cells written
            // from here on carry the link it holds now.
            let uri = self.inner.screen().terminal_state().active_hyperlink().map(|(u, _)| u.to_string());
            if let Some(u) = &uri {
                self.st.events.push(json!({"t": "link", "uri": u}));
            }
            if let Some(cap) = self.capture() {
                cap.active_link = uri.map_or(0, |u| cap.links.intern(&u));
            }
        }
    }

    fn aps(&mut self, data: &[u8]) {
        if is_audio_apc(data) {
            // CTerm audio: the shell's engine takes the bytes (take_apc).
            // Uploads are base64 files, so these can be megabytes.
            if is_wait_apc(data) {
                *self.st.stop = true;
            }
            if data.len() > self.st.apc_limit {
                self.st.events.push(json!({"t": "apc", "n": data.len(), "over": true}));
            } else {
                self.st.apcs.push_back(data.to_vec());
                self.st.events.push(json!({"t": "apc", "n": data.len()}));
            }
            return;
        }
        // Other APC strings: shown in the shell's log only.
        self.st.events.push(json!({"t": "apc", "data": String::from_utf8_lossy(&data[..data.len().min(4096)])}));
        // Inline images (SyncTERM DrawJXLBlob/DrawPPMBlob) are decoded in full
        // before icy_engine's size check, so a small file declaring a huge
        // image exhausts WASM memory. Off unless the shell enables them.
        if self.st.inline_images {
            *self.st.needs_full = true;
            self.inner.aps(data);
        }
    }

    fn play_music(&mut self, _music: AnsiMusic) {
        // Not reached: icy_parser_core's music option stays off; the scanner
        // takes CTerm music strings out of the stream before the parser.
    }

    fn request(&mut self, request: TerminalRequest) {
        if let Some(ev) = self.request_event(&request) {
            self.st.events.push(ev);
        }
        self.inner.request(request);
    }

    fn report_error(&mut self, error: ParseError, level: ErrorLevel) {
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

/// A fresh terminal screen and parser, the screen wrapped for capture.
fn create(cols: u32, rows: u32, emulation: TerminalEmulation) -> (Box<CaptureScreen>, Box<dyn CommandParser + Send>) {
    let (mut screen, parser) = ScreenMode::Vga(cols as i32, rows as i32).create_screen(emulation, None);
    screen.terminal_state_mut().is_terminal_buffer = true;
    screen.set_scrollback_buffer_size(ENGINE_SCROLLBACK_CHUNKS);
    // Every text emulation the shell offers is a TextScreen; take it out of the box.
    let text = match screen.as_any_mut().downcast_mut::<TextScreen>() {
        Some(t) => std::mem::take(t),
        None => TextScreen::new(Size::new(cols as i32, rows as i32)),
    };
    (Box::new(CaptureScreen::new(text)), parser)
}

/// Packed cell for the shell: bits 0-15 glyph code, 16-23 font slot, bit 24 = has a link.
fn pack_cell(c: &AttributedChar, link: u32) -> u32 {
    (c.ch as u32 & 0xffff) | ((c.attribute.font_page() as u32) << 16) | if link != 0 { 1 << 24 } else { 0 }
}

#[wasm_bindgen]
pub struct Core {
    screen: Box<CaptureScreen>,
    parser: Box<dyn CommandParser + Send>,
    emulation: TerminalEmulation,
    events: Vec<Value>,
    fonts: FontState,
    scan: Scan,
    music: MusicState,
    /// Audio APC strings not yet taken by the shell, and the limit for one.
    apcs: VecDeque<Vec<u8>>,
    apc_limit: usize,
    /// Bytes of the last `feed` that were processed.
    fed: u32,
    stop: bool,
    host_ice: bool,
    ice_allowed: bool,
    /// The profile's 16 ANSI colours (None: icy_engine's VGA palette).
    default_palette: Option<Vec<(u8, u8, u8)>>,
    /// icy_engine's own 16 colours, to go back to when a profile palette is cleared.
    engine_palette: Vec<(u8, u8, u8)>,
    sync_output: bool,
    panic_on_sync: bool,

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

    /// Lines scrolled back from live (0 = live view).
    view_offset: usize,
    view_dirty: bool,
    inline_images: bool,
}

#[wasm_bindgen]
impl Core {
    /// `emulation`: "ansi" (default), "utf8ansi", "avatar", "ascii".
    #[wasm_bindgen(constructor)]
    pub fn new(cols: u32, rows: u32, emulation: &str) -> Core {
        install_panic_hook();
        let emulation = emulation_from(emulation);
        let (mut screen, parser) = create(cols, rows, emulation);
        let fonts = FontState::new(rows);
        screen.set_font(0, fonts::placeholder(fonts.mode_h));
        screen.set_font_dimensions(Size::new(8, fonts.mode_h as i32));
        let engine_palette = (0..16u32).map(|i| screen.palette().rgb(icy_engine::ansi_to_internal_palette_index(i))).collect();
        Core {
            screen,
            parser,
            emulation,
            events: Vec::new(),
            fonts,
            scan: Scan::default(),
            music: MusicState::default(),
            apcs: VecDeque::new(),
            apc_limit: DEFAULT_APC_LIMIT,
            fed: 0,
            stop: false,
            host_ice: false,
            ice_allowed: true,
            default_palette: None,
            engine_palette,
            sync_output: false,
            panic_on_sync: false,
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
            view_offset: 0,
            view_dirty: false,
            inline_images: false,
        }
    }

    /// Feed host bytes (after Telnet de-framing). Returns the number of queued
    /// events. Processing stops early, right after a CTerm music string or an
    /// `APC SyncTERM:A;Wait` (CTerm holds the stream there until the music has
    /// played or the channel is idle): `fed()` is the number of bytes
    /// processed, and the shell feeds the rest again when it is ready.
    pub fn feed(&mut self, bytes: &[u8]) -> u32 {
        let pushed = self.screen.pushed;
        let n = bytes.len();
        let mut from = 0;
        let mut i = 0;
        let mut end = n;
        self.stop = false;
        while i < n {
            // Inside a string (an upload can be megabytes of base64): jump to
            // the next byte that can end it.
            if let Some(k) = self.scan.in_string() {
                let rest = &bytes[i..];
                let hit = if k == b']' { memchr::memchr2(0x1b, 0x07, rest) } else { memchr::memchr(0x1b, rest) };
                match hit {
                    Some(p) => i += p,
                    None => break,
                }
            }
            let (pass, found) = self.scan.step(bytes[i]);
            match pass {
                Pass::Byte => {}
                Pass::Drop => {
                    if from < i {
                        self.parse(&bytes[from..i]);
                    }
                    from = i + 1;
                }
                Pass::Instead(x) => {
                    if from < i {
                        self.parse(&bytes[from..i]);
                    }
                    self.parse(&[x]);
                    from = i + 1;
                }
            }
            let mut halt = false;
            match found {
                None => {}
                Some(Found::AudioReport(params)) => {
                    self.parse(&bytes[from..=i]);
                    from = i + 1;
                    self.events.push(json!({"t": "req", "k": "audio", "params": params}));
                }
                Some(Found::Music(buf, m_style)) => {
                    let p = music::play(&mut self.music, &buf, m_style);
                    let flat: Vec<i64> = p.notes.iter().flat_map(|n| [n.n as i64, n.on_ms as i64, n.off_ms as i64]).collect();
                    self.events.push(json!({"t": "music", "fg": p.foreground, "n": flat}));
                    halt = true;
                }
                Some(Found::ApcEnd) => {
                    self.parse(&bytes[from..=i]);
                    from = i + 1;
                    halt = self.stop;
                }
            }
            i += 1;
            if halt {
                end = i;
                break;
            }
        }
        if from < end {
            self.parse(&bytes[from..end]);
        }
        self.fed = end as u32;
        let added = (self.screen.pushed - pushed) as usize;
        if self.view_offset > 0 && added > 0 {
            // Keep a scrolled-back view on the same lines while output scrolls.
            self.view_offset = (self.view_offset + added).min(self.screen.scrollback.len());
            self.view_dirty = true;
        }
        self.events.len() as u32
    }

    /// Bytes the last `feed` processed (less than it was given when it
    /// stopped after music or `A;Wait`).
    pub fn fed(&self) -> u32 {
        self.fed
    }

    /// The oldest audio APC string not yet taken (each `{"t":"apc","n":..}`
    /// event has one, in order), or undefined.
    pub fn take_apc(&mut self) -> Option<Vec<u8>> {
        self.apcs.pop_front()
    }

    /// Longest audio APC string kept for `take_apc` (longer ones are reported
    /// with `"over": true` and dropped).
    pub fn set_apc_limit(&mut self, bytes: u32) {
        self.apc_limit = bytes as usize;
    }

    /// CTerm music introducers (`CSI = Ps M`): 0 `CSI |` only, 1 also `CSI N`
    /// (default), 2 also `CSI M`.
    pub fn music_mode(&self) -> u32 {
        self.scan.music_mode as u32
    }

    /// JSON array of events since the last call: host requests (`t:"req"`),
    /// font switches, bell, OSC 8 links, titles, APC strings, CTerm music
    /// (`{"t":"music","fg":bool,"n":[note, on ms, off ms, ...]}`).
    pub fn take_events(&mut self) -> String {
        Value::Array(std::mem::take(&mut self.events)).to_string()
    }

    pub fn resize(&mut self, cols: u32, rows: u32) {
        let h = mode_height(rows);
        if h != self.fonts.mode_h {
            self.switch_mode_height(h);
        }
        let size = Size::new(cols as i32, rows as i32);
        self.screen.set_size(size);
        self.screen.terminal_state_mut().set_size(size);
        let p = self.screen.caret_position();
        let clamped = icy_engine::Position::new(p.x.min(cols as i32 - 1), p.y.min(rows as i32 - 1));
        self.screen.caret_mut().set_position(clamped);
        self.screen.sanitize_margins();
        self.screen.mark_dirty();
        self.view_offset = 0;
        self.force_full = true;
    }

    /// Reset to a fresh terminal of the same size and emulation. Scrollback
    /// and its limit are kept (they are the session's history), and so are
    /// runtime-loaded fonts (they apply on the next selection).
    pub fn reset(&mut self) {
        let (c, r) = (self.cols(), self.rows());
        let (mut screen, parser) = create(c, r, self.emulation);
        // Loaded fonts stay (the next selection uses them); selections go.
        self.fonts.reset_modes();
        let slot0 = self.fonts.get(0).cloned().unwrap_or_else(|| fonts::placeholder(self.fonts.mode_h));
        screen.set_font_dimensions(slot0.size());
        screen.set_font(0, slot0);
        if let Some(p) = &self.default_palette {
            apply_palette(&mut *screen, p, None);
        }
        self.host_ice = false;
        self.scan.reset();
        self.music = MusicState::default();
        self.apcs.clear();
        screen.scrollback = std::mem::take(&mut self.screen.scrollback);
        screen.scrollback_limit = self.screen.scrollback_limit;
        screen.capture_on_clear = self.screen.capture_on_clear;
        screen.links = std::mem::take(&mut self.screen.links);
        screen.slow_scroll = self.screen.slow_scroll;
        screen.pushed = self.screen.pushed;
        self.screen = screen;
        self.parser = parser;
        self.sync_output = false;
        self.view_offset = 0;
        self.force_full = true;
    }

    // --- scrollback -----------------------------------------------------------

    /// Maximum scrollback lines (cells, not pixels). 0 keeps none.
    pub fn set_scrollback_lines(&mut self, lines: u32) {
        self.screen.set_scrollback_limit(lines as usize);
        self.view_offset = self.view_offset.min(self.screen.scrollback.len());
        self.view_dirty = true;
    }
    /// Lines currently held.
    pub fn scrollback_len(&self) -> u32 {
        self.screen.scrollback.len() as u32
    }
    /// Decoded sixel images the screen holds (tests, diagnostics).
    pub fn sixel_count(&self) -> u32 {
        self.screen.sixel_count() as u32
    }
    /// Also keep the screen's non-blank lines when it is cleared (default on).
    pub fn set_capture_on_clear(&mut self, on: bool) {
        self.screen.capture_on_clear = on;
    }
    pub fn clear_scrollback(&mut self) {
        self.screen.scrollback.clear();
        self.set_view_offset(0);
    }
    /// Show the screen `lines` lines back from live (0 = live). Returns the
    /// offset actually set (clamped to the scrollback held).
    pub fn set_view_offset(&mut self, lines: u32) -> u32 {
        let n = (lines as usize).min(self.screen.scrollback.len());
        if n != self.view_offset {
            if n == 0 {
                self.force_full = true;
            }
            self.view_offset = n;
            self.view_dirty = true;
        }
        n as u32
    }
    pub fn view_offset(&self) -> u32 {
        self.view_offset as u32
    }
    /// Lines that ever left the screen (also counting those not kept), so the
    /// shell can tell that the content under a selection has moved.
    pub fn lines_pushed(&self) -> f64 {
        self.screen.pushed as f64
    }

    // --- cells, for selection, copy and links ------------------------------------

    /// The displayed row `y` (view-aware) as packed cells (see `pack_cell`).
    pub fn row_cells(&self, y: u32) -> Vec<u32> {
        let cols = self.screen.width().max(0) as usize;
        let mut out = Vec::with_capacity(cols);
        match self.view_row(y as usize) {
            ViewRow::Back(i) => {
                let line = &self.screen.scrollback[i];
                for x in 0..cols {
                    let c = line.cells.get(x).copied().unwrap_or_default();
                    out.push(pack_cell(&c, line.links.get(x).copied().unwrap_or(0)));
                }
            }
            ViewRow::Live(r) => {
                for x in 0..cols as i32 {
                    let c = self.screen.char_at(Position::new(x, r as i32));
                    out.push(pack_cell(&c, self.screen.live_link(x, r as i32)));
                }
            }
        }
        out
    }

    /// OSC 8 target of the displayed cell (view-aware), or "" when none.
    pub fn link_at(&self, x: u32, y: u32) -> String {
        let id = match self.view_row(y as usize) {
            ViewRow::Back(i) => self.screen.scrollback[i].links.get(x as usize).copied().unwrap_or(0),
            ViewRow::Live(r) => self.screen.live_link(x as i32, r as i32),
        };
        self.screen.links.get(id).unwrap_or_default().to_string()
    }

    pub fn set_blink(&mut self, on: bool) {
        self.blink_on = on;
    }

    pub fn force_full_render(&mut self) {
        self.force_full = true;
    }

    /// Allow SyncTERM inline images (APC DrawJXLBlob/DrawPPMBlob). Off by
    /// default: the decoder has no memory bound (see `aps`).
    pub fn set_inline_images(&mut self, on: bool) {
        self.inline_images = on;
    }

    /// Test hook: scroll through icy_engine's own (cell-by-cell) path.
    pub fn debug_slow_scroll(&mut self, on: bool) {
        self.screen.slow_scroll = on;
    }

    /// Test hook: make `CSI ? 2026 h` panic, to exercise panic recovery.
    /// (It used to reach icy_engine's `Instant::now`, which panicked on
    /// wasm32; icy_engine uses web-time now.)
    pub fn debug_panic_on_sync(&mut self, on: bool) {
        self.panic_on_sync = on;
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

        if self.view_offset > 0 {
            let live_changed = engine_dirty.is_some() || self.diff_rows(cols, rows).is_some();
            if !(full || self.force_full || self.view_dirty || live_changed || dims_changed || blink_changed || ice_changed) {
                return 0;
            }
            let view = self.compose_view();
            let (size, px) = view.render_to_rgba_raw(&opts(whole, self.blink_on));
            self.set_full_frame(size, px, ice, rows);
            self.view_dirty = false;
            // The live cells were "seen"; diff from here when the view returns to live.
            self.take_snapshot(cols, rows, None);
            return 2;
        }

        if full || self.force_full || dims_changed || blink_changed || ice_changed {
            let (size, px) = self.screen.render_to_rgba_raw(&opts(whole, self.blink_on));
            self.set_full_frame(size, px, ice, rows);
            self.force_full = false;
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

    /// Cheap check for whether anything needs drawing (cells or forced).
    pub fn has_changes(&self) -> bool {
        if self.force_full || self.view_dirty || self.blink_on != self.rendered_blink || self.screen.get_dirty_lines().is_some() {
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
    /// Name of the font in `slot` at the current cell height ("" if none).
    pub fn font_name(&self, slot: u32) -> String {
        if slot > 255 {
            return String::new();
        }
        self.fonts.get(slot as u8).map(|f| f.name().to_string()).unwrap_or_default()
    }
    pub fn font_size_of(&self, slot: u32) -> Vec<u32> {
        if slot > 255 {
            return Vec::new();
        }
        self.fonts.get(slot as u8).map(|f| vec![f.width as u32, f.height as u32]).unwrap_or_default()
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
    /// CTerm Last Column Flag mode (`CSI = 4 h`), for the `CSI = 4 n` report.
    pub fn last_column_flag(&self) -> bool {
        self.screen.terminal_state().last_column_flag_mode
    }

    /// Load a bitmap font (PSF1/PSF2, YAFF or raw 8xN, as icy_engine's
    /// `BitFont::from_bytes` accepts) for SyncTERM font number `slot`, at its
    /// own cell height. It becomes selectable with `CSI Ps1 ; slot SP D` while
    /// the screen mode has that height (and slot 0 sets the cell size). If
    /// the slot is already on screen it applies at once. Returns "WxH".
    pub fn load_font(&mut self, slot: u32, name: &str, data: &[u8]) -> Result<String, JsError> {
        if slot > 255 {
            return Err(JsError::new("font slot must be 0-255"));
        }
        let font = BitFont::from_bytes(name.to_string(), data).map_err(|e| JsError::new(&format!("{e}")))?;
        if !font_is_drawable(&font) {
            return Err(JsError::new(&format!("font size {}x{} is not drawable (max 8x32)", font.width, font.height)));
        }
        let info = format!("{}x{}", font.width, font.height);
        let h = font.height;
        self.fonts.fonts.insert((slot as u8, h), font.clone());
        let in_use = slot == 0 || self.screen.font(slot as usize).is_some() || self.fonts.slots.contains(&(slot as u8));
        if h == self.fonts.mode_h && in_use {
            if slot == 0 {
                self.screen.set_font_dimensions(font.size());
            }
            self.screen.set_font(slot as usize, font);
            self.screen.mark_dirty();
            self.force_full = true;
        }
        Ok(info)
    }

    /// Whether SyncTERM font `slot` can be selected now (a font of the current
    /// cell height is loaded for it).
    pub fn has_font(&self, slot: u32) -> bool {
        slot <= 255 && self.fonts.has(slot as u8)
    }

    /// Cell height the current screen mode uses (16, 14 or 8): the font height
    /// `load_font` needs for a slot to be selectable.
    pub fn mode_font_height(&self) -> u32 {
        self.fonts.mode_h as u32
    }

    /// Font numbers in the four CTerm attribute slots (normal, bright, blink, both).
    pub fn font_slots(&self) -> Vec<u32> {
        self.fonts.slots.iter().map(|&s| s as u32).collect()
    }

    /// Slots on screen now (in the engine's font table), for reloading after a
    /// cell height change.
    pub fn fonts_in_use(&self) -> Vec<u32> {
        (0..=255u32).filter(|&n| self.screen.font(n as usize).is_some()).collect()
    }

    /// Whether the host's `CSI ? 33 h` (iCE colours) takes effect. The Amiga
    /// profile turns it off; the host's setting is kept and applies again when
    /// allowed. Like iCE itself, it affects text written afterwards.
    pub fn set_ice_allowed(&mut self, on: bool) {
        self.ice_allowed = on;
        self.screen.terminal_state_mut().ice_colors = self.host_ice && on;
    }

    /// Set the 16 ANSI colours (48 bytes, RGB, ANSI order: SGR 30-37 then
    /// bright) as the default palette. OSC 4 still changes entries and OSC 104
    /// resets them to this palette.
    pub fn set_palette(&mut self, rgb: &[u8]) -> Result<(), JsError> {
        if rgb.len() != 48 {
            return Err(JsError::new("palette must be 16 RGB triplets (48 bytes)"));
        }
        let p: Vec<(u8, u8, u8)> = rgb.chunks(3).map(|c| (c[0], c[1], c[2])).collect();
        apply_palette(&mut *self.screen, &p, None);
        self.default_palette = Some(p);
        self.force_full = true;
        Ok(())
    }

    /// Back to icy_engine's VGA palette (and OSC 104 resets to it).
    pub fn clear_palette(&mut self) {
        let p = std::mem::take(&mut self.engine_palette);
        apply_palette(&mut *self.screen, &p, None);
        self.engine_palette = p;
        self.default_palette = None;
        self.force_full = true;
    }

    /// The 16 ANSI colours now (48 bytes, ANSI order), host changes included.
    pub fn palette_rgb(&self) -> Vec<u8> {
        (0..16u32)
            .flat_map(|i| {
                let (r, g, b) = self.screen.palette().rgb(icy_engine::ansi_to_internal_palette_index(i));
                [r, g, b]
            })
            .collect()
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
        let mut screen = Box::new(CaptureScreen::new(doc.screen));
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

enum ViewRow {
    /// Index into the scrollback.
    Back(usize),
    /// Row of the live screen.
    Live(usize),
}

impl Core {
    /// Which line the displayed row `y` shows, given the view offset.
    fn view_row(&self, y: usize) -> ViewRow {
        let back = self.screen.scrollback.len();
        let idx = back - self.view_offset.min(back) + y;
        if idx < back { ViewRow::Back(idx) } else { ViewRow::Live(idx - back) }
    }

    /// A copy of the live screen (same fonts, palette and modes) holding the
    /// rows the view shows, so the engine renders them pixel-identically.
    fn compose_view(&self) -> TextScreen {
        let live = &self.screen.inner;
        let mut v = view_screen_from(live);
        let (cols, rows) = (live.width(), live.height());
        let layer = v.current_layer;
        v.buffer.layers[layer].sixels.clear();
        for y in 0..rows {
            let row: Vec<AttributedChar> = match self.view_row(y as usize) {
                ViewRow::Back(i) => {
                    let cells = &self.screen.scrollback[i].cells;
                    (0..cols as usize).map(|x| cells.get(x).copied().unwrap_or_default()).collect()
                }
                ViewRow::Live(r) => (0..cols).map(|x| live.char_at(Position::new(x, r as i32))).collect(),
            };
            for (x, c) in row.into_iter().enumerate() {
                v.set_char(Position::new(x as i32, y), c);
            }
        }
        v
    }

    fn set_full_frame(&mut self, size: Size, px: Vec<u8>, ice: bool, rows: i32) {
        self.frame = px;
        self.frame_w = size.width as u32;
        self.frame_h = size.height as u32;
        self.region_y = 0;
        self.region_h = self.frame_h;
        self.rendered_blink = self.blink_on;
        self.ice_rendered = ice;
        self.last_rendered_rows = (0, rows as u32);
    }

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
        cell_px_of(&*self.screen)
    }

    fn parse(&mut self, bytes: &[u8]) {
        let mut sink = CoreSink {
            inner: ScreenSink::new(&mut *self.screen),
            st: SinkState {
                events: &mut self.events,
                fonts: &mut self.fonts,
                sync_output: &mut self.sync_output,
                panic_on_sync: self.panic_on_sync,
                needs_full: &mut self.force_full,
                inline_images: self.inline_images,
                host_ice: &mut self.host_ice,
                ice_allowed: self.ice_allowed,
                default_palette: self.default_palette.as_deref(),
                music: &mut self.music,
                apcs: &mut self.apcs,
                apc_limit: self.apc_limit,
                stop: &mut self.stop,
            },
        };
        self.parser.parse(bytes, &mut sink);
    }

    /// The screen mode's cell height changed (a resize to or from 28, 43 or
    /// 50 rows): put every slot on screen at the new height. Slots whose font
    /// is not loaded at that height leave the table (their cells draw with
    /// slot 0) and are reported, so the shell can load them.
    fn switch_mode_height(&mut self, h: u8) {
        self.fonts.mode_h = h;
        let mut missing = Vec::new();
        for n in self.fonts_in_use() {
            match self.fonts.get(n as u8).cloned() {
                Some(f) => self.screen.set_font(n as usize, f),
                None if n == 0 => {
                    self.screen.set_font(0, fonts::placeholder(h));
                    missing.push(0);
                }
                None => {
                    self.screen.remove_font(n as usize);
                    missing.push(n);
                }
            }
        }
        for &s in &self.fonts.slots {
            if !self.fonts.has(s) && !missing.contains(&(s as u32)) {
                missing.push(s as u32);
            }
        }
        self.screen.set_font_dimensions(Size::new(8, h as i32));
        self.events.push(json!({"t": "fontheight", "height": h, "missing": missing}));
        self.force_full = true;
    }
}

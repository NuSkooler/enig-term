//! Runtime fonts and CTerm font selection.
//!
//! enig-term compiles no font data into the WASM (the icy_engine build is
//! patched, see patches/icy_tools/). The shell fetches fonts and loads them
//! with `Core::load_font`; DCS `CTerm:Font` adds more. Every font is kept per
//! (slot, cell height): like SyncTERM, the cell height comes from the screen
//! mode (25 rows: 16, 28/43 rows: 14, 50 rows: 8), and a slot is selectable
//! only when a font of that height is loaded for it. A slot that has none is
//! refused (`pR = 1` in the font state report), never drawn blank.
//!
//! `CSI Ps1 ; Ps2 SP D` puts font Ps2 into attribute slot Ps1 (0 normal,
//! 1 bright, 2 blink, 3 bright+blink). The bright/blink slots take effect
//! under `CSI ? 31 h` / `CSI ? 34 h`; icy_engine ignores Ps1 and does not
//! know modes 31, 32, 34 or CTerm's 35, so the wrapper tracks them (a small
//! byte scanner in `feed`, see `DecScan`) and applies them as text is
//! printed. Like icy_engine, fonts are a property of each cell (written with
//! the font current at the time), not of the whole screen.

use std::collections::HashMap;

use icy_engine::BitFont;

/// Cell height of a screen of `rows` rows (icy_engine's `font_height_for_lines`).
pub fn mode_height(rows: u32) -> u8 {
    match rows {
        50 => 8,
        28 | 43 => 14,
        _ => 16,
    }
}

/// What icy_engine's renderer can draw: glyph rows are at most 8 bits wide and
/// a glyph holds at most 32 rows.
pub fn font_is_drawable(f: &BitFont) -> bool {
    (1..=8).contains(&f.width) && (1..=32).contains(&f.height)
}

/// A blank font that keeps the cell size right until the real one arrives.
pub fn placeholder(height: u8) -> BitFont {
    BitFont::create_8("", 8, height, &vec![0u8; 256 * height as usize])
}

#[derive(Default)]
pub struct FontState {
    /// (slot, height) -> font: the shell's (slots 0..=42) and DCS-loaded (43..=255).
    pub fonts: HashMap<(u8, u8), BitFont>,
    /// Font numbers in the four CTerm attribute slots (Ps1 0..=3).
    pub slots: [u8; 4],
    /// `CSI ? 31 h`: bold text uses slot 1 (and slot 3 with blink).
    pub alt_bright: bool,
    /// `CSI ? 32 h`: bold does not brighten.
    pub bright_disable: bool,
    /// `CSI ? 34 h`: blinking text uses slot 2 (and slot 3 with bold).
    pub alt_blink: bool,
    /// `CSI ? 35 h`: blinking text does not blink.
    pub blink_disable: bool,
    /// Cell height of the current screen mode.
    pub mode_h: u8,
}

impl FontState {
    pub fn new(rows: u32) -> Self {
        FontState { mode_h: mode_height(rows), ..Default::default() }
    }

    pub fn get(&self, slot: u8) -> Option<&BitFont> {
        self.fonts.get(&(slot, self.mode_h))
    }

    pub fn has(&self, slot: u8) -> bool {
        self.get(slot).is_some()
    }

    /// Back to power-on state (RIS): loaded fonts stay, selections and modes go.
    pub fn reset_modes(&mut self) {
        self.slots = [0; 4];
        self.alt_bright = false;
        self.bright_disable = false;
        self.alt_blink = false;
        self.blink_disable = false;
    }

    /// The attribute slot a cell with these attributes is drawn from.
    pub fn slot_index(&self, bold: bool, blink: bool) -> usize {
        match (self.alt_bright && bold, self.alt_blink && blink) {
            (true, true) => 3,
            (false, true) => 2,
            (true, false) => 1,
            (false, false) => 0,
        }
    }

    pub fn mode_report(&self) -> [(u16, bool); 4] {
        [(31, self.alt_bright), (32, self.bright_disable), (34, self.alt_blink), (35, self.blink_disable)]
    }
}

/// Finds `CSI ? Pn ; ... h|l` sequences that set CTerm modes icy_engine does
/// not parse (31, 32, 34, 35), across feed() chunks, so `feed` can split the
/// bytes there and apply the mode at the right point in the stream.
#[derive(Default)]
pub struct DecScan {
    state: u8,
    params: Vec<u16>,
    cur: u32,
}

impl DecScan {
    /// Feed one byte; returns `Some((params, set))` when a complete
    /// `CSI ? ... h|l` ends at this byte.
    pub fn step(&mut self, b: u8) -> Option<(Vec<u16>, bool)> {
        if b == 0x1b {
            self.state = 1;
            return None;
        }
        match self.state {
            1 => self.state = if b == b'[' { 2 } else { 0 },
            2 => {
                if b == b'?' {
                    self.state = 3;
                    self.params.clear();
                    self.cur = 0;
                } else {
                    self.state = 0;
                }
            }
            3 => match b {
                b'0'..=b'9' => self.cur = (self.cur * 10 + u32::from(b - b'0')).min(65535),
                b';' => {
                    if self.params.len() < 32 {
                        self.params.push(self.cur as u16);
                    }
                    self.cur = 0;
                }
                b'h' | b'l' => {
                    self.params.push(self.cur as u16);
                    self.state = 0;
                    return Some((std::mem::take(&mut self.params), b == b'h'));
                }
                _ => self.state = 0,
            },
            _ => {}
        }
        None
    }
}

/// True for the modes `DecScan` results are applied for.
pub fn is_cterm_font_mode(p: u16) -> bool {
    matches!(p, 31 | 32 | 34 | 35)
}

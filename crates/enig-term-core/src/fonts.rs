//! Runtime fonts and CTerm font selection.
//!
//! enig-term compiles no font data into the WASM (icy_engine is built without
//! its `embedded-fonts` feature). The shell fetches fonts and loads them
//! with `Core::load_font`; DCS `CTerm:Font` adds more. Every font is kept per
//! (slot, cell height): like SyncTERM, the cell height comes from the screen
//! mode (25 rows: 16, 28/43 rows: 14, 50 rows: 8), and a slot is selectable
//! only when a font of that height is loaded for it. A slot that has none is
//! refused (`pR = 1` in the font state report), never drawn blank.
//!
//! `CSI Ps1 ; Ps2 SP D` puts font Ps2 into attribute slot Ps1 (0 normal,
//! 1 bright, 2 blink, 3 bright+blink). The bright/blink slots take effect
//! under `CSI ? 31 h` / `CSI ? 34 h`, and `CSI ? 32 h` / `CSI ? 35 h` drop
//! the brightening and the blinking; icy_engine applies those modes as text
//! is written, from the attribute slots the wrapper sets. Like icy_engine,
//! fonts are a property of each cell (written with the font current at the
//! time), not of the whole screen.

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
    /// (slot, height) -> font: the shell's (slots 0..=45) and DCS-loaded (46..=255).
    pub fonts: HashMap<(u8, u8), BitFont>,
    /// Font numbers in the four CTerm attribute slots (Ps1 0..=3).
    pub slots: [u8; 4],
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

    /// Back to power-on state (RIS): loaded fonts stay, selections go (the
    /// attribute modes live in icy_engine's TerminalState, which RIS resets).
    pub fn reset_modes(&mut self) {
        self.slots = [0; 4];
    }
}

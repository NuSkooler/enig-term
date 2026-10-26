//! A byte scanner that runs in front of icy_engine's parser and finds the
//! CTerm sequences the wrapper handles itself, across feed() chunks:
//!
//! * `CSI ? Pn ; ... h|l` with CTerm's font modes 31, 32, 34, 35 (icy_engine
//!   does not parse them), applied at the right point in the stream;
//! * `CSI = 7 [; Pn ...] n`, the CTerm audio state report request (icy_engine
//!   only knows `CSI = 1..3 n`, and a two-parameter request is an error there);
//! * `CSI = Ps M`, which sets the "ANSI" music introducers (CTSAM);
//! * the music introducers themselves (`CSI |`, `CSI N` in mode 1 or 2,
//!   `CSI M` without parameters in mode 2) and the music string up to its
//!   SO (0x0E). The string never reaches icy_engine: its own music parser
//!   (`MusicOption`, off here) differs from CTerm in octaves, dotted notes,
//!   lower case and what happens to a bad string (see music.rs);
//! * the end of every APC string, so `feed` can stop right after one that
//!   blocks the stream (`SyncTERM:A;Wait`).
//!
//! It tracks just enough state to ignore those inside DCS, OSC, APC, PM and
//! SOS strings, which end at ST (OSC also at BEL) exactly as icy_engine's
//! parser ends them.

/// What to do with the byte just scanned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pass {
    /// Give it to icy_engine.
    Byte,
    /// Keep it from icy_engine (music string bytes).
    Drop,
    /// Give icy_engine this byte instead (the final byte of a music
    /// introducer becomes `|`, which icy_engine ignores with music off, so
    /// its CSI state ends cleanly and `CSI M` never deletes a line).
    Instead(u8),
}

/// Something that completed at the byte just scanned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    /// `CSI ? params h` (true) or `l` (false).
    DecMode(Vec<u16>, bool),
    /// `CSI = 7 ... n`: the parameters, 7 first.
    AudioReport(Vec<u16>),
    /// A complete music string (without the SO), and whether the introducer
    /// was `CSI M` or `CSI |` (true: a leading F/B/L/S/N sets the style).
    Music(Vec<u8>, bool),
    /// An APC string ended (ST).
    ApcEnd,
}

/// CTerm's limit on a music string (SyncTERM's musicbuf is 1024 bytes).
pub const MUSIC_MAX: usize = 1022;

/// Characters a music string may contain; any other byte ends it unplayed.
pub fn is_music_char(b: u8) -> bool {
    matches!(b, b'a'..=b'g' | b'A'..=b'G' | b'l' | b'L' | b'm' | b'M' | b'n' | b'N' | b'o' | b'O' | b'p' | b'P' | b's' | b'S' | b't' | b'T' | b'0'..=b'9' | b'.' | b'-' | b'+' | b'#' | b'<' | b'>' | b' ')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum St {
    Ground,
    Esc,
    Csi,
    /// Inside a string: the introducer (`P`, `]`, `_`, `^`, `X`).
    Str(u8),
    StrEsc(u8),
    /// Inside a music string; true for the M-style introducers.
    Music(bool),
}

pub struct Scan {
    st: St,
    prefix: u8,
    params: Vec<u16>,
    cur: u32,
    digits: bool,
    odd: bool,
    music: Vec<u8>,
    /// CTSAM: 0 = only `CSI |`, 1 = also `CSI N` (the CTerm default), 2 = also `CSI M`.
    pub music_mode: u8,
}

impl Default for Scan {
    fn default() -> Self {
        Scan { st: St::Ground, prefix: 0, params: Vec::new(), cur: 0, digits: false, odd: false, music: Vec::new(), music_mode: 1 }
    }
}

impl Scan {
    /// Back to power-on state (RIS).
    pub fn reset(&mut self) {
        *self = Scan::default();
    }

    /// Inside a DCS/OSC/APC/PM/SOS string body (the caller may skip ahead
    /// to the next ESC, or BEL for OSC, without scanning each byte).
    pub fn in_string(&self) -> Option<u8> {
        match self.st {
            St::Str(k) => Some(k),
            _ => None,
        }
    }

    fn csi_start(&mut self) {
        self.st = St::Csi;
        self.prefix = 0;
        self.params.clear();
        self.cur = 0;
        self.digits = false;
        self.odd = false;
    }

    fn push_param(&mut self) {
        if self.params.len() < 32 {
            self.params.push(self.cur.min(65535) as u16);
        }
        self.cur = 0;
    }

    pub fn step(&mut self, b: u8) -> (Pass, Option<Found>) {
        match self.st {
            St::Music(m_style) => {
                if b == 0x0e {
                    self.st = St::Ground;
                    return (Pass::Drop, Some(Found::Music(std::mem::take(&mut self.music), m_style)));
                }
                if is_music_char(b) {
                    if self.music.len() < MUSIC_MAX {
                        self.music.push(b);
                    }
                } else {
                    // CTerm leaves music capture and tosses the buffer; the
                    // byte that ended it is consumed too.
                    self.music.clear();
                    self.st = St::Ground;
                }
                (Pass::Drop, None)
            }
            St::Str(k) => {
                if b == 0x1b {
                    self.st = St::StrEsc(k);
                } else if b == 0x07 && k == b']' {
                    self.st = St::Ground;
                }
                (Pass::Byte, None)
            }
            St::StrEsc(k) => {
                if b == b'\\' {
                    self.st = St::Ground;
                    return (Pass::Byte, (k == b'_').then_some(Found::ApcEnd));
                }
                // ESC was payload. icy_engine takes the next byte as payload
                // too in DCS and APC strings, and looks at it again in OSC,
                // PM and SOS strings.
                self.st = if matches!(k, b'P' | b'_') {
                    St::Str(k)
                } else if b == 0x1b {
                    St::StrEsc(k)
                } else if b == 0x07 && k == b']' {
                    St::Ground
                } else {
                    St::Str(k)
                };
                (Pass::Byte, None)
            }
            St::Ground => {
                if b == 0x1b {
                    self.st = St::Esc;
                }
                (Pass::Byte, None)
            }
            St::Esc => {
                match b {
                    b'[' => self.csi_start(),
                    // RIS: CTerm's music mode is back to its default.
                    b'c' => {
                        self.music_mode = 1;
                        self.st = St::Ground;
                    }
                    b'P' | b']' | b'_' | b'^' | b'X' => self.st = St::Str(b),
                    0x1b => {}
                    _ => self.st = St::Ground,
                }
                (Pass::Byte, None)
            }
            St::Csi => self.csi_byte(b),
        }
    }

    fn csi_byte(&mut self, b: u8) -> (Pass, Option<Found>) {
        match b {
            b'0'..=b'9' => {
                self.cur = (self.cur * 10 + u32::from(b - b'0')).min(65535);
                self.digits = true;
            }
            b';' => {
                self.push_param();
                self.digits = true; // "has parameters"
            }
            b'<' | b'=' | b'>' | b'?' => {
                if self.prefix == 0 && !self.digits {
                    self.prefix = b;
                } else {
                    self.odd = true;
                }
            }
            b':' | 0x20..=0x2f => self.odd = true,
            0x1b => self.st = St::Esc,
            0x18 | 0x1a => self.st = St::Ground,
            0x00..=0x1f => {} // C0 controls execute inside a CSI
            0x40..=0x7e => return self.csi_final(b),
            _ => self.st = St::Ground,
        }
        (Pass::Byte, None)
    }

    fn csi_final(&mut self, b: u8) -> (Pass, Option<Found>) {
        self.st = St::Ground;
        if self.odd {
            return (Pass::Byte, None);
        }
        let had_params = self.digits;
        if had_params {
            self.push_param();
        }
        let params = std::mem::take(&mut self.params);
        match (self.prefix, b) {
            (b'?', b'h' | b'l') => (Pass::Byte, Some(Found::DecMode(params, b == b'h'))),
            (b'=', b'n') if params.first() == Some(&7) => (Pass::Byte, Some(Found::AudioReport(params))),
            (b'=', b'M') => {
                match params.first().copied().unwrap_or(0) {
                    m @ 0..=2 => self.music_mode = m as u8,
                    _ => {}
                }
                (Pass::Byte, None)
            }
            (0, b'|') => self.music_start(true),
            (0, b'N') if self.music_mode >= 1 => self.music_start(false),
            (0, b'M') if self.music_mode == 2 && !had_params => self.music_start(true),
            _ => (Pass::Byte, None),
        }
    }

    fn music_start(&mut self, m_style: bool) -> (Pass, Option<Found>) {
        self.st = St::Music(m_style);
        self.music.clear();
        (Pass::Instead(b'|'), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(s: &mut Scan, bytes: &[u8]) -> (Vec<u8>, Vec<Found>) {
        let mut out = Vec::new();
        let mut found = Vec::new();
        for &b in bytes {
            let (p, f) = s.step(b);
            match p {
                Pass::Byte => out.push(b),
                Pass::Instead(x) => out.push(x),
                Pass::Drop => {}
            }
            found.extend(f);
        }
        (out, found)
    }

    #[test]
    fn music_and_modes() {
        let mut s = Scan::default();
        let (out, f) = run(&mut s, b"a\x1b[|MFT120cde\x0eb\x1b[M\x1b[=2M\x1b[MBc\x0e\x1b[2M");
        assert_eq!(out, b"a\x1b[|b\x1b[M\x1b[=2M\x1b[|\x1b[2M");
        assert_eq!(f, vec![Found::Music(b"MFT120cde".to_vec(), true), Found::Music(b"Bc".to_vec(), true)]);
    }

    #[test]
    fn strings_hide_sequences() {
        let mut s = Scan::default();
        let (_, f) = run(&mut s, b"\x1b]0;\x1b[|x\x07\x1b_SyncTERM:A;Wait;C=2\x1b\\\x1b[=7;2n");
        assert_eq!(f, vec![Found::ApcEnd, Found::AudioReport(vec![7, 2])]);
    }
}

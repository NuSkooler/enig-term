//! CTerm "ANSI" music: the PLAY-statement subset in the CTerm manual
//! ("ANSI" Music), parsed into notes for the shell's synthesiser.
//!
//! The scanner (scan.rs) collects the string between the introducer and SO;
//! this turns it into (note number, sounding ms, silent ms) triples with
//! CTerm's state rules: tempo, octave, note length, articulation and
//! foreground/background persist from one string to the next and reset with
//! the terminal (RIS). Timing follows SyncTERM's arithmetic (integer
//! milliseconds: a whole note is 240000 / tempo, dotted 360000 / tempo, then
//! divided by the length; articulation takes 1/8 (normal), 0 (legato) or 1/4
//! (staccato) of it as silence).
//!
//! Pitch follows the manual: note number 0 is C in octave 0 (65.406 Hz),
//! twelve per octave, octaves 0-6 (default 4), `N0`-`N71` by number; the
//! shell maps numbers to equal-tempered frequencies. SyncTERM's code plays
//! letter notes one semitone above that (it indexes its table with
//! octave * 12 + 1); we follow the manual. icy_engine's own music parser maps
//! octave 4 two octaves lower, folds octaves 0-2 together, shortens dotted
//! notes with an explicit length, rejects lower case and prints a bad
//! string as text, so it is not used.

/// Articulation (CTerm's noteshape).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Normal,
    Legato,
    Staccato,
}

#[derive(Debug, Clone)]
pub struct MusicState {
    pub tempo: u32,
    pub octave: i32,
    pub length: u32,
    pub shape: Shape,
    pub foreground: bool,
}

impl Default for MusicState {
    fn default() -> Self {
        MusicState { tempo: 120, octave: 4, length: 4, shape: Shape::Normal, foreground: true }
    }
}

/// One note: number 0..83, or -1 for silence; sounding and silent milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Note {
    pub n: i32,
    pub on_ms: u32,
    pub off_ms: u32,
}

/// What a music string played.
#[derive(Debug, Default)]
pub struct Played {
    pub notes: Vec<Note>,
    /// A note was appended while in foreground mode (CTerm then holds the
    /// stream until the music has played).
    pub foreground: bool,
}

const SCALE: &[u8; 12] = b"C#D#EF#G#A#B";

fn digits(s: &[u8], i: &mut usize) -> Option<u32> {
    let start = *i;
    let mut v: u32 = 0;
    while *i < s.len() && s[*i].is_ascii_digit() {
        v = v.saturating_mul(10).saturating_add(u32::from(s[*i] - b'0'));
        *i += 1;
    }
    (*i > start).then_some(v)
}

/// Parse one music string. `m_style`: the introducer was `CSI M` or `CSI |`,
/// so a leading F, B, L, S (or N not followed by a digit) is a style letter.
pub fn play(st: &mut MusicState, s: &[u8], m_style: bool) -> Played {
    let s: Vec<u8> = s.iter().map(|b| b.to_ascii_uppercase()).collect();
    let mut out = Played::default();
    let mut i = 0;
    if m_style && !s.is_empty() {
        match s[0] {
            b'F' => {
                st.foreground = true;
                i = 1;
            }
            b'B' => {
                st.foreground = false;
                i = 1;
            }
            b'N' if !s.get(1).is_some_and(|c| c.is_ascii_digit()) => {
                st.shape = Shape::Normal;
                i = 1;
            }
            b'L' => {
                st.shape = Shape::Legato;
                i = 1;
            }
            b'S' => {
                st.shape = Shape::Staccato;
                i = 1;
            }
            _ => {}
        }
    }
    while i < s.len() {
        let c = s[i];
        i += 1;
        match c {
            b'M' => match s.get(i) {
                Some(b'F') => {
                    st.foreground = true;
                    i += 1;
                }
                Some(b'B') => {
                    st.foreground = false;
                    i += 1;
                }
                Some(b'N') => {
                    st.shape = Shape::Normal;
                    i += 1;
                }
                Some(b'L') => {
                    st.shape = Shape::Legato;
                    i += 1;
                }
                Some(b'S') => {
                    st.shape = Shape::Staccato;
                    i += 1;
                }
                _ => {}
            },
            b'T' => st.tempo = digits(&s, &mut i).unwrap_or(0).clamp(32, 255),
            b'O' => st.octave = digits(&s, &mut i).unwrap_or(0).min(6) as i32,
            b'L' => st.length = digits(&s, &mut i).unwrap_or(0).clamp(1, 64),
            b'<' => st.octave = (st.octave - 1).max(0),
            b'>' => st.octave = (st.octave + 1).min(6),
            b'A'..=b'G' | b'P' | b'N' => {
                let mut n: i32 = match c {
                    b'P' => -1,
                    // N0-N71 per the manual; anything else is silence.
                    b'N' => match digits(&s, &mut i).unwrap_or(0) {
                        v @ 0..=71 => v as i32,
                        _ => i32::MIN / 2,
                    },
                    _ => st.octave * 12 + SCALE.iter().position(|&x| x == c).unwrap_or(0) as i32,
                };
                let mut len = st.length;
                let mut dotted = false;
                let mut offset: i32 = 0;
                // Modifiers, in any order; a later one overrides an earlier one.
                loop {
                    match s.get(i) {
                        Some(b'+' | b'#') => offset += 1,
                        Some(b'-') => offset -= 1,
                        Some(b'.') => dotted = true,
                        Some(d) if d.is_ascii_digit() => {
                            len = digits(&s, &mut i).unwrap_or(0);
                            continue;
                        }
                        _ => break,
                    }
                    i += 1;
                }
                if c != b'P' {
                    n += offset;
                }
                let len = len.clamp(1, 64);
                let whole = if dotted { 360_000 } else { 240_000 };
                let dur = whole / st.tempo / len;
                let pause = match st.shape {
                    Shape::Staccato => dur / 4,
                    Shape::Legato => 0,
                    Shape::Normal => dur / 8,
                };
                // Seven octaves (the manual lists C up to octave 6, 4186 Hz;
                // SyncTERM's range check silences octave 6).
                let n = if (0..84).contains(&n) { n } else { -1 };
                out.notes.push(Note { n, on_ms: dur - pause, off_ms: pause });
                if st.foreground {
                    out.foreground = true;
                }
            }
            _ => {} // digits, modifiers and spaces with nothing to modify
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_lengths() {
        let mut st = MusicState::default();
        let p = play(&mut st, b"FT120L4CDE8.P2", true);
        assert!(p.foreground);
        // whole = 2000 ms; quarter 500 (normal: 62 silent), dotted eighth 375, half pause 1000
        assert_eq!(p.notes[0], Note { n: 48, on_ms: 500 - 62, off_ms: 62 });
        assert_eq!(p.notes[1].n, 50);
        assert_eq!(p.notes[2].on_ms + p.notes[2].off_ms, 3000 / 8);
        assert_eq!(p.notes[3], Note { n: -1, on_ms: 1000 - 125, off_ms: 125 });
    }

    #[test]
    fn numbers_octaves_and_state() {
        let mut st = MusicState::default();
        let p = play(&mut st, b"o0c n0 n71 n72 b+ >>>>>>>>c mb ml", false);
        assert_eq!(p.notes.iter().map(|n| n.n).collect::<Vec<_>>(), vec![0, 0, 71, -1, 12, 72]);
        assert!(!st.foreground);
        assert_eq!(st.shape, Shape::Legato);
    }
}

# Keyboard

| Key | Sends |
|---|---|
| Arrows | `CSI A` `CSI B` `CSI C` `CSI D` |
| Home / End | `CSI H` / `CSI K` |
| Insert / Delete | `CSI @` / DEL (0x7F) |
| PgUp / PgDn | `CSI V` / `CSI U` |
| Backspace | ^H (0x08); swapped with Delete by `backspace: "del"` |
| Enter / Tab / Shift+Tab / Esc | CR / HT / `CSI Z` / ESC |
| F1-F4 | `ESC O P` .. `ESC O S` |
| F5-F12 | `CSI 15~` `17~` `18~` `19~` `20~` `21~` `23~` `24~` |
| Ctrl+letter, Ctrl+`[ \ ] ^ _`, Ctrl+Space | C0 controls (Ctrl+Space and Ctrl+2: NUL) |
| Alt+key | ESC, then the key (also for named keys) |

Typed and pasted text is encoded as CP437, or as Latin-1 while an Amiga font
(SyncTERM 37-42) is active. Characters with no encoding become `?`. Line
breaks become CR. Paste goes out in 256-byte chunks, 10 ms apart.

While a file transfer runs, keys, the key bar and paste send nothing, since
it would land in the protocol. The same goes for the moment after a failed
transfer while the board's program winds down. The transfer card's buttons
still work, and the keyboard is the terminal's again when the transfer ends.

## Shortcuts

The terminal keeps these:

- Shift+PgUp and Shift+PgDn scroll back.
- Ctrl+Shift+C or Ctrl+Insert copies. Ctrl+C copies too when there is a
  selection; without one it is ^C for the host.
- Ctrl+V, Ctrl+Shift+V and Shift+Insert paste. ^V itself can be sent from the
  key bar (Ctrl, then V).

Cmd/Win combinations are left to the browser.

## Touch

On touch devices the key bar has Esc, Tab, sticky Ctrl and Alt, arrows,
Home/End/PgUp/PgDn/Ins/Del and an Fn row (F1-F12). It sits on the bottom edge
of the visual viewport, so it stays above the soft keyboard (iOS does not
shrink the layout viewport). Tap the screen to raise the keyboard.

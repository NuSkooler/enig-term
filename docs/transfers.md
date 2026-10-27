# File transfers

enig-term does XModem, YModem and ZModem, both ways, as ENiGMA offers them
(`fileTransferProtocols` in its `config_default.js`). Each is checked against
the real program behind it (see [Tests](building.md#tests)).

| ENiGMA protocol | The board runs (download / upload) | In enig-term |
|---|---|---|
| ZModem 8k (SEXYZ), `zmodem8kSexyz` | `sexyz -telnet -8 sz @list` / `sexyz -telnet -8 rz <dir>` | ZModem: starts by itself |
| ZModem 8k, `zmodem8kSz` | lrzsz `sz --zmodem --try-8k --binary --restricted` / `rz --zmodem --binary --restricted` | ZModem: starts by itself |
| YModem (SEXYZ), `ymodemSexyz` | `sexyz -telnet sY @list` (1K blocks) / `sexyz -telnet ry <dir>` | YModem batch, from the Files panel |
| XModem (SEXYZ), `xmodemSexyz` | `sexyz -telnet sX @list` (1K blocks) / `sexyz -telnet rC <file>` | XModem (checksum, CRC-16, 1K), from the Files panel |

ENiGMA offers no YModem-G, and enig-term has none.

## Downloading

Pick the files on the board and start its download.

ZModem starts by itself. The board's `sz` announces it with a ZRQINIT header,
which the terminal takes off the stream before it is drawn, and receiving
begins. `zmodemDetect: "ask"` shows the card first (Receive or Refuse).
`"off"` leaves it alone, and its bytes then show as text. When detection is
off, Files → Download → ZModem → "Wait for the board" does the same for one
transfer.

YModem and XModem cannot announce themselves. Start the download on the board
first (its sender waits about 100 s), then Files → Download → the protocol →
Receive. Started the other way round, the receiver's first `C` would reach the
board's menu as a keystroke. XModem carries no file name, so the panel's
"Save as" names it (`download.bin`). XModem pads the last block with SUB
(0x1A) to 128 bytes, and the file keeps that padding, as sexyz's and lrzsz's
receivers do.

Each file is saved the moment it is complete, under the name the board sent
(path parts and control characters removed), as a browser download. The
browser may ask once before several. A Chromium browser can save into a folder
instead (Files → "Save into a folder…", asked once per page). Files are then
written as they arrive, with no size limit. Otherwise a file is kept as Blobs
(4 MB parts, which a browser may move to disk) until it is complete, and one
larger than `transferMaxFile` (512 MB) is refused: ZModem skips just that
file, X/YModem stop. A file that ends short of the size the board announced
(YModem's header, ZModem's ZFILE) is reported incomplete and not saved.

## Uploading

ZModem: start the upload on the board. Its receiver announces itself (ZRINIT)
and the card asks for files (Choose files…). That is the system's picker, also
on iOS and Android, and takes several files. Or prepare it first: Files →
Upload → ZModem → Choose files → "Send when the board is ready".

YModem and XModem: Files → Upload → the protocol → Choose files (one, for
XModem) → Send, then start the upload on the board within a minute. Or start
the board first: its receiver asks every 3 s and gives up after about 30.
ENiGMA's XModem upload is its "supply filename" upload.

Files are read a megabyte at a time (one ahead), never whole.

## While a transfer runs

A card over the screen shows the file (n of m), bytes, rate, time left and a
Cancel button. The stream belongs to the protocol: nothing is drawn, keys and
paste are not sent, and a resize's NAWS and audio replies wait until it ends.

Telnet stays underneath. The terminal escapes IAC (0xFF) going out and decodes
it coming in. `sexyz -telnet` does the same on its side, and ENiGMA does it for
lrzsz. On a board the transfer program runs on a pty, so its status text is in
the stream with the protocol (sexyz's banner and progress lines, lrzsz's "rz
waiting to receive."). The engines skip it, and what follows the last of the
protocol goes back to the screen.

## How it ends

When it is done, the card lists the files (with Save again links) and closes
after a few seconds. The board's next screen shows as usual.

On Cancel, X/YModem send ten CANs and ten backspaces, and ZModem sends its
abort sequence. Data the board had already sent is dropped until the line is
quiet. While protocol data keeps coming (lrzsz's `sz` can notice an abort
late), the abort goes out again, up to ten times. Then the text that followed
is shown. Keys wait for that too. Refusing the board's offer drains the same
way, so a header it repeats does not start another offer.

If the board cancels (CAN), the transfer fails. If the board's program dies
instead and the board draws its menu again (ANSI sequences where the protocol
should be), the transfer ends and that screen is shown. Protocol data still
ahead of it in the stream is dropped first. Whatever this side sent after the
program died (headers, requests, data) reached the board's prompt as typing,
so the abort goes out with enough backspaces to rub it out: as many as were
sent, 10 to 256, since a prompt's field holds little.

Otherwise ZModem gives up after 60 s without traffic, and X/YModem after
their retries (ten of 10 s). A closed connection ends a transfer at once.

## Speed

ZModem streams. X/YModem wait for an acknowledgement after every block (1 KB),
so they run at one block per round trip: fast on a near line, about 20 KB/s at
50 ms. Playwright's Chromium on the development host takes 50-200 ms per
WebSocket round trip, and Firefox and WebKit about 1 ms. Real browsers were not
measured.

## Known limits

- sexyz cannot send an empty file with ZModem. It refuses the receiver's ZRPOS
  0 ("Received INVALID ZRPOS offset: 0"), against lrzsz's `rz` too. The
  transfer fails cleanly. lrzsz's ZModem and sexyz's YModem send empty files.
- XModem cannot tell a file cut short at a block boundary from a shorter file.
  YModem and ZModem can, because the size is announced.
- There is no resume of partial downloads; a browser cannot append to a saved
  file.

## How it is built

XModem and YModem are TypeScript state machines (`src/transfer/xymodem.ts`)
written from Forsberg's protocol reference and checked against sexyz and
lrzsz.

ZModem is icy_net's (icy_board, Apache-2.0), compiled to
`enig-term-zmodem.wasm` (about 70 KB gzipped) behind a polling wrapper
(`crates/enig-term-zmodem`). `src/transfer/zmodem.ts` drives it, with an
inactivity timeout and the board-left check. How the module is built is in
[Building](building.md#zmodem-a-second-wasm-module). The patches in
`patches/icy_board/` are each marked in the files they change:

| Patch | What |
|---|---|
| 0001 | The wasm32 port: no transports, no X/YModem or Kermit; clock, sleep, timeouts, the file reader and the output file come from the wrapper. |
| 0002 | A CAN abort inside file data ends the transfer (it was skipped as noise and the receiver hung). |
| 0003 | A repeated ZRPOS for the same offset within a second is ignored (lrzsz repeats it; icy_net restarted each time and the two sides ping-ponged until `rz` gave up). |
| 0004 | Upload data is awaited from the host a window at a time; the host may refuse (ZSKIP) an offered file. |
| 0005 | The sender skips text before a header (status text on the board's pty) instead of failing after three bytes of it. |
| 0006 | An overlong data subpacket (text spliced into it) is asked for again (ZRPOS) instead of failing the transfer. |
| 0007 | ZFILE also carries the file's modification time and what is left of the batch (without it sexyz dated uploads in the year 2446). |
| 0008 | After a file was taken, a stale ZDATA (a late answer to an earlier ZRPOS) is ignored instead of failing the session. |

The ZModem start detector is `src/transfer/detect.ts`. The stream handover and
saving are in `src/transfers.ts` and `src/transfer/save.ts`.

`npm run fuzz:xfer` mutates recorded sessions (flipped bytes, CAN and ZDLE
runs, status text, screens, cuts, repeats) into every engine with a jumping
clock. Each engine must end, never throw, and never deliver past its limit,
and a file it calls complete must be byte-identical. The unit tests run a
fixed-seed pass.

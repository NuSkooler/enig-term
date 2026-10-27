# Audio

enig-term plays two kinds of sound, both through one WebAudio mixer with the
user's mute and volume:

- CTerm audio (`APC SyncTERM:A;...`, `SyncTERM:C;S`/`C;L`, `SyncTERM:Q;...`,
  `CSI = 7 n`), as defined by the "Audio APCs" section of the current CTerm
  manual (CTerm 1.332). This is what SyncTERM 1.10 and IcyTerm 0.8.4 speak,
  and what [ansi-bbs-utils](https://github.com/NuSkooler/ansi-bbs-utils) 0.2.1
  drives.
- "ANSI" music (`CSI | ... ^N`, BananaCom `CSI N ... ^N`, `CSI M ... ^N`), as
  in the manual's "ANSI" Music section.

The engine (`enig-term-audio.js`, about 13 KB gzipped) is loaded the first
time a board uses audio. A board that never does costs nothing but the
toolbar button. `sound: false` turns everything audio off: the terminal then
answers no audio query, like a terminal without audio.

## CTerm audio

### Slots and channels

There are 256 patch slots and 16 channels. The commands are `Load` (from the
cache), `LoadBlob` (base64 data), `Synth`, `Copy`, `Queue`, `Flush`, `Volume`,
`Wait` and `Update`. `Synth` knows SIN, SAW, SQ, SINE_HARM, SINE_SAW,
SINE_SAW_CHORD, SINE_SAW_HARM and SILENCE; the four "noisy" shapes sound as
SyncTERM makes them.

Channels 0 and 1 belong to the terminal. Channel 0 is "ANSI" music, and
nothing plays on 1. `Queue` there is refused; `Flush`, `Volume`, `Wait` and
`Update` work.

### Queue

`Queue` moves the slot's buffer onto the channel, leaving the slot empty.
Buffers play back to back without gaps. `I=` fades in (the first pass of a
loop), `O=` fades out the end of the final pass (both are scaled to fit a
short buffer), `L` loops, and `V=`/`VL=`/`VR=` set the buffer's level on top
of the channel's.

A later Queue ends a loop at the end of the pass in progress. That is the
manual's rule; SyncTERM's and IcyTerm's mixers keep looping.

`X` with `I=` crossfades: the buffer playing decays while the new one fades in
over `I`, equal-power, both audible during the overlap. On an empty channel it
is a plain fade-in.

### Flush and Volume

`Flush` drains the channel. With `O=`, what is sounding fades out first.

`Volume` sets the channel's base level. Every channel starts at -12 dB, as in
SyncTERM. `V=100` is 0 dB, `V=0` is the -60 dB floor, and `V=-6dB` works too.
`T=` ramps from the current level, dB-linear. A side not given keeps its
value.

Durations are milliseconds, `ms`, `f` (frames at 44.1 kHz) and, for
`Synth`'s `T`, `p` (periods of `F`).

### Wait and Update

`Wait` holds the stream until the channel is idle (CTerm blocks there), or
returns at once if the channel's head buffer loops. It holds for at most 5
minutes. `Update` arms a one-shot `CSI = 7 ; ch ; 0 n` for the channel's next
running-to-stopped transition.

### Replies

| Request | Reply |
|---|---|
| `SyncTERM:Q;libsndfile` | `CSI = 7 ; 100 ; 1 n` |
| `SyncTERM:Q;libsndfileFormat;pm;ps` | `CSI = 7 ; 101 ; pm ; ps ; 0\|1 n`: what this browser decodes, tried once on a tiny sample (see [Formats](#formats)) |
| `CSI = 7 n` | the running channels (`CSI = 7 n` when idle) |
| `CSI = 7 ; ch n` | one pair (`ch` 100: the decoder, 1) |
| `C;L` | the listing |
| `SyncTERM:Q;JXL` | `CSI = 1 ; 0 - n` |

DA and CTDA are unchanged. CTDA has no audio feature number, so a host
detects audio with the libsndfile query, as ansi-bbs-utils does.

### The file cache

`C;S` stores, `C;L` lists and `Load` reads. The cache is kept per board (the
endpoint without query or fragment) in IndexedDB, so it survives reconnects
and reloads and a board uploads a file once. A board keeps at most 4096
files, and all boards together at most `audioCache` MB; past either, the
least recently used files are dropped. Other tabs on the same site share the
cache.

`C;L;<glob>` matches like glob(3): `*` and `?` stay within a directory. Files
are listed as `path TAB md5`, with their path relative to the cache, and
matching subdirectories as `dir/` with no MD5. SyncTERM prints those blank and
files by basename, and IcyTerm lists everything at once; hosts that handle
both, like ansi-bbs-utils, handle this too.

Names are path segments of printable ASCII, without `.`, `..`,
`\ : * ? " < > |`. Without IndexedDB (private windows) the files live in
memory until the page closes. Settings has Clear sound cache, which clears all
boards.

## "ANSI" music

`CSI = Ps M` picks the introducers: 0 only `CSI |`, 1 (the default) also
`CSI N`, and 2 also `CSI M` without parameters. Otherwise `CSI M` is Delete
Line, which ENiGMA uses.

The string is everything up to SO (0x0E). A character outside the manual's
set ends it unplayed. It accepts `T` (32-255, default 120), `O` (0-6, default
4), `L` (1-64), `N` (0-71), notes with `+`/`#`/`-`/`.`/length, `P`, `<`, `>`,
and `MF`/`MB`/`MN`/`ML`/`MS`, in upper or lower case.

Timing is CTerm's. A whole note is 240000/tempo ms, dotted is x1.5, normal
articulation sounds 7/8, staccato 3/4 and legato all of it. Foreground (`MF`,
the default) holds the stream until the music has played, as CTerm does, for
at most two minutes per string. `MB` plays in the background. State (tempo,
octave, length, style) carries over to the next string and resets with
`ESC c`.

Pitch: note 0 is C in octave 0, 65.406 Hz, equal-tempered (the manual's
table), so the default octave's C is 1046.5 Hz. The voice is `musicTone`:
`square` (the default, a band-limited square like the PC speaker), `syncterm`
(SyncTERM's SINE_SAW_HARM timbre) or `sine`. Music plays on channel 0.

## Autoplay, mute and volume

Browsers let a page start audio only after a user gesture. Clicking Connect
counts: enig-term starts audio then, and suspends it again after 15 s if the
board plays nothing. So does any key or tap in the terminal, the toolbar's
Sound button, or the prompt that appears when a board plays sound before any
of these happened ("This board plays sound: click to enable it").

While sound is not allowed yet, CTerm audio keeps its state. Channels "play"
on the wall clock, so what the board hears back (`CSI = 7 n`, `Update`
reports, `Wait`) is as if sound were on. When sound starts, whatever is still
in progress starts where it would be by then (a looping track mid-loop), after
a 50 ms fade-in. Nothing is dropped.

"ANSI" music is skipped instead, and does not hold the stream. It belongs to
the screen it came with, and starting it later would be out of place. The same
applies while the user has muted sound.

The toolbar has Sound (a mute toggle, reading "Enable sound" while waiting for
a gesture) and a volume slider, which is hidden at phone width. Settings has
Mute sound, Volume, Music (the `musicTone`) and Clear sound cache. `mute`,
`volume` and `musicTone` are user settings, saved and lockable. On iOS,
enabling sound also sets `navigator.audioSession.type` to `playback` when the
browser has it, so the ring/silent switch does not mute it.

## Limits

Host input is untrusted. Every limit drops what exceeds it (and logs it)
without breaking the session.

| Limit | Default | Config |
|---|---|---|
| One file stored, loaded or sent as a blob | 16 MB | `audioMaxFile` (MB) |
| One audio APC string (base64 of the above, plus the command) | ~21.3 MB | follows `audioMaxFile` |
| The cache in IndexedDB, all boards together (least recently used dropped) | 64 MB | `audioCache` (MB) |
| Files in the cache per board (least recently used dropped) | 4096 | |
| Decoded audio held in slots and on channels | 192 MB | `audioMemory` (MB) |
| Length of one decoded or synthesised buffer | 300 s | |
| One decode (browser or Ogg decoder; the Ogg decoder's Worker is terminated) | 15 s | |
| Channels in one file decoded by the bundled Ogg decoders (more is refused) | 8 | |
| Streams in one Ogg Opus file decoded by the bundled decoders (more is refused) | 8 | |
| Ogg pages / packets in one file read by the bundled decoders (empty packets skipped) | 262144 / 262144 | |
| PCM one bundled Ogg decode produces (samples x channels x 4 bytes; decoding stops there) | 192 MB | follows `audioMemory` |
| Buffers per channel / on all channels (queued or playing) | 64 / 128 | |
| One "ANSI" music string | 1022 characters (CTerm's), 120 s of sound | |
| Holding the stream (`Wait`, foreground music) | 5 min, or 32 MB of host data meanwhile | |

The APC parser and the engine are fuzzed (`npm run fuzz`, `npm run fuzz:audio`).

## Formats

Decoding is the browser's `decodeAudioData`. Where it cannot read Ogg Vorbis
or Opus (Safari before 18.4, for one), the bundled decoders take over. Those
are libvorbis and libopus compiled to WebAssembly by
[wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) (MIT; the
libraries BSD-3-Clause), with enig-term's own Ogg page reader.
`enig-term-ogg.js` (about 120 KB gzipped) is fetched only when a browser fails
to decode an Ogg file itself.

The bundled decoders run in a module Worker started from `enig-term-ogg.js`
next to `enig-term-audio.js`, one per decode, so a decode never blocks the
page and one that passes the 15 s limit is terminated. Where no Worker can
start (the bundle served from another origin than the page, a Content
Security Policy that refuses it, a browser without module Workers), they run
on the page's thread as before: the limits above still bound them, but the
15 s limit then only stops the wait. Under a Content Security Policy, the
Worker must be allowed by `worker-src 'self'`; without `worker-src`, browsers
check `child-src` and then `script-src`, so a policy with `script-src 'self'`
already allows it. No `blob:` URL is used. If the server sends a policy with
`enig-term-ogg.js` itself, the Worker runs under that policy, which then needs
`'wasm-unsafe-eval'` in `script-src` like the page.

| Format (libsndfile pm;ps) | Chromium | Firefox | WebKit |
|---|---|---|---|
| WAV PCM U8, 16, 24, 32 bit, float (1;5 1;2 1;3 1;4 1;6) | yes | yes | yes |
| FLAC 16 and 24 bit (23;2 23;3) | yes | yes | yes |
| Ogg Vorbis (32;96) | yes | yes | yes |
| Ogg Opus (32;100) | yes | yes | yes |
| MP3 (35;130) | yes | yes | yes |
| Ogg Vorbis/Opus with the bundled decoders | yes | yes | yes |

`test/audio.spec.ts` established this with generated 440 Hz files
(`test/fixtures/audio/`) in Playwright 1.60's Chromium 148, Firefox 150 and
WebKit 26.4. That WebKit is WebKitGTK on Linux, which decodes through
GStreamer. macOS and iOS Safari decode through Core Audio and were not
available to test, hence the fallback. The format query answers from a decode
of a tiny sample in the browser at hand, so it stays truthful elsewhere.

Some differences: Firefox and WebKitGTK keep MP3 encoder padding (a few tens
of ms longer), and Chromium keeps Vorbis end padding. WebKitGTK decodes a WAV
whose data chunk has an odd length (8- or 24-bit with an odd sample count) as
empty, which enig-term treats as a failed decode.

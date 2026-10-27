# Configuration

## Standalone page

`index.html` is `<enig-term config="config.json" url-params fill>`. It reads
`./config.json` if there is one, and without an endpoint it asks for a host.
On the standalone page only, URL parameters override `config.json`. A link
can come from anyone, so the URL sets only these, nothing that lets a board do
more (sound, ZModem auto-start, file sizes):

| Parameter | Option |
|---|---|
| `endpoint=wss://…` | `endpoint` (ignored when the config sets `lockEndpoint`) |
| `connect=1` | `autoConnect` |
| `aspect=0/1`, `crt=0/1`, `sharp=0/1`, `blink=0/1` | the booleans of the same name |
| `scale=fit\|integer`, `keys=auto\|on\|off`, `profile=auto\|pc\|amiga` | `scale`, `keyBar`, `profile` |
| `amigaPalette=ncomm\|term-ega`, `amigaAspect=pal\|ntsc\|<1-3>`, `amigaRows=` | the same |
| `cols=`, `rows=`, `scrollback=`, `renderer=webgl2\|2d`, `autoReconnect=0/1` | the same |
| `musicTone=square\|syncterm\|sine` | the same |

An endpoint from the URL never connects by itself, whatever sets
`autoConnect`: the page asks first ("Connect to this board?", naming the
address, Cancel focused), so a crafted link cannot point the operator's page
at another board. `connect=1` with the endpoint from `config.json` (or the
attributes) connects at once.

There are also test hooks, never on by default:

- `naws=0` refuses NAWS, so a host falls back to `CSI 255 n`.
- `audioLock=1` behaves as if the browser refused audio until a gesture.
- `audioFallback=1` decodes Ogg with the bundled decoders.

The debug hooks are not URL parameters. A test sets them in the page before
the terminal loads, e.g. with Playwright's `page.addInitScript`:
`window.__enigTermTestHooks = { debugCtermDa: true, debugPanic: true }`.
`debugCtermDa` answers DA as CTerm, for ENiGMA builds that only probe CTerm;
`debugPanic` lets `CSI ? 2026 h` panic the engine, to exercise recovery.

## config.json v1

`config.json` is a JSON object. Unknown keys are ignored, so operators may
pass extras through. Invalid values are dropped with a console warning.
ENiGMA generates `version`, `endpoint` and `title`, then merges its
`wsTerm.client` object. `config.example.json` is an example.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | integer | `1` | Schema version. A newer version is read for the keys this build knows, with a warning. |
| `endpoint` | string or `null` | `null` | `wss://` URL of the board. `ws://` is accepted only for loopback hosts (or with `allowInsecure`). `host:port` alone means `wss://host:port`. `null`: the page asks. |
| `title` | string | `"enig-term"` | Board name: toolbar and page title. |
| `lockEndpoint` | boolean | `false` | The user cannot change the endpoint (host input read-only; the `endpoint` URL parameter is ignored). |
| `autoConnect` | boolean | `false` | Connect on load when there is an endpoint. |
| `cols`, `rows` | integer | `80`, `25` | Terminal size (20-255, 10-255). Sent by NAWS. |
| `profile` | `"auto"`, `"pc"` or `"amiga"` | `"auto"` | Look profile ([Amiga profile](fonts.md#amiga-profile)). `auto`: PC, switching to Amiga while the host's normal font is an Amiga font (SyncTERM 37-42) and back on a PC font. `pc` or `amiga` locks it (a Phase 1 config with `"pc"` keeps the PC look). Typed text always follows the active font (Latin-1 under Amiga fonts). |
| `fonts` | string | `"fonts/"` | Directory of the PC fonts and their `manifest.json`, relative to `enig-term.js`. |
| `amigaFonts` | string, or `false` | `"fonts/amiga/"` | Directory of the operator-installed Amiga fonts, relative to `enig-term.js`. `""` or `false`: none (Amiga fonts are refused without a request). |
| `amigaPalette` | `"ncomm"` or `"term-ega"` | `"ncomm"` | Amiga profile palette. |
| `amigaAspect` | `"pal"`, `"ntsc"` or a number 1-3 | `"pal"` | Amiga profile pixel aspect, height:width of an Amiga hires pixel: PAL 1.875, NTSC 2.4. Applies when `aspect` is on. |
| `amigaRows` | integer 10-255, or `null` | `null` | Rows while the Amiga profile is active (e.g. 24, 25 or 32; NAWS tells the host). `null` keeps `rows`. |
| `amigaFont` | integer 37-42 | `42` | Font the explicit `"amiga"` profile selects when Amiga fonts are installed (42 Topaz). |
| `amigaIce` | boolean | `false` | Amiga profile honours the host's `CSI ? 33 h` (iCE colours). |
| `amigaBlink` | boolean | `true` | Amiga profile blinks SGR 5 text. |
| `amigaCursor` | `"block"` or `"host"` | `"block"` | Amiga profile cursor: always a block, or the shape the host sets. |
| `aspect` | boolean | `true` | 4:3 aspect correction. |
| `crt` | boolean | `false` | CRT effect (curvature, scanlines). |
| `scale` | `"fit"` or `"integer"` | `"fit"` | Fit the space, or only whole multiples (falls back to fit when even 1x does not fit). |
| `sharp` | boolean | `true` | Sharp-bilinear sampling (off: plain bilinear). |
| `keyBar` | `"auto"`, `"on"`, `"off"` (or boolean) | `"auto"` | On-screen key bar; `auto` shows it on coarse pointers (touch). |
| `scrollback` | integer | `2000` | Scrollback lines kept (0-100000; 0 disables). |
| `scrollbackOnClear` | boolean | `true` | Keep the non-blank lines of a screen the host clears. |
| `autoReconnect` | boolean | `false` | Reconnect after an unexpected close, with backoff (1 s doubling to 30 s, jittered; reset after a session of 10 s or more). |
| `backspace` | `"bs"` or `"del"` | `"bs"` | Backspace sends `^H` (Delete sends DEL), or the reverse. |
| `linkSchemes` | string array | `["http:", "https:"]` | OSC 8 link schemes that may be opened. |
| `allowInsecure` | boolean | `false` | Allow `ws://` to non-loopback hosts (development only). Not settable from the URL. |
| `termType` | string | `"ansi-bbs"` | Telnet TTYPE answer. |
| `renderer` | `"webgl2"` or `"2d"` | `"webgl2"` | Output pass. |
| `lock` | string array | `[]` | User settings (see [Settings](#settings)) the user may not change, e.g. `["crt"]`. |
| `toolbar` | boolean | `true` | Show the toolbar. |
| `persist` | boolean | `true` | Remember user settings in `localStorage`. |
| `blink` | boolean | `true` | Text and cursor blink (off is for screenshots). |
| `urlParams` | boolean | `false` | Read URL parameters (the standalone page sets it). |
| `sound` | boolean | `true` | Sound at all ([Audio](audio.md)): `false` answers no audio query and plays nothing. |
| `mute` | boolean | `false` | Muted (a user setting). |
| `volume` | integer 0-100 | `70` | Master volume (a user setting). |
| `musicTone` | `"square"`, `"syncterm"` or `"sine"` | `"square"` | Voice of "ANSI" music (a user setting). |
| `audioCache` | integer (MB) | `64` | Board sounds kept in IndexedDB, all boards together (LRU); `0`: none kept (files last until the page closes). |
| `audioMaxFile` | integer (MB) 1-64 | `16` | Largest sound file a board may store, load or send. |
| `audioMemory` | integer (MB) 16-2048 | `192` | Decoded audio held at once (slots and channels). |
| `transfers` | boolean | `true` | File transfers ([File transfers](transfers.md)): the Files button and ZModem detection. `false`: none (a board's ZModem start shows as text). |
| `zmodemDetect` | `"ask"`, `"auto"` or `"off"` | `"ask"` | A ZModem download the board starts: asks first (Receive or Refuse), begins at once, or is ignored (its bytes show as text). "ask" keeps a board from starting a download without a click. An upload the board starts always asks for files (unless `off`). A user setting. |
| `transferMaxFile` | integer (MB) 1-4096 | `512` | Largest file saved through a browser download; a larger one is refused (ZModem skips it, X/YModem stop). A folder the user picked has no limit. |

## Precedence

Lowest first:

1. built-in defaults;
2. `config.json`;
3. element attributes, or `mount()` options (the embedding page);
4. URL parameters, only when `urlParams` is on (the standalone page), only
   for the keys in the table above, never for `endpoint` when `lockEndpoint`
   is set, and never for a locked key;
5. user settings saved in `localStorage`, only for the user-settable keys and
   only those not in `lock`.

## Settings

The Settings panel holds the user-settable keys: `crt`, `aspect`, `scale`,
`keyBar`, `autoReconnect`, `backspace`, `profile` ("Look": Auto, PC, Amiga),
`amigaPalette`, `amigaAspect`, `mute`, `volume` and `musicTone`.
`zmodemDetect` is set in the Files panel, and `sharp` only through the API.
The panel also has Clear sound cache and a link to the credits page. Keys in
the config's `lock` are shown disabled.

Settings are saved per origin in `localStorage` under `enig-term:settings:v1`.
Every access is guarded, and the terminal works without storage.

The toolbar has the host input, Connect/Disconnect/Reconnect, Copy, Paste,
Sound (mute) with a volume slider, Files ([File transfers](transfers.md)),
and Full screen. An iPhone has no element fullscreen, so it gets a
viewport-covering mode instead.

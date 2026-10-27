# Embedding

## The element

```html
<script type="module" src="/path/to/enig-term.js"></script>
<enig-term endpoint="wss://bbs.example.com:8443" auto-connect crt="off" keybar="auto"></enig-term>
```

Attributes: `config` (URL of a `config.json`, relative to the page),
`endpoint`, `lock-endpoint`, `auto-connect`, `title`, `cols`, `rows`,
`profile`, `scrollback`, `crt`, `aspect`, `scale`, `keybar`, `toolbar`,
`persist`, `url-params`, `renderer`, `blink`, `auto-reconnect`,
`backspace`, `fonts`, `amiga-fonts`, `amiga-palette`, `amiga-aspect`,
`amiga-rows`, `sound`, `mute`, `volume`, `music-tone`, `transfers`,
`zmodem-detect`, `transfer-max-file`, and `fill`. `fill` makes the terminal
fit the element's height too, so give the element a height. The options
behind the attributes are described in [Configuration](configuration.md).

For booleans, present, `on`, `true` or `1` is on, and `off`, `false` or `0`
is off.

These attributes also apply when changed later: `endpoint`, `title`, `crt`,
`aspect`, `scale`, `keybar`, `toolbar`, `auto-reconnect`, `backspace`,
`blink`, `scrollback`, `profile`, `amiga-palette`, `amiga-aspect`,
`amiga-rows`, `mute`, `volume`, `music-tone`, `transfers`, `zmodem-detect`
and `transfer-max-file`.

The element has `ready` (a promise of the handle), `handle`, `connect()` and
`disconnect()`.

## mount()

```js
import { mount } from '/path/to/enig-term.js';
const term = await mount(document.getElementById('bbs'), {
  config: '/bbs/config.json',      // or an object; ranks below the options here
  endpoint: 'wss://bbs.example.com:8443',
  crt: false,
});
term.on('state', e => console.log(e.state, e.detail));   // idle|connecting|connected|closed|error
term.connect();
```

The handle has:

- `connect(endpoint?)`, `disconnect()`
- `setOption(key, value)`, `getOption(key)`
- `on(event, fn)`, which returns an unsubscribe function
- `send(text)`, `paste(text)`, and `write(data)` (as if from the host)
- `copySelection()`, `focus()`, `resize(cols, rows)`, `toggleFullscreen()`
- `soundState`, `enableSound()` (call it from a user gesture, i.e. your own
  "enable sound" control), `clearSoundCache()`
- `download(protocol?, name?)` and `upload(files, protocol?)`. The protocol
  is `"zmodem"` by default, or `"ymodem"` or `"xmodem"`. Files come from an
  `<input type=file>`.
- `cancelTransfer()`, and `transfer` (the current or last transfer's status)
- `state`, `version`, `destroy()`
- `terminal`, the internals, which are not stable

## Events

Events fire on the handle, and as DOM `CustomEvent`s on `<enig-term>` with the
event object as `detail`.

| Event | Detail |
|---|---|
| `state` | `{ state, detail, endpoint, reconnectInMs? }` |
| `title` | `{ title }` (OSC 0/2) |
| `bell` | `{}` (BEL; the screen also flashes). At most one per animation frame, however many BELs came. |
| `link` | `{ url, allowed, reason?, preventDefault() }`: an OSC 8 link was clicked. `preventDefault()` (or on the DOM event) skips the built-in confirmation. |
| `notice` | `{ level, text }`: messages the UI shows (copy refused, engine restarted...) |
| `recovered` | `{ message, recovered }`: the engine trapped and was replaced |
| `scroll` | `{ offset, lines }`: the scrollback view moved (0 = live) |
| `selection` | `{ text }` |
| `profile` | `{ profile, setting }`: the look in effect changed (`pc` or `amiga`; `setting` is the configured `auto`/`pc`/`amiga`) |
| `sound` | `{ state }`: `off` (disabled or unsupported), `idle` (no audio yet), `locked` (the board plays sound; waiting for a gesture), `on`, `muted` |
| `transfer` | `{ phase, direction, protocol, file, fileBytes, totalBytes, doneBytes, rate, eta, files, skipped, error, message }`: `phase` is `idle`, `armed` (prepared, waiting for the board), `offer` (the board started ZModem, waiting for the user), `loading`, `running`, `done`, `failed` or `cancelled`; `files` lists the files finished (`{ name, size, ok, url?, where }`) |

## Isolation

Everything lives in an open shadow root. The page's CSS does not reach in,
because inherited properties are reset at the root, and nothing is added to
the page's `<head>`. The WASM is resolved from the script's own URL, so the
bundle can be served from any path. Several terminals can share a page. They
share one WASM instance (see [engine recovery](behaviour.md#engine-recovery)).

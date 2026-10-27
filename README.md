# enig-term

A browser terminal for ANSI-BBS boards. The emulation is
[icy_engine](https://github.com/mkrueger/icy_tools) compiled to WebAssembly.
Around it is a small TypeScript shell with no framework, and the screen is
drawn with WebGL2 (with a 2D canvas fallback).

enig-term is under active development; the current release is 0.1.0. See
[CHANGELOG.md](CHANGELOG.md) for what is in it, and [SPIKE.md](SPIKE.md) for
the measurements behind the design.

## Features

- Telnet over WebSocket, with NAWS and optional reconnect.
- IBM VGA fonts for most of SyncTERM's PC font slots, SyncTERM font
  switching, fonts loaded by the host, and SAUCE font names.
- Amiga fonts and an Amiga look (NComm or Term palette, PAL or NTSC aspect)
  if the operator installs the fonts.
- Sharp scaling, 4:3 aspect correction and an optional CRT effect.
- iCE colours, VGA-rate blink, scrollback, selection and copy, OSC 8 links.
- CTerm audio and "ANSI" music, compatible with SyncTERM.
- XModem, YModem and ZModem uploads and downloads.
- Works on phones, with an on-screen key bar for the keys a soft keyboard lacks.
- One custom element, `<enig-term>`, in a shadow root, for use in any page.

## Using it

### Download a release

Each release on the
[Releases page](https://github.com/NuSkooler/enig-term/releases) has a
prebuilt `enig-term-<version>.zip` (and `.tar.gz`) and a `SHA256SUMS`. No
Rust or Node is needed to install it.

```sh
sha256sum -c --ignore-missing SHA256SUMS
unzip enig-term-0.1.0.zip                 # creates enig-term-0.1.0/
mkdir -p /path/to/enigma-bbs/ws-term
cp -a enig-term-0.1.0/. /path/to/enigma-bbs/ws-term/
```

That installs it where ENiGMA½ looks by default (`ws-term/` in the ENiGMA½
directory, `contentServers.web.wsTerm.root`). For a plain web server, copy
the same files into a directory under its web root instead. Copying over an
older install keeps an installed `fonts/amiga/`.

Optionally, install the Amiga fonts (Node 18 or later; read
[Amiga fonts](docs/fonts.md#amiga-fonts) first):

```sh
cd /path/to/enigma-bbs/ws-term
node tools/fetch-amiga-fonts.mjs
```

To build it yourself instead, see [Building](#building-from-source).

### With ENiGMA½

ENiGMA½ serves enig-term at `/_enig/ws-term/` and writes its `config.json`
for you. See
[enig-term Web Terminal](https://enigma-bbs.github.io/servers/loginservers/enig-term/)
in the ENiGMA½ docs.

### Standalone

Serve the unpacked release (or a `dist/` you built) from any web server. Put
a `config.json` next to `index.html`:

```json
{
  "version": 1,
  "endpoint": "wss://bbs.example.com:8443",
  "title": "Example BBS",
  "autoConnect": true
}
```

Without an endpoint the page asks for a host. `config.example.json` has more
keys, and [Configuration](docs/configuration.md) has all of them. Serve
`.wasm` files as `application/wasm`.

enig-term does not ship Amiga fonts. To offer them, run
`node tools/fetch-amiga-fonts.mjs` in the directory that holds
`enig-term.js`. Read [Amiga fonts](docs/fonts.md#amiga-fonts) first; whether
to serve them is your call.

### In your own page

```html
<script type="module" src="/path/to/enig-term.js"></script>
<enig-term endpoint="wss://bbs.example.com:8443" auto-connect></enig-term>
```

Or from script:

```js
import { mount } from '/path/to/enig-term.js';
const term = await mount(document.getElementById('bbs'), { endpoint: 'wss://bbs.example.com:8443' });
term.connect();
```

The other files in `dist/` are found relative to `enig-term.js`, so it can be
served from any path. See [Embedding](docs/embedding.md) for the attributes,
the API and events.

## Building from source

Most operators should use a release. To build, you need Node 22, Rust stable with the `wasm32-unknown-unknown` target, and
`wasm-bindgen-cli` 0.2.129. binaryen's `wasm-opt` is optional.

```sh
npm install
npm run build        # both WASM modules, then the JS bundle, into dist/
npm run serve        # http://127.0.0.1:8090/ serves dist/
npm test             # typecheck, Node unit tests, Playwright
```

The build fetches a pinned icy_tools and patches it so no fonts are compiled
in. [Building and testing](docs/building.md) covers the details, rebasing
icy_tools, the tests and the `dist/` layout.

## Documentation

- [Building and testing](docs/building.md): installing a release, toolchain,
  patched icy_tools, tests, CI, releases, the development server, `dist/`
  layout
- [Configuration](docs/configuration.md): the standalone page, `config.json`,
  precedence, user settings
- [Embedding](docs/embedding.md): the `<enig-term>` element, `mount()`, events
- [Keyboard](docs/keyboard.md): what each key sends, shortcuts, the key bar
- [Fonts](docs/fonts.md): PC fonts, SyncTERM slots, SAUCE, Amiga fonts, the
  Amiga profile
- [Audio](docs/audio.md): CTerm audio, "ANSI" music, autoplay, limits, formats
- [File transfers](docs/transfers.md): protocols, downloading, uploading,
  limits, the ZModem patches
- [Behaviour](docs/behaviour.md): scrollback, selection, links, replies,
  Telnet, engine recovery, hardening

## Licence and credits

enig-term is BSD-2-Clause (`LICENSE`).

The engine is [icy_tools](https://github.com/mkrueger/icy_tools) by Mike
Krueger and contributors (MIT OR Apache-2.0, used under MIT), built without
its embedded fonts. `src/crt.ts` ports its CRT shader functions. ZModem is
icy_net from [icy_board](https://github.com/mkrueger/icy_board), Apache-2.0
(`LICENSE-APACHE-2.0`), with the changes listed in
[File transfers](docs/transfers.md#how-it-is-built); the patched files say so.

The PC fonts in `fonts/` come from VileR's
[Ultimate Oldschool PC Font Pack](https://int10h.org/oldschool-pc-fonts/) and
are CC BY-SA 4.0 (`fonts/LICENSE`, `fonts/README.txt`). They are separate data
files under their own licence, so share-alike applies to them only. Amiga fonts
are not distributed. The Amiga palettes are numbers taken from NComm and Term
(cited in `src/palettes.ts`), no code. `enig-term-ogg.js` contains
[wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) (MIT) with
libvorbis, libogg and libopus (BSD-3-Clause) and puff (zlib). The audio test
fixtures are generated tones.

[NOTICE](NOTICE) has the full third-party notices, and `credits.html` in
`dist/` lists all of this for users.

Measurement variants used in SPIKE.md (built outside the repo; nothing here
is part of the shipped build).

core_<variant>/ is a copy of crates/enig-term-core with, where needed, a
[patch."https://github.com/mkrueger/icy_tools"] section pointing at a patched
icy_tools worktree at rev 1456074e:

  nofonts           icy_engine with strip-fonts.py applied
  scrollfix         icy_engine with scrollback-text-only.diff applied
  ansionly          stock engine; wrapper hard-codes TerminalEmulation::Ansi
  nofonts_ansionly  both
  o3, scrollfix_o3  opt-level = 3 and wasm-opt -O3 (WOPT=-O3)

build-variants.sh <variant>... prints cargo / wasm-bindgen / wasm-opt / gzip sizes.

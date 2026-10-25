#!/usr/bin/env python3
# Measurement-only patch: run inside an icy_tools checkout's crates/icy_engine.
# Replaces every embedded font (include_bytes!/include_str! of data/fonts and
# the BGI .CHR fonts) with an empty slice, except the slot-0 CP437 8/14/16 and
# the SAUCE "IBM VGA" font that screen construction and BitFont::default()
# unwrap. Result at icy_tools 1456074e: 204 include_bytes!, 2 include_str!.
import glob, re

KEEP = ('00-Codepage_437_English_8.psf', '00-Codepage_437_English_14.psf',
        '00-Codepage_437_English_16.psf', '/IBM_VGA.psf')
nb = ns = 0
for f in glob.glob('src/**/*.rs', recursive=True):
    s = open(f).read(); o = s
    def rb(m):
        global nb
        if m.group(1).endswith(KEEP):
            return m.group(0)
        nb += 1
        return '(&[] as &[u8])'
    s = re.sub(r'include_bytes!\(\s*"([^"]+)"\s*\)', rb, s)
    def rs(m):
        global ns
        ns += 1
        return '""'
    s = re.sub(r'include_str!\(\s*concat!\([^)]*\)\s*\)', rs, s)
    s = re.sub(r'include_str!\(\s*"[^"]*fonts[^"]*"\s*\)', rs, s)
    if s != o:
        open(f, 'w').write(s)
print('stripped include_bytes!:', nb, 'include_str!:', ns)

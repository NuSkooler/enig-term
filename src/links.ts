// OSC 8 link policy: which link targets may be opened, and how they are shown
// in the confirmation before opening.

export const DEFAULT_LINK_SCHEMES = ['http:', 'https:'];

export interface LinkCheck {
    ok: boolean;
    /** The normalised URL to open and to show (WHATWG href: IDN hosts in punycode). */
    href: string;
    reason?: string;
}

/**
 * Check a host-supplied link target. Only absolute URLs with an allowed scheme
 * pass (http and https by default). Control characters and whitespace are
 * rejected rather than stripped: a target that needs cleaning is not one to open.
 */
export function checkLink(uri: string, schemes: readonly string[] = DEFAULT_LINK_SCHEMES): LinkCheck {
    // eslint-disable-next-line no-control-regex
    if (!uri || uri.length > 2048 || /[\u0000- \u007f-\u009f]/.test(uri)) return { ok: false, href: uri, reason: 'malformed link' };
    let u: URL;
    try {
        u = new URL(uri);
    } catch {
        return { ok: false, href: uri, reason: 'not an absolute URL' };
    }
    const allowed = schemes.map(s => (s.endsWith(':') ? s : s + ':').toLowerCase());
    if (!allowed.includes(u.protocol)) return { ok: false, href: u.href, reason: `${u.protocol} links are not allowed` };
    if (u.username || u.password) return { ok: false, href: u.href, reason: 'links with credentials are not allowed' };
    return { ok: true, href: u.href };
}

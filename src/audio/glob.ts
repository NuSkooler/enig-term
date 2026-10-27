// glob(3)-style matching for `SyncTERM:C;L;<pattern>`: `*` and `?` do not
// cross `/`, `[...]` (and `[!...]`) are character classes, `\` escapes.
// The listing then names every file the pattern matches by its path
// relative to the cache, and each directory it matches as `dir/` with no MD5
// (glob's GLOB_MARK; SyncTERM prints those as a blank name).

export function globToRegExp(glob: string): RegExp {
    try {
        return new RegExp(globSource(glob, true));
    } catch {
        // A class glob(3) would reject (a reversed range): match it literally.
        return new RegExp(globSource(glob, false));
    }
}

function globSource(glob: string, classes: boolean): string {
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else if (c === '\\' && i + 1 < glob.length) re += escape(glob[++i]);
        else if (c === '[' && classes) {
            const end = glob.indexOf(']', i + 2);
            if (end < 0) {
                re += '\\[';
                continue;
            }
            let body = glob.slice(i + 1, end);
            const neg = body[0] === '!' || body[0] === '^';
            if (neg) body = body.slice(1);
            re += `[${neg ? '^' : ''}${body.replace(/[\\\]^]/g, m => '\\' + m)}]`;
            i = end;
        } else re += escape(c);
    }
    return re + '$';
}

function escape(c: string): string {
    return /[.+*?^${}()|[\]\\/]/.test(c) ? '\\' + c : c;
}

/**
 * Entries of a listing: the files matching `glob`, then the directories it
 * matches (as "dir/"), from `names` (paths relative to the cache root).
 */
export function listMatches(names: Iterable<string>, glob: string): { files: string[]; dirs: string[] } {
    const re = globToRegExp(glob || '*');
    const depth = (glob || '*').split('/').length;
    const files: string[] = [];
    const dirs = new Set<string>();
    for (const n of names) {
        const parts = n.split('/');
        if (parts.length === depth) {
            if (re.test(n)) files.push(n);
        } else if (parts.length > depth) {
            const d = parts.slice(0, depth).join('/');
            if (re.test(d)) dirs.add(d + '/');
        }
    }
    files.sort();
    return { files, dirs: [...dirs].sort() };
}

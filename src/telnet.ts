// Client-side Telnet option negotiation (RFC 854/855/856/857/858/1073/1091).
//
// Ported from the Xibalba web terminal (src/lib/terminal/telnet.js, same
// author), keeping its behaviour.
//
// ENiGMA's WebSocket login server subclasses its TelnetClient, so real IAC
// negotiation arrives inside the binary WebSocket frames: it is NOT a clean
// byte pipe. This module strips and answers that negotiation so the layer above
// only ever sees terminal data.
//
// Observed opening volley from ENiGMA:
//   IAC DONT ECHO / WILL ECHO / WILL SGA / DO SGA / DO BINARY / WILL BINARY
//   IAC DO TERMINAL-TYPE / DO NAWS / DO NEW-ENVIRON
// followed by ESC[0c (DA) and ESC[6n (DSR) probes, which the terminal answers.

export const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

const OPT_BINARY = 0;
const OPT_ECHO = 1;
const OPT_SGA = 3;
const OPT_TTYPE = 24;
const OPT_NAWS = 31;
const OPT_NEW_ENVIRON = 39;

const TTYPE_IS = 0;
const TTYPE_SEND = 1;

const enum S {
    Data,
    Iac,
    Negotiate, // awaiting option byte after WILL/WONT/DO/DONT
    Sb,
    SbIac,
}

const OPTION_NAMES: Record<number, string> = {
    [OPT_BINARY]: 'BINARY',
    [OPT_ECHO]: 'ECHO',
    [OPT_SGA]: 'SGA',
    [OPT_TTYPE]: 'TERMINAL-TYPE',
    [OPT_NAWS]: 'NAWS',
    [OPT_NEW_ENVIRON]: 'NEW-ENVIRON',
};

export interface TelnetOptions {
    termType?: string;
    getSize: () => { cols: number; rows: number };
}

export class TelnetClient {
    termType: string;
    getSize: () => { cols: number; rows: number };
    onLog: ((msg: string) => void) | null = null;

    private state = S.Data;
    private verb = 0;
    private sb: number[] = [];
    // Options we are willing to enable on our side.
    private readonly localOk = new Set([OPT_BINARY, OPT_SGA, OPT_TTYPE, OPT_NAWS]);
    // Options we are happy for the server to enable on its side.
    private readonly remoteOk = new Set([OPT_BINARY, OPT_SGA, OPT_ECHO]);
    // What we've agreed to, and which options we've answered at least once. Both
    // are needed: a refusal must still be sent the first time (RFC 854 requires
    // DO -> WONT), but repeated identical requests must not be answered again or
    // the two ends ping-pong forever.
    private readonly localOn = new Set<number>();
    private readonly localAnswered = new Set<number>();

    constructor({ termType = 'ansi-bbs', getSize }: TelnetOptions) {
        this.termType = termType;
        this.getSize = getSize;
    }

    private log(msg: string): void {
        this.onLog?.(msg);
    }

    /** Feed raw bytes from the socket; returns terminal data and bytes to send back. */
    receive(bytes: Uint8Array): { data: Uint8Array; reply: Uint8Array } {
        const data: number[] = [];
        const reply: number[] = [];

        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            switch (this.state) {
                case S.Data:
                    if (b === IAC) this.state = S.Iac;
                    else data.push(b);
                    break;

                case S.Iac:
                    if (b === IAC) {
                        data.push(IAC); // escaped literal 0xFF
                        this.state = S.Data;
                    } else if (b === WILL || b === WONT || b === DO || b === DONT) {
                        this.verb = b;
                        this.state = S.Negotiate;
                    } else if (b === SB) {
                        this.sb = [];
                        this.state = S.Sb;
                    } else {
                        // Standalone command (NOP, GA, ...): nothing to do.
                        this.state = S.Data;
                    }
                    break;

                case S.Negotiate:
                    this.negotiate(this.verb, b, reply);
                    this.state = S.Data;
                    break;

                case S.Sb:
                    if (b === IAC) this.state = S.SbIac;
                    else this.sb.push(b);
                    break;

                case S.SbIac:
                    if (b === IAC) {
                        this.sb.push(IAC); // escaped literal inside subnegotiation
                        this.state = S.Sb;
                    } else if (b === SE) {
                        this.subnegotiate(this.sb, reply);
                        this.state = S.Data;
                    } else {
                        this.state = S.Data;
                    }
                    break;
            }
        }
        return { data: new Uint8Array(data), reply: new Uint8Array(reply) };
    }

    private negotiate(verb: number, opt: number, reply: number[]): void {
        const name = OPTION_NAMES[opt] ?? `opt:${opt}`;
        if (verb === DO || verb === DONT) {
            // Server is asking us to enable/disable something on OUR side.
            const want = verb === DO && this.localOk.has(opt);
            this.log(`<- IAC ${verb === DO ? 'DO' : 'DONT'} ${name}`);
            // Answer if this changes state, or if we have never answered this
            // option before: a decline still needs to go out exactly once.
            const already = this.localOn.has(opt);
            if (this.localAnswered.has(opt) && want === already) return;
            this.localAnswered.add(opt);
            if (want) this.localOn.add(opt);
            else this.localOn.delete(opt);
            reply.push(IAC, want ? WILL : WONT, opt);
            this.log(`-> IAC ${want ? 'WILL' : 'WONT'} ${name}`);
            // NAWS is useless without an immediate size report.
            if (want && opt === OPT_NAWS) this.pushNaws(reply);
        } else {
            // Server is telling us what IT will do.
            const accept = verb === WILL && this.remoteOk.has(opt);
            this.log(`<- IAC ${verb === WILL ? 'WILL' : 'WONT'} ${name}`);
            reply.push(IAC, accept ? DO : DONT, opt);
            this.log(`-> IAC ${accept ? 'DO' : 'DONT'} ${name}`);
        }
    }

    private subnegotiate(sb: number[], reply: number[]): void {
        if (sb.length === 0) return;
        if (sb[0] === OPT_TTYPE && sb[1] === TTYPE_SEND) {
            this.log('<- SB TERMINAL-TYPE SEND');
            reply.push(IAC, SB, OPT_TTYPE, TTYPE_IS);
            for (const ch of this.termType) reply.push(ch.charCodeAt(0) & 0xff);
            reply.push(IAC, SE);
            this.log(`-> SB TERMINAL-TYPE IS ${this.termType}`);
        }
    }

    private pushNaws(reply: number[]): void {
        const { cols, rows } = this.getSize();
        reply.push(IAC, SB, OPT_NAWS);
        // 16-bit big-endian each; 0xFF must be escaped inside subnegotiation.
        for (const v of [cols >> 8, cols & 0xff, rows >> 8, rows & 0xff]) {
            reply.push(v);
            if (v === IAC) reply.push(IAC);
        }
        reply.push(IAC, SE);
        this.log(`-> SB NAWS ${cols}x${rows}`);
    }

    /** NAWS update after a resize, or null if NAWS was never negotiated. */
    buildResize(): Uint8Array | null {
        if (!this.localOn.has(OPT_NAWS)) return null;
        const reply: number[] = [];
        this.pushNaws(reply);
        return new Uint8Array(reply);
    }

    /** Double every literal 0xFF so the server does not take it for IAC. */
    static escape(bytes: Uint8Array): Uint8Array {
        if (!bytes.some(b => b === IAC)) return bytes;
        const out: number[] = [];
        for (const b of bytes) {
            out.push(b);
            if (b === IAC) out.push(IAC);
        }
        return new Uint8Array(out);
    }
}

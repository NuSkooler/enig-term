// The transfer engines (dist/enig-term-xfer.js), imported by the terminal
// the first time a transfer starts: X/YModem in TypeScript, and ZModem with
// its WASM (dist/enig-term-zmodem.wasm, fetched from next to this file).
export { XyReceiver, XySender } from './xymodem.ts';
export { ZmodemEngine, loadZmodem } from './zmodem.ts';

declare const __ENIG_TERM_ZMODEM_HASH__: string | undefined;
const ZMODEM_QUERY = typeof __ENIG_TERM_ZMODEM_HASH__ === 'string' && __ENIG_TERM_ZMODEM_HASH__ ? `?v=${__ENIG_TERM_ZMODEM_HASH__}` : '';

/** The ZModem WASM, next to this bundle. */
export function zmodemWasmUrl(): URL {
    return new URL(`enig-term-zmodem.wasm${ZMODEM_QUERY}`, import.meta.url);
}

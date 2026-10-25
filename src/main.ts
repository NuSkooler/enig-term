// Bundle entry: the embedding API, the <enig-term> element, and nothing that
// runs on its own. Load it as a module:
//   <script type="module" src="enig-term.js"></script>   (defines <enig-term>)
//   import { mount } from './enig-term.ts';
import { mount } from './api.ts';
import { defineElement, EnigTermElement } from './element.ts';
import { VERSION_STRING } from './replies.ts';

export type { EnigTermHandle, MountOptions } from './api.ts';
export type { Options } from './config.ts';
export { mount, defineElement, EnigTermElement };
export const version = VERSION_STRING;

/** Namespace form: EnigTerm.mount(el, options). */
export const EnigTerm = { mount, defineElement, version: VERSION_STRING };
export default EnigTerm;

defineElement();

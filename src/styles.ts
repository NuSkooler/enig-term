// Styles for the shadow root. Nothing here reaches the host page.
export const STYLES = `
:host { display: block; position: relative; color-scheme: dark; contain: content;
  --et-bg: #0b0b0e; --et-panel: #16161c; --et-edge: #2a2a33; --et-ink: #d6d6de; --et-dim: #8a8a96; --et-accent: #5fd3a6;
  --et-warn: #e8b04a; --et-error: #ef6461; }
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
.root { all: initial; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; background: var(--et-bg); color: var(--et-ink);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.root.pseudo-fs { position: fixed; inset: 0; z-index: 2147483000; }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 12px; background: var(--et-panel); border-bottom: 1px solid var(--et-edge); }
.toolbar[hidden] { display: none; }
.title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 16em; }
.host { flex: 1 1 12rem; min-width: 0; background: var(--et-bg); color: var(--et-ink); border: 1px solid var(--et-edge); padding: 5px 8px; font: inherit; border-radius: 3px; }
.host[readonly] { color: var(--et-dim); }
button, select { background: var(--et-bg); color: var(--et-ink); border: 1px solid var(--et-edge); padding: 5px 10px; font: inherit; cursor: pointer; border-radius: 3px; }
button:hover:not(:disabled) { border-color: var(--et-dim); }
button:disabled, select:disabled { opacity: .45; cursor: default; }
button[aria-pressed="true"] { border-color: var(--et-accent); color: var(--et-accent); }
button:focus-visible, select:focus-visible, .host:focus-visible { outline: 2px solid var(--et-accent); outline-offset: 1px; }
.status { color: var(--et-dim); font-size: 12px; white-space: nowrap; }
.soundctl { display: inline-flex; gap: 4px; align-items: center; }
.soundctl[hidden], .settings .group[hidden] { display: none; }
.soundctl .vol { width: 6rem; accent-color: var(--et-accent); }
button[data-sound="locked"] { border-color: var(--et-warn); color: var(--et-warn); }
button[data-sound="muted"] { color: var(--et-dim); }
button[data-sound="idle"] { border-color: var(--et-edge); color: var(--et-ink); }
.settings .group { display: contents; }
.settings input[type="range"] { width: 7rem; accent-color: var(--et-accent); }
.settings .note { color: var(--et-dim); }
.xfer { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 4; width: min(92%, 32rem); background: rgba(22,22,28,.97);
  border: 1px solid var(--et-edge); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.xfer[hidden] { display: none; }
.xfer[data-phase="offer"], .xfer[data-phase="armed"] { border-color: var(--et-accent); }
.xfer[data-phase="failed"] { border-color: var(--et-error); }
.xfer .note:empty, .xfer .xf-file:empty, .xfer .xf-list:empty { display: none; }
.xfer .xf-file { overflow-wrap: anywhere; }
.xf-bar { height: 8px; background: var(--et-bg); border: 1px solid var(--et-edge); border-radius: 4px; overflow: hidden; }
.xf-bar[hidden] { display: none; }
.xf-bar span { display: block; height: 100%; width: 0; background: var(--et-accent); }
.xf-bar.indeterminate span { width: 30%; animation: et-slide 1.2s linear infinite; }
@keyframes et-slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
.xf-list { margin: 0; padding: 0; list-style: none; max-height: 9em; overflow: auto; }
.xf-list li { overflow-wrap: anywhere; }
.xf-list li.bad { color: var(--et-warn); }
.xf-list a { color: var(--et-accent); }
.xf-error { color: var(--et-error); }
.xfer .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.xfer .actions [hidden], .settings [hidden] { display: none; }
.xfer .primary, .settings .primary { border-color: var(--et-accent); color: var(--et-accent); }
.settings .text { background: var(--et-bg); color: var(--et-ink); border: 1px solid var(--et-edge); padding: 4px 6px; font: inherit; border-radius: 3px; width: 11rem; }
.settings .hint { flex-basis: 100%; }
.soundprompt { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 6px; align-items: center; z-index: 3;
  background: rgba(22,22,28,.96); border: 1px solid var(--et-warn); border-radius: 4px; padding: 6px 8px; max-width: min(92%, 34rem); }
.soundprompt[hidden] { display: none; }
.soundprompt .primary { border-color: var(--et-warn); color: var(--et-warn); }
.status[data-state="connected"] { color: var(--et-accent); }
.status[data-state="error"] { color: var(--et-error); }
.spacer { flex: 1 1 0; }
.settings { display: flex; flex-wrap: wrap; gap: 8px 14px; padding: 8px 12px; background: var(--et-panel); border-bottom: 1px solid var(--et-edge); font-size: 13px; }
.settings[hidden] { display: none; }
.settings label { display: inline-flex; gap: 6px; align-items: center; white-space: nowrap; }
.settings .credits { color: inherit; opacity: .8; align-self: center; }
.stage { position: relative; flex: 1 1 auto; min-height: 0; display: flex; justify-content: center; align-items: flex-start; padding: 8px 0; overflow: hidden; }
.stage.bell { animation: et-bell .15s ease-out; }
@keyframes et-bell { from { background: #333; } to { background: transparent; } }
.term { position: relative; width: 100%; max-width: 100%; height: 100%; display: flex; justify-content: center; }
.screen { display: block; background: #000; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.input { position: absolute; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; margin: 0; resize: none;
  font-size: 16px; /* iOS zooms into inputs smaller than 16px */ color: transparent; background: transparent; caret-color: transparent; overflow: hidden; white-space: pre; }
.scrollmark { position: absolute; top: 12px; right: 12px; display: flex; gap: 8px; align-items: center; background: rgba(22,22,28,.92); border: 1px solid var(--et-edge);
  padding: 4px 8px; font-size: 12px; border-radius: 3px; }
.scrollmark[hidden] { display: none; }
.scrollmark button { padding: 2px 8px; font-size: 12px; }
.keybar { display: flex; flex-direction: column; gap: 4px; padding: 6px 6px calc(6px + env(safe-area-inset-bottom)); background: var(--et-panel); border-top: 1px solid var(--et-edge);
  position: fixed; left: 0; width: 100%; z-index: 2147483001; touch-action: manipulation; }
.keybar[hidden] { display: none; }
.keybar .row { display: flex; gap: 4px; justify-content: center; }
.keybar .row[hidden] { display: none; }
.keybar button { flex: 1 1 0; min-width: 0; max-width: 4.5rem; padding: 9px 2px; font-size: 14px; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.keypad { flex: 0 0 auto; }
.toast { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); max-width: min(90%, 36rem); background: rgba(22,22,28,.96); border: 1px solid var(--et-edge);
  padding: 8px 12px; border-radius: 4px; font-size: 13px; pointer-events: auto; z-index: 3; }
.toast[hidden] { display: none; }
.toast[data-level="warn"] { border-color: var(--et-warn); }
.toast[data-level="error"] { border-color: var(--et-error); }
.toast button { margin-left: 10px; padding: 1px 8px; }
dialog { background: var(--et-panel); color: var(--et-ink); border: 1px solid var(--et-edge); border-radius: 6px; max-width: min(92vw, 40rem); padding: 16px; }
dialog::backdrop { background: rgba(0,0,0,.6); }
dialog h2 { font-size: 15px; margin: 0 0 8px; }
dialog .url { display: block; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--et-bg); border: 1px solid var(--et-edge);
  padding: 8px; word-break: break-all; white-space: pre-wrap; max-height: 12em; overflow: auto; margin: 0 0 10px; user-select: all; }
dialog .why { color: var(--et-warn); font-size: 13px; margin: 0 0 10px; }
dialog .actions { display: flex; gap: 8px; justify-content: flex-end; }
dialog .actions .primary { border-color: var(--et-accent); color: var(--et-accent); }
@media (max-width: 600px) {
  .toolbar { padding: 6px 8px; gap: 4px; }
  .title { display: none; }
  .toolbar button { padding: 5px 8px; }
  .soundctl .vol { display: none; }
  .stage { padding: 4px 0; }
}
`;

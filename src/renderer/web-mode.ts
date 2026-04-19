// Runtime check for whether the renderer is being driven by the web
// client (WS-connected) or the Electron preload. The web client entry
// (src/web-client/main.tsx) sets `window.__HARNESS_WEB__ = true` before
// mounting App; Electron renderers leave it undefined.
//
// Components branch on this to hide affordances backed by surfaces that
// genuinely require Electron — native dialogs, WebContentsView browser
// tabs, drag-drop file paths, OS menu triggers. The corresponding
// window.api shim methods log and return sensible no-ops, so a missed
// call site won't crash; this is the *visible* fallback layer.

export function isWebClient(): boolean {
  return typeof window !== 'undefined' && window.__HARNESS_WEB__ === true
}

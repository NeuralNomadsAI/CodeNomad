// Put policy and bridge before all author bytes. Additional CSPs can only restrict it.
export const PANEL_EXTENSION_SANDBOX = "allow-scripts"
export const PANEL_EXTENSION_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"

const bridge = (handshake: string) => `(() => {
  let context = null;
  const listeners = new Set();
  Object.defineProperty(window, "codenomad", { value: Object.freeze({
    apiVersion: 1,
    getContext: () => context,
    onContext: listener => { listeners.add(listener); if (context) listener(context); return () => listeners.delete(listener); }
  }) });
  const initialize = event => {
    if (event.source !== parent || event.data?.type !== "codenomad:init" || event.ports.length !== 1) return;
    window.removeEventListener("message", initialize);
    const port = event.ports[0];
    port.onmessage = event => {
      if (event.data?.type !== "context") return;
      context = Object.freeze(event.data.context);
      for (const listener of listeners) { try { listener(context); } catch {} }
    };
    port.postMessage({ type: "ready", handshake: ${JSON.stringify(handshake)} });
  };
  window.addEventListener("message", initialize);
})();`

export function panelExtensionDocument(html: string, handshake: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PANEL_EXTENSION_CSP}"><script>${bridge(handshake)}</script>${html}`
}

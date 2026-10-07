// Put policy and bridge before all author bytes. Additional CSPs can only restrict it.
export const PANEL_EXTENSION_SANDBOX = "allow-scripts"
export const PANEL_EXTENSION_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"

const bridge = (handshake: string, apiVersion: 1 | 2) => `(() => {
  let context = null;
  let channel;
  let sequence = 0;
  const pending = new Map(), changes = new Set();
  const request = (method, input) => new Promise((resolve, reject) => {
    if (!channel || !context || pending.size >= 4) { reject(new Error('Assets unavailable')); return; }
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Assets unavailable')); }, 20000);
    pending.set(id, { resolve, reject, timeout });
    channel.postMessage({ type: 'assets:request', id, method, input });
  });
  const listeners = new Set();
  Object.defineProperty(window, "codenomad", { value: Object.freeze({
    apiVersion: ${apiVersion},
    ${apiVersion === 2 ? `assets: Object.freeze({
      list: cursor => request('list', { cursor }),
      read: (target, options = {}) => request('read', { target, thumbnail: options.thumbnail === true }),
      onChanged: listener => { changes.add(listener); return () => changes.delete(listener); }
    }),` : ""}
    getContext: () => context,
    onContext: listener => { listeners.add(listener); if (context) listener(context); return () => listeners.delete(listener); }
  }) });
  const initialize = event => {
    if (event.source !== parent || event.data?.type !== "codenomad:init" || event.ports.length !== 1) return;
    window.removeEventListener("message", initialize);
    const port = event.ports[0];
    channel = port;
    port.onmessage = event => {
      if (event.data?.type === 'assets:changed') { for (const listener of changes) { try { listener(); } catch {} } return; }
      if (event.data?.type === 'assets:result') {
        const request = pending.get(event.data.id); if (!request) return;
        pending.delete(event.data.id); clearTimeout(request.timeout);
        if (event.data.error) request.reject(new Error('Assets unavailable')); else request.resolve(event.data.result);
        return;
      }
      if (event.data?.type !== "context") return;
      context = Object.freeze(event.data.context);
      for (const listener of listeners) { try { listener(context); } catch {} }
    };
    port.postMessage({ type: "ready", handshake: ${JSON.stringify(handshake)} });
  };
  window.addEventListener("message", initialize);
})();`

export function panelExtensionDocument(html: string, handshake: string, apiVersion: 1 | 2 = 1): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PANEL_EXTENSION_CSP}"><script>${bridge(handshake, apiVersion)}</script>${html}`
}

// Put policy and bridge before all author bytes. Additional CSPs can only restrict it.
export const PANEL_EXTENSION_SANDBOX = "allow-scripts"
export const PANEL_EXTENSION_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"

export type PanelExtensionApiVersion = 1 | 2 | 3

// API 2 reads session assets and API 3 the repository's work items, each over
// its own request/result message pair on the one-use channel.
const bridge = (handshake: string, apiVersion: PanelExtensionApiVersion) => `(() => {
  let context = null;
  let channel;
  let sequence = 0;
  const pending = new Map(), changes = new Set();
  const request = (capability, failure, method, input) => new Promise((resolve, reject) => {
    if (!channel || !context || pending.size >= 4) { reject(new Error(failure)); return; }
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(failure)); }, 20000);
    pending.set(id, { resolve, reject, timeout, failure });
    channel.postMessage({ type: capability + ':request', id, method, input });
  });
  const listeners = new Set();
  Object.defineProperty(window, "codenomad", { value: Object.freeze({
    apiVersion: ${apiVersion},
    ${apiVersion === 2 ? `assets: Object.freeze({
      list: cursor => request('assets', 'Assets unavailable', 'list', { cursor }),
      read: (target, options = {}) => request('assets', 'Assets unavailable', 'read', { target, thumbnail: options.thumbnail === true }),
      onChanged: listener => { changes.add(listener); return () => changes.delete(listener); }
    }),` : ""}
    ${apiVersion === 3 ? `workItems: Object.freeze({
      list: (options = {}) => request('workItems', 'Work items unavailable', 'list', { kind: options.kind, query: options.query ?? '',
        page: options.page ?? 1, fresh: options.fresh === true }),
      open: (kind, number) => request('workItems', 'Work items unavailable', 'open', { kind, number })
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
      if (event.data?.type === 'assets:result' || event.data?.type === 'workItems:result') {
        const request = pending.get(event.data.id); if (!request) return;
        pending.delete(event.data.id); clearTimeout(request.timeout);
        if (event.data.error) request.reject(new Error(request.failure)); else request.resolve(event.data.result);
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

export function panelExtensionDocument(html: string, handshake: string, apiVersion: PanelExtensionApiVersion = 1): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PANEL_EXTENSION_CSP}"><script>${bridge(handshake, apiVersion)}</script>${html}`
}

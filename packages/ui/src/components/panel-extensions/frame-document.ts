// Put policy and bridge before all author bytes. Additional CSPs can only restrict it.
export const PANEL_EXTENSION_SANDBOX = "allow-scripts"
export const PANEL_EXTENSION_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"

export type PanelExtensionApiVersion = 1 | 2 | 3 | 4

// API 4 objects, each present only when its permission is declared (`composer.prefill`
// gives `composer`, and so on); requests share one `api4:request`/`api4:result` pair.
const api4Objects = (permissions: readonly string[]) => [
  permissions.includes("session.images.read") ? `images: Object.freeze({
      status: () => request('api4', 'Images unavailable', 'status', {}, 'images'),
      list: cursor => request('api4', 'Images unavailable', 'list', cursor === undefined ? {} : { cursor }, 'images'),
      read: (target, options = {}) => request('api4', 'Images unavailable', 'read', { target, thumbnail: options.thumbnail === true }, 'images'),
      onChanged: listener => { changes.add(listener); return () => changes.delete(listener); }
    }),` : "",
  permissions.includes("composer.prefill") ? `composer: Object.freeze({
      prefill: (input = {}) => request('api4', 'Composer unavailable', 'prefill', input, 'composer')
    }),` : "",
  permissions.includes("images.conversation") ? `conversation: Object.freeze({
      status: () => request('api4', 'Conversation unavailable', 'status', {}, 'conversation'),
      open: () => request('api4', 'Conversation unavailable', 'open', {}, 'conversation'),
      startNew: () => request('api4', 'Conversation unavailable', 'startNew', {}, 'conversation')
    }),` : "",
  permissions.includes("panel.preferences") ? `preferences: Object.freeze({
      get: () => request('api4', 'Preferences unavailable', 'get', {}, 'preferences'),
      set: value => request('api4', 'Preferences unavailable', 'set', { value }, 'preferences')
    }),` : "",
  permissions.includes("bundles.read") ? `bundles: Object.freeze({
      catalog: () => request('api4', 'Bundles unavailable', 'catalog', {}, 'bundles'),
      state: () => request('api4', 'Bundles unavailable', 'state', {}, 'bundles'),
      hosts: (input = {}) => request('api4', 'Bundles unavailable', 'hosts', input, 'bundles'),
      openDocs: (input = {}) => request('api4', 'Bundles unavailable', 'openDocs', input, 'bundles')
        .catch(error => ({ outcome: error.message === 'busy' ? 'busy' : 'unavailable' })),
      ${permissions.includes("bundles.manage") ? ["request", "setActive", "installHost", "attach", "detach"].map(method =>
        `${method}: (input = {}) => request('api4', 'Bundles unavailable', '${method}', input, 'bundles', true),`).join("\n      ") : ""}
      onChanged: listener => { bundleChanges.add(listener); return () => bundleChanges.delete(listener); }
    }),` : "",
].join("\n    ")

// API 2 reads session assets and API 3 the repository's work items, each over
// its own request/result message pair on the one-use channel; API 4 is above.
const bridge = (handshake: string, apiVersion: PanelExtensionApiVersion, permissions: readonly string[]) => `(() => {
  let context = null;
  let channel;
  let sequence = 0;
  const pending = new Map(), changes = new Set(), bundleChanges = new Set(), focus = new Map();
  const capturedDocument = document;
  const request = (capability, failure, method, input, scope, management = false) => new Promise((resolve, reject) => {
    if (!channel || !context) { reject(new Error(failure)); return; }
    if (pending.size >= 4) { reject(new Error(scope === 'bundles' ? 'busy' : failure)); return; }
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(failure)); }, 20000);
    pending.set(id, { resolve, reject, timeout, failure,
      trigger: management && document.activeElement instanceof HTMLElement ? document.activeElement : undefined });
    channel.postMessage(scope ? { type: capability + ':request', id, capability: scope, method, input } : { type: capability + ':request', id, method, input });
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
    ${apiVersion === 4 ? api4Objects(permissions) : ""}
    getContext: () => context,
    onContext: listener => { listeners.add(listener); if (context) listener(context); return () => listeners.delete(listener); }
  }) });
  const initialize = event => {
    if (event.source !== parent || event.data?.type !== "codenomad:init" || event.ports.length !== 1) return;
    window.removeEventListener("message", initialize);
    const port = event.ports[0];
    channel = port;
    port.onmessage = event => {
      if (event.data?.type === 'bundles:focus') {
        const saved = focus.get(event.data.requestID);
        if (!saved) return;
        focus.delete(event.data.requestID); clearTimeout(saved.timeout);
        if (document === capturedDocument && saved.trigger.ownerDocument === capturedDocument && saved.trigger.isConnected) saved.trigger.focus();
        return;
      }
      if (event.data?.type === 'assets:changed') { for (const listener of changes) { try { listener(); } catch {} } return; }
      if (event.data?.type === 'images:changed') {
        const detail = Object.freeze({ gallery: event.data.gallery === true, status: event.data.status === true });
        for (const listener of changes) { try { listener(detail); } catch {} }
        return;
      }
      if (event.data?.type === 'bundles:changed') {
        const value = event.data;
        let detail;
        if (value.kind === 'state' && Object.keys(value).length === 2) detail = Object.freeze({ kind: 'state' });
        else if (value.kind === 'request' && Object.keys(value).length === 4 &&
          typeof value.requestID === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.requestID) &&
          ['confirmed', 'cancelled', 'expired', 'failed'].includes(value.outcome)) {
          detail = Object.freeze({ kind: 'request', requestID: value.requestID, outcome: value.outcome });
        } else return;
        for (const listener of bundleChanges) { try { listener(detail); } catch {} }
        return;
      }
      if (event.data?.type === 'assets:result' || event.data?.type === 'workItems:result' || event.data?.type === 'api4:result') {
        const request = pending.get(event.data.id); if (!request) return;
        pending.delete(event.data.id); clearTimeout(request.timeout);
        const result = event.data.result;
        if (request.trigger && !event.data.error && result?.outcome === 'confirming' &&
          typeof result.requestID === 'string' && /^[a-f0-9]{32,64}$/.test(result.requestID)) {
          while (focus.size >= 8) { const key = focus.keys().next().value; clearTimeout(focus.get(key).timeout); focus.delete(key); }
          const old = focus.get(result.requestID); if (old) clearTimeout(old.timeout);
          focus.set(result.requestID, { trigger: request.trigger, timeout: setTimeout(() => focus.delete(result.requestID), 300000) });
        }
        if (event.data.error) request.reject(new Error(event.data.error === 'busy' ? 'busy' : request.failure)); else request.resolve(event.data.result);
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

export function panelExtensionDocument(html: string, handshake: string, apiVersion: PanelExtensionApiVersion = 1, permissions: readonly string[] = []): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PANEL_EXTENSION_CSP}"><script>${bridge(handshake, apiVersion, permissions)}</script>${html}`
}

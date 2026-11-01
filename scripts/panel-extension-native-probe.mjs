// Shared native isolation probe for panel extension frames (Tauri and Electron hosts).
// A loopback server serves one host page per mode, answers the frame's port requests,
// collects the frame's report and counts every other request as a leak.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tsImport } from "tsx/esm/api"

const product = new URL("../packages/", import.meta.url)
const HANDSHAKE = "fixture-handshake"
const GRACE_MS = 1500

// Frame methods per API 4 permission (dev-docs/PANEL_EXTENSIONS.md#api-4); permissions
// without frame methods map to none. A new permission must be added here.
const API4_FRAME_METHODS = {
  "session.images.read": { images: ["status", "list", "read"] },
  "session.images.prompts": {},
  "composer.prefill": { composer: ["prefill"] },
  "images.conversation": { conversation: ["status", "open", "startNew"] },
  "opencode.designAgent": {},
  "panel.preferences": { preferences: ["get", "set"] },
  "bundles.read": { bundles: ["catalog", "state", "hosts"] },
  "bundles.manage": {},
}
const LEGACY_FRAME_METHODS = { 1: {}, 2: { assets: ["list", "read"] }, 3: { workItems: ["list", "open"] } }
const LISTENERS = { 2: { assets: ["onChanged"] }, 4: { images: ["onChanged"], bundles: ["onChanged"] } }
const ARGS = {
  "assets.read": ["probe-target", { thumbnail: true }], "workItems.list": [{ kind: "issue" }], "workItems.open": ["issue", 1],
  "images.read": ["probe-target", { thumbnail: true }], "composer.prefill": [{ text: "probe" }], "preferences.set": [{ probe: true }],
  "bundles.hosts": [{ integration: "blender" }],
}

export const MODES = ["real", "same-origin", "no-csp"]

/** Loads the product's frame policy and binds the probe to the real panel's iframe attributes. */
export async function loadFramePolicy() {
  const frame = await tsImport(new URL("ui/src/components/panel-extensions/frame-document.ts", product).href, import.meta.url)
  const contract = await tsImport(new URL("server/src/panel-extensions/contract.ts", product).href, import.meta.url)
  const panel = await readFile(new URL("ui/src/components/panel-extensions/extension-panel.tsx", product), "utf8")
  assert.deepEqual(panel.match(/\bsandbox=\S+/g), ["sandbox={PANEL_EXTENSION_SANDBOX}"], "The real panel must use PANEL_EXTENSION_SANDBOX as its only sandbox")
  assert.match(panel, /panelExtensionDocument\(/, "The real panel must build its srcdoc with panelExtensionDocument")
  for (const permission of contract.PANEL_EXTENSION_API4_PERMISSIONS) {
    assert.ok(Object.hasOwn(API4_FRAME_METHODS, permission), `Probe has no frame method list for API 4 permission ${permission}`)
  }
  return { ...frame, api4Permissions: ["session.context", ...contract.PANEL_EXTENSION_API4_PERMISSIONS] }
}

function frameMethods(apiVersion, permissions) {
  if (apiVersion !== 4) return LEGACY_FRAME_METHODS[apiVersion]
  const methods = {}
  for (const permission of permissions) for (const [object, names] of Object.entries(API4_FRAME_METHODS[permission] ?? {})) {
    methods[object] = [...(methods[object] ?? []), ...names]
  }
  return methods
}

// Author code: identity, reachability, native and network attempts, then each declared method once.
function authorHtml({ leakBase, methods, apiVersion }) {
  return `<h1>Native probe</h1><script>
  const results = { origin: self.origin, parentDocument: 'unknown', native: {}, globals: {}, leaks: {}, api: {}, surface: null, context: null, changed: null, bundlesChanged: null, errors: [] };
  try { void parent.document.title; results.parentDocument = 'reachable'; } catch { results.parentDocument = 'blocked'; }
  for (const [name, read] of Object.entries({
    __TAURI_INTERNALS__: () => window.__TAURI_INTERNALS__, __TAURI__: () => window.__TAURI__, electronAPI: () => window.electronAPI,
    require: () => window.require, process: () => window.process, ipc: () => window.ipc, ipcRenderer: () => window.ipcRenderer,
    chromeWebview: () => window.chrome && window.chrome.webview, webkitHandlers: () => window.webkit && window.webkit.messageHandlers,
  })) { try { results.globals[name] = typeof read(); } catch { results.globals[name] = 'threw'; } }
  const attempt = (name, run) => {
    try { const value = run(); results.native[name] = 'called';
      if (value && typeof value.then === 'function') value.then(() => { results.native[name] = 'resolved'; }, () => { results.native[name] = 'rejected'; });
    } catch { results.native[name] = 'threw'; }
  };
  const ipcMessage = role => JSON.stringify({ cmd: 'probe', callback: 1, error: 2, payload: { role } });
  attempt('tauri.invoke', () => __TAURI_INTERNALS__.invoke('probe', { role: 'child' }));
  attempt('tauri.ipc', () => __TAURI_INTERNALS__.ipc({ cmd: 'probe', callback: 1, error: 2, payload: { role: 'raw-child' } }));
  attempt('tauri.global', () => __TAURI__.core.invoke('probe', { role: 'global-child' }));
  attempt('tauri.parent', () => parent.__TAURI_INTERNALS__.invoke('probe', { role: 'parent-reach-child' }));
  attempt('tauri.top', () => top.__TAURI_INTERNALS__.invoke('probe', { role: 'top-reach-child' }));
  attempt('tauri.protocol', () => fetch('http://ipc.localhost/probe', { method: 'POST', body: '{"role":"protocol-child"}' }));
  attempt('tauri.ipcScheme', () => fetch('ipc://localhost/probe', { method: 'POST', body: '{"role":"scheme-child"}' }));
  attempt('webview2.postMessage', () => chrome.webview.postMessage(ipcMessage('webview-child')));
  attempt('webkit.postMessage', () => webkit.messageHandlers.ipc.postMessage(ipcMessage('webkit-child')));
  attempt('wry.ipc', () => window.ipc.postMessage(ipcMessage('wry-child')));
  attempt('electron.self', () => electronAPI.restartCli());
  attempt('electron.parent', () => parent.electronAPI.restartCli());
  attempt('electron.top', () => top.electronAPI.restartCli());
  attempt('electron.require', () => require('electron').ipcRenderer.invoke('cli:restart'));
  attempt('electron.process', () => process.electronBinding('ipc'));
  attempt('message', () => parent.postMessage({ cmd: 'probe', role: 'message-child' }, '*'));
  const leakBase = ${JSON.stringify(leakBase)};
  const add = (tag, attributes, where = document.body) => { const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); where.append(node); return node; };
  const style = css => { const node = document.createElement('style'); node.textContent = css; document.head.append(node); };
  const leak = (kind, run) => { try { run(leakBase + kind); results.leaks[kind] = 'attempted'; } catch { results.leaks[kind] = 'threw'; } };
  leak('fetch', url => fetch(url).catch(() => {}));
  leak('fetch-no-cors', url => fetch(url, { mode: 'no-cors' }).catch(() => {}));
  leak('fetch-relative', () => fetch('/api/forbidden').catch(() => {}));
  leak('xhr', url => { const request = new XMLHttpRequest(); request.open('GET', url); request.send(); });
  leak('img', url => add('img', { src: url }));
  leak('img-srcset', url => add('img', { srcset: url + ' 1x' }));
  leak('script', url => add('script', { src: url }));
  leak('stylesheet', url => add('link', { rel: 'stylesheet', href: url }, document.head));
  leak('prefetch', url => add('link', { rel: 'prefetch', href: url }, document.head));
  leak('preload', url => add('link', { rel: 'preload', as: 'image', href: url }, document.head));
  leak('css-background', url => add('div', { style: 'width:8px;height:8px;background:url("' + url + '")' }));
  leak('css-import', url => style('@import url("' + url + '");'));
  leak('css-font', url => { style('@font-face{font-family:probe;src:url("' + url + '")}'); add('span', { style: 'font-family:probe' }).textContent = 'x'; });
  leak('iframe', url => add('iframe', { src: url }));
  leak('object', url => add('object', { data: url }));
  leak('embed', url => add('embed', { src: url }));
  leak('form', url => { add('iframe', { name: 'leak-target' }); add('form', { action: url, method: 'POST', target: 'leak-target' }).submit(); });
  leak('beacon', url => navigator.sendBeacon(url, 'probe'));
  leak('websocket', url => new WebSocket(url.replace(/^http:/, 'ws:')));
  leak('eventsource', url => new EventSource(url));
  leak('audio', url => add('audio', { src: url, preload: 'auto' }));
  leak('video', url => add('video', { src: url, preload: 'auto' }));
  leak('video-poster', url => add('video', { poster: url }));
  leak('svg-image', url => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const image = document.createElementNS('http://www.w3.org/2000/svg', 'image'); image.setAttribute('href', url); svg.append(image); document.body.append(svg); });
  leak('worker-blob', url => new Worker(URL.createObjectURL(new Blob(['fetch(' + JSON.stringify(url) + ').catch(() => {})'], { type: 'text/javascript' }))));
  leak('worker-data', url => new Worker('data:text/javascript,' + encodeURIComponent('fetch(' + JSON.stringify(url) + ').catch(() => {})')));
  leak('popup', url => window.open(url));
  const fired = Date.now();
  if (${apiVersion} === 2) codenomad.assets.onChanged(() => { results.changed = 'called'; });
  if (${apiVersion} === 4 && codenomad.images) codenomad.images.onChanged(detail => { results.changed = detail; });
  if (${apiVersion} === 4 && codenomad.bundles) codenomad.bundles.onChanged(detail => { results.bundlesChanged = detail; });
  const methods = ${JSON.stringify(methods)}, args = ${JSON.stringify(ARGS)};
  let started = false;
  codenomad.onContext(async context => {
    if (started) return; started = true;
    results.context = context.sessionId;
    results.surface = Object.fromEntries(Object.keys(codenomad).map(key => [key, codenomad[key] && typeof codenomad[key] === 'object' ? Object.keys(codenomad[key]) : typeof codenomad[key]]));
    for (const [object, names] of Object.entries(methods)) for (const method of names) {
      const key = object + '.' + method;
      try { results.api[key] = await codenomad[object][method](...(args[key] || [])); } catch (error) { results.errors.push(key + ': ' + error.message); }
    }
    setTimeout(() => parent.postMessage({ type: 'results', results }, '*'), Math.max(0, ${GRACE_MS} - (Date.now() - fired)));
  });
</script>`
}

// Host page: positive native control, one-use port handshake, one answer per request.
function hostPage({ mode, srcdoc, sandbox, apiVersion }) {
  const attribute = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
  return `<!doctype html><meta charset="utf-8"><title>Native probe host</title><script>
  const answers = [], unexpected = [];
  let positive = 'none';
  window.addEventListener('DOMContentLoaded', () => {
    if (window.__TAURI_INTERNALS__) { positive = 'tauri'; __TAURI_INTERNALS__.invoke('probe', { role: 'parent' }); }
    else if (window.electronAPI) { positive = 'electron'; window.electronAPI.getCliStatus(); }
  });
  window.addEventListener('message', event => {
    const frame = document.querySelector('iframe');
    if (event.source !== frame.contentWindow || event.data?.type !== 'results') return;
    fetch('/report/${mode}', { method: 'POST', body: JSON.stringify({ child: event.data.results, answers, unexpected, positive, hostOrigin: location.origin }) });
  });
  function initialize(frame) {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => {
      const data = event.data, request = /^(assets|workItems|api4):request$/.exec(data?.type);
      if (request) {
        const capability = request[1] === 'api4' ? data.capability : request[1];
        answers.push({ type: request[1], capability, method: data.method, input: data.input });
        channel.port1.postMessage({ type: request[1] + ':result', id: data.id, result: { probe: capability + '.' + data.method } });
      } else if (data?.type === 'ready' && data.handshake === ${JSON.stringify(HANDSHAKE)}) {
        channel.port1.postMessage({ type: 'context', context: { apiVersion: ${apiVersion}, sessionId: 'native-session', locale: 'en', appearance: 'light' } });
        if (${apiVersion} === 2) channel.port1.postMessage({ type: 'assets:changed' });
        if (${apiVersion} === 4) channel.port1.postMessage({ type: 'images:changed', gallery: true, status: false });
        if (${apiVersion} === 4) channel.port1.postMessage({ type: 'bundles:changed', kind: 'state' });
      } else unexpected.push(data?.type ?? typeof data);
    };
    frame.contentWindow.postMessage({ type: 'codenomad:init' }, '*', [channel.port2]);
  }
</script><iframe sandbox="${attribute(sandbox)}" onload="initialize(this)" srcdoc="${attribute(srcdoc)}"></iframe>`
}

/** Starts the loopback server serving `/host/<mode>`; everything outside host, report and favicon counts as a leak. */
export async function startProbeServer({ policy, apiVersion }) {
  const permissions = apiVersion === 4 ? policy.api4Permissions : []
  const methods = frameMethods(apiVersion, permissions)
  const state = Object.fromEntries(MODES.map(mode => [mode, { reports: [], reportedAt: null, leaks: [] }]))
  let current = MODES[0]
  const record = (request, kind) => state[current].leaks.push(`${kind} ${request.method} ${request.url}`)
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    const [, area, mode] = url.pathname.split("/")
    if (request.method === "GET" && area === "host" && MODES.includes(mode)) {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(hostPage({ mode, apiVersion, ...frameFor(mode) }))
      return
    }
    if (request.method === "POST" && area === "report" && MODES.includes(mode)) {
      let body = ""
      request.on("data", chunk => { body += chunk })
      request.on("end", () => { state[mode].reports.push(JSON.parse(body)); state[mode].reportedAt = Date.now(); response.end("ok") })
      return
    }
    if (url.pathname !== "/favicon.ico") record(request, "http")
    response.statusCode = url.pathname === "/favicon.ico" ? 404 : 204
    response.end()
  })
  server.on("upgrade", (request, socket) => { record(request, "upgrade"); socket.destroy() })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const leakBase = `http://127.0.0.1:${port}/leak/`
  const document = policy.panelExtensionDocument(authorHtml({ leakBase, methods, apiVersion }), HANDSHAKE, apiVersion, permissions)
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${policy.PANEL_EXTENSION_CSP}">`
  assert.ok(document.includes(cspMeta), "Cannot build the CSP-removed negative control: the CSP meta changed shape")
  function frameFor(mode) {
    if (mode === "same-origin") return { sandbox: `${policy.PANEL_EXTENSION_SANDBOX} allow-same-origin`, srcdoc: document }
    if (mode === "no-csp") return { sandbox: policy.PANEL_EXTENSION_SANDBOX, srcdoc: document.replace(cspMeta, "") }
    return { sandbox: policy.PANEL_EXTENSION_SANDBOX, srcdoc: document }
  }
  return {
    port, methods,
    url: mode => { current = mode; return `http://127.0.0.1:${port}/host/${mode}` },
    outcome: (mode, { output, exitedAt }) => ({ mode, apiVersion, methods, output, exitedAt, ...state[mode] }),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }),
  }
}

/** Every isolation violation of one mode's outcome; the real mode must have none. */
export function probeViolations(outcome) {
  const violations = []
  const fail = (category, message) => violations.push({ category, message })
  const nativeLines = outcome.output.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith("NATIVE:"))
  const children = nativeLines.filter(line => line !== "NATIVE:parent")
  if (nativeLines.length - children.length !== 1) fail("positive-control", `expected one NATIVE:parent line, got ${JSON.stringify(nativeLines)}`)
  if (children.length) fail("native", `frame reached native commands: ${JSON.stringify(children)}`)
  if (outcome.leaks.length) fail("leak", `${outcome.leaks.length} leaked request(s): ${outcome.leaks.slice(0, 8).join(", ")}`)
  if (outcome.reports.length !== 1) { fail("report", `expected one frame report, got ${outcome.reports.length}`); return violations }
  if (outcome.exitedAt - outcome.reportedAt < GRACE_MS) fail("grace", `host exited ${outcome.exitedAt - outcome.reportedAt} ms after the report`)
  const { child, answers, unexpected } = outcome.reports[0]
  if (child.origin !== "null") fail("origin", `self.origin is ${JSON.stringify(child.origin)}`)
  if (child.parentDocument !== "blocked") fail("parent", `parent.document is ${child.parentDocument}`)
  if (child.context !== "native-session") fail("context", `context ${JSON.stringify(child.context)}`)
  if (child.errors.length) fail("api", `frame method errors: ${child.errors.join("; ")}`)
  if (unexpected.length) fail("api", `unexpected port messages: ${JSON.stringify(unexpected)}`)
  const expected = Object.entries(outcome.methods).flatMap(([object, names]) => names.map(method => `${object}.${method}`))
  const answered = answers.map(answer => `${answer.capability}.${answer.method}`)
  if (JSON.stringify(answered.toSorted()) !== JSON.stringify(expected.toSorted())) fail("api", `port answers ${JSON.stringify(answered)}, expected ${JSON.stringify(expected)}`)
  for (const key of expected) if (child.api[key]?.probe !== key) fail("api", `frame saw ${JSON.stringify(child.api[key])} for ${key}`)
  const surface = { apiVersion: "number", getContext: "function", onContext: "function" }
  const listeners = LISTENERS[outcome.apiVersion] ?? {}
  for (const object of new Set([...Object.keys(outcome.methods), ...Object.keys(listeners)])) surface[object] = [...(outcome.methods[object] ?? []), ...(listeners[object] ?? [])]
  const sorted = value => JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, Array.isArray(entry) ? entry.toSorted() : entry]).toSorted()))
  if (sorted(child.surface) !== sorted(surface)) fail("api", `frame surface ${JSON.stringify(child.surface)}, expected ${JSON.stringify(surface)}`)
  const change = outcome.apiVersion === 4 ? { gallery: true, status: false } : outcome.apiVersion === 2 ? "called" : null
  if (JSON.stringify(child.changed) !== JSON.stringify(change)) fail("api", `change notification ${JSON.stringify(child.changed)}`)
  if (JSON.stringify(child.bundlesChanged) !== JSON.stringify(outcome.apiVersion === 4 ? { kind: "state" } : null)) fail("api", `bundles notification ${JSON.stringify(child.bundlesChanged)}`)
  return violations
}

const NEGATIVE_CATEGORIES = { "same-origin": ["origin", "parent"], "no-csp": ["leak"] }

/** Runs every mode through `launch(url, mode)` (resolving to the host's output) and asserts real isolation plus detected negative controls. */
export async function runProbe({ host, apiVersion, launch }) {
  const policy = await loadFramePolicy()
  const server = await startProbeServer({ policy, apiVersion })
  try {
    const summary = { host, apiVersion, sandbox: policy.PANEL_EXTENSION_SANDBOX }
    for (const mode of MODES) {
      const output = await launch(server.url(mode), mode)
      await new Promise(resolve => setTimeout(resolve, 300))
      const outcome = server.outcome(mode, { output, exitedAt: Date.now() })
      const violations = probeViolations(outcome)
      const report = outcome.reports[0]
      const line = {
        origin: report?.child.origin, parentDocument: report?.child.parentDocument, positive: report?.positive,
        nativeLines: output.split(/\r?\n/).map(entry => entry.trim()).filter(entry => entry.startsWith("NATIVE:")),
        leakCount: outcome.leaks.length, answers: report?.answers.map(answer => `${answer.capability}.${answer.method}`),
        frameGlobals: report && Object.fromEntries(Object.entries(report.child.globals).filter(([, type]) => type !== "undefined")),
        violations: violations.map(violation => violation.category),
      }
      if (mode === "real") {
        assert.deepEqual(violations, [], `${host} real mode failed:\n${violations.map(violation => violation.message).join("\n")}\n${output}`)
      } else {
        const missing = NEGATIVE_CATEGORIES[mode].filter(category => !line.violations.includes(category))
        assert.equal(missing.length, 0, `${host} negative control ${mode} was not detected (${missing.join(", ")}): ${JSON.stringify(line)}\n${output}`)
        line.detected = NEGATIVE_CATEGORIES[mode]
      }
      summary[mode] = line
    }
    return summary
  } finally {
    await server.close()
  }
}

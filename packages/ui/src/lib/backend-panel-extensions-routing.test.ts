import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { test, type TestContext } from "node:test"
import { createRoot } from "solid-js"
import ts from "typescript"
import { backends, createBackendClient, localBackend, type BackendClient } from "./backend-client"
import { backendEvents } from "./backend-events"
import { captureBackendOperation } from "./backend-operation"
import { createPanelExtensionsApi, panelExtensionsApi, panelExtensionsApi4 } from "./panel-extensions-api"
import { panelExtensionsFor } from "./panel-extensions-backend"
import { usePanelExtensions } from "../components/panel-extensions/use-panel-extensions"
import { useAssetsChannel } from "../components/panel-extensions/assets-channel"
import { useWorkItemsChannel } from "../components/panel-extensions/work-items-channel"
import { useApi4Channel } from "../components/panel-extensions/api4-channel"

const registry = backends as Map<string, BackendClient>
const entry = { manifest: { id: "example.panel", name: "Panel", version: "1.0.0", apiVersion: 1 as const,
  author: "Example", license: "MIT", repository: "https://github.com/example/panel", permissions: ["session.context"] as ["session.context"] },
  digest: "d", enabled: true }
type Wire = { url: string; method: string; body: unknown; headers: [string, string][]; credentials?: RequestCredentials }
function wire(input: RequestInfo | URL, init?: RequestInit): Wire {
  return { url: String(input), method: init?.method ?? "GET", body: init?.body,
    headers: [...new Headers(init?.headers)], credentials: init?.credentials }
}
function reply(request: Wire) {
  if (request.url.endsWith("/api/panel-extensions")) return Response.json([entry])
  if (request.url.endsWith("/catalog")) return Response.json({ entries: [] })
  if (request.url.includes("/panel?")) return Response.json({ html: "<p>local srcdoc</p>" })
  if (request.url.endsWith("/preferencesGet")) return Response.json({ status: "ok", value: { owner: new URL(request.url, "https://local.invalid").host } })
  if (request.url.endsWith("/preferencesSet")) return Response.json({ status: "saved" })
  if (request.url.endsWith("/inspect")) return Response.json(entry)
  return Response.json({ status: "page", entries: [], cursor: null })
}
function fixture(t: TestContext, id: string, respond: (request: Wire) => Promise<Response> | Response = reply) {
  const calls: Wire[] = []
  const backend = createBackendClient({ id, baseUrl: `https://${id}.invalid`, fetcher: async (input, init) => {
    const request = wire(input, init); calls.push(request); return respond(request)
  } })
  registry.set(id, backend)
  const detach = backendEvents.attach(id, backend.events)
  t.after(() => { detach(); backend.events.dispose(); registry.delete(id) })
  return { backend, calls, detach }
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise<void>(done => setImmediate(done)) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function inventory(t: TestContext, id: string) {
  let controller!: ReturnType<typeof usePanelExtensions>
  createRoot(dispose => { t.after(dispose); controller = usePanelExtensions(() => id, () => true) })
  return controller
}
async function bridges(t: TestContext, instanceId: string) {
  const answers: any[] = []
  let assets!: ReturnType<typeof useAssetsChannel>, work!: ReturnType<typeof useWorkItemsChannel>, api4!: ReturnType<typeof useApi4Channel>
  createRoot(dispose => {
    t.after(dispose)
    const authority = { instanceId, id: entry.manifest.id, digest: entry.digest, send: (value: unknown) => answers.push(value) }
    assets = useAssetsChannel({ ...authority, sessionId: () => "session" })
    work = useWorkItemsChannel({ ...authority, captureOperation: captureBackendOperation })
    api4 = useApi4Channel({ ...authority, permissions: ["panel.preferences"], sessionId: "session",
      host: { activeSessionId: () => "session", promptInputApi: () => null, isPhoneLayout: () => false, closePanel() {} } })
  })
  await Promise.all([
    assets({ type: "assets:request", id: 1, method: "list", input: {} }),
    work({ type: "workItems:request", id: 2, method: "list", input: { kind: "issue", query: "word", page: 1, fresh: false } }),
    api4({ type: "api4:request", id: 3, capability: "preferences", method: "get", input: {} }),
  ])
  return answers
}

// Run the actual manager callback bodies with their real controller and HTTP API, without unrelated JSX.
function managerAction(name: string, scope: Record<string, unknown>) {
  const text = readFileSync(new URL("../components/panel-extensions/extension-manager.tsx", import.meta.url), "utf8")
  const file = ts.createSourceFile("manager.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) found = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file); assert.ok(found)
  const code = ts.transpileModule(`return (${found.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(scope), code)(...Object.values(scope))
}
function manager(controller: ReturnType<typeof usePanelExtensions>) {
  let busy = false, failed = false, preview: unknown
  let selected: any = { ...entry, source: { kind: "catalog" } }
  class FileReader {
    result = "data:application/zip;base64,ZIP"
    onload?: () => void
    readAsDataURL() { queueMicrotask(() => this.onload?.()) }
  }
  const scope = { disposed: false, busy: () => busy, setBusy: (value: boolean) => { busy = value },
    setFailed: (value: boolean) => { failed = value }, props: { controller }, setPreview: (value: unknown) => { preview = value; selected = value },
    setAcknowledged: () => {}, removal: () => ({ id: entry.manifest.id, digest: entry.digest }), setRemoval: () => {},
    preview: () => selected, acknowledged: () => true, setQuery: () => {},
    generation: 0, controller: undefined, setLoading: () => {}, setCatalogFailed: () => {}, setCatalog: () => {},
    FileReader, reader: undefined, PANEL_EXTENSION_LIMITS: { archiveBytes: 2 * 1024 * 1024 } }
  const run = managerAction("run", scope)
  return { inspect: managerAction("inspectCatalog", { ...scope, run }), install: managerAction("install", { ...scope, run }),
    zip: managerAction("inspect", { ...scope, run }), load: managerAction("load", scope),
    remove: managerAction("remove", { ...scope, run }), state: () => ({ busy, failed, preview }) }
}

test("real panel inventory, manager and API2/3/4 bridges isolate two backends and send raw workspace ids", async t => {
  const a = fixture(t, "panelsA"), b = fixture(t, "panelsB")
  for (const owner of [a, b]) {
    const id = `${owner.backend.id}~w/1`, controller = inventory(t, id)
    await flush(); assert.equal(controller.verified(), true)
    await controller.activate(entry, true)
    const ui = manager(controller)
    ui.inspect(entry); await flush(); assert.ok(ui.state().preview)
    await ui.install(); await ui.remove()
    await ui.zip({ size: 1 }); assert.ok(ui.state().preview); await ui.install()
    await ui.load()
    const answers = await bridges(t, id)
    assert.equal(answers.length, 3)
    assert.equal(answers.some(value => value.error), false)
    assert.deepEqual(answers.find(value => value.id === 3).result, { owner: `${owner.backend.id.toLowerCase()}.invalid` })
    assert.deepEqual(await panelExtensionsApi.panel(id, entry.manifest.id, entry.digest, new AbortController().signal), { html: "<p>local srcdoc</p>" })
    for (const call of owner.calls) {
      assert.ok(call.url.startsWith(`https://${owner.backend.id.toLowerCase()}.invalid/`))
      assert.equal(JSON.stringify(call).includes(`${owner.backend.id}~`), false)
      if (call.body && String(call.body).includes("instanceId")) assert.equal(JSON.parse(String(call.body)).instanceId, "w/1")
    }
    assert.ok(owner.calls.some(call => call.url.includes("instanceId=w%2F1")))
    assert.ok(owner.calls.some(call => call.url.endsWith("/catalog/install")))
    assert.ok(owner.calls.some(call => call.method === "DELETE"))
    assert.ok(owner.calls.some(call => call.body && JSON.parse(String(call.body)).archiveBase64 === "ZIP"))
  }
})

test("missing backend produces real consumer errors with zero local dispatch", async t => {
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}) })
  const owner = fixture(t, "panelsMissing")
  registry.delete(owner.backend.id)
  const controller = inventory(t, "panelsMissing~w/1")
  await flush(); assert.equal(controller.failed(), true); assert.equal(controller.verified(), false)
  const answers = await bridges(t, "panelsMissing~w/1")
  assert.equal(answers.length, 3); assert.ok(answers.every(value => value.error))
  assert.throws(() => panelExtensionsFor("panelsMissing~w/1"), /Backend unavailable/)
  assert.equal(calls, 0); assert.equal(owner.calls.length, 0)
})

test("local contextual calls preserve standalone wire bytes and errors", async t => {
  const calls: Wire[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = wire(input, init); calls.push(request); return reply(request)
  })
  const signal = new AbortController().signal
  const authority = { instanceId: "w/1", id: entry.manifest.id, digest: entry.digest }
  await panelExtensionsFor("w/1").panelExtensionsApi.list()
  await panelExtensionsApi.assets("w/1", entry.manifest.id, entry.digest, "session", undefined, signal)
  await panelExtensionsApi.workItems("w/1", entry.manifest.id, entry.digest, { kind: "issue", query: "word", page: 1, fresh: false }, signal)
  await panelExtensionsApi4.preferencesSet(authority, { choice: 1 }, signal)
  await panelExtensionsApi.panel("w/1", entry.manifest.id, entry.digest, signal)
  const routed = calls.splice(0), baseline = createPanelExtensionsApi(localBackend)
  await baseline.panelExtensionsApi.list()
  await baseline.panelExtensionsApi.assets("w/1", entry.manifest.id, entry.digest, "session", undefined, signal)
  await baseline.panelExtensionsApi.workItems("w/1", entry.manifest.id, entry.digest, { kind: "issue", query: "word", page: 1, fresh: false }, signal)
  await baseline.panelExtensionsApi4.preferencesSet(authority, { choice: 1 }, signal)
  await baseline.panelExtensionsApi.panel("w/1", entry.manifest.id, entry.digest, signal)
  assert.deepEqual(routed, calls)
  t.mock.method(globalThis, "fetch", async () => new Response("refused", { status: 403 }))
  const controller = inventory(t, "w/1")
  await flush(); assert.equal(controller.failed(), true)
  const answers = await bridges(t, "w/1")
  assert.ok(answers.every(value => value.error))
})

test("revocation during response JSON rejects API results and manager publication", async t => {
  const body = deferred<unknown>(), started = deferred<void>()
  const owner = fixture(t, "panelsRevoked", request => {
    if (request.url.endsWith("/catalog/inspect")) return { ok: true, json: () => { started.resolve(); return body.promise } } as Response
    return reply(request)
  })
  const id = "panelsRevoked~w/1", controller = inventory(t, id)
  await flush()
  const ui = manager(controller)
  ui.inspect(entry); await started.promise
  owner.detach(); body.resolve(entry); await flush()
  assert.deepEqual(ui.state(), { busy: false, failed: false, preview: undefined })
  assert.equal(owner.calls.filter(call => call.url.endsWith("/api/panel-extensions")).length, 1, "revoked inspection cannot refresh")
})

test("old inventory and activation completions cannot release or publish into a replacement attachment", async t => {
  const oldRead = deferred<Response>(), newRead = deferred<Response>(), oldMutation = deferred<Response>(), newMutation = deferred<Response>()
  let reads = 0, mutations = 0
  const owner = fixture(t, "panelsGeneration", request => {
    if (request.method === "PATCH") return ++mutations === 1 ? oldMutation.promise : newMutation.promise
    if (request.url.endsWith("/api/panel-extensions")) {
      reads++
      return reads === 1 ? Response.json([entry]) : reads === 2 ? oldRead.promise : reads === 3 ? newRead.promise : Response.json([entry])
    }
    return reply(request)
  })
  const id = "panelsGeneration~w/1", controller = inventory(t, id)
  await flush()
  const oldActivation = controller.activate(entry, true)
  const refresh = controller.refresh(); await flush()
  owner.detach()
  const detach = backendEvents.attach(owner.backend.id, owner.backend.events); t.after(detach)
  ;(owner.backend.events as any).emitTransportStatus("connected")
  await flush(); assert.equal(reads, 3)
  oldRead.resolve(Response.json([{ ...entry, digest: "old" }]))
  await refresh; await flush()
  assert.equal(controller.verified(), false)
  newRead.resolve(Response.json([entry])); await flush()
  assert.equal(controller.entries()[0].digest, "d")
  const nextActivation = controller.activate(entry, false); await flush()
  oldMutation.resolve(Response.json({})); await oldActivation
  assert.equal(controller.activating(), true)
  newMutation.resolve(Response.json({})); await nextActivation
  assert.equal(controller.activating(), false)
})

test("inventory invalidations share one in-flight read and one trailing refresh", async t => {
  const read = deferred<Response>()
  let count = 0
  const owner = fixture(t, "panelsShared", () => ++count === 1 ? read.promise : Response.json([entry]))
  const controller = inventory(t, `${owner.backend.id}~w/1`)
  await flush()
  const a = controller.refresh(), b = controller.refresh()
  assert.equal(count, 1)
  read.resolve(Response.json([entry])); await Promise.all([a, b])
  assert.equal(count, 2); assert.equal(controller.verified(), true)
})

test("real API2/3/4 bridge and panel-document IO stays revoked after backend reattachment", async t => {
  const result = deferred<Response>()
  const owner = fixture(t, "panelsBridgeRevoked", () => result.promise)
  const id = "panelsBridgeRevoked~w/1"
  const receive = bridges(t, id)
  const document = panelExtensionsApi.panel(id, entry.manifest.id, entry.digest, new AbortController().signal)
  await flush(); assert.equal(owner.calls.length, 4)
  owner.detach()
  const detach = backendEvents.attach(owner.backend.id, owner.backend.events); t.after(detach)
  result.resolve(Response.json({ status: "ok", value: {}, html: "late" }))
  await assert.rejects(document, { name: "AbortError" })
  assert.deepEqual(await receive, [])
  assert.equal(owner.calls.length, 4, "old operations never retry on the new attachment")
})

test("registered local inventory and capability consumers preserve every injected local URL join", () => {
  for (const base of [undefined, "", "/relay", "/relay/", "https://local.invalid", "https://local.invalid/tenant/"]) {
    const result = spawnSync(process.execPath, ["--conditions=browser", "--import", "tsx", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      const base = ${JSON.stringify(base) ?? "undefined"};
      if (base !== undefined) globalThis.window = { __CODENOMAD_API_BASE__: base, location: { origin: "https://page.invalid" } };
      const requests = [];
      globalThis.fetch = async (input, init) => { requests.push({ url: String(input), body: init?.body, method: init?.method }); return Response.json({}); };
      const { panelExtensionsFor } = await import(${JSON.stringify(new URL("./panel-extensions-backend.ts", import.meta.url).href)});
      const { panelExtensionsApi, panelExtensionsApi4 } = await import(${JSON.stringify(new URL("./panel-extensions-api.ts", import.meta.url).href)});
      requests.length = 0;
      await panelExtensionsFor("w/1").panelExtensionsApi.list();
      const signal = new AbortController().signal;
      await panelExtensionsApi.assets("w/1", "example.panel", "d", "session", undefined, signal);
      await panelExtensionsApi4.preferencesGet({ instanceId: "w/1", id: "example.panel", digest: "d" }, signal);
      assert.deepEqual(requests.map(value => value.url), ["", "/example.panel/assets", "/example.panel/preferencesGet"].map(path => (base ?? "") + "/api/panel-extensions" + path));
      assert.equal(requests[1].body, JSON.stringify({ instanceId: "w/1", digest: "d", sessionID: "session" }));
      assert.equal(requests[2].body, JSON.stringify({ instanceId: "w/1", digest: "d" }));
      process.exit(0); // The real backend imports application lifetime timers.
    `], { encoding: "utf8", timeout: 30_000, windowsHide: true })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${base}: ${result.stdout}\n${result.stderr}`)
  }
})

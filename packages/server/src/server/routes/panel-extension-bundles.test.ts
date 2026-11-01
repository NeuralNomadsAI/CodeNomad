import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import Fastify from "fastify"
import pino from "pino"
import { PanelExtensionStore } from "../../panel-extensions/store"
import { readPanelExtensionArchive } from "../../panel-extensions/archive"
import { fixtureArchive } from "../../panel-extensions/archive-fixture"
import { IntegrationCatalogSource, INTEGRATION_CATALOG_CACHE_MS } from "../../opencode/integrations/catalog"
import { catalogEntry, catalogOf, pluginSnapshot } from "../../opencode/integrations/catalog-fixture"
import { IntegrationsReader } from "../../opencode/integrations/integrations"
import { IntegrationAttachments } from "../../opencode/integrations/attachments"
import { registerRequestLogging } from "../request-logging"
import { registerPanelExtensionBundlesRoutes, BUNDLES_RATE_WINDOW_MS, BUNDLES_READS_PER_MINUTE } from "./panel-extension-bundles"
import { createOfferRegistry, createFakeIntegrationRpc, fakeIntegrationMarker, startFakeHost,
  // @ts-expect-error The shared dependency-free native fixture is JavaScript.
  assertNoSentinels, FAKE_INTEGRATION_SENTINELS } from "../../../../../scripts/fixtures/fake-integration/index.mjs"

const readPermissions = ["session.context", "bundles.read"]
const privateFields = { source: "SOURCE_SENTINEL", spec: "SPEC_SENTINEL", session: "ses_FOREIGN_SENTINEL",
  project: "PROJECT_SENTINEL", document: "FOREIGN_DOCUMENT_SENTINEL", ownerProof: "OWNER_PROOF_SENTINEL",
  domainID: "DOMAIN_SENTINEL", intentID: "INTENT_SENTINEL", serviceGeneration: "SERVICE_GENERATION_SENTINEL",
  registryGeneration: "REGISTRY_GENERATION_SENTINEL", cursor: "CURSOR_SENTINEL", digest: "DIGEST_SENTINEL", raw: "RAW_ERROR_SENTINEL",
  revision: "REVISION_SENTINEL", globalCounts: "GLOBAL_COUNTS_SENTINEL", projectCounts: "PROJECT_COUNTS_SENTINEL", notice: "future_notice_sentinel" }
const secrets = { ...FAKE_INTEGRATION_SENTINELS, ...privateFields }
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function bounded<T>(work: PromiseLike<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Test deadline")), ms) })]) }
  finally { clearTimeout(timer) }
}

async function fixture(t: TestContext, options: {
  permissions?: string[]; level?: "debug" | "trace"; budget?: number
  rpc?: (method: string, input: any, signal: AbortSignal, output: any) => unknown | Promise<unknown>
  onGet?: (id: string, count: number, signal: AbortSignal) => unknown
  catalog?: Pick<IntegrationCatalogSource, "read">
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "codenomad-bundles-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const host = await startFakeHost({ leaky: true })
  t.after(() => host.close())
  const clock = { now: 100_000 }
  const registry = createOfferRegistry({ now: () => clock.now })
  assert.deepEqual(await registry.advertise(host.advertiseInput()), { outcome: "accepted" })
  const offer = registry.hosts().offers[0]
  registry.attach(offer.offerID, privateFields.session)
  const native = createFakeIntegrationRpc({ marker: fakeIntegrationMarker(), registry })
  const store = new PanelExtensionStore(directory)
  const pkg = await readPanelExtensionArchive(fixtureArchive("<p>read</p>", { apiVersion: 4, permissions: options.permissions ?? readPermissions }))
  await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
  const state = { current: true, connected: true, owned: new Set(["/work", "/other-owned"]), reads: 0 }
  const sessions: Record<string, any> = { ses_displayed: { id: "ses_displayed", location: { directory: "/work" } },
    [privateFields.session]: { id: privateFields.session, location: { directory: "/other-owned" } } }
  for (const session of Object.values(sessions)) Object.defineProperty(session, "metadata", { get() { assert.fail("Binding authority must never read Q8") } })
  const calls: Array<{ method: string; rpcID: string; input: any; location: any }> = [], trace: string[] = [], logs: string[] = []
  const client = { session: {
    get: async ({ sessionID }: { sessionID: string }, { signal }: { signal: AbortSignal }) => {
      trace.push(`get:${sessionID}`)
      await options.onGet?.(sessionID, ++state.reads, signal)
      if (!sessions[sessionID]) throw Object.assign(new Error(privateFields.raw), { _tag: "SessionNotFoundError" })
      return sessions[sessionID]
    },
    update: async () => assert.fail("Read routes must never mutate session metadata"),
    list: async () => assert.fail("Read routes must never enumerate sessions"),
  }, rpc: { call: async (request: any, { signal }: { signal: AbortSignal }) => {
    calls.push(request); trace.push(request.method)
    assert.equal(request.rpcID, "neuralnomads.fixture")
    assert(["status", "hosts", "bindingRead"].includes(request.method), "No mutation dispatch")
    const output = await native.handlers[request.method](request.input)
    return { output: options.rpc ? await options.rpc(request.method, request.input, signal, output) : output }
  } } }
  const connection = { client, assertCurrent: () => { if (!state.current) throw new Error(privateFields.raw) } }
  const workspaceManager: any = {
    getSharedServiceConnection: async (id: string) => id === "instance" && state.connected ? connection : undefined,
    ownsLocation: async (id: string, location: any) => id === "instance" && location.workspaceID === undefined && state.owned.has(location.directory),
  }
  const entry = catalogEntry("fixture", { sources: { git: [`https://github.com/example/${privateFields.source}`] } })
  const catalog = options.catalog ?? { read: async () => ({ state: "fresh" as const, fetchedAt: new Date(0).toISOString(), catalog: catalogOf(entry) }) }
  const controls = { read: async (_id: string, location: any) => ({ ...pluginSnapshot({
    sources: [{ target: "@neuralnomads/opencode-fixture", scope: "global", entryIndex: 0, hasOptions: true,
      pluginId: "neuralnomads.fixture", path: `/private/${privateFields.document}`, spec: privateFields.spec } as any],
    runtime: [{ key: privateFields.source, id: "neuralnomads.fixture", features: {}, state: { status: "active" },
      source: { type: "package", target: "@neuralnomads/opencode-fixture", version: "0.1.0", outdated: true } }],
  }), location }) }
  const integrations = new IntegrationsReader({ controls, workspaceManager, catalog, timeoutMs: 500 })
  const attachments = new IntegrationAttachments({ controls, workspaceManager, catalog, timeoutMs: 500 })
  const logger = pino({ level: options.level ?? "trace" }, { write: (line: string) => { logs.push(line) } })
  const app = Fastify({ logger: false })
  registerRequestLogging(app, logger as any)
  app.addHook("onRequest", async request => { request.log = logger })
  registerPanelExtensionBundlesRoutes(app, { store, workspaceManager, catalog, integrations, attachments,
    now: () => clock.now, routeBudgetMs: options.budget ?? 1_000 })
  t.after(() => app.close())
  const payload = (body = {}) => ({ instanceId: "instance", digest: pkg.digest, sessionID: "ses_displayed", ...body })
  const post = (method: string, body = {}, id = pkg.manifest.id) => app.inject({ method: "POST",
    url: `/api/panel-extensions/${id}/bundles/${method}`, payload: payload(body) })
  const clean = (value: unknown) => assertNoSentinels(value, { sentinels: secrets }, "HTTP/log projection")
  return { app, directory, host, registry, offer, store, pkg, clock, state, sessions, calls, trace, logs, catalog, payload, post, clean }
}

test("C3A: real binding registry projects only the exact conversation, never the aggregate foreign attachment", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const response = await f.post("state")
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.headers["cache-control"], "no-store")
  const item = response.json().integrations[0]
  assert.deepEqual(item, { id: "fixture", family: "native", configured: true, scopes: ["global"],
    activation: { global: "default", project: "default", effective: "default" }, version: "0.1.0", outdated: true, state: "ok",
    status: { version: "0.1.0", host: { state: "ok", partVersion: "0.1.0", expectedRange: "^0.1.0" }, connection: { offers: 1 } }, attachment: { state: "none" } })
  assert.deepEqual(f.calls.filter(call => call.method === "bindingRead").map(call => call.input), [{ sessionID: "ses_displayed" }])
  const bindingIndex = f.trace.indexOf("bindingRead")
  assert.deepEqual(f.trace.slice(bindingIndex - 1, bindingIndex + 2), ["get:ses_displayed", "bindingRead", "get:ses_displayed"])
  assert.equal(f.trace.at(-1), "get:ses_displayed", "Final envelope rechecks the same native identity")
  f.registry.attach(f.offer.offerID, "ses_displayed")
  assert.deepEqual((await f.post("state")).json().integrations[0].attachment, { state: "attached", label: f.offer.label })
  const hosts = await f.post("hosts", { integration: "fixture" })
  assert.deepEqual(hosts.json(), { offers: [f.offer] })
  const catalog = await f.post("catalog")
  assert.deepEqual(Object.keys(catalog.json().integrations[0]).sort(), ["app", "catalogStatus", "displayName", "docs", "family", "id", "summary"])
  f.clean([response.json(), hosts.json(), catalog.json(), f.logs])
  assertNoSentinels(hosts.json(), { port: f.host.port })
})

test("C3A: consent, digest, missing/disabled package fail before native IO on every read", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { permissions: ["session.context", "panel.preferences"] })
  for (const method of ["catalog", "state", "hosts"]) assert.equal((await f.post(method, method === "hosts" ? { integration: "fixture" } : {})).statusCode, 403)
  assert.equal(f.state.reads, 0)
  const g = await fixture(t)
  for (const method of ["catalog", "state", "hosts"]) {
    const body = method === "hosts" ? { integration: "fixture" } : {}
    assert.equal((await g.post(method, { ...body, digest: "0".repeat(64) })).statusCode, 409)
    assert.equal((await g.post(method, body, "missing.addon")).statusCode, 404)
  }
  await g.store.activate(g.pkg.manifest.id, g.pkg.digest, false)
  for (const method of ["catalog", "state", "hosts"]) assert.equal((await g.post(method, method === "hosts" ? { integration: "fixture" } : {})).statusCode, 403)
  assert.equal(g.state.reads, 0); assert.equal(g.calls.length, 0)
})

test("C3A: revocation, removal and replacement during real native IO discard its result", { timeout: 10_000 }, async t => {
  for (const change of ["disable", "remove", "replace"] as const) for (const method of ["catalog", "state", "hosts"]) {
    const entered = deferred(), release = deferred()
    const f = await fixture(t, { ...(method === "catalog" ? { catalog: { read: async () => {
      entered.resolve(); await release.promise
      return { state: "fresh" as const, catalog: catalogOf(catalogEntry("fixture")) }
    } } } : {}), rpc: async (name, _input, _signal, output) => {
      if (name === "status") { entered.resolve(); await release.promise }
      return output
    } })
    const pending = f.post(method, method === "hosts" ? { integration: "fixture" } : {}).then(value => value)
    await bounded(entered.promise)
    if (change === "disable") await f.store.activate(f.pkg.manifest.id, f.pkg.digest, false)
    if (change === "remove") await f.store.remove(f.pkg.manifest.id, f.pkg.digest)
    if (change === "replace") await f.store.install(await readPanelExtensionArchive(fixtureArchive("<p>replacement</p>", {
      apiVersion: 4, permissions: readPermissions, version: "2.0.0" })), f.pkg.digest)
    release.resolve()
    const response = await bounded(pending)
    assert.equal(response.statusCode, { disable: 403, remove: 404, replace: 409 }[change])
    assert.deepEqual(response.json(), { error: "Panel extension request unavailable" })
    f.clean([response.json(), f.logs])
  }
})

test("C3A: exact native identity, move/deletion, ownership and current connection are fenced before and after IO", { timeout: 15_000 }, async t => {
  for (const method of ["catalog", "state", "hosts"]) for (const when of ["before", "after"]) {
    for (const change of ["id", "move", "delete", "ownership", "connection", "disconnect", "workspaceID"]) {
      let f!: Awaited<ReturnType<typeof fixture>>
      const mutate = () => {
        if (change === "id") f.sessions.ses_displayed.id = "ses_wrong"
        if (change === "move") f.sessions.ses_displayed.location = { directory: "/other-owned" }
        if (change === "delete") delete f.sessions.ses_displayed
        if (change === "ownership") f.state.owned.clear()
        if (change === "connection") f.state.current = false
        if (change === "disconnect") { f.state.connected = false; f.state.current = false }
        if (change === "workspaceID") f.sessions.ses_displayed.location.workspaceID = "retired"
      }
      f = await fixture(t, { onGet: (_id, count) => { if (when === "after" && count === 2) mutate() } })
      if (when === "before") {
        // A session moved before the request is legitimate at its newly captured Location.
        if (change === "move") { f.sessions.ses_displayed.location = { directory: "/unowned" } }
        else mutate()
      }
      const response = await f.post(method, method === "hosts" ? { integration: "fixture" } : {})
      assert.notEqual(response.statusCode, 200, `${method} ${when} ${change}`)
      if (when === "before") assert.equal(f.calls.length, 0)
      f.clean([response.json(), f.logs])
    }
  }
  const f = await fixture(t)
  f.sessions.ses_displayed.location = { directory: "/other-owned" }
  assert.equal((await f.post("state")).statusCode, 200)
  assert(f.calls.every(call => call.location.directory === "/other-owned"))
})

test("C3A: bindingRead missing/nonconforming/failure stays unknown, never none; no raw errors", { timeout: 10_000 }, async t => {
  for (const output of [{ state: "none" }, { state: "none", authority: { serviceGeneration: "a", registryGeneration: "b", revision: 0 }, ownerProof: privateFields.ownerProof },
    { state: "attached", authority: { serviceGeneration: "a", registryGeneration: "b", revision: 0 }, binding: { offerID: "offer_fixture", label: "C:private" } }]) {
    const f = await fixture(t, { rpc: (method, _input, _signal, native) => method === "bindingRead" ? output : native })
    const response = await f.post("state")
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().integrations[0].attachment, { state: "unknown" })
    f.clean([response.json(), f.logs])
  }
  for (const type of ["rpc.method_not_found", "rpc.unavailable", "rpc.invalid_output", "other"]) {
    const f = await fixture(t, { rpc: (method, _input, _signal, native) => {
      if (method === "bindingRead") throw Object.assign(new Error(privateFields.raw), { _tag: "RpcError", type, input: secrets })
      return native
    } })
    assert.deepEqual((await f.post("state")).json().integrations[0].attachment, { state: "unknown" })
    f.clean(f.logs)
  }
})

test("C3A: whitelist strips hostile status/host extras and rejects unsafe host labels, documents and versions", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { rpc: (method, _input, _signal, native) => method === "status" ? { ...native, ...secrets,
    host: { ...native.host, ...secrets }, connection: { ...native.connection, ...secrets, attachedSessions: 9831 }, notices: ["legacy_install", privateFields.notice] }
    : method === "hosts" ? { offers: native.offers.map((offer: any) => ({ ...offer, ...secrets, label: offer.label, document: "Scene.blend" })) }
    : { ...native, authority: { serviceGeneration: privateFields.serviceGeneration, registryGeneration: privateFields.registryGeneration, revision: 991337 } } })
  // The extra top-level `spec` is not the marker's integration.spec.
  const state = await f.post("state"), hosts = await f.post("hosts", { integration: "fixture" })
  assert.equal(state.statusCode, 200, state.body); assert.equal(hosts.statusCode, 200, hosts.body)
  assert.deepEqual(state.json().integrations[0].status.connection, { offers: 1 })
  assert.deepEqual(state.json().integrations[0].status.notices, ["legacy_install"])
  assert.deepEqual(state.json().integrations[0].attachment, { state: "none" }, "Conforming sentinel authority remains backend-only")
  assert(!JSON.stringify(state.json()).includes("991337"), "The registry revision remains backend-only")
  f.clean([state.json(), hosts.json(), f.logs])
  for (const key of ["label", "document", "appVersion"]) for (const value of ["C:private", "~private", "/private/scene", "bad\nvalue"]) {
    const g = await fixture(t, { rpc: (method, _input, _signal, native) => method === "hosts" ? { offers: [{ ...native.offers[0], [key]: value }] } : native })
    const response = await g.post("hosts", { integration: "fixture" })
    assert.notEqual(response.statusCode, 200, `${key}: ${value}`)
    g.clean([response.json(), g.logs])
  }
})

test("C3A: strict body selectors reject arbitrary native authority before IO; manage grants expose no mutation routes", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { permissions: [...readPermissions, "bundles.manage"] })
  for (const method of ["catalog", "state", "hosts"]) {
    const base = method === "hosts" ? { integration: "fixture" } : {}
    for (const body of [{ sessionID: "arbitrary" }, { sessionID: "ses_bad\n" }, { sessionID: "ses" + "a".repeat(126) },
      { rpcID: "neuralnomads.evil" }, { method: "attachHost" }, { directory: "/arbitrary" }, { location: { directory: "/arbitrary" } },
      { workspaceID: "arbitrary" }, { source: privateFields.spec }, { offerID: "offer_fixture" }, { ownerProof: privateFields.ownerProof }]) {
      assert.equal((await f.post(method, { ...base, ...body })).statusCode, 400, `${method} ${JSON.stringify(body)}`)
    }
  }
  assert.equal((await f.post("hosts", { integration: "../native" })).statusCode, 400)
  for (const method of ["request", "installHost", "install-host", "setActive", "attach", "detach"]) {
    assert.equal((await f.post(method, { integration: "fixture" })).statusCode, 404, method)
  }
  assert.equal(f.calls.length, 0); assert.equal(f.state.reads, 0)
  assert.notEqual((await f.post("hosts", { integration: "unknown" })).statusCode, 200)
  assert.equal(f.calls.length, 0, "Unknown catalog integration never dispatches a caller-selected RPC")
})

test("C3A: shared sliding 60/min budget uses injectable time and isolates extensions", { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  assert.equal(BUNDLES_READS_PER_MINUTE, 60); assert.equal(BUNDLES_RATE_WINDOW_MS, 60_000)
  for (let index = 0; index < 60; index++) {
    if (index === 30) f.clock.now++
    const method = ["catalog", "state", "hosts"][index % 3]!
    assert.equal((await f.post(method, method === "hosts" ? { integration: "fixture" } : {})).statusCode, 200)
  }
  assert.equal((await f.post("catalog")).statusCode, 429)
  const second = await readPanelExtensionArchive(fixtureArchive("<p>second</p>", { id: "other.extension", apiVersion: 4, permissions: readPermissions }))
  await f.store.install(second); await f.store.activate(second.manifest.id, second.digest, true)
  assert.equal((await f.post("catalog", { digest: second.digest }, second.manifest.id)).statusCode, 200)
  f.clock.now = 100_000 + BUNDLES_RATE_WINDOW_MS - 1
  assert.equal((await f.post("catalog")).statusCode, 429)
  f.clock.now++
  assert.equal((await f.post("catalog")).statusCode, 200, "The oldest half expire exactly at the window boundary")
})

test("C3A: route deadline and real caller disconnect abort native work and fence late dispatch", { timeout: 10_000 }, async t => {
  for (const stage of ["session", "rpc"]) {
    const entered = deferred(), release = deferred(), signals: AbortSignal[] = []
    const hold = async (signal: AbortSignal) => { signals.push(signal); entered.resolve(); await release.promise }
    const f = await fixture(t, { budget: 40, onGet: (_id, _count, signal) => stage === "session" ? hold(signal) : undefined,
      rpc: async (_method, _input, signal, native) => { if (stage === "rpc") await hold(signal); return native } })
    const pending = f.post("state").then(value => value)
    await bounded(entered.promise)
    assert.equal((await bounded(pending)).statusCode, 503)
    assert(signals.every(signal => signal.aborted))
    const calls = f.calls.length, reads = f.state.reads
    release.resolve(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.calls.length, calls, "Cancelled continuation dispatches no next native call")
    assert.equal(f.state.reads, reads, "Cancelled continuation dispatches no session re-read")
  }
  const entered = deferred(), release = deferred(); let nativeSignal!: AbortSignal
  const f = await fixture(t, { rpc: async (_method, _input, signal, native) => { nativeSignal = signal; entered.resolve(); await release.promise; return native } })
  const settled = deferred<number>()
  f.app.addHook("onSend", async (_request, reply, payload) => { settled.resolve(reply.statusCode); return payload })
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 }), caller = new AbortController()
  const pending = fetch(`${address}/api/panel-extensions/${f.pkg.manifest.id}/bundles/state`, { method: "POST", signal: caller.signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify(f.payload()) })
  await bounded(entered.promise); caller.abort(); await assert.rejects(pending)
  assert.equal(await bounded(settled.promise), 503); assert.equal(nativeSignal.aborted, true)
  release.resolve()
})

test("C3A: actual DEBUG/TRACE completion hooks omit selectors, foreign authority, host secrets and raw native errors", { timeout: 10_000 }, async t => {
  for (const level of ["debug", "trace"] as const) {
    const f = await fixture(t, { level, rpc: () => { throw Object.assign(new Error(privateFields.raw), { cause: secrets }) } })
    for (const method of ["state", "hosts"]) f.clean((await f.post(method, method === "hosts" ? { integration: "fixture" } : {})).json())
    const response = await f.app.inject({ method: "POST", url: `/api/panel-extensions/${privateFields.session}/bundles/state?${privateFields.ownerProof}=${privateFields.document}`,
      payload: f.payload({ ...secrets, sessionID: privateFields.session }) })
    f.clean(response.json()); f.clean(f.logs)
    for (const pathname of ["bundles%2Fstate", "bundles%5Cstate", "/bundles/state", "bundles%3Bstate", "bundles/state/unknown"]) {
      await f.app.inject({ method: "POST", url: `/api/panel-extensions/${privateFields.session}/${pathname}?ownerProof=${privateFields.ownerProof}`,
        payload: f.payload({ document: privateFields.document }) })
      assert.doesNotThrow(() => f.clean(f.logs), pathname)
    }
    for (const id of [`addon;${privateFields.session}`, `addon%3B${privateFields.session}`, `${privateFields.session}%2Fextra`]) {
      const response = await f.app.inject({ method: "POST", url: `/api/panel-extensions/${id}/bundles/unknown?owner=${privateFields.ownerProof}`, payload: {} })
      f.clean([response.json(), f.logs])
    }
    const records = f.logs.map(line => JSON.parse(line))
    assert(records.some(record => record.level === 20 && record.msg === "HTTP request completed"))
    if (level === "trace") assert(records.some(record => record.level === 10 && record.msg === "HTTP request payload"))
    assert(records.every(record => !record.body && !record.query && !record.params))
  }
})

test("C3A: real catalog source serves unavailable/fresh/stale, cached and persisted, through the HTTP facade", { timeout: 10_000 }, async t => {
  let available = false, requests = 0, now = 0
  const server = createServer((request, response) => {
    requests++
    if (!available) return void response.writeHead(503).end(privateFields.raw)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(request.url === "/asset" ? catalogOf(catalogEntry("fixture")) : [{ tag_name: "catalog-v1", draft: false, prerelease: false,
      assets: [{ name: "catalog.json", id: 1, updated_at: "2026-10-31T00:00:00Z", url: `http://${request.headers.host}/asset` }] }]))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const releasesUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/releases`
  const directory = await mkdtemp(path.join(tmpdir(), "codenomad-bundles-catalog-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = new IntegrationCatalogSource({ releasesUrl, now: () => now, stateFile: path.join(directory, "catalog.json"), timeoutMs: 500 })
  const f = await fixture(t, { catalog: source })
  assert.deepEqual((await f.post("catalog")).json(), { state: "unavailable", integrations: [] })
  assert.deepEqual((await f.post("state")).json(), { catalog: { state: "unavailable" }, integrations: [] })
  assert.equal(requests, 1)
  available = true; now += INTEGRATION_CATALOG_CACHE_MS
  const fresh = (await f.post("catalog")).json()
  assert.equal(fresh.state, "fresh"); assert.equal(fresh.integrations.length, 1)
  assert.equal(requests, 3)
  available = false; now += INTEGRATION_CATALOG_CACHE_MS
  const stale = (await f.post("catalog")).json()
  assert.deepEqual(stale, { ...fresh, state: "stale" })
  const restored = await fixture(t, { catalog: new IntegrationCatalogSource({ releasesUrl, stateFile: path.join(directory, "catalog.json"), timeoutMs: 500 }) })
  assert.deepEqual((await restored.post("catalog")).json(), stale)
  f.clean([fresh, stale, f.logs])
})

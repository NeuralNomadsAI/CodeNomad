import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test, type TestContext } from "node:test"
import ts from "typescript"
import { backends, createBackendClient, type BackendClient } from "./backend-client"
import { backendEvents } from "./backend-events"
import { captureBackendOperation } from "./backend-operation"
import { fetchIntegrationBinding, fetchIntegrations, installIntegration, integrationAttachmentRequest } from "./integrations-api"
import { HttpResponseError } from "./retryable-file-search"
import { integrations, integrationBindings } from "../stores/integrations"
import { createIntegrationBindingsStore } from "../stores/integration-bindings-store"
import { pluginSourcesStore } from "../stores/plugin-sources"

const catalogue = { integrations: [], catalog: { state: "fresh", fetchedAt: 1 } }
const target = (instanceId: string) => ({ instanceId, directory: "/repo dir", sessionID: "ses_1", integrationId: "fixture" })
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(done => setImmediate(done)) }
type Wire = { url: string; method: string; body: unknown; headers: [string, string][]; credentials?: RequestCredentials; cache?: RequestCache }
function wire(input: RequestInfo | URL, init?: RequestInit): Wire {
  return { url: String(input), method: init?.method ?? "GET", body: init?.body,
    headers: [...new Headers(init?.headers)], credentials: init?.credentials, cache: init?.cache }
}
function reply(call: Wire) {
  const action = new URL(call.url, "https://local.invalid").pathname.split("/").at(-1)
  return Response.json(action === "binding" ? { state: "attached", label: "Scene" }
    : action === "hosts" ? { offers: [{ offerID: "offer_1", protocol: "ok", label: "Scene" }] } : action === "attach" ? { outcome: "attached" }
    : action === "detach" ? { outcome: "detached" } : action === "install-host" ? { outcome: "installed" }
    : action === "install" ? { scope: "global", spec: "fixture@1", reloadPending: true } : catalogue)
}
function fixture(t: TestContext, id: string) {
  const calls: Wire[] = []
  const transport = { answer: async (call: Wire) => reply(call) }
  const backend = createBackendClient({ id, baseUrl: `https://${id}.invalid/tenant`, fetcher: async (input, init) => {
    const call = wire(input, init); calls.push(call); return transport.answer(call)
  } })
  const registry = backends as Map<string, BackendClient>
  registry.set(id, backend)
  let detach = backendEvents.attach(id, backend.events)
  t.after(() => { detach(); backend.events.dispose(); registry.delete(id); integrations.clearInstance(`${id}~w/1`); integrationBindings.clearInstance(`${id}~w/1`) })
  return { backend, calls, transport, detach: () => detach(), reattach: () => { detach = backendEvents.attach(id, backend.events) } }
}

// Execute the real component callback, retaining its await, error and release paths.
function consumer(path: string, name: string, scope: Record<string, unknown>) {
  const file = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: ts.ArrowFunction | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer && ts.isArrowFunction(node.initializer)) found = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file); assert.ok(found, name)
  const code = ts.transpileModule(`(${found.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function("scope", `with (scope) { return ${code} }`)(scope)
}
function hostConsumer(id: string) {
  let pending = false
  const messages: unknown[] = []
  const scope = { props: { instanceId: id, directory: "/repo dir" }, pending: () => pending,
    setPending: (value: boolean) => { pending = value }, eligible: () => ({ app: { name: "Fixture" }, displayName: "Fixture", status: { version: "1", host: { action: "install" } } }),
    identity: () => id, epoch: () => "epoch", signature: () => "signature", focusGeneration: 0,
    confirmation: undefined, target: undefined, pendingOwner: undefined, disposed: false, cancel() {},
    document: { activeElement: null }, HTMLElement: class {}, captureBackendOperation,
    confirmIntegrationAction: async () => true, integrationAttachmentRequest, integrations, HttpResponseError,
    showToastNotification: (value: unknown) => messages.push(value), t: (key: string) => key }
  return { open: consumer("../components/integration-host-installation.ts", "open", scope), pending: () => pending, messages }
}
function detachConsumer(id: string) {
  const bindingTarget = target(id), messages: unknown[] = []
  const scope = { props: { instanceId: id, session: { id: "ses_1" }, onMessage: (value: unknown) => messages.push(value) },
    identity: () => id, target: () => bindingTarget, disposed: false, receiptGeneration: 0, attached: () => true,
    receipts: () => new Map(), captureBackendOperation, integrationBindings, integrationAttachmentRequest,
    receipt: () => messages.push("receipt"), fail: () => "error" }
  return { detach: consumer("../components/integration-attachment.tsx", "detach", scope), messages }
}
function attachmentConsumer(id: string) {
  let captured: any, selected: any, pending = false, outcome: unknown
  const scope = { props: { instanceId: id, directory: "/repo dir", session: { id: "ses_1" } },
    shown: () => [{ id: "fixture" }], canOpen: () => true, capture: () => captured,
    setCapture: (value: unknown) => { captured = value }, selected: () => selected,
    setSelected: (value: unknown) => { selected = value }, setPending: (value: boolean) => { pending = value }, pending: () => pending,
    setOutcome: (value: unknown) => { outcome = value }, setError() {}, setOffers() {}, setKnownOffers() {}, setOperation() {},
    ready: () => true, setReady() {}, identity: () => id, epoch: () => "epoch", target: () => target(id),
    captureBackendOperation, claimIntegrationConfirmation: () => () => {}, document: { activeElement: null }, HTMLElement: class {},
    viewGeneration: 0, receiptGeneration: 0, controller: undefined, readyTimer: undefined,
    INTEGRATION_CONFIRM_DELAY_MS: 0, integrationAttachmentRequest, integrationBindings,
    owns: (value: any) => captured === value && value.authority.current(),
    current: (value: any) => captured === value && value.authority.current(), fail: () => "error", receipt() {}, t: (key: string) => key }
  return { open: consumer("../components/integration-attachment.tsx", "open", scope),
    attach: consumer("../components/integration-attachment.tsx", "attach", scope), outcome: () => outcome }
}
async function exercise(id: string) {
  const value = target(id)
  const release = integrations.demand(id, value.directory), unbind = integrationBindings.demand(value)
  await flush()
  assert.equal(integrations.state(id, value.directory).status, "ready")
  assert.deepEqual(integrationBindings.state(value), { state: "attached", label: "Scene" })
  release(); unbind()
  await installIntegration(id, value.directory, value.integrationId, "global")
  const attachment = attachmentConsumer(id)
  await attachment.open("fixture"); await attachment.attach(); assert.equal(attachment.outcome(), "attached")
  const detach = detachConsumer(id); await detach.detach("fixture"); assert.deepEqual(detach.messages, [])
  const host = hostConsumer(id); await host.open("fixture"); assert.equal(host.pending(), false); assert.equal(host.messages.length, 1)
}

test("actual catalogue, binding, attachment and host installation consumers isolate two backends", async t => {
  const a = fixture(t, "integrationsA"), b = fixture(t, "integrationsB")
  for (const owner of [a, b]) {
    await exercise(`${owner.backend.id}~w/1`)
    assert.equal(owner.calls.length, 7)
    for (const call of owner.calls) {
      assert.ok(call.url.startsWith(`https://${owner.backend.id.toLowerCase()}.invalid/api/workspaces/w%2F1/integrations`))
      assert.equal(JSON.stringify(call).includes(`${owner.backend.id}~`), false)
      assert.equal(new URL(call.url).searchParams.get("directory"), "/repo dir")
    }
  }
  assert.equal(a.calls.length, 7)
})

test("local consumers keep the exact baseline URL, query, credentials, headers and bodies", async t => {
  const calls: Wire[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => { const call = wire(input, init); calls.push(call); return reply(call) })
  await exercise("w/1")
  const prefix = "/api/workspaces/w%2F1/integrations", query = "?directory=%2Frepo+dir"
  assert.deepEqual(calls, [
    { url: prefix + query, method: "GET", body: undefined, headers: [], credentials: "include", cache: undefined },
    { url: `${prefix}/fixture/binding${query}&sessionID=ses_1`, method: "GET", body: undefined, headers: [], credentials: "include", cache: "no-store" },
    ...[["install", { scope: "global" }], ["hosts", undefined], ["attach", { sessionID: "ses_1", offerID: "offer_1" }],
      ["detach", { sessionID: "ses_1" }], ["install-host", {}]].map(([action, body]) => ({
      url: `${prefix}/fixture/${action}${query}`, method: action === "hosts" ? "GET" : "POST", body: body ? JSON.stringify(body) : undefined,
      headers: body ? [["content-type", "application/json"]] : [], credentials: "include", cache: "no-store",
    })),
  ])
  integrations.clearInstance("w/1")
})

test("missing backend and HTTP errors fail closed without local fallback or successful receipts", async t => {
  let localCalls = 0
  t.mock.method(globalThis, "fetch", async () => { localCalls++; return Response.json({}) })
  const owner = fixture(t, "integrationsMissing"), id = "integrationsMissing~w/1"
  ;(backends as Map<string, BackendClient>).delete(owner.backend.id)
  await assert.rejects(fetchIntegrations(id, "/repo", new AbortController().signal), /Backend unavailable/)
  assert.deepEqual(await fetchIntegrationBinding(target(id), new AbortController().signal), { state: "unknown" })
  await assert.rejects(installIntegration(id, "/repo", "fixture", "global"), /Backend unavailable/)
  const host = hostConsumer(id); await host.open("fixture")
  assert.equal(host.pending(), false); assert.equal((host.messages[0] as any).variant, "error")
  const detach = detachConsumer(id); await detach.detach("fixture"); assert.deepEqual(detach.messages, ["receipt", "error"])
  assert.equal(localCalls, 0)
  const failed = fixture(t, "integrationsError"), failedId = "integrationsError~w/1"
  failed.transport.answer = async () => Response.json({ code: "forbidden" }, { status: 403 })
  await assert.rejects(fetchIntegrations(failedId, "/repo", new AbortController().signal), { status: 403 })
  assert.deepEqual(await fetchIntegrationBinding(target(failedId), new AbortController().signal), { state: "unknown" })
  await assert.rejects(installIntegration(failedId, "/repo", "fixture", "global"), { status: 403, code: "forbidden" })
  const refused = hostConsumer(failedId); await refused.open("fixture"); assert.equal((refused.messages[0] as any).variant, "error")
})

test("revocation after headers and JSON awaits fences results and releases replacement pending ownership", async t => {
  const owner = fixture(t, "integrationsRevoked"), id = "integrationsRevoked~w/1"
  const finishes: (() => void)[] = []
  owner.transport.answer = async call => new Promise<Response>(done => finishes.push(() => done(reply(call))))
  const host = hostConsumer(id), detach = detachConsumer(id)
  const firstHost = host.open("fixture"), firstDetach = detach.detach("fixture")
  const release = integrations.demand(id, "/repo dir"), unbind = integrationBindings.demand(target(id))
  const install = pluginSourcesStore.installIntegration(id, { directory: "/repo dir" }, "fixture", "global")
  const installed = assert.rejects(install, { name: "AbortError" })
  await flush(); assert.equal(finishes.length, 5)
  owner.detach()
  assert.equal(host.pending(), false)
  assert.equal(integrationBindings.busy(target(id)), true, "admitted binding mutation remains exclusive until settlement")
  owner.reattach()
  const secondHost = host.open("fixture")
  await detach.detach("fixture")
  await flush(); assert.equal(finishes.length, 6, "replacement cannot dispatch a second binding mutation while the old one runs")
  assert.equal(host.pending(), true); assert.equal(integrationBindings.busy(target(id)), true)
  for (const finish of finishes.slice(0, 5)) finish()
  await Promise.all([firstHost, firstDetach, installed]); await flush()
  const secondDetach = detach.detach("fixture")
  await flush(); assert.equal(finishes.length, 7)
  assert.equal(host.pending(), true); assert.equal(integrationBindings.busy(target(id)), true)
  assert.deepEqual(host.messages, []); assert.deepEqual(detach.messages, [])
  assert.deepEqual(pluginSourcesStore.addedSpecs(id, { directory: "/repo dir" }), [])
  assert.equal(integrations.state(id, "/repo dir").status, "loading")
  assert.deepEqual(integrationBindings.state(target(id)), { state: "unknown" })
  release(); unbind()
  finishes[5]!(); finishes[6]!(); await Promise.all([secondHost, secondDetach])
  assert.equal(host.pending(), false); assert.equal(integrationBindings.busy(target(id)), false)
  assert.equal(host.messages.length, 1)
  // A transport can deliver headers before revocation but finish JSON afterwards.
  let finishJson!: (value: unknown) => void
  owner.transport.answer = async () => ({ ok: true, json: () => new Promise(done => { finishJson = done }) }) as Response
  const late = installIntegration(id, "/repo", "fixture", "global"), rejected = assert.rejects(late, { name: "AbortError" })
  await flush(); owner.detach(); finishJson({ scope: "global", spec: "late", reloadPending: true }); await rejected
})

test("binding mutation admission stays exclusive across generations until settlement even without a demanded read", async () => {
  let authority = new AbortController(), reads = 0, mutations = 0
  const store = createIntegrationBindingsStore(async () => { reads++; return { state: "none" } }, { signal: () => authority.signal })
  let finishOld!: () => void, finishNew!: () => void
  const value = target("generation~w")
  const old = store.run(value, () => { mutations++; return new Promise(done => { finishOld = done }) })
  await store.run(value, async () => { mutations++ }); assert.equal(mutations, 1)
  authority.abort(); assert.equal(store.busy(value), true)
  authority = new AbortController()
  await store.run(value, async () => { mutations++ }); assert.equal(mutations, 1)
  finishOld(); await old; assert.equal(store.busy(value), false)
  const next = store.run(value, () => { mutations++; return new Promise(done => { finishNew = done }) })
  assert.equal(store.busy(value), true)
  finishNew(); await next; assert.equal(store.busy(value), false); assert.equal(reads, 0)
})

test("production connection events suspend and reopen only their backend's demanded reads", async t => {
  const a = fixture(t, "integrationsConnectionA"), b = fixture(t, "integrationsConnectionB")
  const aId = `${a.backend.id}~w/1`, bId = `${b.backend.id}~w/1`
  const releases = [integrations.demand(aId, "/repo dir"), integrations.demand(bId, "/repo dir"),
    integrationBindings.demand(target(aId)), integrationBindings.demand(target(bId))]
  await flush(); assert.equal(a.calls.length, 2); assert.equal(b.calls.length, 2)
  const events = a.backend.events as any
  events.emitTransportStatus("disconnected")
  assert.deepEqual(integrationBindings.state(target(aId)), { state: "unknown" })
  assert.equal(integrationBindings.state(target(bId)).state, "attached")
  await integrations.refreshDemanded(); await integrationBindings.refresh(target(aId)); await integrationBindings.refresh(target(bId))
  assert.equal(a.calls.length, 2); assert.equal(b.calls.length, 4)
  events.notify(events.openHandlers, undefined, "open")
  await flush()
  assert.equal(a.calls.length, 4); assert.equal(b.calls.length, 4)
  assert.equal(integrationBindings.state(target(aId)).state, "attached")
  events.dispatch({ type: "instance.eventStatus", instanceId: "w/1", status: "disconnected" })
  await integrations.refreshDemanded(); await integrationBindings.refresh(target(aId))
  assert.equal(a.calls.length, 4); assert.equal(b.calls.length, 5)
  releases.forEach(release => release())
})

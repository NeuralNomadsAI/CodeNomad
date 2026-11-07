import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { after, test, type TestContext } from "node:test"
import ts from "typescript"
import { backendOf, backends, createBackendClient, localBackend, type BackendClient } from "./backend-client"
import { backendEvents } from "./backend-events"
import { captureBackendOperation } from "./backend-operation"
import { SDKManager } from "./sdk-manager"
import { pluginControlsCache } from "../stores/plugin-controls"
import { clearInstanceMetadata } from "../stores/instance-metadata"

// Keep the real plugin consumers and transports; unrelated integration UI is outside this slice.
const hooks = registerHooks({ resolve(specifier, context, next) {
  // Foreground scheduling is the sole session-UI dependency of the root client.
  if (context.parentURL?.endsWith("/stores/opencode-client.ts") && specifier === "./instances") {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent("export const activeInstanceId = () => undefined")}` }
  }
  if (context.parentURL?.endsWith("/stores/plugin-sources.ts")) {
    const source = specifier === "./integrations" ? "export const integrations = { refreshDemanded: async () => {} }"
      : specifier === "../lib/integrations-api" ? "export const installIntegration = () => { throw new Error('outside this slice') }" : undefined
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` }
  }
  return next(specifier, context)
} })
const { pluginSourcesStore } = await import("../stores/plugin-sources")
const { getRootClient } = await import("../stores/opencode-client")
const { runPluginPackageAction, isPluginPackagePending } = await import("../stores/plugin-package-actions")
const { loadInstanceMetadata } = await import("./hooks/use-instance-metadata")
after(() => hooks.deregister())

const location = { directory: "/repo" }
const source = { scope: "global" as const, target: "example-plugin", entryIndex: 0, expectedRevision: "confirmed" }
const snapshot = { location, runtime: [], configured: { rules: [], sources: [] }, targets: [], controls: [] }
type Wire = { url: string; method: string; body: unknown; headers: [string, string][]; credentials?: RequestCredentials }
const registry = backends as Map<string, BackendClient>
function wire(input: RequestInfo | URL, init?: RequestInit): Wire {
  return { url: String(input), method: init?.method ?? "GET", body: init?.body,
    headers: [...new Headers(init?.headers)], credentials: init?.credentials }
}
function reply(request: Wire) {
  if (request.url.includes("/instance/")) return Response.json({ _tag: "InvalidRequestError", message: "native refusal", kind: "fixture" }, { status: 400 })
  if (request.method === "GET") return Response.json(snapshot)
  if (request.url.endsWith("/plugin-controls")) return Response.json({ snapshot, changed: true, reloadPending: true })
  return Response.json({ scope: "global", spec: "example-plugin", reloadPending: true })
}
function fixture(t: TestContext, id: string) {
  const calls: Wire[] = []
  const backend = createBackendClient({ id, baseUrl: `https://${id}.invalid`, fetcher: async (input, init) => {
    const request = wire(input, init); calls.push(request); return reply(request)
  } })
  registry.set(id, backend)
  const detach = backendEvents.attach(id, backend.events)
  t.after(() => { detach(); backend.events.dispose(); registry.delete(id); pluginControlsCache.clearInstance(`${id}~w/1`); pluginSourcesStore.clearInstance(`${id}~w/1`) })
  return { backend, calls, detach }
}

function releaseHintTimers(t: TestContext) {
  const schedule = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const timer = schedule(callback, delay, ...args)
    if (delay === 120_001) timer.unref()
    return timer
  }) as typeof setTimeout)
}

// Compile the actual callback bodies so request routing, catch and post-await guards
// are exercised without substituting implementations or mounting unrelated JSX.
function consumer(path: string, name: string, scope: Record<string, unknown>) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8")
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: ts.ArrowFunction | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer && ts.isArrowFunction(node.initializer)) found = node.initializer
    if (name === "skills" && ts.isCallExpression(node) && node.expression.getText(file) === "createEffect"
      && ts.isArrowFunction(node.arguments[0]) && node.arguments[0].getText(file).includes("skill.list")) found = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(file); assert.ok(found, name)
  const code = ts.transpileModule(`(${found.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function("scope", `with (scope) { return ${code} }`)(scope)
}
const flush = async () => { for (let i = 0; i < 100; i++) await new Promise<void>(done => setImmediate(done)) }
function nativeConsumers(id: string) {
  let refreshes = 0, loading = false, failed = false, pending: unknown, shown: unknown
  const cleanups: (() => void)[] = []
  const scope = { captureBackendOperation, getRootClient, instance: () => ({ id, folder: "/repo", client: {} }), metadata: () => ({}),
    pendingMcpOwners: new Map(),
    refreshMetadata: async () => { refreshes++ }, setPendingMcpAction: (_name: string, action?: unknown) => { pending = action },
    props: { open: true, workspaceId: id, directory: "/repo" }, mode: () => "mention",
    setSkills: (value: unknown) => { shown = value }, setSkillsError: (value: boolean) => { failed = value },
    setSkillsLoading: (value: boolean) => { loading = value }, log: { error() {} },
    onCleanup: (fn: () => void) => cleanups.push(fn),
    serverEvents: { on: () => () => {}, forInstance: () => ({ onOpen: () => () => {} }) } }
  return { toggle: consumer("../components/instance-service-status.tsx", "toggleMcpServer", scope),
    skills: consumer("../components/unified-picker.tsx", "skills", scope),
    state: () => ({ refreshes, loading, failed, pending, shown }), cleanup: () => cleanups.forEach(fn => fn()) }
}
async function exercise(id: string) {
  await pluginControlsCache.load(id, location, { force: true })
  assert.equal(pluginControlsCache.state(id, location).error, undefined)
  await pluginControlsCache.mutate(id, location, "example.id", "global", false)
  await pluginSourcesStore.add(id, location, "global", "example-plugin")
  await pluginSourcesStore.remove(id, location, source as any)
  await loadInstanceMetadata({ id, folder: "/repo", client: {
    location: { get: async () => ({ directory: "/repo", project: { id: "project" } }) }, project: { list: async () => [] },
  } } as any, { force: true })
  clearInstanceMetadata(id)
  for (const action of ["check", "update"] as const) await assert.rejects(runPluginPackageAction(id, location, "example-plugin", action), /native refusal/)
  assert.equal(isPluginPackagePending(id, "example-plugin"), false)
  const native = nativeConsumers(id)
  await native.toggle("example", true); await native.toggle("example", false)
  native.skills(); await flush()
  assert.equal(native.state().failed, true)
  assert.equal(native.state().loading, false)
  assert.equal(native.state().pending, undefined)
  assert.equal(native.state().refreshes, 0)
  native.cleanup()
}

test("real plugin, MCP and skill consumers isolate two backends with raw workspace paths", async t => {
  releaseHintTimers(t)
  const a = fixture(t, "pluginsA"), b = fixture(t, "pluginsB")
  for (const owner of [a, b]) {
    await exercise(`${owner.backend.id}~w/1`)
    assert.equal(owner.calls.length, 10)
    for (const call of owner.calls) {
      assert.equal(new URL(call.url).origin, new URL(owner.backend.baseUrl!).origin)
      assert.ok(call.url.includes("/w%2F1/"))
      assert.equal(JSON.stringify(call).includes(`${owner.backend.id}~`), false)
    }
    assert.ok(owner.calls.some(call => call.url.includes("/mcp/")))
    assert.ok(owner.calls.some(call => call.url.includes("/skill")))
  }
  assert.equal(a.calls.length, 10, "B never reaches A")
})

test("missing backend settles consumers as errors without local dispatch", async t => {
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}) })
  const id = "absentPlugins~w/1"
  // An admitted attachment whose registry entry disappeared must still fail at backendOf.
  const absent = createBackendClient({ id: "absentPlugins", baseUrl: "https://absent.invalid" })
  const detach = backendEvents.attach(absent.id, absent.events)
  t.after(() => { detach(); absent.events.dispose() })
  await pluginControlsCache.load(id, location)
  assert.match(String(pluginControlsCache.state(id, location).error), /Backend unavailable/)
  await assert.rejects(pluginControlsCache.mutate(id, location, "id", "global", false), /Backend unavailable/)
  await assert.rejects(pluginSourcesStore.add(id, location, "global", "example-plugin"), /Backend unavailable/)
  await assert.rejects(pluginSourcesStore.remove(id, location, source as any), /Backend unavailable/)
  await assert.rejects(runPluginPackageAction(id, location, "example-plugin", "check"), /Backend unavailable/)
  const native = nativeConsumers(id)
  await native.toggle("example", true); native.skills(); await flush()
  assert.equal(native.state().failed, true); assert.equal(native.state().loading, false)
  assert.equal(native.state().pending, undefined); assert.equal(calls, 0)
  native.cleanup(); pluginControlsCache.clearInstance(id)
})

test("plugin HTTP failures retain their owner and do not publish success", async t => {
  const owner = fixture(t, "pluginsError"), id = "pluginsError~w/1"
  for (const method of ["getPluginControls", "setPluginActivation", "addPluginSource", "removePluginSource"] as const) {
    t.mock.method(owner.backend.api, method, async () => { throw Object.assign(new Error("owner refused"), { status: 403 }) })
  }
  await pluginControlsCache.load(id, location)
  assert.equal((pluginControlsCache.state(id, location).error as any).status, 403)
  await assert.rejects(pluginControlsCache.mutate(id, location, "id", "global", false), { status: 403 })
  await assert.rejects(pluginSourcesStore.add(id, location, "global", "example-plugin"), { status: 403 })
  await assert.rejects(pluginSourcesStore.remove(id, location, source as any), { status: 403 })
  assert.deepEqual(pluginSourcesStore.addedSpecs(id, location), [])
  assert.equal(pluginSourcesStore.isRemoving(id, location, source as any), false)
})

test("local consumers preserve the baseline request bytes", async t => {
  releaseHintTimers(t)
  const calls: Wire[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => { const request = wire(input, init); calls.push(request); return reply(request) })
  const manager = new SDKManager({ url: path => `https://local.invalid${path}`, fetch: localBackend.fetch })
  t.mock.method(localBackend.sdk, "createClient", manager.createClient.bind(manager))
  await exercise("w/1")
  const routed = calls.splice(0)
  await localBackend.api.getPluginControls("w/1", location)
  await localBackend.api.setPluginActivation("w/1", { location, pluginId: "example.id", scope: "global", enabled: false })
  await localBackend.api.addPluginSource("w/1", { location, scope: "global", spec: "example-plugin" })
  await localBackend.api.removePluginSource("w/1", { location, ...source })
  const baseline = new SDKManager({ url: path => `https://local.invalid${path}`, fetch: localBackend.fetch }).createClient("baseline", "/workspaces/w%2F1/instance")
  for (const call of [() => baseline.mcp.list({ location }), () => baseline.plugin.check({ location, target: "example-plugin" }),
    () => baseline.plugin.update({ location, targets: ["example-plugin"] }),
    () => baseline.mcp.connect({ server: "example", location }), () => baseline.mcp.disconnect({ server: "example", location }),
    () => baseline.skill.list({ location })]) await assert.rejects(call())
  assert.deepEqual(routed, calls)
  assert.equal(backendOf("w/1"), localBackend)
  pluginControlsCache.clearInstance("w/1"); pluginSourcesStore.clearInstance("w/1")
})

test("revocation after awaits fences plugin publications, MCP refresh and skill results", async t => {
  const owner = fixture(t, "pluginsRevoked"), id = "pluginsRevoked~w/1"
  const resolve: ((value: any) => void)[] = []
  const wait = () => new Promise<any>(done => resolve.push(done))
  t.mock.method(owner.backend.api, "getPluginControls", wait)
  t.mock.method(owner.backend.api, "setPluginActivation", wait)
  t.mock.method(owner.backend.api, "addPluginSource", wait)
  t.mock.method(owner.backend.api, "removePluginSource", wait)
  t.mock.method(owner.backend.sdk, "createClient", () => ({ mcp: { connect: wait }, skill: { list: wait }, plugin: { update: wait } }) as any)
  const read = pluginControlsCache.load(id, location)
  const mutate = pluginControlsCache.mutate(id, location, "id", "global", false)
  const add = pluginSourcesStore.add(id, location, "global", "example-plugin")
  const remove = pluginSourcesStore.remove(id, location, source as any)
  const update = runPluginPackageAction(id, location, "example-plugin", "update")
  const native = nativeConsumers(id), toggle = native.toggle("example", true)
  native.skills()
  await flush()
  assert.equal(resolve.length, 7)
  owner.detach()
  assert.equal(native.state().loading, false, "detachment releases the skill indicator before transport settlement")
  for (const finish of resolve) finish({ snapshot, ...snapshot, scope: "global", spec: "example-plugin", reloadPending: true, data: [{ id: "late", name: "Late" }] })
  await Promise.all([read, mutate, add, remove, update, toggle]); await flush()
  assert.equal(pluginControlsCache.state(id, location).snapshot, undefined)
  assert.equal(pluginControlsCache.state(id, location).loading, false)
  assert.deepEqual(pluginSourcesStore.addedSpecs(id, location), [])
  assert.equal(pluginSourcesStore.isRemoving(id, location, source as any), false)
  assert.equal(isPluginPackagePending(id, "example-plugin"), false)
  assert.equal(native.state().refreshes, 0)
  assert.deepEqual(native.state().shown, [])
  assert.equal(native.state().failed, false)
  assert.equal(native.state().pending, undefined)
  assert.equal(owner.calls.length, 0, "revoked completion admits no reconciliation reads")
  native.cleanup()
})

for (const oldFirst of [true, false]) test(`source removal owns its attachment and pending cleanup, old settles first=${oldFirst}`, async t => {
  const owner = fixture(t, oldFirst ? "pluginsRemovalOldFirst" : "pluginsRemovalNewFirst")
  const id = `${owner.backend.id}~w/1`, completions: (() => void)[] = [], invalidations: string[] = []
  t.mock.method(owner.backend.api, "removePluginSource", (workspaceId: string) => {
    assert.equal(workspaceId, "w/1")
    return new Promise(done => completions.push(() => done({ scope: "global", spec: source.target, reloadPending: true })))
  })
  t.mock.method(pluginControlsCache, "invalidateInstance", (instanceId: string) => { invalidations.push(instanceId) })
  const old = pluginSourcesStore.remove(id, location, source as any)
  await pluginSourcesStore.remove(id, location, source as any)
  assert.equal(completions.length, 1, "same-attachment requests deduplicate")
  owner.detach()
  assert.equal(pluginSourcesStore.isRemoving(id, location, source as any), false)
  const detachReplacement = backendEvents.attach(owner.backend.id, owner.backend.events)
  t.after(detachReplacement)
  const replacement = pluginSourcesStore.remove(id, location, source as any)
  await pluginSourcesStore.remove(id, location, source as any)
  assert.equal(completions.length, 2, "a replacement attachment admits exactly one fresh removal")
  assert.equal(pluginSourcesStore.isRemoving(id, location, source as any), true)
  if (oldFirst) {
    completions[0](); await old
    assert.equal(pluginSourcesStore.isRemoving(id, location, source as any), true, "old cleanup cannot release the replacement")
    await pluginSourcesStore.remove(id, location, source as any)
    assert.equal(completions.length, 2, "old cleanup cannot remove replacement deduplication")
    assert.deepEqual(invalidations, [], "revoked completion cannot reconcile the replacement")
    completions[1](); await replacement
  } else {
    completions[1](); await replacement
    assert.equal(pluginSourcesStore.isRemoving(id, location, source as any), false)
    const latest = pluginSourcesStore.remove(id, location, source as any)
    assert.equal(completions.length, 3)
    completions[0](); await old
    assert.equal(pluginSourcesStore.isRemoving(id, location, source as any), true, "old cleanup cannot release a later same-attachment owner")
    await pluginSourcesStore.remove(id, location, source as any)
    assert.equal(completions.length, 3)
    completions[2](); await latest
  }
  assert.equal(pluginSourcesStore.isRemoving(id, location, source as any), false)
  assert.deepEqual(invalidations, Array(oldFirst ? 1 : 2).fill(id))
})

test("queued plugin activation retains its original attachment across reattachment", async t => {
  const owner = fixture(t, "pluginsActivationQueue"), id = "pluginsActivationQueue~w/1"
  const completions: ((value: any) => void)[] = []
  t.mock.method(owner.backend.api, "setPluginActivation", (workspaceId: string) => {
    assert.equal(workspaceId, "w/1")
    return new Promise(done => completions.push(done))
  })
  const old = pluginControlsCache.mutate(id, location, "old", "global", false)
  const queued = assert.rejects(pluginControlsCache.mutate(id, location, "queued", "global", false), { name: "AbortError" })
  await flush()
  assert.equal(completions.length, 1)
  owner.detach()
  const detachReplacement = backendEvents.attach(owner.backend.id, owner.backend.events)
  t.after(detachReplacement)
  const replacement = pluginControlsCache.mutate(id, location, "replacement", "global", true)
  await flush()
  assert.equal(completions.length, 2, "replacement does not wait for the revoked queue")
  const currentSnapshot = { ...snapshot, marker: "replacement" }
  completions[1]({ snapshot: currentSnapshot, changed: true, reloadPending: true })
  await replacement
  completions[0]({ snapshot, changed: true, reloadPending: true })
  await Promise.all([old, queued])
  assert.equal(completions.length, 2, "queued revoked activation never dispatches")
  assert.equal(pluginControlsCache.state(id, location).snapshot, currentSnapshot, "revoked completion cannot replace current state")
})

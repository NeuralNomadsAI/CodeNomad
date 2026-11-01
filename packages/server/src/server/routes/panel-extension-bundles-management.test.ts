import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { BundlesTransport } from "../../panel-extensions/bundles-transport"
import { BundlesLifecycle } from "../../panel-extensions/bundles-lifecycle"
import { registerEventRoutes } from "./events"
import { registerPanelExtensionBundlesManagementRoutes } from "./panel-extension-bundles-management"
import { registerRequestLogging } from "../request-logging"
import { BundlesActions, type BundlesAction } from "../../panel-extensions/bundles-actions"
import { catalogEntry, catalogOf } from "../../opencode/integrations/catalog-fixture"

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const digest = "a".repeat(64), extension = "test.bundles", base = `/api/panel-extensions/${extension}/bundles`
async function harness(options: { readOnly?: boolean; backpressure?: boolean; closeOnRegister?: "client" | "connection"; routeBudgetMs?: number } = {}) {
  const app = Fastify(), bus = new EventBus(), records: unknown[] = [], lanes: Array<{ close(): void; frames: string[] }> = []
  let prepared = 0, disposed = 0, leaseLive = true, nativeLive = true, owned = true, directory = "/private/project", at = 0
  let refusePrepare = false, staleTarget = false, refuseDispatch = false, replacement = false, unregistered = 0, unregisteredConnection = 0
  let stall: Promise<void> | undefined, dispatchWait: Promise<void> | undefined, prepareWait: Promise<void> | undefined
  const dispatched: BundlesAction[] = [], preparedActions: BundlesAction[] = [], leases: AbortController[] = []
  let nativeReads = 0
  const entry = catalogEntry("blender")
  const catalog = { snapshot: () => ({ state: "fresh" as const, catalog: catalogOf(entry) }) }
  let catalogState: "fresh" | "stale" | "unavailable" = "fresh", catalogWait: Promise<void> | undefined
  const admissions = new BundlesActions({ catalog } as never)
  const logger = { debug(record: unknown) { records.push(record) }, trace(record: unknown) { records.push(record) },
    isLevelEnabled() { return true } } as unknown as Logger
  const connection = { assertCurrent() { if (!nativeLive) throw new Error("secret-native-connection") }, client: { session: {
    async get() { nativeReads++; await stall; return { id: "ses_test", location: { directory } } },
  } } }
  const transport = new BundlesTransport({ eventBus: bus, catalog: { async read() { await catalogWait; return { ...catalog.snapshot(), state: catalogState } } }, lifecycle: new BundlesLifecycle({ now: () => at,
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout) }),
    auth: { getSessionFromRequest(req) { const sessionId = req.headers.cookie; return typeof sessionId === "string" ? { username: "human", sessionId } : null } },
    workspaceManager: { async getSharedServiceConnection() { return (replacement ? { ...connection } : connection) as never }, async ownsLocation() { return owned } },
    store: { async captureReadAuthority() {
      const controller = new AbortController(); leases.push(controller)
      return { canManage: !options.readOnly, signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); if (!leaseLive) throw new Error("secret-file-and-token") },
        async revalidate() { if (!leaseLive) throw new Error("secret-file-and-token") }, dispose() { disposed++; controller.abort() } }
    } },
    actions: { accepts: action => admissions.accepts(action), async prepare(context, action, signal) {
      prepared++
      preparedActions.push(action)
      await prepareWait; signal.throwIfAborted(); await context.authority.revalidate()
      if (refusePrepare) throw new Error("secret-file-and-token")
      const scope = "scope" in action ? action.scope : "global"
      const target = { instance: "instance", session: "ses_test", location: "/private/project", connection: "secret-native-connection",
        integration: action.integration, scope, range: entry.range, documentDigest: "private-document" }
      return { target,
        display: { action: action.action === "setActive" ? action.active ? "enable" : "disable" : action.action,
          integration: "Blender", scope, version: "1", conversation: "Private title" },
        async readTarget() { await context.authority.revalidate(); return { ...target, range: entry.range,
          documentDigest: staleTarget ? "changed" : target.documentDigest } },
        async dispatch(authority, submitted) {
          await dispatchWait; signal.throwIfAborted(); await authority.revalidate(); authority.assertCurrent()
          if (refuseDispatch) throw new Error("secret-file-and-token")
          dispatched.push(action); submitted()
        } }
    } },
  })
  registerRequestLogging(app, logger)
  app.addHook("onRequest", (request, reply, done) => {
    if (request.url.startsWith("/api/events")) {
      const lane = { close() {}, frames: [] as string[] }, original = reply.raw.write.bind(reply.raw)
      let first = true
      reply.raw.write = ((...args: Parameters<typeof reply.raw.write>) => {
        lane.frames.push(String(args[0])); const result = original(...args)
        if (first && options.backpressure) { first = false; return false }
        return result
      }) as typeof reply.raw.write
      lanes.push(lane)
    }
    done()
  })
  registerEventRoutes(app, { eventBus: bus, logger, bundlesTransport: transport,
    backpressureLimitBytes: 128, backpressureTimeoutMs: 80,
    registerClient(close) {
      lanes[lanes.length - 1].close = close
      if (options.closeOnRegister === "client") close()
      return () => { unregistered++ }
    },
    connectionManager: { register({ close }: { close(): void }) {
      if (options.closeOnRegister === "connection") close()
      return () => { unregisteredConnection++ }
    }, pong() { return false } } as never })
  registerPanelExtensionBundlesManagementRoutes(app, { transport, routeBudgetMs: options.routeBudgetMs ?? 500 })
  await app.ready()
  const open = async (cookie = "human", clientId = "same", connectionId = "same") => {
    const response = app.inject({ method: "GET", url: `/api/events?clientId=${clientId}&connectionId=${connectionId}`, headers: { cookie } })
    void response.catch(() => {})
    await turn()
    const lane = lanes[lanes.length - 1]
    const ownerFrame = lane.frames.find(frame => frame.startsWith("event: codenomad.bundles.owner"))
    const owner: string = ownerFrame ? JSON.parse(ownerFrame.split("data: ")[1]).owner : ""
    return { ...lane, owner, response }
  }
  const post = (method: string, payload: Record<string, unknown>, cookie = "human") => app.inject({ method: "POST", url: `${base}/${method}`, headers: { cookie }, payload })
  return { app, bus, transport, records, open, post, leases, dispatched, preparedActions, entry,
    setCatalog(state: typeof catalogState, wait?: Promise<void>) { catalogState = state; catalogWait = wait },
    state: () => ({ prepared, disposed, nativeReads, unregistered, unregisteredConnection }), advance(ms: number) { at += ms },
    setLive(value: boolean) { leaseLive = value }, setStall(value: Promise<void> | undefined) { stall = value },
    set(options: { nativeLive?: boolean; owned?: boolean; directory?: string; refusePrepare?: boolean; staleTarget?: boolean; refuseDispatch?: boolean; replacement?: boolean;
      prepareWait?: Promise<void>; dispatchWait?: Promise<void> }) {
      if (options.nativeLive !== undefined) nativeLive = options.nativeLive
      if (options.owned !== undefined) owned = options.owned
      if (options.directory !== undefined) directory = options.directory
      if (options.refusePrepare !== undefined) refusePrepare = options.refusePrepare
      if (options.staleTarget !== undefined) staleTarget = options.staleTarget
      if (options.refuseDispatch !== undefined) refuseDispatch = options.refuseDispatch
      if (options.replacement !== undefined) replacement = options.replacement
      if ("prepareWait" in options) prepareWait = options.prepareWait
      if ("dispatchWait" in options) dispatchWait = options.dispatchWait
    },
    async close() { for (const lane of lanes) lane.close(); transport.dispose(); await app.close() } }
}

test("read-only authenticated docs mounts resolve fresh/stale catalogue URLs, never management authority", async () => {
  const h = await harness({ readOnly: true })
  try {
    const a = await h.open(), b = await h.open()
    const { mountID } = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    const input = { owner: a.owner, mountID, integration: "blender" }
    for (const state of ["fresh", "stale"] as const) {
      h.setCatalog(state)
      const response = await h.post("openDocs", input)
      assert.equal(response.statusCode, 200)
      assert.equal(response.headers["cache-control"], "no-store")
      assert.deepEqual(response.json(), { outcome: "ready", url: h.entry.docs })
    }
    h.setCatalog("unavailable"); assert.deepEqual((await h.post("openDocs", input)).json(), { outcome: "unavailable" })
    h.setCatalog("fresh"); assert.deepEqual((await h.post("openDocs", { ...input, integration: "unknown" })).json(), { outcome: "invalid" })
    h.entry.docs += "?redirect=PRIVATE_DOCS_SENTINEL"
    assert.deepEqual((await h.post("openDocs", input)).json(), { outcome: "unavailable" })
    for (const field of ["url", "sessionID", "directory", "rpc", "digest", "input"]) {
      assert.equal((await h.post("openDocs", { ...input, [field]: "PRIVATE_DOCS_SENTINEL" })).statusCode, 400)
    }
    assert.equal((await h.post("openDocs", { ...input, owner: b.owner })).statusCode, 503)
    assert.equal((await h.post("openDocs", input, "another-human")).statusCode, 503)
    for (const method of ["request", "setActive", "installHost", "attach", "detach"]) {
      const nested = method === "request" ? { action: "remove", integration: "blender", scope: "global" }
        : method === "setActive" ? { integration: "blender", scope: "global", enabled: true }
          : method === "attach" ? { integration: "blender", offerID: "offer_fixture" } : { integration: "blender" }
      assert.equal((await h.post("manage", { owner: a.owner, mountID, method, input: nested })).statusCode, 503)
    }
    for (const command of ["start", "displayed", "confirm", "cancel", "userRemount"]) {
      const extra = command === "start" ? { requestID: "a".repeat(32) } : command === "userRemount" ? {} : { planID: "a".repeat(32) }
      assert.equal((await h.post("control", { owner: a.owner, mountID, command, ...extra })).statusCode, 503)
    }
    assert.equal(h.state().prepared, 0); assert.deepEqual(h.dispatched, [])
    assert(!JSON.stringify(h.records).includes("PRIVATE_DOCS_SENTINEL")); assert(!JSON.stringify(h.records).includes(a.owner))
    assert(h.records.some(record => JSON.stringify(record).includes(`${base.replace(extension, ":id")}/openDocs`)))
    assert.deepEqual((await h.post("control", { owner: a.owner, mountID, command: "dispose" })).json(), { ok: true })
  } finally { await h.close() }
})

test("documentation read quota survives remount and shares the lifecycle's read budget", async () => {
  const h = await harness({ readOnly: true })
  try {
    const a = await h.open()
    let mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    for (let i = 0; i < 59; i++) assert(h.transport.lifecycle.budget.take(extension, "read"))
    assert.equal((await h.post("openDocs", { owner: a.owner, ...mounted, integration: "blender" })).json().outcome, "ready")
    await h.post("control", { owner: a.owner, ...mounted, command: "dispose" })
    mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    assert.deepEqual((await h.post("openDocs", { owner: a.owner, ...mounted, integration: "blender" })).json(), { outcome: "busy" })
    h.advance(60_001)
    assert.equal((await h.post("openDocs", { owner: a.owner, ...mounted, integration: "blender" })).json().outcome, "ready")
  } finally { await h.close() }
})

test("documentation resolution fences revocation, owner/connection/session changes and deadlines across catalogue IO", async () => {
  for (const change of ["consent", "owner", "connection", "session", "ownership", "deadline", "disconnect"] as const) {
    const h = await harness({ readOnly: true, routeBudgetMs: 35 })
    let resume!: () => void
    try {
      const a = await h.open(), mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
      h.setCatalog("fresh", new Promise(resolve => { resume = resolve }))
      const pending = h.post("openDocs", { owner: a.owner, ...mounted, integration: "blender" })
      void pending.then(() => {}); await turn(); await turn()
      switch (change) {
        case "consent": h.leases[0].abort(); break
        case "owner": a.close(); break
        case "connection": h.set({ replacement: true }); break
        case "session": h.set({ directory: "/another-owned-location" }); break
        case "ownership": h.set({ owned: false }); break
        case "disconnect": h.bus.publish({ type: "instance.eventStatus", instanceId: "instance", status: "disconnected", generation: 1 }); break
        case "deadline": assert.equal((await pending).statusCode, 503); break
      }
      resume()
      assert.equal((await pending).statusCode, 503, change)
      assert(!JSON.stringify((await pending).json()).includes("https:")); assert.deepEqual(h.dispatched, [])
    } finally { resume?.(); await h.close() }
  }
})

test("actual SSE streams mint independent private owners despite equal client IDs; stream close revokes mounts", async () => {
  const h = await harness()
  try {
    const a = await h.open(), b = await h.open()
    assert.match(a.owner, /^[a-f0-9]{64}$/); assert.notEqual(a.owner, b.owner)
    const mount = await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })
    assert.equal(mount.statusCode, 200); assert.equal(mount.headers["cache-control"], "no-store")
    const { mountID } = mount.json()
    const command = { owner: a.owner, mountID, method: "request", input: { action: "install", integration: "blender", scope: "global" } }
    const ack = await h.post("manage", command)
    assert.deepEqual(Object.keys(ack.json()).sort(), ["outcome", "requestID"])
    assert.equal(ack.json().outcome, "confirming"); assert.equal(h.state().prepared, 0)
    assert.equal((await h.post("control", { owner: b.owner, mountID, command: "start", requestID: ack.json().requestID })).statusCode, 503)
    assert.deepEqual((await h.post("control", { owner: a.owner, mountID, command: "start", requestID: ack.json().requestID })).json(), { ok: true })
    await turn()
    assert.equal(h.state().prepared, 1)
    assert(a.frames.some(frame => frame.includes('"view":') && frame.includes("Private title")))
    assert(!b.frames.some(frame => frame.includes("Private title")))
    assert(!JSON.stringify(h.records).includes("Private title")); assert(!JSON.stringify(h.records).includes(a.owner))
    a.close(); await a.response
    assert.equal((await h.post("manage", command)).statusCode, 503)
    assert.equal(h.state().disposed, 1)
    b.close(); await b.response
  } finally { await h.close() }
})

test("strict bodies reject authority widening, inherited methods, private controls and anonymous ownership", async () => {
  const h = await harness()
  try {
    const anonymous = await h.open("auth-disabled"); assert.equal(anonymous.owner, "")
    anonymous.close(); await anonymous.response
    const a = await h.open(), mountBody = { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" }
    for (const payload of [{ ...mountBody, directory: "/other" }, { ...mountBody, sessionID: "foreign" }, { ...mountBody, clientId: "fake-owner" }]) {
      assert.equal((await h.post("mount", payload)).statusCode, 400)
    }
    const { mountID } = (await h.post("mount", mountBody)).json()
    for (const payload of [
      { owner: a.owner, mountID, method: "constructor", input: {} },
      { owner: a.owner, mountID, method: "confirm", input: {} },
      { owner: a.owner, mountID, method: "setActive", input: { integration: "blender", scope: "global", enabled: true, target: "arbitrary-package" } },
      { owner: a.owner, mountID, method: "detach", input: { integration: "blender", userActivation: true } },
    ]) assert.equal((await h.post("manage", payload)).statusCode, 400)
    assert.deepEqual((await h.post("manage", { owner: a.owner, mountID, method: "detach", input: { integration: "blender" } })).json(), { outcome: "invalid" })
    assert.deepEqual((await h.post("manage", { owner: a.owner, mountID, method: "request", input: { action: "remove", integration: "blender", scope: "project" } })).json(), { outcome: "invalid" })
    assert.equal((await h.post("control", { owner: a.owner, mountID, command: "userRemount", explicit: true })).statusCode, 400)
    assert.equal((await h.post("control", { owner: a.owner, mountID, command: "dispose" }, "another-session")).statusCode, 503)
    assert.equal(h.state().prepared, 0)
    a.close(); await a.response
  } finally { await h.close() }
})

test("management logs use fixed templates only and errors never serialize rejected data or backend secrets", async () => {
  const h = await harness()
  try {
    const a = await h.open(), { mountID } = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    h.setLive(false)
    const result = await h.post("manage", { owner: a.owner, mountID, method: "installHost", input: { integration: "blender" } })
    assert.equal(result.statusCode, 503); assert.deepEqual(result.json(), { error: "Panel extension request unavailable" })
    await h.app.inject({ method: "POST", url: "/api/panel-extensions/secret-addon/bundles/control?owner=secret-query", payload: { owner: "secret-body" } })
    const serialized = JSON.stringify(h.records.filter(record => (record as { method?: string }).method === "POST"))
    for (const secret of [a.owner, mountID, "secret-addon", "secret-query", "secret-body", "secret-file-and-token", "ses_test"]) assert(!serialized.includes(secret), secret)
    assert(serialized.includes("/api/panel-extensions/:id/bundles/mount"))
    assert(serialized.includes("/api/panel-extensions/:id/bundles/manage"))
    assert(serialized.includes("/api/panel-extensions/:id/bundles/control"))
    a.close(); await a.response
  } finally { await h.close() }
})

test("mount timeout disposes its lease and cannot create a late mount", async () => {
  const h = await harness({ routeBudgetMs: 40 })
  try {
    const a = await h.open()
    let release!: () => void
    h.setStall(new Promise<void>(resolve => { release = resolve }))
    const response = await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })
    assert.equal(response.statusCode, 503)
    release(); h.setStall(undefined); await turn()
    assert.equal(h.state().prepared, 0)
    assert.equal(h.state().disposed, 1)
    const mount = await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })
    const next = await h.post("manage", { owner: a.owner, mountID: mount.json().mountID, method: "installHost", input: { integration: "blender" } })
    assert.equal(next.json().outcome, "confirming")
    a.close(); await a.response
  } finally { await h.close() }
})

const safeMethods: Array<{ name: string; method: string; input: Record<string, unknown>; action: BundlesAction }> = [
  { name: "install", method: "request", input: { action: "install", integration: "blender", scope: "global" }, action: { action: "install", integration: "blender", scope: "global" } },
  { name: "update", method: "request", input: { action: "update", integration: "blender", scope: "global" }, action: { action: "update", integration: "blender", scope: "global" } },
  { name: "remove", method: "request", input: { action: "remove", integration: "blender", scope: "global" }, action: { action: "remove", integration: "blender", scope: "global" } },
  { name: "enable", method: "setActive", input: { integration: "blender", scope: "global", enabled: true }, action: { action: "setActive", integration: "blender", scope: "global", active: true } },
  { name: "disable", method: "setActive", input: { integration: "blender", scope: "global", enabled: false }, action: { action: "setActive", integration: "blender", scope: "global", active: false } },
  { name: "installHost", method: "installHost", input: { integration: "blender" }, action: { action: "installHost", integration: "blender" } },
  { name: "attach", method: "attach", input: { integration: "blender", offerID: "opaque_offer" }, action: { action: "attach", integration: "blender", offerID: "opaque_offer" } },
]
const privateEvents = (frames: string[]) => frames.filter(frame => frame.startsWith("event: codenomad.bundles.event"))
  .map(frame => JSON.parse(frame.split("data: ")[1]))

for (const operation of safeMethods) for (const outcome of ["success", "refused", "stale", "revoked", "concurrent", "cancelled", "dispatchFailure"] as const) {
  test(`Fastify ${operation.name}: ${outcome}, exact fixed builder input and one private terminal`, async () => {
    const h = await harness()
    try {
      const a = await h.open(), b = await h.open()
      const { mountID } = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
      const command = { owner: a.owner, mountID, method: operation.method, input: operation.input }
      if (outcome === "refused") h.set({ refusePrepare: true })
      const ack = (await h.post("manage", command)).json()
      assert.equal(ack.outcome, "confirming"); assert.equal(h.state().prepared, 0)
      assert.deepEqual((await h.post("control", { owner: a.owner, mountID, command: "start", requestID: ack.requestID })).json(), { ok: true })
      await turn()
      assert.equal(h.state().prepared, 1)
      assert.deepEqual(h.preparedActions, [operation.action])
      if (outcome !== "refused") {
        const view = privateEvents(a.frames).find(event => event.view)?.view
        assert(view); assert.equal(view.action, operation.name === "enable" || operation.name === "disable" ? operation.name : operation.action.action)
        if (outcome === "concurrent") {
          const other = (await h.post("mount", { owner: b.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
          assert.deepEqual((await h.post("manage", { ...command, owner: b.owner, mountID: other.mountID })).json(), { outcome: "busy" })
        }
        if (outcome === "revoked") {
          h.leases[0].abort()
          assert.equal((await h.post("control", { owner: a.owner, mountID, command: "confirm", planID: view.planID })).statusCode, 409)
        } else if (outcome === "cancelled") {
          await h.post("control", { owner: a.owner, mountID, command: "cancel", planID: view.planID })
        } else {
          if (outcome === "stale") h.set({ staleTarget: true })
          if (outcome === "dispatchFailure") h.set({ refuseDispatch: true })
          await h.post("control", { owner: a.owner, mountID, command: "displayed", planID: view.planID })
          h.advance(600)
          const responses = await Promise.all([1, 2].map(() => h.post("control", { owner: a.owner, mountID, command: "confirm", planID: view.planID })))
          assert.deepEqual(responses.map(response => response.statusCode), outcome === "stale" ? [409, 409] : [200, 409])
        }
        await turn()
      }
      const success = outcome === "success" || outcome === "concurrent"
      assert.deepEqual(h.dispatched, success ? [operation.action] : [])
      const terminal = privateEvents(a.frames).filter(event => event.change?.kind === "request")
      assert.deepEqual(terminal.map(event => event.change), [{ kind: "request", requestID: ack.requestID,
        outcome: success ? "confirmed" : outcome === "cancelled" ? "cancelled" : "failed" }])
      assert.equal(privateEvents(b.frames).length, 0)
      assert(!JSON.stringify(h.records).includes("Private title"))
      a.close(); b.close(); await Promise.all([a.response, b.response])
    } finally { await h.close() }
  })
}

test("dispose authenticates only the original exact owner/mount and releases a stale native or revoked lease immediately", async () => {
  for (const stale of ["native", "lease"] as const) {
    const h = await harness()
    try {
      const a = await h.open(), b = await h.open()
      const { mountID } = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
      const ack = (await h.post("manage", { owner: a.owner, mountID, method: "installHost", input: { integration: "blender" } })).json()
      if (stale === "native") h.set({ nativeLive: false }); else h.setLive(false)
      assert.equal((await h.post("control", { owner: b.owner, mountID, command: "dispose" })).statusCode, 503)
      assert.equal((await h.post("control", { owner: a.owner, mountID, command: "dispose" }, "other-auth-session")).statusCode, 503)
      assert.equal((await h.post("control", { owner: a.owner, mountID, command: "userRemount" })).statusCode, 503)
      assert.equal((await h.post("control", { owner: a.owner, mountID, command: "start", requestID: ack.requestID })).statusCode, 503)
      assert.deepEqual((await h.post("control", { owner: a.owner, mountID, command: "dispose" })).json(), { ok: true })
      assert.equal(h.state().disposed, 1); assert.equal(h.state().prepared, 0)
      assert.equal((await h.post("control", { owner: a.owner, mountID, command: "start", requestID: ack.requestID })).statusCode, 503)
      h.set({ nativeLive: true }); h.setLive(true)
      const next = (await h.post("mount", { owner: b.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
      assert.equal((await h.post("manage", { owner: b.owner, ...next, method: "installHost", input: { integration: "blender" } })).json().outcome, "confirming")
      a.close(); b.close(); await Promise.all([a.response, b.response])
    } finally { await h.close() }
  }
})

test("Project-native removal/detach refusals consume the same sliding budget; successful safe requests are debited exactly once", async () => {
  const h = await harness()
  try {
    const a = await h.open()
    let mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    for (let i = 0; i < 9; i++) {
      const denied = i % 2 ? { method: "detach", input: { integration: "blender" } }
        : { method: "request", input: { action: "remove", integration: "blender", scope: "project" } }
      assert.deepEqual((await h.post("manage", { owner: a.owner, ...mounted, ...denied })).json(), { outcome: "invalid" })
    }
    assert.equal((await h.post("manage", { owner: a.owner, ...mounted, method: "installHost", input: { integration: "blender" } })).json().outcome, "confirming")
    await h.post("control", { owner: a.owner, ...mounted, command: "userRemount" })
    mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    assert.deepEqual((await h.post("manage", { owner: a.owner, ...mounted, method: "detach", input: { integration: "blender" } })).json(), { outcome: "busy" })
    h.advance(60_001)
    for (let i = 0; i < 10; i++) {
      assert.equal((await h.post("manage", { owner: a.owner, ...mounted, method: "installHost", input: { integration: "blender" } })).json().outcome, "confirming")
      await h.post("control", { owner: a.owner, ...mounted, command: "dispose" })
      mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    }
    assert.deepEqual((await h.post("manage", { owner: a.owner, ...mounted, method: "installHost", input: { integration: "blender" } })).json(), { outcome: "busy" })
    assert.equal(h.state().prepared, 0); assert.deepEqual(h.dispatched, [])
    a.close(); await a.response
  } finally { await h.close() }
})

for (const closeOnRegister of ["client", "connection"] as const) test(`SSE ${closeOnRegister} synchronous registration closure releases owner and its cleanup handles`, async () => {
  const h = await harness({ closeOnRegister })
  try {
    const a = await h.open(); await a.response
    assert.match(a.owner, /^[a-f0-9]{64}$/)
    assert.equal((await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).statusCode, 503)
    assert.equal(h.state().unregistered, 1)
    assert.equal(h.state().unregisteredConnection, closeOnRegister === "connection" ? 1 : 0)
    assert.equal(h.state().disposed, 0)
  } finally { await h.close() }
})

for (const pressure of ["timeout", "overflow"] as const) test(`SSE ${pressure} closes its private owner and all mounts before a replacement stream can act`, async () => {
  const h = await harness({ backpressure: true })
  try {
    const a = await h.open()
    const mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    const ack = (await h.post("manage", { owner: a.owner, ...mounted, method: "installHost", input: { integration: "blender" } })).json()
    assert.equal(ack.outcome, "confirming")
    if (pressure === "overflow") for (let i = 0; i < 3; i++) h.bus.publish({ type: "workspace.filesChanged", workspaceId: "x".repeat(256), changes: [] })
    await a.response.catch(() => {})
    assert.equal(h.state().disposed, 1)
    assert.equal(h.state().unregistered, 1); assert.equal(h.state().unregisteredConnection, 1)
    assert.equal((await h.post("control", { owner: a.owner, ...mounted, command: "start", requestID: ack.requestID })).statusCode, 503)
    const b = await h.open(), next = (await h.post("mount", { owner: b.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    assert.notEqual(a.owner, b.owner)
    assert.equal((await h.post("manage", { owner: b.owner, ...next, method: "installHost", input: { integration: "blender" } })).json().outcome, "confirming")
    b.close(); await b.response
  } finally { await h.close() }
})

for (const replacement of ["server.connected", "generation", "native-object"] as const) test(`Fastify fences ${replacement} before a stale plan can submit`, async () => {
  const h = await harness()
  try {
    const a = await h.open(), mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    const ack = (await h.post("manage", { owner: a.owner, ...mounted, method: "attach", input: { integration: "blender", offerID: "opaque_offer" } })).json()
    await h.post("control", { owner: a.owner, ...mounted, command: "start", requestID: ack.requestID }); await turn()
    const view = privateEvents(a.frames).find(event => event.view).view
    await h.post("control", { owner: a.owner, ...mounted, command: "displayed", planID: view.planID }); h.advance(600)
    if (replacement === "native-object") h.set({ replacement: true })
    else if (replacement === "generation") h.bus.publish({ type: "instance.eventStatus", instanceId: "instance", status: "connected", generation: 2 })
    else h.bus.publish({ type: "instance.event", instanceId: "instance", event: { type: "server.connected", data: {} } } as never)
    const response = await h.post("control", { owner: a.owner, ...mounted, command: "confirm", planID: view.planID })
    assert.equal(response.statusCode, 409)
    await turn(); assert.deepEqual(h.dispatched, [])
    assert.equal(privateEvents(a.frames).filter(event => event.change?.outcome === "failed").length, 1)
    assert.equal(h.state().disposed, 1)
    a.close(); await a.response
  } finally { await h.close() }
})

test("native reconnect fences a mounting read that ignores abort, and revocation across dispatch awaits prevents submission", async () => {
  const h = await harness()
  let release!: () => void
  try {
    const a = await h.open()
    h.setStall(new Promise<void>(resolve => { release = resolve }))
    const mounting = h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" }).then(response => response)
    for (let i = 0; i < 100 && !h.state().nativeReads; i++) await turn()
    assert.equal(h.state().nativeReads, 1)
    h.bus.publish({ type: "instance.event", instanceId: "instance", event: { type: "server.connected", data: {} } } as never)
    assert.equal((await mounting).statusCode, 503)
    release(); h.setStall(undefined); await turn(); assert.equal(h.state().disposed, 1)
    const mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    const ack = (await h.post("manage", { owner: a.owner, ...mounted, method: "installHost", input: { integration: "blender" } })).json()
    await h.post("control", { owner: a.owner, ...mounted, command: "start", requestID: ack.requestID }); await turn()
    const view = privateEvents(a.frames).find(event => event.view).view
    await h.post("control", { owner: a.owner, ...mounted, command: "displayed", planID: view.planID }); h.advance(600)
    h.set({ dispatchWait: new Promise<void>(resolve => { release = resolve }) })
    await h.post("control", { owner: a.owner, ...mounted, command: "confirm", planID: view.planID }); await turn()
    h.leases[1].abort(); release(); await turn()
    assert.deepEqual(h.dispatched, [])
    assert.equal(privateEvents(a.frames).filter(event => event.change?.outcome === "failed").length, 1)
    a.close(); await a.response
  } finally { release?.(); await h.close() }
})

test("stale-authority management refusals debit the budget without authorizing effects or blocking disposal", async () => {
  const h = await harness()
  try {
    const a = await h.open(), mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    h.set({ nativeLive: false })
    for (let i = 0; i < 9; i++) assert.equal((await h.post("manage", { owner: a.owner, ...mounted,
      method: "installHost", input: { integration: "blender" } })).statusCode, 503)
    h.set({ nativeLive: true })
    assert.equal((await h.post("manage", { owner: a.owner, ...mounted, method: "installHost", input: { integration: "blender" } })).json().outcome, "confirming")
    h.set({ nativeLive: false })
    assert.deepEqual((await h.post("control", { owner: a.owner, ...mounted, command: "dispose" })).json(), { ok: true })
    h.set({ nativeLive: true })
    const next = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    assert.deepEqual((await h.post("manage", { owner: a.owner, ...next, method: "installHost", input: { integration: "blender" } })).json(), { outcome: "busy" })
    assert.equal(h.state().prepared, 0); assert.deepEqual(h.dispatched, [])
    a.close(); await a.response
  } finally { await h.close() }
})

test("native Project and unknown integrations answer invalid before ACK reservation, view or native IO and debit every attempt", async () => {
  const h = await harness()
  try {
    const a = await h.open(), mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    const reads = h.state().nativeReads
    const refused = [
      { method: "request", input: { action: "install", integration: "blender", scope: "project" } },
      { method: "request", input: { action: "update", integration: "blender", scope: "project" } },
      { method: "setActive", input: { integration: "blender", scope: "project", enabled: true } },
      { method: "setActive", input: { integration: "blender", scope: "project", enabled: false } },
      { method: "request", input: { action: "install", integration: "unknown", scope: "global" } },
      { method: "setActive", input: { integration: "unknown", scope: "global", enabled: true } },
      { method: "installHost", input: { integration: "unknown" } },
      { method: "attach", input: { integration: "unknown", offerID: "opaque_offer" } },
    ]
    for (const request of [...refused, ...refused.slice(0, 2)]) {
      assert.deepEqual((await h.post("manage", { owner: a.owner, ...mounted, ...request })).json(), { outcome: "invalid" })
    }
    assert.deepEqual((await h.post("manage", { owner: a.owner, ...mounted, method: "installHost", input: { integration: "blender" } })).json(), { outcome: "busy" })
    assert.equal(h.state().nativeReads, reads); assert.equal(h.state().prepared, 0)
    assert.deepEqual(privateEvents(a.frames), []); assert.deepEqual(h.dispatched, [])
    a.close(); await a.response
  } finally { await h.close() }
})

for (const stale of ["document", "catalogue", "consent", "connection"] as const) test(`control confirm returns HTTP409 for stale ${stale}, one terminal and zero transmissions`, async () => {
  const h = await harness()
  try {
    const a = await h.open(), mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    const ack = (await h.post("manage", { owner: a.owner, ...mounted, method: "installHost", input: { integration: "blender" } })).json()
    await h.post("control", { owner: a.owner, ...mounted, command: "start", requestID: ack.requestID }); await turn()
    const view = privateEvents(a.frames).find(event => event.view).view
    await h.post("control", { owner: a.owner, ...mounted, command: "displayed", planID: view.planID }); h.advance(600)
    if (stale === "document") h.set({ staleTarget: true })
    else if (stale === "catalogue") h.entry.range = "^0.2"
    else if (stale === "consent") h.setLive(false)
    else h.set({ nativeLive: false })
    const response = await h.post("control", { owner: a.owner, ...mounted, command: "confirm", planID: view.planID })
    assert.equal(response.statusCode, 409); assert.deepEqual(response.json(), { error: "Panel extension request unavailable" })
    await turn()
    assert.deepEqual(h.dispatched, [])
    assert.deepEqual(privateEvents(a.frames).filter(event => event.change).map(event => event.change), [
      { kind: "request", requestID: ack.requestID, outcome: "failed" },
    ])
    assert.equal((await h.post("control", { owner: a.owner, ...mounted, command: "confirm", planID: view.planID })).statusCode, 409)
    assert.equal(privateEvents(a.frames).filter(event => event.change).length, 1)
    a.close(); await a.response
  } finally { await h.close() }
})

test("checked HTTP confirmation acknowledges fresh admission without waiting native prerequisites; late staleness stays a private result", async () => {
  const h = await harness()
  let release!: () => void
  try {
    const a = await h.open(), mounted = (await h.post("mount", { owner: a.owner, digest, instanceId: "instance", sessionID: "ses_test" })).json()
    const ack = (await h.post("manage", { owner: a.owner, ...mounted, method: "installHost", input: { integration: "blender" } })).json()
    await h.post("control", { owner: a.owner, ...mounted, command: "start", requestID: ack.requestID }); await turn()
    const view = privateEvents(a.frames).find(event => event.view).view
    await h.post("control", { owner: a.owner, ...mounted, command: "displayed", planID: view.planID }); h.advance(600)
    h.set({ dispatchWait: new Promise<void>(resolve => { release = resolve }) })
    const response = await h.post("control", { owner: a.owner, ...mounted, command: "confirm", planID: view.planID })
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { ok: true })
    assert.deepEqual(h.dispatched, []); assert.equal(privateEvents(a.frames).filter(event => event.change).length, 0)
    h.set({ staleTarget: true }); release(); await turn()
    assert.deepEqual(h.dispatched, [])
    assert.deepEqual(privateEvents(a.frames).filter(event => event.change).map(event => event.change), [
      { kind: "request", requestID: ack.requestID, outcome: "failed" },
    ])
    a.close(); await a.response
  } finally { release?.(); await h.close() }
})

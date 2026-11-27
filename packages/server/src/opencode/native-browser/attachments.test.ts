import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import { EventBus } from "../../events/bus"
import { modernContractFixture } from "../compatibility/contract-fixture"
import { rememberRuntime } from "../compatibility/runtime"
import { BROWSER_CONTROL_EVENT, NativeBrowserAttachments } from "./attachments"
import { RECOMMENDED, BELOW_MINIMUM } from "../runtime-version-fixture"

const until = async (condition: () => boolean, label: string, timeout = 5_000) => {
  for (const end = Date.now() + timeout; !condition();) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** The live daemon identity the attachment reads before `attach`. */
const info = (version: string) => ({ version, pid: 1234, urls: [], paths: { tmp: "/tmp" } })

test("NativeBrowserAttachments attaches through an owner, runs each command once, and rechecks ownership per command", async t => {
  const rpcCalls: Array<{ method: string; input: Record<string, unknown> }> = []
  const nativeCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  let releaseAttach: (outcome: string) => void = () => {}
  let attached!: (connectionID: string) => void
  const attachedReady = new Promise<string>(resolve => { attached = resolve })
  const app = Fastify({ logger: false })
  app.get("/openapi.json", async () => modernContractFixture)
  app.get("/api/info", async () => info(RECOMMENDED))
  app.get("/api/session/:id", async request => ({
    data: { id: (request.params as { id: string }).id, location: { directory: "/repo" } },
  }))
  app.post("/api/rpc/:rpcID/:method", async request => {
    const { method } = request.params as { rpcID: string; method: string }
    const input = (request.body as { input: Record<string, unknown> }).input
    rpcCalls.push({ method, input })
    if (method === "attach") {
      attached(String(input.connectionID))
      return { output: await new Promise<string>(done => { releaseAttach = done }) }
    }
    if (method === "command") return { output: { action: input.requestID === "req-2" ? { type: "tabs.open", url: "https://example.com/" } : { type: "tabs.list" } } }
    return { output: { ok: true } }
  })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(async () => {
    releaseAttach("replaced")
    await app.close()
  })
  const endpoint = { url: address, auth: undefined }
  rememberRuntime(endpoint, { version: RECOMMENDED, pid: 1234, discovery: "status" })
  const client = OpenCode.make({ baseUrl: address, fetch: globalThis.fetch })
  const connection = { endpoint, client, fetch: globalThis.fetch, assertCurrent: () => {}, invalidate: () => {}, profile: async () => "modern" as const }
  const eventBus = new EventBus()
  const owners = new Set<string>()
  const attachments = new NativeBrowserAttachments({
    workspaceManager: {
      getSharedServiceConnection: async () => connection,
      ownsLocation: async (workspaceID: string) => owners.has(workspaceID),
    } as never,
    eventBus,
    nativeParent: {
      available: true,
      browserAutomationUnavailable: false,
      request: async (method: string, params: Record<string, unknown>) => {
        nativeCalls.push({ method, params })
        return method === "browser.probe" ? { available: false } : { url: "https://example.com/" }
      },
    } as never,
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {}, trace: () => {}, isLevelEnabled: () => false } as never,
  })
  t.after(() => attachments.close())
  const publish = (instanceId: string, data: Record<string, unknown>) =>
    eventBus.publish({ type: "instance.event", instanceId, event: { type: BROWSER_CONTROL_EVENT, data } } as any)

  // A holder that does not own the session never attaches it; a later owner's hold does.
  attachments.hold("hold-unowned", "ws-1", "ses-1")
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(rpcCalls.length, 0)
  owners.add("ws-2")
  attachments.hold("hold-owner", "ws-2", "ses-1")
  const connectionID = await attachedReady
  assert.equal(rpcCalls.filter(c => c.method === "attach").length, 1)

  // State is published on `attached` and before every result.
  publish("ws-2", { type: "attached", connectionID })
  publish("ws-2", { type: "command", connectionID, requestID: "req-1" })
  await until(() => rpcCalls.some(c => c.method === "result"), "first result")
  const methods = rpcCalls.map(c => c.method)
  assert.ok(methods.lastIndexOf("state") < methods.lastIndexOf("result"), "state is published before every result")
  assert.deepEqual((rpcCalls.find(c => c.method === "result")?.input.outcome as any)?.result?.value, { tabs: [], focusedTabID: null })

  // The relay delivers a control event once per owning workspace: the command runs once.
  publish("ws-1", { type: "command", connectionID, requestID: "req-1" })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(rpcCalls.filter(c => c.method === "command").length, 1)

  // The project stops owning the session: the next command fails before any native request.
  owners.delete("ws-2")
  nativeCalls.length = 0
  publish("ws-2", { type: "command", connectionID, requestID: "req-2" })
  await until(() => rpcCalls.filter(c => c.method === "result").length === 2, "second result")
  const refused = rpcCalls.filter(c => c.method === "result")[1].input.outcome as any
  assert.equal(refused.type, "failure")
  assert.match(refused.message, /owns this conversation/)
  assert.equal(nativeCalls.some(call => call.method === "browser.execute"), false)
})

test("a reconnect to OpenCode ends the attachment made on the replaced connection, and it attaches again", async t => {
  const attaches: Array<{ connectionID: string; release: (outcome: string) => void }> = []
  const app = Fastify({ logger: false })
  app.get("/openapi.json", async () => modernContractFixture)
  app.get("/api/info", async () => info(RECOMMENDED))
  app.get("/api/session/:id", async request => ({ data: { id: (request.params as { id: string }).id, location: { directory: "/repo" } } }))
  app.post("/api/rpc/:rpcID/:method", async (request, reply) => {
    const { method } = request.params as { rpcID: string; method: string }
    const input = (request.body as { input: Record<string, unknown> }).input
    if (method !== "attach") return { output: { ok: true } }
    const outcome = await new Promise<string>(release => {
      attaches.push({ connectionID: String(input.connectionID), release })
      request.raw.once("close", () => release("closed"))
    })
    return reply.send({ output: outcome })
  })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(async () => { for (const attach of attaches) attach.release("replaced"); await app.close() })
  const endpoint = { url: address, auth: undefined }
  rememberRuntime(endpoint, { version: RECOMMENDED, pid: 1234, discovery: "status" })
  const connect = () => {
    const connection = { endpoint, client: OpenCode.make({ baseUrl: address, fetch: globalThis.fetch }), fetch: globalThis.fetch, stale: false,
      assertCurrent: () => { if (connection.stale) throw new Error("OpenCode connection changed; refresh before retrying") },
      invalidate: () => {}, profile: async () => "modern" as const }
    return connection
  }
  let connection = connect()
  const attachments = new NativeBrowserAttachments({
    workspaceManager: { getSharedServiceConnection: async () => connection, ownsLocation: async () => true } as never,
    eventBus: new EventBus(),
    nativeParent: { available: true, browserAutomationUnavailable: false, request: async () => ({ available: false }) } as never,
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {}, trace: () => {}, isLevelEnabled: () => false } as never,
  })
  t.after(() => attachments.close())
  attachments.hold("hold", "ws", "ses-1")
  await until(() => attaches.length === 1, "first attach")
  // The service reconnects: the old connection is invalidated and a new one replaces it.
  connection.stale = true
  connection = connect()
  attachments.hold("hold", "ws", "ses-1")
  await until(() => attaches.length === 2, "attach on the new connection")
  assert.notEqual(attaches[1].connectionID, attaches[0].connectionID)
})
test("ownership is checked when a queued command's turn comes, and a failed inventory still settles the result", async t => {
  const rpcCalls: Array<{ method: string; input: Record<string, unknown> }> = []
  const dispatched: boolean[] = []
  let failState = false
  let releaseAttach: (outcome: string) => void = () => {}
  let attached!: (connectionID: string) => void
  const attachedReady = new Promise<string>(resolve => { attached = resolve })
  const app = Fastify({ logger: false })
  app.get("/openapi.json", async () => modernContractFixture)
  app.get("/api/info", async () => info(RECOMMENDED))
  app.get("/api/session/:id", async request => ({ data: { id: (request.params as { id: string }).id, location: { directory: "/repo" } } }))
  app.post("/api/rpc/:rpcID/:method", async (request, reply) => {
    const { method } = request.params as { rpcID: string; method: string }
    const input = (request.body as { input: Record<string, unknown> }).input
    rpcCalls.push({ method, input })
    if (method === "attach") {
      attached(String(input.connectionID))
      return { output: await new Promise<string>(done => { releaseAttach = done }) }
    }
    if (method === "command") return { output: { action: input.requestID === "pause"
      ? { type: "wait", condition: "delay", timeoutMs: 300 } : { type: "tabs.open", url: "https://example.com/" } } }
    if (method === "state" && failState) return reply.code(503).send({ error: "unavailable" })
    return { output: { ok: true } }
  })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(async () => { releaseAttach("replaced"); await app.close() })
  const endpoint = { url: address, auth: undefined }
  rememberRuntime(endpoint, { version: RECOMMENDED, pid: 1234, discovery: "status" })
  const connection = { endpoint, client: OpenCode.make({ baseUrl: address, fetch: globalThis.fetch }), fetch: globalThis.fetch,
    assertCurrent: () => {}, invalidate: () => {}, profile: async () => "modern" as const }
  const eventBus = new EventBus()
  let owned = true
  const attachments = new NativeBrowserAttachments({
    workspaceManager: { getSharedServiceConnection: async () => connection, ownsLocation: async () => owned } as never,
    eventBus,
    nativeParent: { available: true, browserAutomationUnavailable: false, request: async (method: string) => {
      if (method === "browser.execute") dispatched.push(owned)
      if (method === "browser.probe") return { available: true, target: "doc", loading: false }
      return { url: "https://example.com/" }
    } } as never,
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {}, trace: () => {}, isLevelEnabled: () => false } as never,
  })
  t.after(() => attachments.close())
  attachments.hold("hold", "ws", "ses-1")
  const connectionID = await attachedReady
  const command = (requestID: string) => eventBus.publish({ type: "instance.event", instanceId: "ws",
    event: { type: BROWSER_CONTROL_EVENT, data: { type: "command", connectionID, requestID } } } as any)
  const results = () => rpcCalls.filter(call => call.method === "result")

  // An inventory OpenCode refuses does not drop the result of an action that already ran.
  failState = true
  command("open-1")
  await until(() => results().length === 1, "result despite a failed inventory")
  // The open ran, but OpenCode could not resolve its tab: the request settles as failed instead of naming it.
  assert.equal((results()[0].input.outcome as any).type, "failure")
  assert.match((results()[0].input.outcome as any).message, /could not be published/)
  failState = false

  // The project stops owning the session while the open waits behind a pause: it never reaches the preview,
  // and the preview is not read for the inventory.
  command("pause")
  await until(() => rpcCalls.filter(call => call.method === "command").length === 2, "pause running")
  command("open-2")
  await until(() => rpcCalls.filter(call => call.method === "command").length === 3, "open queued")
  owned = false
  const states = rpcCalls.filter(call => call.method === "state").length
  await until(() => results().some(call => call.input.requestID === "open-2"), "refused open")
  const refused = results().find(call => call.input.requestID === "open-2")!.input.outcome as any
  assert.match(refused.message, /owns this conversation/)
  assert.deepEqual(dispatched, [true], "only the first open reached the preview")
  assert.equal(rpcCalls.filter(call => call.method === "state").length - states <= 1, true, "the refused command publishes nothing")
})
test("a daemon reporting OpenCode older than 2.4 or a custom label is never attached, and an unreadable command is settled with probes naming the owners", async t => {
  const rpcCalls: Array<{ method: string; input: Record<string, unknown> }> = []
  const probes: Array<Record<string, unknown>> = []
  let releaseAttach: (outcome: string) => void = () => {}
  let live = BELOW_MINIMUM
  const app = Fastify({ logger: false })
  app.get("/openapi.json", async () => modernContractFixture)
  app.get("/api/info", async () => info(live))
  app.get("/api/session/:id", async request => ({ data: { id: (request.params as { id: string }).id, location: { directory: "/repo" } } }))
  app.post("/api/rpc/:rpcID/:method", async (request, reply) => {
    const { method } = request.params as { rpcID: string; method: string }
    const input = (request.body as { input: Record<string, unknown> }).input
    rpcCalls.push({ method, input })
    if (method === "attach") return { output: await new Promise<string>(done => { releaseAttach = done }) }
    if (method === "command") return reply.code(503).send({ error: "unavailable" })
    return { output: { ok: true } }
  })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(async () => { releaseAttach("replaced"); await app.close() })
  const runtime = (version: string) => {
    const endpoint = { url: address, auth: undefined }
    rememberRuntime(endpoint, { version, pid: 1234, discovery: "status" })
    return { endpoint, client: OpenCode.make({ baseUrl: address, fetch: globalThis.fetch }), fetch: globalThis.fetch,
      assertCurrent: () => {}, invalidate: () => {}, profile: async () => "modern" as const }
  }
  // The shared service admitted 2.4.1; a same-address replacement now answers.
  const connection = runtime(RECOMMENDED)
  const eventBus = new EventBus()
  const attachments = new NativeBrowserAttachments({
    workspaceManager: { getSharedServiceConnection: async () => connection, ownsLocation: async () => true } as never,
    eventBus,
    nativeParent: { available: true, browserAutomationUnavailable: false, request: async (method: string, params: Record<string, unknown>) => {
      if (method === "browser.probe") probes.push(params)
      return { available: false }
    } } as never,
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {}, trace: () => {}, isLevelEnabled: () => false } as never,
  })
  t.after(() => attachments.close())
  attachments.hold("hold", "ws", "ses-1")
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(rpcCalls.some(call => call.method === "attach"), false, "2.3 would let the preview bypass a browser deny")
  const timers = () => process.getActiveResourcesInfo().filter(kind => kind === "Timeout").length
  const waiting = timers()
  attachments.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(timers() < waiting, "closing ends the retry wait, so it never holds the process open")

  live = "local-build"
  const custom = new NativeBrowserAttachments({
    workspaceManager: { getSharedServiceConnection: async () => connection, ownsLocation: async () => true } as never,
    eventBus, nativeParent: { available: true, browserAutomationUnavailable: false, request: async () => ({ available: false }) } as never,
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {}, trace: () => {}, isLevelEnabled: () => false } as never,
  })
  custom.hold("hold", "ws", "ses-1")
  await new Promise(resolve => setTimeout(resolve, 300))
  custom.close()
  assert.equal(rpcCalls.some(call => call.method === "attach"), false, "a custom label gives no evidence of the browser permission check")

  live = RECOMMENDED
  const current = new NativeBrowserAttachments({
    workspaceManager: { getSharedServiceConnection: async () => connection, ownsLocation: async () => true } as never,
    eventBus,
    nativeParent: { available: true, browserAutomationUnavailable: false, request: async (method: string, params: Record<string, unknown>) => {
      if (method === "browser.probe") probes.push(params)
      return { available: false }
    } } as never,
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {}, trace: () => {}, isLevelEnabled: () => false } as never,
  })
  t.after(() => current.close())
  current.hold("hold", "ws", "ses-1")
  await until(() => rpcCalls.some(call => call.method === "attach"), "attach on 2.4")
  const connectionID = rpcCalls.find(call => call.method === "attach")!.input.connectionID
  const publish = (data: Record<string, unknown>) => eventBus.publish({ type: "instance.event", instanceId: "ws",
    event: { type: BROWSER_CONTROL_EVENT, data: { connectionID, ...data } } } as any)
  publish({ type: "attached" })
  publish({ type: "command", requestID: "unreadable" })
  await until(() => rpcCalls.some(call => call.method === "result"), "settled unreadable command")
  const settled = rpcCalls.find(call => call.method === "result")!.input as any
  assert.deepEqual([settled.requestID, settled.outcome.type], ["unreadable", "failure"])
  assert.deepEqual(probes.at(-1)?.workspaceIDs, ["ws"], "the probe names the verified owners")
})
test("a session moved before a queued command's turn refuses it, and inventories are published one at a time", async t => {
  const rpcCalls: Array<{ method: string; input: Record<string, unknown> }> = []
  const dispatched: string[] = []
  let directory = "/old"
  let holdState: Promise<void> | undefined
  let releaseAttach: (outcome: string) => void = () => {}
  let attached!: (connectionID: string) => void
  const attachedReady = new Promise<string>(resolve => { attached = resolve })
  const app = Fastify({ logger: false })
  app.get("/openapi.json", async () => modernContractFixture)
  app.get("/api/info", async () => info(RECOMMENDED))
  app.get("/api/session/:id", async request => ({ data: { id: (request.params as { id: string }).id, location: { directory } } }))
  app.post("/api/rpc/:rpcID/:method", async request => {
    const { method } = request.params as { rpcID: string; method: string }
    const input = (request.body as { input: Record<string, unknown> }).input
    rpcCalls.push({ method, input })
    if (method === "attach") { attached(String(input.connectionID)); return { output: await new Promise<string>(done => { releaseAttach = done }) } }
    if (method === "command") return { output: { action: input.requestID === "pause"
      ? { type: "wait", condition: "delay", timeoutMs: 300 } : { type: "tabs.open", url: "https://example.com/" } } }
    if (method === "state" && holdState) await holdState
    return { output: { ok: true } }
  })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(async () => { releaseAttach("replaced"); await app.close() })
  const endpoint = { url: address, auth: undefined }
  rememberRuntime(endpoint, { version: RECOMMENDED, pid: 1234, discovery: "status" })
  const connection = { endpoint, client: OpenCode.make({ baseUrl: address, fetch: globalThis.fetch }), fetch: globalThis.fetch,
    assertCurrent: () => {}, invalidate: () => {}, profile: async () => "modern" as const }
  const eventBus = new EventBus()
  const attachments = new NativeBrowserAttachments({
    workspaceManager: { getSharedServiceConnection: async () => connection, ownsLocation: async () => true } as never,
    eventBus,
    nativeParent: { available: true, browserAutomationUnavailable: false, request: async (method: string) => {
      if (method === "browser.execute") dispatched.push(directory)
      if (method === "browser.probe") return { available: true, target: "doc", loading: false }
      return { url: "https://example.com/" }
    } } as never,
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {}, trace: () => {}, isLevelEnabled: () => false } as never,
  })
  t.after(() => attachments.close())
  attachments.hold("hold", "ws", "ses-1")
  const connectionID = await attachedReady
  const publish = (data: Record<string, unknown>) => eventBus.publish({ type: "instance.event", instanceId: "ws",
    event: { type: BROWSER_CONTROL_EVENT, data: { connectionID, ...data } } } as any)
  const results = () => rpcCalls.filter(call => call.method === "result")

  // Two publications: the second waits for the first to be answered.
  let release!: () => void
  holdState = new Promise<void>(resolve => { release = resolve })
  publish({ type: "attached" })
  await until(() => rpcCalls.filter(call => call.method === "state").length === 1, "first publication")
  publish({ type: "attached" })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(rpcCalls.filter(call => call.method === "state").length, 1, "the second publication waits for the first")
  holdState = undefined
  release()
  await until(() => rpcCalls.filter(call => call.method === "state").length === 2, "second publication")

  publish({ type: "command", requestID: "pause" })
  await until(() => rpcCalls.filter(call => call.method === "command").length === 1, "pause running")
  publish({ type: "command", requestID: "open" })
  await until(() => rpcCalls.filter(call => call.method === "command").length === 2, "open queued")
  directory = "/new"
  await until(() => results().some(call => call.input.requestID === "open"), "refused open")
  assert.match((results().find(call => call.input.requestID === "open")!.input.outcome as any).message, /owns this conversation/)
  assert.deepEqual(dispatched, [], "the moved session's preview is never acted on")
})
test("a command whose ownership check fails is settled as failed", async t => {
  const rpcCalls: Array<{ method: string; input: Record<string, unknown> }> = []
  let reads = 0
  let releaseAttach: (outcome: string) => void = () => {}
  let attached!: (connectionID: string) => void
  const attachedReady = new Promise<string>(resolve => { attached = resolve })
  const app = Fastify({ logger: false })
  app.get("/openapi.json", async () => modernContractFixture)
  app.get("/api/info", async () => info(RECOMMENDED))
  app.get("/api/session/:id", async (request, reply) => ++reads > 1
    ? reply.code(503).send({ error: "unavailable" })
    : { data: { id: (request.params as { id: string }).id, location: { directory: "/repo" } } })
  app.post("/api/rpc/:rpcID/:method", async request => {
    const { method } = request.params as { rpcID: string; method: string }
    const input = (request.body as { input: Record<string, unknown> }).input
    rpcCalls.push({ method, input })
    if (method === "attach") { attached(String(input.connectionID)); return { output: await new Promise<string>(done => { releaseAttach = done }) } }
    if (method === "command") return { output: { action: { type: "tabs.list" } } }
    return { output: { ok: true } }
  })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  t.after(async () => { releaseAttach("replaced"); await app.close() })
  const endpoint = { url: address, auth: undefined }
  rememberRuntime(endpoint, { version: RECOMMENDED, pid: 1234, discovery: "status" })
  const connection = { endpoint, client: OpenCode.make({ baseUrl: address, fetch: globalThis.fetch }), fetch: globalThis.fetch,
    assertCurrent: () => {}, invalidate: () => {}, profile: async () => "modern" as const }
  const eventBus = new EventBus()
  const attachments = new NativeBrowserAttachments({
    workspaceManager: { getSharedServiceConnection: async () => connection, ownsLocation: async () => true } as never,
    eventBus,
    nativeParent: { available: true, browserAutomationUnavailable: false, request: async () => ({ available: false }) } as never,
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {}, trace: () => {}, isLevelEnabled: () => false } as never,
  })
  t.after(() => attachments.close())
  attachments.hold("hold", "ws", "ses-1")
  const connectionID = await attachedReady
  eventBus.publish({ type: "instance.event", instanceId: "ws", event: { type: BROWSER_CONTROL_EVENT, data: { type: "command", connectionID, requestID: "list" } } } as any)
  await until(() => rpcCalls.some(call => call.method === "result"), "settled command")
  assert.equal((rpcCalls.find(call => call.method === "result")!.input.outcome as any).type, "failure")
})
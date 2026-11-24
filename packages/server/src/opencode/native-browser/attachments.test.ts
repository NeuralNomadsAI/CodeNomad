import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import { EventBus } from "../../events/bus"
import { modernContractFixture } from "../compatibility/contract-fixture"
import { rememberRuntime } from "../compatibility/runtime"
import { BROWSER_CONTROL_EVENT, NativeBrowserAttachments } from "./attachments"

const until = async (condition: () => boolean, label: string, timeout = 5_000) => {
  for (const end = Date.now() + timeout; !condition();) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test("NativeBrowserAttachments attaches through an owner, runs each command once, and rechecks ownership per command", async t => {
  const rpcCalls: Array<{ method: string; input: Record<string, unknown> }> = []
  const nativeCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  let releaseAttach: (outcome: string) => void = () => {}
  let attached!: (connectionID: string) => void
  const attachedReady = new Promise<string>(resolve => { attached = resolve })
  const app = Fastify({ logger: false })
  app.get("/openapi.json", async () => modernContractFixture)
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
  rememberRuntime(endpoint, { version: "2.4.1", pid: 1234, discovery: "status" })
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
  rememberRuntime(endpoint, { version: "2.4.1", pid: 1234, discovery: "status" })
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
import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import { EventBus } from "../../events/bus"
import { modernContractFixture } from "../compatibility/contract-fixture"
import { rememberRuntime } from "../compatibility/runtime"
import { BROWSER_CONTROL_EVENT, NativeBrowserAttachments } from "./attachments"

test("NativeBrowserAttachments holds owned sessions, publishes state before result, and refuses unowned sessions", async t => {
  const rpcCalls: Array<{ method: string; input: Record<string, unknown> }> = []
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
    if (method === "command") return { output: { action: { type: "tabs.list" } } }
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
  let owns = false
  const attachments = new NativeBrowserAttachments({
    workspaceManager: {
      getSharedServiceConnection: async () => connection,
      ownsLocation: async () => owns,
    } as never,
    eventBus,
    nativeParent: {
      available: true,
      browserAutomationUnavailable: false,
      request: async (method: string) => method === "browser.probe" ? { available: false } : {},
    } as never,
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {}, trace: () => {}, isLevelEnabled: () => false } as never,
  })
  t.after(() => attachments.close())

  // Unowned session does not attach.
  attachments.hold("hold-unowned", "ws-1", "ses-unowned")
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(rpcCalls.length, 0)
  attachments.release("hold-unowned")

  // Owned session attaches, publishes state on `attached`, and publishes state before `result` on `command`.
  owns = true
  attachments.hold("hold-owned", "ws-1", "ses-owned")
  const connectionID = await attachedReady
  eventBus.publish({ type: "instance.event", instanceId: "ws-1", event: { type: BROWSER_CONTROL_EVENT, data: { type: "attached", connectionID } } as any })
  eventBus.publish({ type: "instance.event", instanceId: "ws-1", event: { type: BROWSER_CONTROL_EVENT, data: { type: "command", connectionID, requestID: "req-1" } } as any })
  for (let i = 0; i < 50 && !rpcCalls.some(c => c.method === "result"); i++) await new Promise(resolve => setTimeout(resolve, 20))
  const methods = rpcCalls.map(c => c.method)
  assert.equal(methods[0], "attach")
  assert.ok(methods.includes("command"))
  assert.ok(methods.lastIndexOf("state") < methods.lastIndexOf("result"), "state is published before every result")
  const resultCall = rpcCalls.find(c => c.method === "result")
  assert.deepEqual((resultCall?.input.outcome as any)?.result?.value, { tabs: [], focusedTabID: null })
})

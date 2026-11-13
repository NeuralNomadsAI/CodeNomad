import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { z } from "zod"
import type { InstanceData } from "../../api-types"
import { EventBus } from "../../events/bus"
import { createHttpServer } from "../http-server"
import { recurrenceCreateSchema } from "../routes/mission-recurrence-create"
import { InstanceDataSchema } from "../routes/storage"

// Exercise the production routes and global authentication hook without listening
// or connecting to OpenCode, disk storage or a desktop host.
function fixture(t: TestContext) {
  const state = { authEnabled: true, workspaceReads: 0, nativeCalls: 0,
    writes: [] as Array<{ id: string; data: InstanceData }>, events: [] as unknown[], writeFailure: undefined as Error | undefined }
  const stub = new Proxy({}, { get: () => () => undefined }) as never
  const logger: any = { child: () => logger, debug() {}, trace() {}, info() {}, warn() {}, error() {}, isLevelEnabled: () => false }
  const eventBus = new EventBus()
  eventBus.on("instance.dataChanged", event => state.events.push(event))
  const app = createHttpServer({
    bindHost: "127.0.0.1", bindPort: 0, defaultPort: 0, protocol: "http",
    workspaceManager: { get: () => { state.workspaceReads++; return { path: "/owned/project" } },
      getServiceLocation: () => undefined,
      getSharedServiceConnection: () => { state.nativeCalls++; throw new Error("Unexpected native access") } } as never,
    authManager: { isAuthEnabled: () => state.authEnabled, isTokenBootstrapEnabled: () => false,
      getSessionFromRequest: (request: { headers: { cookie?: string } }) => !state.authEnabled
        ? { sessionId: "auth-disabled", username: "local" }
        : request.headers.cookie === "fixture=human" ? { sessionId: "human", username: "human" } : undefined } as never,
    instanceStore: { write: async (id: string, data: InstanceData) => {
      assert.equal(state.events.length, state.writes.length, "storage write precedes publication")
      if (state.writeFailure) throw state.writeFailure
      state.writes.push({ id, data })
    } } as never,
    remoteControlManager: { gate: () => ({}) } as never,
    eventBus, settings: stub, fileSystemBrowser: stub, serverMeta: {} as never,
    speechService: stub, sidecarManager: stub, previewManager: stub,
    clientConnectionManager: stub, remoteProxySessionManager: stub, yoloManager: stub,
    uiStaticDir: "", logger, nativeParent: stub, automationBridgeToken: "fixture-bridge",
  }).instance
  t.after(() => app.close())
  const put = (payload: unknown, authenticated = true) => app.inject({ method: "PUT", url: "/api/storage/instances/workspace",
    headers: { "content-type": "application/json", ...(authenticated ? { cookie: "fixture=human" } : {}) }, payload: JSON.stringify(payload) })
  const post = (payload: unknown, authenticated = true) => app.inject({ method: "POST", url: "/api/workspaces/workspace/missions/recurrence",
    headers: { "content-type": "application/json", ...(authenticated ? { cookie: "fixture=human" } : {}) }, payload: JSON.stringify(payload) })
  return { app, state, put, post }
}

const profile = { agent: "general", model: { providerID: "provider", id: "model" } }
const recurrence = { requestID: "bounded_request", instructions: "Review changes", template: "custom", taskMode: "native",
  clock: { time: "09:30", zone: "UTC" }, watchedConversationIDs: [],
  profiles: { coordinator: profile, roles: { specialist: profile } } }
const invalid = Array(65_536).fill(0)

function observeArrayParsing(t: TestContext, ...schemas: z.ZodArray[]) {
  const parsing = t.mock.fn()
  for (const schema of schemas) {
    const run = schema._zod.run
    t.mock.method(schema._zod, "run", (...args: Parameters<typeof run>) => { parsing(); return run(...args) })
    schema.parse([])
  }
  assert.equal(parsing.mock.callCount(), schemas.length, "the observer sees each actual route array parser")
  parsing.mock.resetCalls()
  return parsing
}

test("bounded Zod collections reject excess entries before parsing their elements", () => {
  let visits = 0
  const element = z.unknown().transform(value => { visits++; return value })
  element.parse(null)
  assert.equal(visits, 1)
  visits = 0
  for (const [schema, input] of [
    [z.array(element).max(2), [1, 2, 3]],
    [z.set(element).max(2), new Set([1, 2, 3])],
    [z.map(z.string(), element).max(2), new Map([["a", 1], ["b", 2], ["c", 3]])],
  ] as const) {
    const result = schema.safeParse(input)
    assert.equal(result.success, false)
    assert.equal(visits, 0, "oversized collections must not visit attacker-controlled elements")
  }
})

test("recurrence rejects oversized and wrongly typed watches before Zod or workspace admission", async t => {
  const { app, post, state } = fixture(t)
  const parsing = observeArrayParsing(t, recurrenceCreateSchema.shape.watchedConversationIDs)
  for (const watchedConversationIDs of [invalid, Array.from({ length: 33 }, (_, i) => `ses_${i}`), null, {}, [0], ["ses_ok", false]]) {
    const payload = { ...recurrence, watchedConversationIDs }
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < app.initialConfig.bodyLimit!)
    parsing.mock.resetCalls()
    const response = await post(payload)
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { error: "Invalid recurrence creation request" })
    assert.equal(parsing.mock.callCount(), 0, "hostile watch arrays must never enter Zod")
  }
  assert.equal(state.workspaceReads, 0)
  assert.equal(state.nativeCalls, 0)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.events, [])
})

test("recurrence keeps the 32-watch schema boundary, optional fields and bounded content validation", async t => {
  const { post, state } = fixture(t)
  for (const watchedConversationIDs of [[], Array.from({ length: 32 }, (_, i) => `ses_${i}`)]) {
    // The fixture's unavailable Location is reached only after request validation.
    // 32 watches retain the separate whole-input capacity check after ownership.
    const response = await post({ ...recurrence, watchedConversationIDs })
    assert.equal(response.statusCode, 404)
    assert.deepEqual(response.json(), { error: "Workspace unavailable" })
  }
  assert.equal(state.workspaceReads, 2, "missing optional title, notes and directory remain accepted")
  for (const watchedConversationIDs of [undefined, ["ses_duplicate", "ses_duplicate"], [""], ["ses/invalid"], ["x".repeat(241)]]) {
    assert.equal((await post({ ...recurrence, watchedConversationIDs })).statusCode, 400)
  }
  assert.equal(state.workspaceReads, 2)
  assert.equal(state.nativeCalls, 0)
})

test("storage rejects invalid histories before Zod and returns bounded schema errors without effects", async t => {
  const { app, put, state } = fixture(t)
  const parsing = observeArrayParsing(t, InstanceDataSchema.shape.messageHistory.unwrap())
  for (const messageHistory of [invalid, [false, "ok"], ["first", {}, "last"], null, "not an array", {}]) {
    assert.ok(Buffer.byteLength(JSON.stringify({ messageHistory })) < app.initialConfig.bodyLimit!)
    parsing.mock.resetCalls()
    const response = await put({ messageHistory })
    assert.equal(response.statusCode, 400)
    assert.ok(response.body.length < 256, "validation error text must stay bounded")
    assert.deepEqual(response.json(), { error: "Invalid instance data" })
    assert.equal(parsing.mock.callCount(), 0, "invalid histories must never enter Zod")
  }
  const response = await put({ agentModelSelections: { arbitrary: { providerId: 0, modelId: false } } })
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: "Invalid instance data" })
  assert.equal(state.workspaceReads, 0)
  assert.equal(state.nativeCalls, 0)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.events, [])
})

test("storage preserves string histories, defaults, arbitrary selection keys and mutation order", async t => {
  const { put, state } = fixture(t)
  const selections = { "arbitrary/key": { providerId: "", modelId: "model", ignored: true } }
  const histories = [[], ["", "first", "first", "last"], Array(65_536).fill("x")]
  for (const messageHistory of histories) {
    const response = await put({ messageHistory, agentModelSelections: selections, ignored: true })
    assert.equal(response.statusCode, 204)
    assert.deepEqual(state.writes.at(-1), { id: "/owned/project", data: { messageHistory,
      agentModelSelections: { "arbitrary/key": { providerId: "", modelId: "model" } } } })
    assert.equal(state.events.length, state.writes.length)
    assert.deepEqual(state.events.at(-1), { type: "instance.dataChanged", instanceId: "workspace", data: state.writes.at(-1)!.data })
  }
  for (const body of [{}, null]) {
    assert.equal((await put(body)).statusCode, 204)
    assert.deepEqual(state.writes.at(-1)?.data, { messageHistory: [], agentModelSelections: {} })
  }
  const writes = state.writes.length, events = state.events.length
  state.writeFailure = new Error("Fixture write failed")
  const failed = await put({ messageHistory: ["unsaved"] })
  assert.equal(failed.statusCode, 400)
  assert.deepEqual(failed.json(), { error: "Fixture write failed" }, "non-validation errors retain their existing semantics")
  assert.equal(state.writes.length, writes)
  assert.equal(state.events.length, events, "failed writes never publish")
})

test("global authentication and recurrence's human gate stay ahead of array validation", async t => {
  const { put, post, state } = fixture(t)
  const parsing = observeArrayParsing(t, recurrenceCreateSchema.shape.watchedConversationIDs, InstanceDataSchema.shape.messageHistory.unwrap())
  assert.equal((await put({ messageHistory: invalid }, false)).statusCode, 401)
  assert.equal((await post({ ...recurrence, watchedConversationIDs: invalid }, false)).statusCode, 401)
  assert.equal(parsing.mock.callCount(), 0)
  state.authEnabled = false
  const response = await post({ ...recurrence, watchedConversationIDs: invalid })
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: "Human authentication required" })
  assert.equal(parsing.mock.callCount(), 0)
  assert.equal(state.workspaceReads, 0)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.events, [])
  // Auth-disabled local storage keeps its existing admission policy.
  assert.equal((await put({ messageHistory: invalid }, false)).statusCode, 400)
  assert.equal((await put({ messageHistory: ["local"] }, false)).statusCode, 204)
})

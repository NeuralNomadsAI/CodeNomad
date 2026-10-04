import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerMissionRoutes } from "./missions"
import { createManagedMissionRoot } from "./mission-root-creation"
import { registerAutomationPluginRoute } from "./automation-plugin"
import { AUTOMATION_BRIDGE_PATH } from "../../opencode/automation-plugin"
import { setupMissionsPlugin } from "../../opencode/missions-plugin"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

const directory = "C:/private-fixture/worktree"
const physical = "C:/private-fixture/physical"
const projectID = "private-project"
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
async function waitForGate(gate: ReturnType<typeof deferred>, effect: Promise<unknown>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([gate.promise, effect.then(() => { throw new Error(`${label}: effect settled before gate`) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: gate not reached`)), 5_000) })])
  } finally { clearTimeout(timer) }
}
async function fixture(useBridge = false) {
  const app = Fastify()
  const fence = new WorktreeDeletionFence(2_000)
  const storage = new Map<string, any>(), sessions = new Map<string, any>(), tools = new Map<string, any>()
  let handlers: any, creates = 0, writes = 0, current = true
  let creationGate: ReturnType<typeof deferred> | undefined, publicationGate: ReturnType<typeof deferred> | undefined
  let settlementGate: ReturnType<typeof deferred> | undefined, foreignRoot = false, nativeDirectory = directory
  const creationStarted = deferred(), publicationStarted = deferred(), settlementStarted = deferred()
  const effects: Promise<unknown>[] = []
  const track = <T>(effect: Promise<T>): Promise<T> => {
    effects.push(effect)
    void effect.catch(() => {}) // Observe early rejection; the test still asserts the original promise.
    return effect
  }
  const session = {
    get: async ({ sessionID }: any) => { if (!sessions.has(sessionID)) throw Object.assign(new Error("Absent"), { _tag: "SessionNotFoundError", sessionID }); return sessions.get(sessionID) },
    create: async (input: any) => {
      creates++; creationStarted.resolve(); await creationGate?.promise
      const value = { ...input, projectID, ...(foreignRoot ? { parentID: "ses_parent" } : {}) }; sessions.set(input.id, value); return value
    },
    environment: async () => {}, instructions: { entry: { put: async () => {}, remove: async () => {} } },
    prompt: async () => ({}), synthetic: async () => ({}), hook: async () => ({ dispose: async () => {} }),
  }
  const client: any = {
    session, location: { get: async () => ({ directory: nativeDirectory, project: { id: projectID } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => new Proxy({}, { get: (_, method) => async (input: any) => {
      if (method === "snapshot" && creates && settlementGate) { settlementStarted.resolve(); await settlementGate.promise }
      return handlers[method](input, {
      error: (type: string, message: string, data: any) => { throw Object.assign(new Error(message), { type, data }) },
    }) } }),
  }
  const manager: any = {
    get: () => current ? { id: "workspace" } : undefined, list: () => [{ id: "workspace" }],
    getServiceLocation: () => ({ directory }), getSharedServiceClient: async () => client,
    getSharedServiceConnection: async () => ({ client, assertCurrent: () => { if (!current) throw new Error("Stale"); } }),
    ownsLocation: async (_id: string, location: any) => current && location.directory === directory,
    getServiceDirectoryForPath: async (_id: string, path: string) => current && path === directory ? directory : undefined,
    getWorktreeIdentityForPath: async (_id: string, path: string) => current && path === directory ? physical : undefined,
    getSessionEnvironment: async () => ({}),
  }
  const context: any = {
    location: { directory, project: { id: projectID, canonical: directory } }, session,
    storage: { get: async (key: string) => structuredClone(storage.get(key)), set: async (key: string, value: any) => {
      publicationStarted.resolve(); await publicationGate?.promise; writes++; storage.set(key, structuredClone(value))
    }, scan: async ({ prefix }: any) => ({ entries: [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }) },
    agent: { list: async () => ({ data: [] }) }, model: { list: async () => ({ data: [] }) },
    tool: { transform: async (callback: any) => { callback({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }); return { dispose: async () => {} } } },
    rpc: { register: async (_definition: any, value: any) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  }
  const transport = {
    prompt: async () => ({}), synthetic: async () => ({}),
  }
  const creationLifetime = new AbortController()
  const dispose = await setupMissionsPlugin(context, transport, undefined,
    async (id, input) => {
      if (!useBridge) return createManagedMissionRoot(manager, fence, id, { kind: "create-root", input }, creationLifetime.signal) as any
      const response = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
        headers: { "x-codenomad-automation-token": "private-token" }, payload: { mode: "mission-input", sessionID: id,
          command: { kind: "create-root", input } } })
      if (response.statusCode !== 200) throw new Error(response.json().error)
      return response.json().result
    })
  registerMissionRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence })
  registerAutomationPluginRoute(app, { workspaceManager: manager, worktreeDeletionFence: fence, bridgeToken: "private-token",
    authManager: { isLoopbackRequest: () => true }, nativeParent: {}, developerCdp: {} } as any)
  return {
    app, fence, sessions, tools, handlers, manager, creationStarted, publicationStarted, settlementStarted, track,
    get creates() { return creates }, get writes() { return writes },
    delayCreation: () => creationGate = deferred(), delayPublication: () => publicationGate = deferred(),
    delaySettlement: () => settlementGate = deferred(),
    returnChild: () => { foreignRoot = true }, redirectLocation: () => { nativeDirectory = "C:/private-fixture/foreign" },
    stale: () => { current = false },
    cancelCreation: () => creationLifetime.abort(),
    close: async () => {
      creationGate?.resolve(); publicationGate?.resolve(); settlementGate?.resolve()
      await Promise.allSettled(effects)
      await app.close(); await dispose()
    },
  }
}
const payload = { requestId: "create", objective: "Private test", template: "custom", directory }
async function specialist(f: Awaited<ReturnType<typeof fixture>>) {
  const coordinator = { id: "ses_coordinator", projectID, location: { directory } }
  f.sessions.set(coordinator.id, coordinator)
  const result = await f.tools.get("inspect").execute({ start: { objective: "Test", template: "custom" } }, {
    sessionID: coordinator.id, id: "inspect", progress: async () => {},
  })
  return { coordinator, mission: JSON.parse(result.content).mission }
}
function delegate(f: Awaited<ReturnType<typeof fixture>>) {
  return f.track(f.tools.get("delegate").execute({ taskKey: "work", title: "Work", brief: "Test", role: "worker",
    executionMode: { kind: "independent", reason: "lifetime",
      explanation: "Create a separately owned root to test its physical admission lifetime through native creation, publication and cancellation settlement." },
  }, {
    sessionID: "ses_coordinator", id: "delegate", progress: async () => {},
  }))
}

test("human coordinator creation fails before native creation and publication under the physical deletion fence", async () => {
  const f = await fixture(), held = deferred()
  const deletion = f.fence.run(physical, [physical], () => held.promise)
  try {
    const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })
    assert.equal(response.statusCode, 409)
    assert.equal(f.creates, 0); assert.equal(f.writes, 0)
  } finally { held.resolve(); await deletion; await f.close() }
})

test("human creation holds admission through delayed native creation and journal publication", { timeout: 15_000 }, async () => {
  const f = await fixture(), create = f.delayCreation(), publish = f.delayPublication()
  try {
    const request = f.track(f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload }).then(r => r))
    await waitForGate(f.creationStarted, request, "human creation")
    let evacuated = false
    const deletion = f.track(f.fence.run(physical, [physical], async () => { evacuated = true }))
    await new Promise(resolve => setImmediate(resolve)); assert.equal(evacuated, false)
    create.resolve(); await waitForGate(f.publicationStarted, request, "human publication")
    await new Promise(resolve => setImmediate(resolve)); assert.equal(evacuated, false)
    publish.resolve(); assert.equal((await request).statusCode, 200)
    await deletion; assert.equal(evacuated, true); assert.equal(f.creates, 1)
  } finally { await f.close() }
})

test("managed specialist creation fails before native root creation under the same physical fence", async () => {
  const f = await fixture(), held = deferred()
  await specialist(f)
  const deletion = f.fence.run(physical, [physical], () => held.promise)
  try {
    await assert.rejects(delegate(f), /deletion/i)
    assert.equal(f.creates, 0)
  } finally { held.resolve(); await deletion; await f.close() }
})

test("managed specialist admission drains delayed native creation only after published actor settlement", { timeout: 15_000 }, async () => {
  const f = await fixture(), create = f.delayCreation(), settle = f.delaySettlement()
  try {
    await specialist(f)
    const request = delegate(f)
    await waitForGate(f.creationStarted, request, "specialist creation")
    let evacuated = false
    const deletion = f.track(f.fence.run(physical, [physical], async () => { evacuated = true }))
    await new Promise(resolve => setImmediate(resolve)); assert.equal(evacuated, false)
    create.resolve(); await waitForGate(f.settlementStarted, request, "specialist settlement")
    await new Promise(resolve => setImmediate(resolve)); assert.equal(evacuated, false)
    settle.resolve(); await request; await deletion
    assert.equal(evacuated, true); assert.equal(f.creates, 1)
    const snapshot = await f.handlers.snapshot({})
    assert.equal(snapshot.missions[0].actors.filter((actor: any) => actor.managed).length, 1)
  } finally { await f.close() }
})

test("existing human coordinators also hold the physical creation fence", async () => {
  const f = await fixture(), held = deferred()
  f.sessions.set("ses_existing", { id: "ses_existing", projectID, location: { directory } })
  const deletion = f.fence.run(physical, [physical], () => held.promise)
  try {
    const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions",
      payload: { ...payload, coordinatorSessionId: "ses_existing" } })
    assert.equal(response.statusCode, 409); assert.equal(f.creates, 0); assert.equal(f.writes, 0)
  } finally { held.resolve(); await deletion; await f.close() }
})

test("native effective-location redirects fail before coordinator or specialist creation", async () => {
  const f = await fixture()
  try {
    await specialist(f); f.redirectLocation()
    const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })
    assert.equal(response.statusCode, 403)
    await assert.rejects(delegate(f), /effective.*location/)
    assert.equal(f.creates, 0)
  } finally { await f.close() }
})

test("the managed creation capability rejects arbitrary native inputs and child roots", async () => {
  const f = await fixture()
  try {
    const { mission } = await specialist(f)
    await assert.rejects(createManagedMissionRoot(f.manager, f.fence, "ses_coordinator", { kind: "create-root",
      input: { missionID: mission.id, taskKey: "work", parentID: "ses_parent" } }, new AbortController().signal))
    assert.equal(f.creates, 0)
    f.returnChild()
    await assert.rejects(delegate(f), { code: "creation-uncertain" })
    assert.equal([...f.sessions.values()].filter(session => session.parentID === "ses_parent").length, 1)
    assert.equal((await f.handlers.snapshot({})).missions[0].tasks[0].status, "dispatching")
  } finally { await f.close() }
})

test("cancelled managed native creation keeps admission until native settlement", { timeout: 15_000 }, async () => {
  const f = await fixture(), create = f.delayCreation()
  try {
    await specialist(f)
    const pluginRequest = delegate(f)
    await waitForGate(f.creationStarted, pluginRequest, "cancelled creation")
    f.cancelCreation()
    assert.equal(f.creates, 1)
    let evacuated = false
    const deletion = f.track(f.fence.run(physical, [physical], async () => { evacuated = true }))
    await new Promise(resolve => setImmediate(resolve)); assert.equal(evacuated, false)
    create.resolve(); await assert.rejects(pluginRequest, /aborted/i); await deletion
    assert.equal((await f.handlers.snapshot({})).missions[0].tasks[0].status, "dispatching")
  } finally { await f.close() }
})

test("connection/ownership retirement during managed creation cannot release an unsettled native write", { timeout: 15_000 }, async () => {
  const f = await fixture(), create = f.delayCreation()
  try {
    await specialist(f)
    const request = delegate(f)
    await waitForGate(f.creationStarted, request, "retiring creation"); f.stale()
    let evacuated = false
    const deletion = f.track(f.fence.run(physical, [physical], async () => { evacuated = true }))
    await new Promise(resolve => setImmediate(resolve)); assert.equal(evacuated, false)
    create.resolve(); await assert.rejects(request, /owned|Stale/); await deletion
    assert.equal(f.creates, 1)
    assert.equal((await f.handlers.snapshot({})).missions[0].tasks[0].status, "dispatching")
  } finally { await f.close() }
})

test("managed creation uses the authenticated desktop bridge without generic native inputs", async () => {
  const f = await fixture(true), held = deferred()
  try {
    const { mission } = await specialist(f)
    const response = await f.app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
      payload: { mode: "mission-input", sessionID: "ses_coordinator", command: { kind: "create-root",
        input: { missionID: mission.id, taskKey: "work" } } } })
    assert.equal(response.statusCode, 401); assert.equal(f.creates, 0)
    const deletion = f.fence.run(physical, [physical], () => held.promise)
    await assert.rejects(delegate(f), /admission failed/); assert.equal(f.creates, 0)
    held.resolve(); await deletion
    await delegate(f); assert.equal(f.creates, 1)
  } finally { held.resolve(); await f.close() }
})

import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerMissionRoutes } from "./missions"
import { createManagedMissionRoot } from "./mission-root-creation"
import { registerAutomationPluginRoute } from "./automation-plugin"
import { AUTOMATION_BRIDGE_PATH } from "../../opencode/automation-plugin"
import { setupMissionsPlugin } from "../../opencode/missions-plugin"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { prepareMissionCreation } from "./mission-creation-pipeline"
import { missionRecoveryControlError, missionRecoveryError } from "../../missions/recovery-error"
import { MissionControlError } from "../../missions/control-error"
import { prepareCoordinatorMission } from "./mission-prepare"
import { SessionPermissionModes } from "../../permissions/session-mode"
import type { PermissionRule } from "@opencode/client"

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
async function fixture(useBridge = false, drainTimeout = 2_000, supervised = false) {
  const app = Fastify()
  const fence = new WorktreeDeletionFence(drainTimeout)
  const storage = new Map<string, any>(), sessions = new Map<string, any>(), tools = new Map<string, any>()
  let handlers: any, creates = 0, writes = 0, current = true, rpcCreates = 0
  let lostAck = false, failedPublication = false, wrongProfile = false, documentCapabilities = true, failedIntentCleanup = false
  let supportsPermissionMode = true
  const confirmedPermissions: PermissionRule[][] = []
  const permissionModes = supervised ? new SessionPermissionModes({
    getRawConfigOwner: () => ({ settings: { newConversationPermissions: "supervised" } }),
    getPrivateSessionPermissionState: () => ({}),
    setPrivateSessionPermissionBlock: (_key, rules) => { if (rules) confirmedPermissions.push(rules) },
  }) : undefined
  let preferences: unknown, preferenceReads = 0
  let rejectionTransform: ((error: any) => any) | undefined
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
      const value = { ...input, projectID, time: { created: 100 }, ...(foreignRoot ? { parentID: "ses_parent" } : {}),
        ...(wrongProfile ? { agent: "wrong" } : {}) }; sessions.set(input.id, value); return value
    },
    environment: async () => {}, instructions: { entry: { put: async () => {}, remove: async () => {} } },
    prompt: async () => ({}), synthetic: async () => ({}), hook: async () => ({ dispose: async () => {} }),
  }
  const client: any = {
    config: { get: async () => [] },
    session, location: { get: async () => ({ directory: nativeDirectory, project: { id: projectID } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => new Proxy({}, { get: (_, method) => async (input: any) => {
      if (method === "documentCapabilities") {
        if (!documentCapabilities) throw new Error("Document capabilities unavailable")
        return { version: 1, automaticStart: true, ...(supportsPermissionMode ? { rootPermissions: true } : {}) }
      }
      if (method === "snapshot" && creates && settlementGate) { settlementStarted.resolve(); await settlementGate.promise }
      if (method === "create") rpcCreates++
      try {
        const result = await handlers[method](input, {
          error: (type: string, message: string, data: any) => { throw Object.assign(new Error(message), { type, data }) },
        })
        if (method === "create" && lostAck) throw new Error("Create acknowledgement lost")
        return result
      } catch (error) { throw rejectionTransform?.(error) ?? error }
    } }),
  }
  const connection = { client, assertCurrent: () => { if (!current) throw new Error("Stale"); } }
  const manager: any = {
    get: () => current ? { id: "workspace" } : undefined, list: () => [{ id: "workspace" }],
    getServiceLocation: () => ({ directory }), getSharedServiceClient: async () => client,
    getSharedServiceConnection: async () => connection,
    ownsLocation: async (_id: string, location: any) => current && location.directory === directory,
    getServiceDirectoryForPath: async (_id: string, path: string) => current && path === directory ? directory : undefined,
    getWorktreeIdentityForPath: async (_id: string, path: string) => current && path === directory ? physical : undefined,
    getSessionEnvironment: async () => ({}),
  }
  const context: any = {
    location: { directory, project: { id: projectID, canonical: directory } }, session,
    storage: { get: async (key: string) => structuredClone(storage.get(key)), set: async (key: string, value: any) => {
      if (failedIntentCleanup && key.includes("/creation-intents/") && value === null) throw new Error("Intention cleanup unavailable")
      publicationStarted.resolve(); await publicationGate?.promise
      if (failedPublication) throw new Error("Publication unavailable")
      writes++; storage.set(key, structuredClone(value))
    }, scan: async ({ prefix }: any) => ({ entries: [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }) },
    agent: { list: async () => ({ data: [{ id: "fixture", mode: "primary" }] }) }, model: { list: async () => ({ data: [] }) },
    tool: { transform: async (callback: any) => { callback({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }); return { dispose: async () => {} } } },
    rpc: { register: async (_definition: any, value: any) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  }
  // The plugin's bridge call, with sendMissionInput's fixed-error mapping.
  const bridge = async (sessionID: string, kind: string, input: unknown) => {
    const response = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH, headers: { "x-codenomad-automation-token": "private-token" },
      payload: { mode: "mission-input", sessionID, command: { kind, input } } })
    if (response.statusCode !== 200) {
      const error = missionRecoveryError(response.json().code, response.json().error)
      if (error && error.status === response.statusCode) throw missionRecoveryControlError(error.code, response.json().error)
      throw new Error(response.json().error)
    }
    return response.json().result
  }
  const transport = {
    prompt: async () => ({}), synthetic: async () => ({}),
    resolveCreationDefaults: (sessionID: string, input: unknown) => bridge(sessionID, "profile-defaults", input),
    prepare: (sessionID: string, input: unknown) => bridge(sessionID, "prepare", input),
  }
  const creationLifetime = new AbortController()
  const dispose = await setupMissionsPlugin(context, transport, undefined,
    async (id, input) => {
      if (!useBridge) return createManagedMissionRoot(manager, fence, id, { kind: "create-root", input }, creationLifetime.signal, permissionModes) as any
      const response = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
        headers: { "x-codenomad-automation-token": "private-token" }, payload: { mode: "mission-input", sessionID: id,
          command: { kind: "create-root", input } } })
      if (response.statusCode !== 200) throw new Error(response.json().error)
      return response.json().result
    })
  registerMissionRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence, permissionModes })
  registerAutomationPluginRoute(app, { workspaceManager: manager, worktreeDeletionFence: fence, bridgeToken: "private-token", permissionModes,
    settings: { getRawConfigOwner: (owner: string) => { assert.equal(owner, "ui"); preferenceReads++; return { settings: { missionProfileDefaults: preferences } } } },
    authManager: { isLoopbackRequest: () => true }, nativeParent: {}, developerCdp: {} } as any)
  return {
    app, fence, sessions, storage, tools, handlers, manager, context, creationStarted, publicationStarted, settlementStarted, track,
    get creates() { return creates }, get writes() { return writes }, get rpcCreates() { return rpcCreates },
    get preferenceReads() { return preferenceReads },
    confirmedPermissions, withoutPermissionModeSupport: () => { supportsPermissionMode = false },
    setPreferences: (value: unknown) => { preferences = value },
    setDocumentCapabilities: (value: boolean) => { documentCapabilities = value },
    failIntentCleanup: () => { failedIntentCleanup = true },
    loseAck: () => { lostAck = true }, failPublication: () => { failedPublication = true },
    mismatchProfile: () => { wrongProfile = true },
    transformRejection: (transform: (error: any) => any) => { rejectionTransform = transform },
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

test("passes and confirms the default at Mission coordinator creation, not on adoption or unsupported runtime", async () => {
  const f = await fixture(false, 2_000, true)
  const url = "/api/workspaces/workspace/missions"
  try {
    const created = await f.app.inject({ method: "POST", url, payload })
    assert.equal(created.statusCode, 200, created.body)
    const coordinatorID = created.json().mission.coordinatorSessionId
    const block = [{ action: "edit", resource: "*", effect: "ask" }, { action: "shell", resource: "*", effect: "ask" }]
    assert.deepEqual(f.sessions.get(coordinatorID).permissions, block)
    assert.deepEqual(f.confirmedPermissions, [block])
    f.withoutPermissionModeSupport()
    const unsupported = await f.app.inject({ method: "POST", url, payload: { ...payload, requestId: "unsupported" } })
    assert.equal(unsupported.statusCode, 503)
    assert.equal(f.creates, 1)
    f.sessions.set("ses_existing", { id: "ses_existing", projectID, location: { directory } })
    const adopted = await f.app.inject({ method: "POST", url, payload: { ...payload, requestId: "adopted", coordinatorSessionId: "ses_existing" } })
    assert.equal(adopted.statusCode, 200, adopted.body)
    assert.equal(f.sessions.get("ses_existing").permissions, undefined)
    assert.equal(f.creates, 1)
  } finally { await f.close() }
})

test("lost creation acknowledgement is read by its original request without another create or premature fence release", async () => {
  const f = await fixture(false, 20)
  try {
    f.loseAck()
    assert.equal((await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })).json().code, "creation-uncertain")
    const creates = f.rpcCreates, writes = f.writes
    const receipt = await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })
    assert.equal(receipt.json().state, "created")
    assert.equal(receipt.json().requestId, payload.requestId)
    assert.equal(receipt.json().mission.bodies.objective.characters, payload.objective.length)
    assert.equal(f.rpcCreates, creates); assert.equal(f.writes, writes)
    await f.fence.run(physical, [physical], async () => {})
  } finally { await f.close() }
})

test("durable creation settles a lost acknowledgement independently of later coordinator permission edits", async () => {
  for (const change of ["unrelated", "removed", "ambiguous", "unavailable"] as const) {
    const f = await fixture(false, 20, true)
    try {
      f.loseAck()
      assert.equal((await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })).json().code, "creation-uncertain")
      await assert.rejects(f.fence.run(physical, [physical], async () => assert.fail("pending create")), /Timed out/)
      const root = [...f.sessions.values()][0]
      const block = structuredClone(root.permissions)
      const extra = { action: "read", resource: "fixture.txt", effect: "deny" }
      const changed = change === "unrelated" ? [extra, ...block] : change === "removed" ? [extra] : [...block, extra, ...block]
      root.permissions = changed
      if (change === "unavailable") f.sessions.delete(root.id)
      const { writes } = f
      const receipt = await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })
      assert.equal(receipt.json().state, "created", change)
      assert.equal(receipt.json().mission.coordinatorSessionId, root.id)
      assert.deepEqual(f.confirmedPermissions, change === "unrelated" ? [block] : [])
      assert.deepEqual(root.permissions, changed)
      assert.equal(f.rpcCreates, 1)
      assert.equal(f.writes, writes)
      await f.fence.run(physical, [physical], async () => {})
    } finally { await f.close() }
  }
})

test("the original terminal refusal is recoverable; an absent request is unknown", async () => {
  const f = await fixture()
  try {
    await f.handlers.create({ requestID: payload.requestId, objective: "Other contract", template: payload.template })
    assert.equal((await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })).statusCode, 409)
    const receipt = await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })
    assert.deepEqual(receipt.json(), { requestId: "create", state: "rejected" })
    assert.deepEqual((await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/absent" })).json(), { requestId: "absent", state: "unknown" })
    assert.equal(f.creates, 1)
  } finally { await f.close() }
})

test("a lost pre-dispatch refusal is retained as terminal without any native effect", async () => {
  const f = await fixture()
  try {
    f.setDocumentCapabilities(false)
    assert.equal((await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })).statusCode, 503)
    assert.deepEqual((await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })).json(),
      { requestId: "create", state: "rejected" })
    assert.equal(f.rpcCreates, 0); assert.equal(f.creates, 0)
  } finally { await f.close() }
})

test("a repeated successful request cannot replace its original outcome with a later preflight refusal", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })).statusCode, 200)
    f.setDocumentCapabilities(false)
    const repeat = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })
    assert.equal(repeat.json().code, "creation-uncertain")
    assert.equal((await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })).json().state, "created")
    assert.equal(f.rpcCreates, 1); assert.equal(f.creates, 1)
  } finally { await f.close() }
})

test("pending creation and changed-scope duplicates retain the original request until native completion", async () => {
  const f = await fixture(false, 20), gate = f.delayCreation()
  try {
    const original = f.track(f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload }).then(r => r))
    await waitForGate(f.creationStarted, original, "receipt pending")
    assert.equal((await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })).json().state, "unknown")
    const changed = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions",
      payload: { ...payload, directory: "C:/private-fixture/other" } })
    assert.equal(changed.json().code, "creation-conflict")
    await assert.rejects(f.fence.run(physical, [physical], async () => assert.fail("pending create")), /Timed out/)
    assert.equal(f.rpcCreates, 1)
    gate.resolve(); assert.equal((await original).statusCode, 200)
    f.manager.getServiceLocation = () => ({ directory: "C:/private-fixture/current-default" })
    const receipt = (await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })).json()
    assert.equal(receipt.state, "created")
    assert.equal(receipt.mission.bodies.objective.characters, payload.objective.length)
  } finally { gate.resolve(); await f.close() }
})

test("healthy existing creation contract conflicts return definitive rejection without new roots or parked permits", async () => {
  const f = await fixture(false, 50)
  try {
    await f.handlers.create({ requestID: payload.requestId, objective: payload.objective, template: payload.template })
    const bytes = structuredClone([...f.storage]), roots = structuredClone([...f.sessions])
    for (const objective of [payload.objective, "Different creation", "Different creation", "Changed contract"]) {
      const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload: { ...payload, objective } })
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().code, objective === payload.objective ? "request-conflict" : "creation-conflict")
      assert.deepEqual([...f.storage], bytes)
      assert.deepEqual([...f.sessions], roots)
      await f.fence.run(physical, [physical], async () => {})
    }
    assert.equal(f.creates, 1); assert.equal(f.writes, 1); assert.equal(f.rpcCreates, 1)
  } finally { await f.close() }
})

test("unproven creation conflicts retain their original permit and reject changed retry scope", async () => {
  const f = await fixture(false, 20)
  try {
    await f.handlers.create({ requestID: payload.requestId, objective: "Existing native creation", template: payload.template })
    f.transformRejection(error => { delete error.data.noEffect; return error })
    for (const objective of [payload.objective, payload.objective, "Changed held contract"]) {
      const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload: { ...payload, objective } })
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().code, objective === "Changed held contract" ? "creation-conflict" : "creation-uncertain")
    }
    assert.equal(f.rpcCreates, 1); assert.equal(f.creates, 1); assert.equal(f.writes, 1)
    await assert.rejects(f.fence.run(physical, [physical], async () => assert.fail("must not evacuate")), /Timed out/)
  } finally { await f.close() }
})

test("unproven or mismatched no-effect conflicts retain the original permit and forbid replay", async () => {
  for (const mode of ["legacy", "request", "mission", "effect", "internal", "invalid-execution"] as const) {
    const f = await fixture(false, 20)
    try {
      await f.handlers.create({ requestID: payload.requestId, objective: "Existing native creation", template: payload.template })
      f.transformRejection(error => {
        if (mode === "legacy") delete error.data.noEffect
        else if (mode === "internal") error.type = "rpc.internal"
        else if (mode === "invalid-execution") error.data.code = "invalid-execution"
        else error.data.noEffect = { requestID: mode === "request" ? "other" : payload.requestId,
          missionID: mode === "mission" ? "msn_other" : error.data.noEffect?.missionID,
          ...(mode === "effect" ? { effect: "unknown" } : {}) }
        return error
      })
      const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })
      assert.equal(response.json().code, "creation-uncertain", mode)
      assert.equal((await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })).json().state, "unknown", mode)
      assert.equal((await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })).json().code, "creation-uncertain")
      assert.equal(f.rpcCreates, 1)
      await assert.rejects(f.fence.run(physical, [physical], async () => assert.fail("must not evacuate")), /Timed out/)
    } finally { await f.close() }
  }
})

test("post-create profile/publication errors and lost ACKs retain the hold without duplicate creation", async () => {
  for (const mode of ["profile", "publication", "ack"] as const) {
    const f = await fixture(false, 20)
    try {
      if (mode === "profile") f.mismatchProfile()
      if (mode === "publication") f.failPublication()
      if (mode === "ack") f.loseAck()
      const request = { ...payload, profiles: { coordinator: { agent: "fixture" } } }
      const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload: request })
      assert.equal(response.json().code, "creation-uncertain", mode)
      if (mode !== "ack") assert.equal((await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })).json().state, "unknown", mode)
      assert.equal(f.creates, 1)
      assert.equal((await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload: request })).json().code, "creation-uncertain")
      assert.equal(f.creates, 1); assert.equal(f.rpcCreates, 1)
      assert.equal(f.writes, mode === "ack" ? 1 : 0)
      await assert.rejects(f.fence.run(physical, [physical], async () => assert.fail("must not evacuate")), /Timed out/)
    } finally {
      if (mode === "publication") await assert.rejects(f.close(), /Publication unavailable/)
      else await f.close()
    }
  }
})

test("damaged creation storage cannot produce a no-effect receipt or create another root", async () => {
  const f = await fixture(false, 20)
  try {
    await f.handlers.create({ requestID: "existing", objective: "Existing mission", template: "custom", prepared: true })
    const key = f.storage.keys().next().value!
    f.storage.set(`${key.slice(0, key.lastIndexOf("/"))}/damaged`, { invalid: true })
    const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })
    assert.equal(response.json().code, "creation-uncertain")
    assert.equal(f.creates, 1); assert.equal(f.writes, 1)
    await assert.rejects(f.fence.run(physical, [physical], async () => assert.fail("must not evacuate")), /Timed out/)
  } finally { await f.close() }
})

test("damaged evidence after successful creation prevents replay without acquiring another physical permit", async () => {
  const f = await fixture(false, 20)
  try {
    assert.equal((await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })).statusCode, 200)
    const key = f.storage.keys().next().value!
    f.storage.set(key, { invalid: true })
    const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload })
    assert.equal(response.json().code, "creation-uncertain")
    assert.equal(f.creates, 1); assert.equal(f.writes, 1)
    assert.equal((await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })).json().state, "unknown")
    await f.fence.run(physical, [physical], async () => {})
  } finally { await f.close() }
})
async function specialist(f: Awaited<ReturnType<typeof fixture>>) {
  const coordinator = { id: "ses_coordinator", projectID, location: { directory } }
  f.sessions.set(coordinator.id, coordinator)
  const result = await f.tools.get("inspect").execute({ start: { objective: "Test", template: "custom" } }, {
    sessionID: coordinator.id, id: "inspect", progress: async () => {},
  })
  return { coordinator, ...JSON.parse(result.content) }
}
function delegate(f: Awaited<ReturnType<typeof fixture>>) {
  return f.track(f.tools.get("delegate").execute({ taskKey: "work", title: "Work", brief: "Test", role: "worker",
    executionMode: { kind: "independent", reason: "lifetime",
      explanation: "Create a separately owned root to test its physical admission lifetime through native creation, publication and cancellation settlement." },
  }, {
    sessionID: "ses_coordinator", id: "delegate", progress: async () => {},
  }))
}

test("a coordinator prepares a paused hand-off through the bridge's fenced creation pipeline, never Play", async () => {
  const f = await fixture()
  try {
    const { coordinator, mission: source } = await specialist(f)
    const tool = (name: string, input: unknown) => f.tools.get(name).execute(input, { sessionID: coordinator.id, id: `call-${name}`, progress: async () => {} })
    const prepare = (objective = "Pilot the chosen seam") => tool("prepare", { requestID: "pilot", objective, template: "custom" })
    const output = JSON.parse((await prepare()).content), prepared = output.target.mission
    assert.deepEqual([output.outcome, output.acknowledgement, prepared.status, prepared.runState], ["prepared", "fresh", "active", "prepared"])
    assert.deepEqual(prepared.selection, { profiles: { coordinator: {}, roles: { specialist: {} } }, taskMode: "native",
      origins: { coordinator: "opencode-default", roles: { specialist: "opencode-default" }, taskMode: "opencode-default" } })
    const handoff = (await f.handlers.snapshot()).missions.find((mission: any) => mission.id === prepared.missionID)
    assert.deepEqual(handoff.preparedBy, { missionId: source.id, coordinatorSessionId: coordinator.id })
    assert.notEqual(handoff.coordinatorSessionId, coordinator.id)
    assert.equal(f.rpcCreates, 1)
    assert.equal(JSON.parse((await prepare()).content).target.mission.missionID, prepared.missionID, "the same requestID replays the same mission")
    assert.equal(JSON.parse((await prepare("A different objective")).content).code, "prepare-conflict")
    assert.equal(f.rpcCreates, 1, "replays and conflicts are settled from the journal, without another creation")
    const listed = JSON.parse((await tool("inspect", { list: true })).content).missions
    assert.deepEqual(listed.map((entry: any) => [entry.missionID, entry.relation]), [[prepared.missionID, "prepared"], [source.id, "member"]])
    assert.equal(JSON.parse((await tool("inspect", { missionID: prepared.missionID })).content).mission.id, prepared.missionID)
    // The deletion fence still guards a coordinator's creation like the editor's.
    const held = deferred(), deletion = f.fence.run(physical, [physical], () => held.promise)
    try { assert.equal(JSON.parse((await tool("prepare", { requestID: "fenced", objective: "Blocked", template: "custom" })).content).code, "prepare-refused") }
    finally { held.resolve(); await deletion }
    assert.equal(f.rpcCreates, 1)
  } finally { await f.close() }
})

test("an ordinary author prepares through the bridge without joining the separate paused mission or sending a prompt", async () => {
  const f = await fixture()
  try {
    const author = { id: "ses_ordinary", projectID, location: { directory }, title: "Ordinary discussion", metadata: { custom: true } }
    f.sessions.set(author.id, structuredClone(author))
    f.context.session.prompt = async () => assert.fail("Preparation cannot send a prompt")
    f.context.session.synthetic = async () => assert.fail("Preparation cannot send a synthetic input")
    const tool = (name: string, input: unknown) => f.tools.get(name).execute(input, { sessionID: author.id, id: `ordinary-${name}`, progress: async () => {} })
    const request = { requestID: "ordinary", objective: "Separate mission", title: "Pilot", notes: " \n ", template: "custom",
      profiles: { coordinator: { agent: "fixture" }, roles: { specialist: {} } }, taskMode: "native" }
    const [one, two] = await Promise.all([tool("prepare", request), tool("prepare", request)])
    const result = JSON.parse(one.content)
    assert.deepEqual(JSON.parse(two.content), { ...result, acknowledgement: "recovered" })
    const mission = (await f.handlers.snapshot()).missions[0]
    assert.deepEqual(mission.preparedBy, { coordinatorSessionId: author.id })
    assert.equal(mission.runState, "prepared")
    assert.notEqual(mission.coordinatorSessionId, author.id)
    assert.deepEqual(f.sessions.get(author.id), author)
    assert.equal(JSON.parse((await tool("inspect", {})).content).mission, null)
    assert.deepEqual(JSON.parse((await tool("inspect", { list: true })).content).missions.map((item: any) => item.missionID), [mission.id])
    assert.equal(JSON.parse((await tool("inspect", { missionID: mission.id })).content).actor, null)
    assert.equal(f.rpcCreates, 1)
    assert.equal(f.creates, 1)
    assert.equal(JSON.parse((await tool("prepare", { ...request, notes: "" })).content).code, "prepare-conflict")
    assert.equal(f.rpcCreates, 1)
  } finally { await f.close() }
})

test("backend preparation rechecks persisted author provenance after physical admission and before native creation", async () => {
  const f = await fixture()
  try {
    const author = { id: "ses_ordinary", projectID, location: { directory }, metadata: {} as Record<string, unknown> }
    f.sessions.set(author.id, author)
    const physicalIdentity = f.manager.getWorktreeIdentityForPath
    f.manager.getWorktreeIdentityForPath = async (...args: any[]) => {
      author.metadata = { "codenomad.mission": { kind: "coordinator", missionID: "old",
        document: { missionID: "schedule", passageID: "old" } } }
      return physicalIdentity(...args)
    }
    await assert.rejects(prepareCoordinatorMission(f.manager, f.fence, author.id, { kind: "prepare",
      input: { requestID: "changed-author", objective: "Never create", template: "custom" } }, new AbortController().signal),
    (error: any) => error.code === "prepare-refused")
    assert.equal(f.rpcCreates, 0)
    assert.equal(f.creates, 0)
    assert.equal(f.storage.size, 0)
    assert.equal(await f.fence.run(physical, [physical], async () => "released"), "released")
  } finally { await f.close() }
})

test("a lost prepare acknowledgement is reported uncertain, never as nothing created, and the retry returns the saved mission", async () => {
  const f = await fixture()
  try {
    const { coordinator } = await specialist(f)
    const prepare = () => f.tools.get("prepare").execute({ requestID: "pilot", objective: "Pilot the chosen seam", template: "custom" },
      { sessionID: coordinator.id, id: "call-prepare", progress: async () => {} })
    f.loseAck()
    const unknown = JSON.parse((await prepare()).content)
    assert.deepEqual([unknown.outcome, unknown.phase], ["uncertain", "creation"])
    assert.match(unknown.requestID, /^prepare_/)
    assert.match(unknown.missionID, /^msn_/)
    const saved = (await f.handlers.snapshot()).missions.find((mission: any) => mission.preparedBy?.coordinatorSessionId === coordinator.id)
    const reads = f.preferenceReads
    f.setPreferences({ invalid: true })
    const replay = JSON.parse((await prepare()).content).target.mission
    assert.equal(replay.missionID, saved.id)
    assert.deepEqual(replay.selection, { profiles: saved.profiles, taskMode: saved.taskMode, origins: saved.creationDefaults.origins })
    assert.equal(f.preferenceReads, reads, "invalid current preferences cannot invalidate a saved creation")
    assert.equal(f.rpcCreates, 1, "the retry never asks for a second creation")
  } finally { await f.close() }
})

test("an intention cleanup failure preserves creation success and releases the native admission hold", async () => {
  const f = await fixture()
  try {
    const { coordinator } = await specialist(f)
    f.failIntentCleanup()
    const prepare = () => f.tools.get("prepare").execute({ requestID: "cleanup", objective: "Pilot", template: "custom" },
      { sessionID: coordinator.id, id: "cleanup-prepare", progress: async () => {} })
    const first = JSON.parse((await prepare()).content)
    assert.equal(first.outcome, "prepared")
    assert.deepEqual(JSON.parse((await prepare()).content), { ...first, acknowledgement: "recovered" })
    assert.equal(f.rpcCreates, 1)
    assert.equal(await f.fence.run(physical, [physical], async () => "released"), "released")
  } finally { await assert.rejects(f.close(), /Intention cleanup unavailable/) }
})

test("an uncertain prepare before any creation document retains its original selection across preference changes", async () => {
  const f = await fixture()
  try {
    const { coordinator } = await specialist(f)
    f.setPreferences([{ template: "all", profiles: { coordinator: { agent: "fixture" } }, taskMode: "independent" }])
    const request = { requestID: "uncertain-profile", objective: "Uncertain pilot", template: "custom" }
    const prepare = (input = request) => f.tools.get("prepare").execute(input, {
      sessionID: coordinator.id, id: "prepare-uncertain-profile", progress: async () => {},
    })
    f.returnChild()
    assert.equal(JSON.parse((await prepare()).content).outcome, "uncertain")
    assert.equal((await f.handlers.snapshot()).missions.some((mission: any) => mission.preparedBy), false)
    const reads = f.preferenceReads, bytes = structuredClone([...f.storage])
    f.setDocumentCapabilities(false)
    assert.equal(JSON.parse((await prepare()).content).outcome, "uncertain")
    assert.equal(f.preferenceReads, reads)
    assert.deepEqual([...f.storage], bytes, "a later prevalidation refusal cannot erase the original uncertain intention")
    f.setDocumentCapabilities(true)
    for (const preferences of [[], { invalid: true }]) {
      f.setPreferences(preferences)
      assert.equal(JSON.parse((await prepare()).content).outcome, "uncertain")
      assert.equal(f.preferenceReads, reads)
      assert.equal(f.rpcCreates, 1, "the original uncertain hold never permits a replay")
      assert.deepEqual([...f.storage], bytes)
    }
    assert.equal(JSON.parse((await prepare({ ...request, objective: "Another pilot" })).content).code, "prepare-conflict")
    assert.equal(f.creates, 1)
  } finally { await f.close() }
})

test("the bridge resolves owner preferences once and returns the frozen tool selection on replay", async () => {
  const f = await fixture()
  try {
    const { coordinator, selection } = await specialist(f)
    assert.deepEqual(selection, { profiles: { coordinator: {}, roles: { specialist: {} } }, taskMode: "native",
      origins: { coordinator: "opencode-default", roles: { specialist: "opencode-default" }, taskMode: "opencode-default" } })
    f.setPreferences([{ template: "all", profiles: { coordinator: { agent: "fixture" }, roles: { specialist: {} } }, taskMode: "independent" }])
    const request = { requestID: "preferred", objective: "Owner choices", template: "custom" }
    const prepare = (input = request) => f.tools.get("prepare").execute(input, { sessionID: coordinator.id, id: "prepare-preferred", progress: async () => {} })
    const first = JSON.parse((await prepare()).content)
    assert.deepEqual(first.target.mission.selection, { profiles: { coordinator: { agent: "fixture" }, roles: { specialist: {} } }, taskMode: "independent",
      origins: { coordinator: "preference", roles: { specialist: "preference" }, taskMode: "preference" } })
    const reads = f.preferenceReads, bytes = structuredClone([...f.storage])
    f.setPreferences([{ template: "all", profiles: {}, taskMode: "native" }])
    assert.deepEqual(JSON.parse((await prepare()).content), { ...first, acknowledgement: "recovered" })
    assert.equal(JSON.parse((await prepare({ ...request, objective: "Conflict" })).content).code, "prepare-conflict")
    assert.equal(f.preferenceReads, reads)
    assert.equal(f.rpcCreates, 1)
    assert.deepEqual([...f.storage], bytes)
  } finally { await f.close() }
})

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

test("managed creation uses the authenticated desktop bridge and applies the configured default", async () => {
  const f = await fixture(true, 2_000, true), held = deferred()
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
    const block = [{ action: "edit", resource: "*", effect: "ask" }, { action: "shell", resource: "*", effect: "ask" }]
    assert.deepEqual([...f.sessions.values()].find(session => session.id !== "ses_coordinator").permissions, block)
    assert.deepEqual(f.confirmedPermissions, [block])
  } finally { held.resolve(); await f.close() }
})

test("ordinary HTTP and extracted creation execute the same native catalog/root/journal policy without Play", async () => {
  for (const path of ["http", "pipeline"] as const) {
    const f = await fixture()
    try {
      const request = { ...payload, profiles: { coordinator: { agent: "fixture" } }, taskMode: "independent" }
      let mission
      if (path === "http") {
        const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload: request })
        assert.equal(response.statusCode, 200)
        mission = response.json().mission
      } else {
        const prepared = await prepareMissionCreation({ manager: f.manager, fence: f.fence, workspaceID: "workspace",
          request, signal: new AbortController().signal })
        // Neither request aliases nor inspection copies can retarget the effect.
        request.objective = "Changed caller alias"
        prepared.request.objective = "Changed inspection copy"
        prepared.request.profiles!.coordinator!.agent = "wrong"
        mission = (await prepared.execute()).mission
        await assert.rejects(prepared.execute(), /released/)
      }
      assert.equal(mission.objective, payload.objective)
      assert.equal(mission.runState, "prepared")
      assert.equal(mission.taskMode, "independent")
      assert.equal(mission.profiles.coordinator.agent, "fixture")
      assert.equal(f.rpcCreates, 1); assert.equal(f.creates, 1); assert.equal(f.writes, 1)
      await f.fence.run(physical, [physical], async () => {})
    } finally { await f.close() }
  }
})

test("HTTP, pipeline and coordinator prepare freeze the same Compare judge before acknowledgement or replay", async () => {
  for (const path of ["http", "pipeline", "prepare"] as const) {
    const f = await fixture()
    try {
      f.context.model.list = async () => ({ data: ["a", "b"].map(id => ({ providerID: "p", id, enabled: true, capabilities: { tools: true }, variants: [] })) })
      const profiles = { coordinator: { agent: "fixture", model: { providerID: "p", id: "a" } },
        roles: { "model-a": { model: { providerID: "p", id: "a" } }, "model-b": { model: { providerID: "p", id: "b" } } } }
      const request = { ...payload, template: "compare", profiles }
      const { coordinator } = path === "prepare" ? await specialist(f) : { coordinator: undefined }
      const run = async () => {
        if (path === "http") {
          const response = await f.app.inject({ method: "POST", url: "/api/workspaces/workspace/missions", payload: request })
          if (response.statusCode === 409) {
            assert.equal(response.json().code, "creation-uncertain")
            const receipt = (await f.app.inject({ url: "/api/workspaces/workspace/missions/creation/create" })).json()
            assert.equal(receipt.state, "created")
            return receipt.mission
          }
          assert.equal(response.statusCode, 200); return response.json().mission
        }
        if (path === "pipeline") {
          const prepared = await prepareMissionCreation({ manager: f.manager, fence: f.fence, workspaceID: "workspace", request, signal: new AbortController().signal })
          return (await prepared.execute()).mission
        }
        const result = await f.tools.get("prepare").execute({ requestID: "pilot", objective: payload.objective, template: "compare", profiles },
          { sessionID: coordinator!.id, id: "call-prepare", progress: async () => {} })
        return (await f.handlers.snapshot()).missions.find((mission: any) => mission.id === JSON.parse(result.content).target.mission.missionID)
      }
      const mission = await run()
      assert.deepEqual(mission.profiles.roles.comparator, { model: profiles.coordinator.model })
      const replay = await run()
      assert.equal(replay.id, mission.id)
      assert.deepEqual(replay.profiles, mission.profiles)
      assert.equal(f.creates, 1)
    } finally { await f.close() }
  }
})

test("extracted creation runs the exact late passage fence before its only native RPC", async () => {
  const f = await fixture()
  try {
    const prepared = await prepareMissionCreation({ manager: f.manager, fence: f.fence, workspaceID: "workspace",
      request: payload, signal: new AbortController().signal })
    await assert.rejects(prepared.execute(async () => () => { throw new Error("revoked") }), /policy-unqualified/)
    assert.equal(f.rpcCreates, 0); assert.equal(f.creates, 0); assert.equal(f.writes, 0)
    await f.fence.run(physical, [physical], async () => {})
  } finally { await f.close() }
})

test("concurrent execution and disposal cannot release the original creation owner's permit", async () => {
  const f = await fixture(), gate = f.delayCreation()
  try {
    const prepared = await prepareMissionCreation({ manager: f.manager, fence: f.fence, workspaceID: "workspace",
      request: payload, signal: new AbortController().signal })
    const original = f.track(prepared.execute())
    await assert.rejects(prepared.execute(), /already claimed/)
    await waitForGate(f.creationStarted, original, "original concurrent execution")
    prepared.dispose()
    let evacuated = false
    const deletion = f.track(f.fence.run(physical, [physical], async () => { evacuated = true }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(evacuated, false)
    gate.resolve()
    const result = await original
    assert.equal(result.mission.runState, "prepared")
    await deletion
    assert.equal(evacuated, true)
    assert.equal(f.rpcCreates, 1); assert.equal(f.creates, 1); assert.equal(f.writes, 1)
    // Proven success released the original registry entry, not a replacement.
    const retry = await prepareMissionCreation({ manager: f.manager, fence: f.fence, workspaceID: "workspace",
      request: payload, signal: new AbortController().signal })
    retry.dispose()
  } finally { gate.resolve(); await f.close() }
})

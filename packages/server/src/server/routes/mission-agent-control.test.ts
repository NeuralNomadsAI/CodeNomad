import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { MissionControl } from "../../missions/control"
import type { MissionJsonValue } from "../../missions/model"
import type { MissionStorage } from "../../missions/journal"
import { MissionJournal } from "../../missions/journal"
import { projectMissionController, projectControlResult } from "../../missions/project-control"
import { signProjectControl } from "../../missions/project-control-proof"
import { projectControlInput, projectConfigureInput, projectDeleteInput, type ProjectToolCommand } from "../../missions/project-control-tool"
import { controlResumeAdmissionID } from "../../missions/receipt-identity"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { controlAgentMission, verifyAgentMissionControl } from "./mission-agent-control"
import { registerMissionRoutes } from "./missions"

async function fixture(t: test.TestContext, agentCreated = false) {
  const values = new Map<string, MissionJsonValue>(), native = new Map<string, any>()
  const state = { owned: true, foreign: false, ambiguous: false, loseACK: false, failNative: false, failUpdate: false, cleanupFail: false, preference: true,
    mutations: 0, updates: 0, recoveries: 0, removals: [] as string[], block: undefined as Promise<void> | undefined }
  const directory = process.cwd(), workspace = { id: "owned" }
  const storage: MissionStorage = {
    get: async key => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit }) => {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit).map(([key, value]) => ({ key, value }))
      return { entries, ...(entries.length === limit ? { next: entries.at(-1)!.key } : {}) }
    },
  }
  for (const id of ["ses_root", "ses_child", "ses_actor", "ses_passage", "ses_reused"]) native.set(id, {
    id, projectID: "project", location: { directory }, ...(id === "ses_child" ? { parentID: "ses_root" } : {}),
  })
  const control: MissionControl = new MissionControl({ project: { id: "project", canonical: directory, location: { directory } }, storage,
    sessions: {
      get: async ({ sessionID }) => { if (!native.has(sessionID)) throw new Error("Missing session"); return native.get(sessionID) },
      create: async value => { const result = { ...value, projectID: "project" }; native.set(value.id, result); return result },
      prompt: async () => assert.fail("Use bridge"), synthetic: async () => assert.fail("Use bridge"),
    },
    transport: {
      prompt: async () => {}, synthetic: async () => { state.recoveries++ },
      cleanup: async (_, input) => {
        if (state.cleanupFail) throw new Error("Cleanup unavailable")
        state.removals.push(input.sessionID); native.delete(input.sessionID); return { outcome: "removed" }
      },
      lifecycle: async (_, input) => {
        state.mutations++; await state.block
        if (state.failNative) throw new Error("Unknown native ACK")
        const mission = (await control.snapshot()).missions.find(m => m.id === input.missionID)!, action = mission.control!.action
        const identity = { missionID: input.missionID, operationID: input.operationID, sessionID: input.sessionID, action }
        return { nativeAcknowledgement: action === "start" ? { ...identity, disposition: "start-admitted", admission: {
          id: controlResumeAdmissionID(input.operationID, input.sessionID), sessionID: input.sessionID, type: "synthetic", delivery: "queue",
          time: { created: 100 }, payload: { text: "Continue", metadata: { "codenomad.mission": {
            version: 1, missionID: input.missionID, operationID: input.operationID, kind: "lifecycle",
          } } },
        } } : { ...identity, disposition: "interrupt-observed", interrupt: { interrupted: true }, cancellations: [] } }
      },
    } })
  const rpc: any = {
    snapshot: () => control.snapshot(), mission: ({ missionID }: any) => control.mission(missionID),
    update: (input: any) => control.update(input), lifecycle: (input: any) => control.lifecycle(input),
    delete: (input: any) => control.delete(input), recover: (input: any) => control.recover(input),
    projectControl: async (input: unknown) => {
      const result = await controller(input)
      if (state.loseACK) throw new Error("Lost project RPC ACK")
      return { json: JSON.stringify(result) }
    },
  }
  const client: any = {
    rpc: () => rpc,
    session: { get: async ({ sessionID }: any) => {
      const session = native.get(sessionID)
      if (!session) throw new Error("Missing session")
      return state.foreign ? { ...session, projectID: "foreign" } : session
    }, environment: async () => {}, prompt: async (input: any) => {
      assert.equal(input.delivery, "steer")
      assert.equal(input.agent, undefined); assert.equal(input.model, undefined)
      assert.match(input.text, /CodeNomad project briefing request/)
      state.updates++
      if (state.failUpdate) throw new Error("Unknown briefing ACK")
    } },
    location: { get: async ({ location }: any) => ({ ...location, project: { id: "project", canonical: directory } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
  }
  const connection = { client, assertCurrent() {} }, another = { ...connection }
  const manager: any = {
    list: () => state.ambiguous ? [workspace, { id: "other" }] : [workspace], get: () => workspace,
    getServiceLocation: () => ({ directory }), getSharedServiceConnection: async (id: string) => id === "other" ? another : connection,
    ownsLocation: async (_id: string, location: any) => state.owned && location.directory === directory,
    getServiceDirectoryForPath: async (_id: string, path: string) => path,
    getWorktreeIdentityForPath: async () => directory, getSessionEnvironment: async () => ({}),
  }
  const fence = new WorktreeDeletionFence(5000)
  const deps: any = { workspaceManager: manager, worktreeDeletionFence: fence, bridgeToken: "private-token",
    settings: { getRawConfigOwner: () => ({ settings: { missionDeleteSessions: state.preference } }) } }
  const controller = projectMissionController({ projectID: "project", directory, storage, control, current() {},
    verify: proof => verifyAgentMissionControl(deps, proof.principal.sessionID, { kind: "project-control-verify", input: proof }, new AbortController().signal),
    update: proof => verifyAgentMissionControl(deps, proof.principal.sessionID, { kind: "project-update", input: proof }, new AbortController().signal),
  })
  const mission = (await control.create({ requestID: "create", objective: "Fixture", template: "custom", prepared: true,
    ...(agentCreated ? { preparedBy: { coordinatorSessionID: "ses_actor" } } : {}) })).mission
  const read = async () => (await control.snapshot()).missions.find(m => m.id === mission.id)!
  const invoke = (command: ProjectToolCommand, sessionID = "ses_child") => controlAgentMission(deps, sessionID,
    { kind: "project-control", input: command }, new AbortController().signal) as Promise<any>
  const action = async (action: any, requestID = action, extra = {}) => invoke({ tool: "control", input: {
    action, requestID, missionID: mission.id, expectedRevision: (await read()).revision, ...extra } })
  const app = Fastify({ logger: false })
  registerMissionRoutes(app, deps)
  t.after(() => app.close())
  return { state, native, mission, read, action, invoke, app, directory, controller, control, storage, values }
}

for (const source of ["human", "agent"]) test(`${source} Mission: all owned conversation kinds control lifecycle, edit, brief, recover and delete`, async t => {
  const f = await fixture(t, source === "agent")
  const play = await f.action("play")
  assert.equal(play.receipt.state, "completed")
  for (const sessionID of ["ses_root", "ses_child", "ses_actor", "ses_passage"]) {
    assert.equal((await f.invoke({ tool: "control", input: { missionID: f.mission.id, action: "read" } }, sessionID)).mission.runState, "running")
  }
  const calls = f.state.mutations
  await f.action("pause")
  assert.equal(f.state.mutations, calls, "graceful pause has no native interrupt")
  await f.action("interrupt")
  assert.equal(f.state.mutations, calls + 1)
  await f.action("resume")
  const expectedRevision = (await f.read()).revision
  const edit: ProjectToolCommand = { tool: "configure", input: { action: "save", requestID: "edit",
    missionID: f.mission.id, expectedRevision, objective: "Edited", notes: "" } }
  assert.equal((await f.invoke(edit)).receipt.state, "completed")
  assert.equal((await f.read()).objective, "Edited")
  assert.equal((await f.invoke(edit)).receipt.state, "completed", "exact edit replay")
  const update: ProjectToolCommand = { tool: "control", input: { action: "request-update", missionID: f.mission.id,
    requestID: "one-update", expectedRevision: (await f.read()).revision, language: "fr" } }
  assert.equal((await f.invoke(update)).receipt.state, "completed")
  await f.invoke(update)
  assert.equal(f.state.updates, 1)
  await f.action("recover-coordinator", "recovery-one")
  await f.action("recover-coordinator", "recovery-two")
  assert.equal((await f.action("recover-coordinator", "recovery-two")).receipt.state, "completed")
  assert.equal(f.state.recoveries, 1, "same mission/revision/target nudges once")
  await f.action("stop")
  const deletion: ProjectToolCommand = { tool: "delete", input: { action: "delete", missionID: f.mission.id,
    expectedRevision: (await f.read()).revision, requestID: "delete" } }
  assert.equal((await f.invoke(deletion)).receipt.state, "completed")
  f.state.preference = false
  assert.equal((await f.invoke(deletion)).receipt.state, "completed", "default preference is frozen across replay")
  const removed = await f.invoke({ tool: "delete", input: { action: "read", missionID: f.mission.id, requestID: "delete" } })
  assert.equal(removed.mission, undefined)
  assert.equal(removed.cleanups[0].deleteManagedSessions, true)
  assert.ok(f.native.has(f.mission.coordinatorSessionId), "coordinator retained")
})

test("lost acknowledgement is observed, never resent; original partial lifecycle retries require a positive read", async t => {
  const f = await fixture(t)
  f.state.failNative = true
  const original: ProjectToolCommand = { tool: "control", input: { missionID: f.mission.id, action: "play", requestID: "original", expectedRevision: 1 } }
  assert.equal((await f.invoke(original)).receipt.state, "pending")
  const calls = f.state.mutations
  await f.invoke(original)
  await f.invoke({ ...original, input: { ...original.input, retry: true } } as ProjectToolCommand)
  assert.equal(f.state.mutations, calls)
  const conflicting = await f.invoke({ ...original, input: { ...original.input, requestID: "escape" } } as ProjectToolCommand)
  assert.equal(conflicting.code, "control-pending", "a new identity cannot evade pending control")
  assert.equal(f.state.mutations, calls)
  const read = await f.invoke({ tool: "control", input: { action: "read", missionID: f.mission.id, requestID: "original" } })
  assert.equal(read.receipt.retryable, true)
  f.state.failNative = false
  assert.equal((await f.invoke({ ...original, input: { ...original.input, retry: true } } as ProjectToolCommand)).receipt.state, "completed")
  f.state.loseACK = true
  const pause: ProjectToolCommand = { tool: "control", input: { missionID: f.mission.id, action: "pause",
    expectedRevision: (await f.read()).revision, requestID: "lost-ack" } }
  assert.equal((await f.invoke(pause)).uncertain, true)
  f.state.loseACK = false
  const count = f.state.mutations
  assert.equal((await f.invoke({ tool: "control", input: { action: "read", missionID: f.mission.id, requestID: "lost-ack" } })).receipt.state, "completed")
  assert.equal(f.state.mutations, count)
})

test("agent/human revision race uses the same mutation lane", async t => {
  const f = await fixture(t)
  const revision = (await f.read()).revision
  const outcomes = await Promise.all([
    f.action("play"),
    f.app.inject({ method: "POST", url: `/api/workspaces/owned/missions/${f.mission.id}/control`,
      payload: { action: "start", requestId: "human-race", expectedRevision: revision } }),
  ])
  const agent = outcomes[0] as any, human = outcomes[1] as any
  assert.equal(Number(agent.receipt.state === "completed") + Number(human.statusCode === 200), 1)
  assert.equal(f.state.mutations, 1)
})

test("explicit Stop can supersede a positively saved partial control, retaining the original receipt", async t => {
  const f = await fixture(t)
  f.state.failNative = true
  assert.equal((await f.action("play", "pending-start")).receipt.state, "pending")
  f.state.failNative = false
  assert.equal((await f.action("stop", "explicit-stop")).receipt.state, "completed")
  const original = await f.invoke({ tool: "control", input: { action: "read", missionID: f.mission.id, requestID: "pending-start" } })
  assert.equal(original.receipt.state, "completed")
  assert.equal(original.receipt.result.superseded, true)
  assert.equal(f.state.mutations, 2, "only the original Start and explicit Stop were sent")
})

test("an agent reads and resumes the exact unconfirmed human lifecycle control without manufacturing an identity", async t => {
  const f = await fixture(t)
  const original = { missionID: f.mission.id, requestID: "human-start", expectedRevision: 1, action: "start" as const }
  f.state.failNative = true
  await assert.rejects(f.control.lifecycle(original))
  assert.equal((await f.action("play", "replacement")).code, "control-pending")
  const read = await f.invoke({ tool: "control", input: { action: "read", missionID: f.mission.id, requestID: original.requestID } })
  assert.deepEqual(read.receipt.command.input, { missionID: f.mission.id, requestID: original.requestID, expectedRevision: 1, action: "play" })
  assert.equal(read.receipt.retryable, true)
  f.state.failNative = false
  assert.equal((await f.invoke({ tool: "control", input: { ...read.receipt.command.input, retry: true } })).receipt.state, "completed")
  assert.equal(f.state.mutations, 2)
})

test("an uncertain briefing never disables the panel's independent explicit Stop", async t => {
  const f = await fixture(t)
  await f.action("play")
  f.state.failUpdate = true
  assert.equal((await f.action("request-update", "unknown-point")).receipt.state, "pending")
  assert.equal((await f.action("stop", "stop-work")).receipt.state, "completed")
  assert.equal((await f.invoke({ tool: "control", input: { action: "read", missionID: f.mission.id, requestID: "unknown-point" } })).receipt.result.superseded, true)
  assert.equal(f.state.updates, 1)
})

test("foreign projects, ambiguous owners and forged agent proofs refuse before effects", async t => {
  const f = await fixture(t)
  for (const key of ["owned", "foreign", "ambiguous"] as const) {
    f.state[key] = key !== "owned"
    await assert.rejects(f.action("play"))
    f.state[key] = key === "owned"
  }
  const body = { principal: { kind: "agent" as const, sessionID: "ses_child" }, projectID: "project", directory: f.directory,
    command: { tool: "control" as const, input: { action: "read" as const, missionID: f.mission.id } }, issuedAt: Date.now() }
  await assert.rejects(f.controller({ ...body, proof: signProjectControl(body, "foreign-token") }))
  await assert.rejects(f.controller({ ...body, principal: { kind: "human", sessionID: "cookie" }, proof: signProjectControl(body, "private-token") }))
  assert.equal(f.state.mutations, 0)
})

for (const agentCreated of [false, true]) test(`failed coordinator and missing report recovery (${agentCreated ? "agent" : "human"} Mission)`, async t => {
  const f = await fixture(t, agentCreated)
  await f.action("play")
  let mission = await f.read()
  await f.control.delegate(mission.coordinatorSessionId, { taskKey: "missing-report", title: "Worker", brief: "Work", role: "worker",
    blockedBy: [], delivery: "queue" })
  const request = await f.action("recover-report", "report-one", { taskKey: "missing-report" })
  assert.equal(request.receipt.state, "completed")
  await f.action("recover-report", "report-two", { taskKey: "missing-report" })
  assert.equal((await f.action("recover-report", "report-two", { taskKey: "missing-report" })).receipt.state, "completed")
  assert.equal(f.state.recoveries, 1)
  mission = await f.read()
  await new MissionJournal(f.storage, "project", f.directory).append({ version: 1, id: "evt_failure", missionID: mission.id,
    projectID: "project", type: "mission.finished", createdAt: mission.updatedAt + 1, outcome: "failed", summary: "Fixture failure" })
  const revision = (await f.read()).revision
  const original: ProjectToolCommand = { tool: "control", input: { missionID: mission.id, action: "recover-coordinator",
    expectedRevision: revision, requestID: "reopen" } }
  assert.equal((await f.invoke(original)).receipt.state, "completed")
  await f.invoke(original)
  assert.equal((await f.read()).status, "active")
  assert.equal(f.state.recoveries, 2)
})

test("concurrent update requests and lost ACK replay preserve one native steer message", async t => {
  const f = await fixture(t)
  await f.action("play")
  const original: ProjectToolCommand = { tool: "control", input: { action: "request-update", missionID: f.mission.id,
    requestID: "one-point", expectedRevision: (await f.read()).revision } }
  f.state.loseACK = true
  await Promise.all([f.invoke(original), f.invoke(original)])
  assert.equal(f.state.updates, 1)
  f.state.loseACK = false
  await f.invoke({ tool: "control", input: { action: "read", missionID: f.mission.id, requestID: "one-point" } })
  await f.invoke(original)
  assert.equal(f.state.updates, 1)
})

test("a matching coordinator briefing settles uncertain update admission without another message", async t => {
  const f = await fixture(t)
  await f.action("play")
  f.state.failUpdate = true
  assert.equal((await f.action("request-update", "answered-point")).receipt.state, "pending")
  await f.control.briefing(f.mission.coordinatorSessionId, { missionID: f.mission.id, requestID: "answered-point",
    basedOnRevision: (await f.read()).revision, summary: "Actual coordinator readout", achieved: [], ongoing: [], obstacles: [], next: [] })
  const read = await f.invoke({ tool: "control", input: { action: "read", missionID: f.mission.id, requestID: "answered-point" } })
  assert.equal(read.receipt.state, "completed")
  assert.equal(read.receipt.result.answered, true)
  assert.equal(f.state.updates, 1)
})

test("negative receipt reads and unknown native dispatch never authorize a replacement or retry", async t => {
  const f = await fixture(t)
  const original: ProjectToolCommand = { tool: "control", input: { action: "play", missionID: f.mission.id,
    requestID: "unknown", expectedRevision: 1, retry: true } }
  const missing = await f.invoke({ tool: "control", input: { action: "read", missionID: f.mission.id, requestID: "unknown" } })
  assert.equal(missing.uncertain, true)
  assert.equal((await f.invoke(original)).code, "control-pending")
  assert.equal(f.state.mutations, 0)
})

for (const human of [false, true]) test(`partial ${human ? "human" : "agent"} deletion retains cleanup identity and excluded sessions`, async t => {
  const f = await fixture(t)
  await f.action("play")
  const managed = await f.control.delegate(f.mission.coordinatorSessionId, { taskKey: "managed", title: "Managed", brief: "Work",
    role: "worker", blockedBy: [], delivery: "queue" })
  const specialist = managed.mission.tasks.find(task => task.key === "managed")!.actorSessionId!
  await f.control.delegate(f.mission.coordinatorSessionId, { taskKey: "reused", title: "Reused", brief: "Work",
    role: "worker", blockedBy: [], delivery: "queue", targetSessionID: "ses_reused" })
  await f.action("stop")
  const original: ProjectToolCommand = { tool: "delete", input: { action: "delete", missionID: f.mission.id,
    requestID: "partial-delete", expectedRevision: (await f.read()).revision } }
  f.state.cleanupFail = true
  if (human) await assert.rejects(f.control.delete({ missionID: f.mission.id, requestID: original.input.requestID!,
    expectedRevision: original.input.expectedRevision!, deleteManagedSessions: true }))
  else assert.equal((await f.invoke(original)).receipt.state, "pending")
  assert.equal((await f.invoke({ tool: "delete", input: { action: "read", missionID: f.mission.id, requestID: "partial-delete" } })).receipt.retryable, true)
  f.state.preference = false
  f.state.cleanupFail = false
  assert.equal((await f.invoke({ tool: "delete", input: { ...original.input, action: "delete", retry: true } })).receipt.state, "completed")
  assert.deepEqual(f.state.removals, [specialist])
  assert.ok(f.native.has("ses_reused"))
  assert.ok(f.native.has(f.mission.coordinatorSessionId))
})

test("project controls validate domain combinations independently of portable wire schemas", () => {
  for (const input of [
    { action: "play", missionID: "mission" }, { action: "pause", missionID: "mission", requestID: "id", expectedRevision: 1, graceful: false },
    { action: "recover-report", missionID: "mission", requestID: "id", expectedRevision: 1 },
    { action: "request-update", missionID: "mission", requestID: "id", expectedRevision: 1, language: "x\ninject" },
    { action: "request-update", missionID: "mission", requestID: "id\ninject", expectedRevision: 1 },
    { action: "read", missionID: "mission", retry: true },
  ]) assert.equal(projectControlInput.safeParse(input).success, false)
  assert.equal(projectConfigureInput.safeParse({ action: "save", missionID: "mission", requestID: "id", expectedRevision: 1 }).success, false)
  assert.equal(projectDeleteInput.safeParse({ action: "read", missionID: "mission", deleteManagedSessions: true }).success, false)
})

test("maximal escaped text edits keep their receipt readable within the native wire bound", () => {
  const command = { tool: "configure" as const, input: { missionID: "mission", action: "save" as const,
    requestID: "edit", expectedRevision: 1, objective: "\0".repeat(20_000), notes: "\0".repeat(20_000) } }
  const result = projectControlResult({ receipt: { command, state: "completed" } })
  assert.ok(JSON.stringify(result).length < 1000)
  assert.match((result.receipt as any).payloadDigest, /^[a-f0-9]{64}$/)
  assert.equal("objective" in result.receipt!.command.input, false)
})

import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerMissionRoutes } from "./missions"
import { WorkspaceCapabilityError } from "../../opencode/servers/capabilities"
import { registerMissionRecurrenceSnapshot } from "./mission-recurrence-snapshot"
import { registerMissionRecurrenceCurrent } from "./mission-recurrence-current"
import { registerMissionRecurrenceControlStatus } from "./mission-recurrence-control-status"
import { registerMissionRecurrenceManual } from "./mission-recurrence-manual"
import { registerMissionRecurrenceCreate } from "./mission-recurrence-create"
import { prepareMissionCreation } from "./mission-creation-pipeline"
import { prepareMissionMapMutation } from "./mission-map-mutation"
import { prepareHumanRecurrenceControl } from "./mission-recurrence-play-preparation"
import { verifyMissionHumanAnswer } from "./mission-human-answer"
import { verifyHumanRecurrenceRequest } from "./mission-recurrence-proof"
import { admitMissionInput } from "./mission-input"
import { createManagedMissionRoot } from "./mission-root-creation"
import { prepareCoordinatorMission } from "./mission-prepare"
import { observeMissionTask, interruptMissionTask } from "./mission-task-native"
import { recurrenceControlRequestDigest } from "../../missions/recurrence-control-proof"

const signal = new AbortController().signal
const denied = new WorkspaceCapabilityError("missions", { code: "deferred" })
const workspace = { id: "explicit", binding: { serverId: "loopback-explicit", directory: "/repo" } }
const unexpected = () => { throw new Error("Host/native work before capability admission") }
function manager() {
  const calls: string[] = []
  const value = {
    get: () => workspace, list: () => [workspace], getServiceLocation: () => ({ directory: "/repo" }),
    requireWorkspaceCapability: (id: string, capability: string) => { calls.push(`${id}:${capability}`); throw denied },
    getSharedServiceConnection: unexpected, getSharedServiceClient: unexpected,
    getWorktreeIdentityForPath: unexpected, getServiceDirectoryForPath: unexpected,
    getServiceWslDistro: unexpected, ownsLocation: unexpected, getSessionEnvironment: unexpected,
  }
  return { value: value as never, calls }
}
const auth = { isAuthEnabled: () => true, getSessionFromRequest: () => ({ sessionId: "cookie", username: "human" }) }

test("Mission reads and mutations reject explicit bindings with the shared structured error", async t => {
  const f = manager(), app = Fastify()
  t.after(() => app.close())
  registerMissionRoutes(app, { workspaceManager: f.value } as never)
  for (const request of [
    { method: "GET", url: "/api/workspaces/explicit/missions" },
    { method: "GET", url: "/api/workspaces/explicit/missions/msn_same" },
    { method: "GET", url: "/api/workspaces/explicit/missions/msn_same/admission" },
    { method: "GET", url: "/api/workspaces/explicit/missions/msn_same/content?kind=mission&field=objective&offset=0" },
    { method: "POST", url: "/api/workspaces/explicit/missions", payload: { objective: "Review", requestId: "create_1", template: "custom" } },
    { method: "PATCH", url: "/api/workspaces/explicit/missions/msn_same", payload: { objective: "Review", expectedRevision: 1, requestId: "update_1" } },
    { method: "POST", url: "/api/workspaces/explicit/missions/msn_same/control", payload: { action: "start", expectedRevision: 1, requestId: "start_1" } },
    { method: "DELETE", url: "/api/workspaces/explicit/missions/msn_same", payload: { expectedRevision: 1, requestId: "delete_1" } },
    { method: "POST", url: "/api/workspaces/explicit/missions/msn_same/recover", payload: { expectedRevision: 1, target: "coordinator" } },
  ]) {
    const result = await app.inject(request as never)
    assert.equal(result.statusCode, 403, `${request.url}: ${result.body}`)
    assert.deepEqual(result.json(), { error: denied.code, code: denied.code, capability: "missions", reason: { code: "deferred" } })
  }
  assert.equal(f.calls.length, 9)
})

test("creation, map mutation and human control deny before any host/native preparation", async () => {
  for (const operation of [
    (m: never) => prepareMissionCreation({ manager: m, workspaceID: "explicit", signal, request: {} }),
    (m: never) => prepareMissionMapMutation({ manager: m, workspaceID: "explicit", signal }),
    (m: never) => prepareHumanRecurrenceControl({ raw: { socket: {} } } as never, "explicit",
      { scheduleID: "daily", requestID: "play_1", action: "play", expectedRevision: 0 }, { manager: m, auth } as never, signal),
  ]) {
    const f = manager()
    await assert.rejects(operation(f.value), error => error === denied)
    assert.deepEqual(f.calls, ["explicit:missions"])
  }
})

test("recurrence display and exact status routes return structured capability refusal before inventory", async t => {
  const f = manager(), app = Fastify()
  t.after(() => app.close())
  const deps = { workspaceManager: f.value, manager: f.value, auth, fence: {}, settings: {}, bridgeToken: "fixture" } as never
  registerMissionRecurrenceSnapshot(app, deps)
  registerMissionRecurrenceCurrent(app, deps)
  registerMissionRecurrenceControlStatus(app, deps)
  registerMissionRecurrenceManual(app, deps)
  registerMissionRecurrenceCreate(app, deps)
  for (const request of [
    { method: "GET", url: "/api/workspaces/explicit/missions/recurrence" },
    { method: "GET", url: "/api/workspaces/explicit/missions/recurrence/daily/passages/passage" },
    { method: "GET", url: "/api/workspaces/explicit/missions/recurrence/daily/current" },
    { method: "GET", url: "/api/workspaces/explicit/missions/recurrence/daily/current/passage/content?kind=overview&section=objective" },
    { method: "POST", url: "/api/workspaces/explicit/missions/recurrence/daily/control/status", payload: { requestID: "play_1", action: "play", expectedRevision: 0 } },
    { method: "GET", url: "/api/workspaces/explicit/missions/recurrence/daily/run-now/status?requestID=manual_1&expectedRevision=0" },
    { method: "POST", url: "/api/workspaces/explicit/missions/recurrence", payload: { requestID: "create_1", instructions: "Review", clock: { time: "12:00", zone: "UTC" }, template: "custom", watchedConversationIDs: [], taskMode: "native" } },
  ]) {
    const result = await app.inject(request as never)
    assert.equal(result.statusCode, 403, `${request.url}: ${result.body}`)
    assert.deepEqual(result.json(), { error: denied.code, code: denied.code, capability: "missions", reason: { code: "deferred" } })
  }
  assert.equal(f.calls.length, 7)
})

test("early human verification callbacks deny explicit owners before profile/host/native reads", async () => {
  const f = manager(), deps = { manager: f.value } as never
  await assert.rejects(verifyMissionHumanAnswer({ sessionID: "ses_same", formID: "frm_1", projectID: "project",
    location: { directory: "/repo" }, profileID: "profile", executionHost: "local", workspaceID: "explicit",
    principal: { kind: "cookie", sessionID: "cookie" }, username: "human", answer: { q0: "yes" }, issuedAt: Date.now() }, deps, signal), error => error === denied)
  const identity = { sessionID: "cookie", workspaceID: "explicit", requestID: "play_1", location: { directory: "/repo" },
    scheduleID: "daily", action: "play" as const, expectedRevision: 0, issuedAt: Date.now(),
    profileSource: { profileID: "profile", executionHost: "local", configYamlPath: "/host/config.yaml" } }
  await assert.rejects(verifyHumanRecurrenceRequest({ ...identity, digest: recurrenceControlRequestDigest(identity) }, deps, signal), error => error === denied)
  assert.deepEqual(f.calls, ["explicit:missions", "explicit:missions"])
})

test("all Mission bridge owner walks filter explicit records before acquisition", async () => {
  const f = manager(), fence = {} as never, coordinator = "ses_same"
  const task = { missionID: "msn_same", taskKey: "task-one" }
  const commands: Array<() => Promise<unknown>> = [
    () => admitMissionInput(f.value, fence, coordinator, { kind: "prompt", input: { sessionID: coordinator, id: "msg_same", text: "Review",
      metadata: { "codenomad.mission": { version: 1, missionID: task.missionID, kind: "assignment", taskKey: task.taskKey } }, delivery: "queue", resume: true } }, signal),
    () => admitMissionInput(f.value, fence, coordinator, { kind: "lifecycle", input: { missionID: task.missionID, operationID: "op_1", sessionID: coordinator } }, signal),
    () => admitMissionInput(f.value, fence, coordinator, { kind: "cleanup", input: { missionID: task.missionID, deletionID: "delete_1", sessionID: coordinator } }, signal),
    () => createManagedMissionRoot(f.value, fence, coordinator, { kind: "create-root", input: task }, signal),
    () => prepareCoordinatorMission(f.value, fence, coordinator, { kind: "prepare", input: { missionID: task.missionID, requestID: "prepare_1", objective: "Review", template: "custom" } }, signal),
    () => observeMissionTask(f.value, coordinator, { kind: "task-sessions", input: task }, signal),
    () => interruptMissionTask(f.value, fence, coordinator, { kind: "interrupt", input: task }, signal),
  ]
  for (const command of commands) await assert.rejects(command(), /Missing mission/)
  assert.deepEqual(f.calls, [])
})

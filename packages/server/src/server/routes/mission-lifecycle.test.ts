import assert from "node:assert/strict"
import test from "node:test"
import { applyMissionLifecycle } from "./mission-lifecycle"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

function fixture(action: "start" | "pause" | "stop") {
  const mission: any = {
    id: "msn_fixture", projectID: "project", coordinatorSessionId: "ses_coordinator", status: action === "stop" ? "stopped" : "active",
    runState: action === "start" ? "running" : action === "pause" ? "paused" : "stopped",
    actors: [{ sessionId: "ses_actor", location: { directory: "/repo" } }], tasks: [{ actorSessionId: "ses_actor", status: "queued", execution: { agent: "reviewer" } }],
    control: { id: "evt_control", action, targets: [{ sessionID: "ses_actor", location: { directory: "/repo" } }], pending: ["ses_actor"] },
  }
  const native: Record<string, any> = {
    ses_coordinator: { id: "ses_coordinator", projectID: "project", location: { directory: "/repo" } },
    ses_actor: { id: "ses_actor", projectID: "project", location: { directory: "/repo" }, agent: "reviewer" },
  }
  const state = { owned: true, current: true, environmentFails: false, variables: { TEST: "first" }, afterEnvironment: () => {} }
  const calls: Array<{ kind: string; input: any }> = []
  let inbox = [
    { id: "inb_mission", type: "user", payload: { metadata: { "codenomad.mission": { missionID: mission.id } } } },
    { id: "inb_user", type: "user", payload: {} },
    { id: "inb_other", type: "synthetic", payload: { metadata: { "codenomad.mission": { missionID: "msn_other" } } } },
  ]
  const client = {
    rpc: () => ({ snapshot: async () => ({ projectID: "project", missions: [mission] }) }),
    session: {
      get: async ({ sessionID }: any) => {
        if (!native[sessionID]) throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError", sessionID })
        return structuredClone(native[sessionID])
      },
      environment: async (input: any) => { calls.push({ kind: "environment", input }); state.afterEnvironment(); if (state.environmentFails) throw new Error("secret") },
      instructions: { entry: { remove: async () => {}, put: async () => {} } },
      synthetic: async (input: any) => { calls.push({ kind: "synthetic", input }) },
      interrupt: async (input: any) => { calls.push({ kind: "interrupt", input }) },
      inbox: {
        list: async () => inbox,
        cancel: async (input: any) => { calls.push({ kind: "cancel", input }); inbox = inbox.filter(item => item.id !== input.inboxID) },
      },
    },
  }
  const manager = {
    list: () => [{ id: "workspace" }], getSharedServiceConnection: async () => ({ client, assertCurrent: () => { if (!state.current) throw new Error("stale") } }),
    ownsLocation: async () => state.owned, getWorktreeIdentityForPath: async () => "/repo", getSessionEnvironment: async () => ({ ...state.variables }),
  }
  const fence = new WorktreeDeletionFence()
  const command = { kind: "lifecycle", input: { missionID: mission.id, operationID: mission.control.id, sessionID: "ses_actor" } }
  const send = (signal = new AbortController().signal) => applyMissionLifecycle(manager as never, fence, "ses_coordinator", command, signal)
  return { mission, native, state, calls, send, fence }
}

test("Pause interrupts directly without admitting a message or changing the native inbox", async () => {
  const f = fixture("pause")
  await f.send()
  assert.deepEqual(f.calls, [{ kind: "interrupt", input: { sessionID: "ses_actor", resume: false } }])
})

test("Stop interrupts and cancels only this mission's queued inputs", async () => {
  const f = fixture("stop")
  await f.send()
  assert.deepEqual(f.calls.map(call => call.kind), ["interrupt", "cancel"])
  assert.equal(f.calls[1].input.inboxID, "inb_mission")
})

test("Play syncs current environment and uses the same native admission ID on retry", async () => {
  const f = fixture("start")
  await f.send()
  f.state.variables.TEST = "second"
  await f.send()
  assert.deepEqual(f.calls.map(call => call.kind), ["environment", "synthetic", "environment", "synthetic"])
  assert.equal(f.calls[0].input.variables.TEST, "first")
  assert.equal(f.calls[2].input.variables.TEST, "second")
  assert.equal(f.calls[1].input.id, f.calls[3].input.id)
  assert.equal(f.calls[1].input.resume, true)
})

test("native lifecycle mutations reject absent authority, changed identities, selection and worktree races", async () => {
  for (const mode of ["unowned", "foreign", "moved", "child", "selection", "superseded", "acknowledged", "stale", "environment", "abort"]) {
    const f = fixture("start")
    const abort = new AbortController()
    if (mode === "unowned") f.state.owned = false
    if (mode === "foreign") f.native.ses_actor.projectID = "other"
    if (mode === "moved") f.native.ses_actor.location.directory = "/other"
    if (mode === "child") f.native.ses_actor.parentID = "ses_other"
    if (mode === "selection") f.native.ses_actor.agent = "other"
    if (mode === "superseded") f.mission.runState = "paused"
    if (mode === "acknowledged") f.mission.control.pending = []
    if (mode === "stale") f.state.afterEnvironment = () => { f.state.current = false }
    if (mode === "environment") f.state.environmentFails = true
    if (mode === "abort") f.state.afterEnvironment = () => abort.abort()
    await assert.rejects(f.send(abort.signal), `Must reject ${mode}`)
    assert.equal(f.calls.some(call => call.kind === "synthetic" || call.kind === "interrupt"), false)
    await f.fence.run("project", ["/repo"], async () => {})
  }
  const f = fixture("pause")
  await f.fence.run("project", ["/repo"], async () => { await assert.rejects(f.send(), /Worktree mutation/) })
  assert.deepEqual(f.calls, [])
})

test("missing roots can acknowledge interruption but are not recreated by Play", async () => {
  for (const action of ["start", "pause", "stop"] as const) {
    const f = fixture(action)
    delete f.native.ses_actor
    if (action === "start") await assert.rejects(f.send())
    else assert.deepEqual(await f.send(), { applied: true })
    assert.deepEqual(f.calls, [])
  }
})

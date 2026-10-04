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
  const effects = { afterSynthetic: () => {}, afterInterrupt: () => {}, afterCancel: () => {},
    interruptReply: { interrupted: true } as unknown, running: true }
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
      synthetic: async (input: any) => { calls.push({ kind: "synthetic", input }); effects.afterSynthetic(); return {
        id: input.id, sessionID: input.sessionID, type: "synthetic", delivery: "queue", time: { created: 100 },
        payload: { text: input.text, description: input.description, metadata: input.metadata },
      } },
      interrupt: async (input: any) => { calls.push({ kind: "interrupt", input }); effects.afterInterrupt(); return effects.interruptReply },
      active: async () => effects.running ? { ses_actor: { type: "running" } } : {},
      inbox: {
        list: async () => inbox,
        cancel: async (input: any) => { calls.push({ kind: "cancel", input }); inbox = inbox.filter(item => item.id !== input.inboxID); effects.afterCancel() },
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
  return { mission, native, state, effects, client, calls, send, fence }
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
    else assert.deepEqual(await f.send(), { nativeAcknowledgement: { missionID: f.mission.id, operationID: "evt_control",
      sessionID: "ses_actor", action, disposition: "target-missing" } })
    assert.deepEqual(f.calls, [])
  }
})

test("native interrupted:false is retained even while separately observed activity remains running", async () => {
  const f = fixture("pause")
  f.effects.interruptReply = { interrupted: false }
  const result = await f.send()
  assert.deepEqual(result.nativeAcknowledgement, { missionID: f.mission.id, operationID: "evt_control", sessionID: "ses_actor",
    action: "pause", disposition: "interrupt-observed", interrupt: { interrupted: false }, cancellations: [] })
  assert.deepEqual(await f.client.session.active(), { ses_actor: { type: "running" } })
  assert.equal("applied" in result, false)
})

test("start returns the actual full queued native admission with its stable message identity", async () => {
  const f = fixture("start")
  const first = await f.send(), second = await f.send()
  assert.deepEqual(first, second)
  assert.equal(first.nativeAcknowledgement.disposition, "start-admitted")
  if (first.nativeAcknowledgement.disposition !== "start-admitted") throw new Error("Wrong ACK")
  const sent = f.calls.find(call => call.kind === "synthetic")!.input
  assert.deepEqual(first.nativeAcknowledgement.admission, { id: sent.id, sessionID: sent.sessionID, type: "synthetic", delivery: "queue",
    time: { created: 100 }, payload: { text: sent.text, description: sent.description, metadata: sent.metadata } })
})

test("Stop records exact cancellation IDs without claiming an absent input was cancelled by native", async () => {
  const f = fixture("stop")
  f.effects.afterCancel = () => { throw new Error("Lost cancel response") }
  const result = await f.send()
  assert.equal(result.nativeAcknowledgement.disposition, "interrupt-observed")
  if (result.nativeAcknowledgement.disposition !== "interrupt-observed") throw new Error("Wrong ACK")
  assert.deepEqual(result.nativeAcknowledgement.cancellations, [{ inboxID: "inb_mission", disposition: "observed-absent" }])
  const acknowledged = await fixture("stop").send()
  if (acknowledged.nativeAcknowledgement.disposition !== "interrupt-observed") throw new Error("Wrong ACK")
  assert.deepEqual(acknowledged.nativeAcknowledgement.cancellations, [{ inboxID: "inb_mission", disposition: "native-acknowledged" }])
})

test("malformed native acknowledgements fail closed without follow-up cancellation or start replay", async () => {
  for (const reply of [undefined, null, true, {}, { interrupted: "false" }, { applied: true }, { interrupted: false, suspended: true }]) {
    const f = fixture("stop"); f.effects.interruptReply = reply
    await assert.rejects(f.send(), /Unknown native interrupt/)
    assert.deepEqual(f.calls.map(call => call.kind), ["interrupt"])
  }
  const f = fixture("start")
  f.client.session.synthetic = async (input: any) => { f.calls.push({ kind: "synthetic", input }); return { applied: true } as any }
  await assert.rejects(f.send(), /Unknown native control/)
  assert.equal(f.calls.filter(call => call.kind === "synthetic").length, 1)
})

test("late moved, stale, child or superseded targets cannot produce a receipt after captured native settlement", async () => {
  for (const action of ["start", "pause", "stop"] as const) {
    for (const mode of ["target", "deleted", "workspaceID", "coordinator", "stale", "child", "operation", "targets", "pending", "lost-response"] as const) {
      const f = fixture(action)
      const change = () => {
        if (mode === "target") f.native.ses_actor.location.directory = "/moved"
        if (mode === "deleted") delete f.native.ses_actor
        if (mode === "workspaceID") f.native.ses_actor.location.workspaceID = "foreign"
        if (mode === "coordinator") f.native.ses_coordinator.location.directory = "/moved"
        if (mode === "stale") f.state.current = false
        if (mode === "child") f.native.ses_actor.parentID = "ses_parent"
        if (mode === "operation") f.mission.control.id = "evt_new"
        if (mode === "targets") f.mission.control.targets[0].location.directory = "/moved"
        if (mode === "pending") f.mission.control.pending = []
        if (mode === "lost-response") throw new Error("Native response lost")
      }
      if (action === "start") f.effects.afterSynthetic = change
      else f.effects.afterInterrupt = change
      await assert.rejects(f.send(), `${action}/${mode}`)
      assert.equal(f.calls.filter(call => call.kind === "synthetic" || call.kind === "interrupt").length, 1)
      await f.fence.run("project", ["/repo"], async () => {})
    }
  }
})

test("unknown missing errors are not authoritative absence and root identity remains mandatory", async () => {
  for (const mode of ["network", "wrong-missing", "wrong-id", "child", "coordinator-child"] as const) {
    const f = fixture("pause"), get = f.client.session.get
    if (mode === "wrong-id") f.native.ses_actor.id = "ses_other"
    if (mode === "child") f.native.ses_actor.parentID = "ses_parent"
    if (mode === "coordinator-child") f.native.ses_coordinator.parentID = "ses_parent"
    f.client.session.get = async (input: any) => {
      if (input.sessionID === "ses_actor" && mode === "network") throw new Error("Unavailable")
      if (input.sessionID === "ses_actor" && mode === "wrong-missing") throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError", sessionID: "ses_other" })
      return get(input)
    }
    await assert.rejects(f.send(), `Must reject ${mode} root observation`)
    assert.equal(f.calls.length, 0)
  }
})

test("a cancellation failure with a still-pending input remains uncertain rather than applied", async () => {
  const f = fixture("stop")
  f.client.session.inbox.cancel = async (input: any) => { f.calls.push({ kind: "cancel", input }); throw new Error("Cancellation unknown") }
  await assert.rejects(f.send(), /Cancellation unknown/)
  assert.deepEqual(f.calls.map(call => call.kind), ["interrupt", "cancel"])
})

test("permission, Form and Shell cancellation are never inferred from mission interruption", async () => {
  const f = fixture("stop"), forbidden = () => { throw new Error("Arbitrary cancellation") }
  Object.assign(f.client, { shell: { cancel: forbidden, remove: forbidden }, form: { cancel: forbidden }, permission: { reply: forbidden } })
  await f.send()
  assert.deepEqual(f.calls.map(call => call.kind), ["interrupt", "cancel"])
})

test("late cancellation settlement after a root moves or authority is revoked remains uncertain", async () => {
  for (const mode of ["moved", "stale", "superseded"] as const) {
    const f = fixture("stop")
    f.effects.afterCancel = () => {
      if (mode === "moved") f.native.ses_actor.location.directory = "/moved"
      if (mode === "stale") f.state.current = false
      if (mode === "superseded") f.mission.control.id = "evt_replacement"
    }
    await assert.rejects(f.send(), `Must reject ${mode} cancellation settlement`)
    assert.deepEqual(f.calls.map(call => call.kind), ["interrupt", "cancel"])
  }
})

test("a vanished target after lost interrupt settlement is observed missing only on explicit retry", async () => {
  const f = fixture("pause")
  f.effects.afterInterrupt = () => { delete f.native.ses_actor; throw new Error("Lost response") }
  await assert.rejects(f.send(), /Lost response/)
  assert.equal(f.calls.length, 1)
  const result = await f.send()
  assert.equal(result.nativeAcknowledgement.disposition, "target-missing")
  assert.equal(f.calls.length, 1, "retry observes disappearance without replaying the old interrupt")
})

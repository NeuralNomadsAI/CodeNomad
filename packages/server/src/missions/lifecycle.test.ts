import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl, MissionControlError } from "./control"
import type { MissionInputTransport, NativeMissionSession } from "./control-types"
import type { MissionJsonValue, MissionMap } from "./model"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, parseMissionEvent, type MissionStorage } from "./journal"
import { controlResumeAdmissionID, recurrenceMessageID } from "./receipt-identity"

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const state = { active: true, loseReceipt: false, afterNative: () => {}, interrupted: true }
  const storage: MissionStorage = {
    get: async key => values.get(key), set: async (key, value) => {
      if (state.loseReceipt && value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, MissionJsonValue>).type === "mission.control-applied") {
        state.loseReceipt = false; throw new Error("Lost receipt write")
      }
      values.set(key, structuredClone(value))
    },
    scan: async ({ prefix, after, limit }) => {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value }))
      return { entries, next: entries.length === limit ? entries.at(-1)?.key : undefined }
    },
  }
  const native = new Map<string, NativeMissionSession>()
  const calls: Array<{ action: string; sessionID: string; operationID?: string }> = []
  const failing = new Set<string>()
  let now = 1_000
  const transport: MissionInputTransport = {
    prompt: async (_, input) => { calls.push({ action: "assignment", sessionID: input.sessionID }) },
    synthetic: async (_, input) => { calls.push({ action: "report", sessionID: input.sessionID }) },
    lifecycle: async (_, input) => {
      const mission = (await control().snapshot()).missions.find(mission => mission.id === input.missionID)!
      calls.push({ ...input, action: mission.control!.action })
      if (failing.has(input.sessionID)) throw new Error("Native unavailable")
      state.afterNative()
      const identity = { ...input, action: mission.control!.action }
      return { nativeAcknowledgement: mission.control!.action === "start" ? { ...identity, disposition: "start-admitted", admission: {
        id: controlResumeAdmissionID(input.operationID, input.sessionID), sessionID: input.sessionID, type: "synthetic", delivery: "queue", time: { created: 100 },
        payload: { text: "Continue existing work", metadata: { "codenomad.mission": { version: 1, missionID: input.missionID, operationID: input.operationID, kind: "lifecycle" } } },
      } } : { ...identity, disposition: "interrupt-observed", interrupt: { interrupted: state.interrupted }, cancellations: [] } }
    },
  }
  const control = () => new MissionControl({ project: { id: "project", canonical: "/repo", location: { directory: "/repo" } }, storage,
    now: () => now++, transport, isActive: () => state.active, sessions: {
      get: async ({ sessionID }) => { if (!native.has(sessionID)) throw new Error("missing"); return native.get(sessionID)! },
      create: async input => { const session = { ...input, projectID: "project" }; native.set(session.id, session); return session },
      prompt: async () => { throw new Error("Transport required") }, synthetic: async () => { throw new Error("Transport required") },
    },
  })
  const create = async () => (await control().create({ requestID: "create", objective: "Fixture", template: "custom", prepared: true })).mission
  const action = (mission: MissionMap, action: "start" | "pause" | "stop", requestID = `${action}-${mission.revision}`) => ({ missionID: mission.id, action, expectedRevision: mission.revision, requestID })
  const delegate = (mission: MissionMap, key: string) => control().delegate(mission.coordinatorSessionId, { missionID: mission.id, taskKey: key, title: key, brief: key, role: "worker", blockedBy: [], delivery: "queue" })
  return { control, create, calls, failing, action, delegate, values, native, transport, state, storage }
}
const code = (value: string) => (error: unknown) => error instanceof MissionControlError && error.code === value

test("explicit Pause supersedes a lost start ACK and interrupts its registered root without replaying start", async () => {
  const f = fixture(), prepared = await f.create()
  f.failing.add(prepared.coordinatorSessionId)
  await assert.rejects(f.control().lifecycle(f.action(prepared, "start")), code("control-pending"))
  const uncertain = (await f.control().snapshot()).missions[0]
  assert.equal(uncertain.control?.action, "start")
  assert.equal(uncertain.control?.pending.length, 1)
  f.failing.clear()
  const paused = (await f.control().lifecycle(f.action(uncertain, "pause"))).mission
  assert.equal(paused.runState, "paused")
  assert.equal(paused.control?.receipts?.[0]?.nativeAcknowledgement?.disposition, "interrupt-observed")
  assert.deepEqual(f.calls.map(call => call.action), ["start", "pause"])
})

test("Stop then new Pause then Start cannot reopen work, including a pending Stop", async () => {
  for (const pending of [false, true]) {
    const f = fixture(), prepared = await f.create()
    const running = (await f.control().lifecycle(f.action(prepared, "start"))).mission
    await f.delegate(running, "unfinished")
    const active = (await f.control().snapshot()).missions[0]
    if (pending) f.failing.add(active.coordinatorSessionId)
    const stopping = f.control().lifecycle(f.action(active, "stop"))
    if (pending) await assert.rejects(stopping, code("control-pending"))
    else await stopping
    const stopped = (await f.control().snapshot()).missions[0]
    assert.equal(stopped.status, "stopped")
    assert.equal(stopped.tasks[0].status, "withdrawn")
    const count = f.calls.length
    await assert.rejects(f.control().lifecycle(f.action(stopped, "pause")), code("mission-finished"))
    await assert.rejects(f.control().lifecycle(f.action(stopped, "start")), code("mission-finished"))
    const final = (await f.control().snapshot()).missions[0]
    assert.equal(final.runState, "stopped")
    assert.equal(final.status, "stopped")
    assert.equal(final.tasks[0].status, "withdrawn")
    assert.equal(f.calls.length, count, "terminal denial never dispatches a Pause or Start")
  }
})

test("current-revision Pause of a finished mission is refused before any journal intent", async () => {
  const f = fixture(), prepared = await f.create()
  const running = (await f.control().lifecycle(f.action(prepared, "start"))).mission
  const journal = new MissionJournal(f.storage, "project", "/repo")
  await journal.append({ version: 1, id: "evt_final_report", missionID: running.id, projectID: "project", type: "mission.finished",
    createdAt: running.updatedAt + 1, outcome: "completed", summary: "Original successful result" })
  const completed = (await f.control().snapshot()).missions[0]
  const calls = f.calls.length
  await assert.rejects(f.control().lifecycle(f.action(completed, "pause")), code("mission-finished"))
  const after = (await f.control().snapshot()).missions[0]
  assert.equal(after.revision, completed.revision, "no durable Pause intent was written")
  assert.equal(after.control?.action, "start")
  assert.deepEqual(after.control?.pending, [], "no unresolved control remains")
  assert.equal(f.calls.length, calls, "no native Pause was dispatched")
})

test("a normal Pause of an active mission remains resumable", async () => {
  const f = fixture(), prepared = await f.create()
  const running = (await f.control().lifecycle(f.action(prepared, "start"))).mission
  const paused = (await f.control().lifecycle(f.action(running, "pause"))).mission
  assert.equal(paused.runState, "paused")
  assert.deepEqual(paused.control?.pending, [])
  const resumed = (await f.control().lifecycle(f.action(paused, "start"))).mission
  assert.equal(resumed.runState, "running")
  assert.deepEqual(resumed.control?.pending, [])
})

test("stop records native target receipts after final report without rewriting its completed result", async () => {
  const f = fixture(), prepared = await f.create()
  const running = (await f.control().lifecycle(f.action(prepared, "start"))).mission
  const journal = new MissionJournal(f.storage, "project", "/repo")
  await journal.append({ version: 1, id: "evt_final_report", missionID: running.id, projectID: "project", type: "mission.finished",
    createdAt: running.updatedAt + 1, outcome: "completed", summary: "Original successful result" })
  const completed = (await f.control().snapshot()).missions[0]
  assert.equal(completed.status, "completed")
  const controlled = (await f.control().lifecycle(f.action(completed, "stop"))).mission
  assert.equal(controlled.status, "completed")
  assert.equal(controlled.summary, "Original successful result")
  assert.equal(controlled.control?.receipts?.[0]?.nativeAcknowledgement?.disposition, "interrupt-observed")
  assert.deepEqual(controlled.control?.pending, [])
  await assert.rejects(f.control().lifecycle(f.action(controlled, "start")), code("mission-finished"))
})

test("signed-passage lifecycle ID is exact and ordinary one-shot start ID stays unchanged", async () => {
  const f = fixture(), mission = await f.create(), passageID = "rcp_signed_passage"
  const recurrence = { grantID: "rgrant_signed", passageID, messageID: recurrenceMessageID(passageID),
    coordinatorSessionID: mission.coordinatorSessionId }
  const request = { ...f.action(mission, "start", passageID), recurrence }
  await assert.rejects(f.control().lifecycle({ ...request, recurrence: { ...recurrence, messageID: "msg_wrong" } }),
    code("control-conflict"))
  assert.equal(f.calls.length, 0, "a mismatched message is rejected before transport")
  f.transport.lifecycle = async (_, input) => ({ nativeAcknowledgement: {
    missionID: input.missionID, sessionID: input.sessionID, operationID: input.operationID,
    action: "start", disposition: "start-admitted", admission: { id: input.recurrence!.messageID,
      sessionID: input.sessionID, type: "synthetic", delivery: "queue", time: { created: 100 },
      payload: { text: "Continue existing work", metadata: { "codenomad.mission": {
        version: 1, kind: "lifecycle", missionID: input.missionID, operationID: input.operationID,
        recurrence: input.recurrence,
      } } },
    },
  } })
  const result = (await f.control().lifecycle(request)).mission
  assert.equal(result.control?.receipts?.[0]?.nativeAcknowledgement?.disposition, "start-admitted")
  assert.equal(result.control?.recurrence?.messageID, recurrence.messageID)
  const ordinary = fixture(), prepared = await ordinary.create()
  const standard = (await ordinary.control().lifecycle(ordinary.action(prepared, "start"))).mission.control!
  assert.equal(standard.recurrence, undefined)
  assert.equal(standard.receipts?.[0]?.nativeAcknowledgement?.disposition, "start-admitted")
})

test("recurring start with lost native ACK retains its original operation without automatic replay", async () => {
  const f = fixture(), mission = await f.create(), passageID = "rcp_uncertain_start"
  const request = { ...f.action(mission, "start", passageID), recurrence: { grantID: "rgrant_original", passageID,
    messageID: recurrenceMessageID(passageID), coordinatorSessionID: mission.coordinatorSessionId } }
  let entries = 0
  f.transport.lifecycle = async () => { entries++; throw new Error("native ACK lost") }
  await assert.rejects(f.control().lifecycle(request), code("control-pending"))
  const first = (await f.control().snapshot()).missions[0].control!
  assert.equal(first.recurrence?.grantID, request.recurrence.grantID)
  assert.deepEqual(first.pending, [mission.coordinatorSessionId])
  assert.equal((await f.control().snapshot()).missions[0].control?.id, first.id)
  assert.equal(entries, 1)
})

test("native coordinator readout respects explicit Play, Pause and terminal Stop", async () => {
  const f = fixture()
  let mission = await f.create()
  mission = (await f.control().lifecycle(f.action(mission, "start"))).mission
  mission = (await f.control().declare(mission.coordinatorSessionId, { taskKey: "native-work", title: "Work",
    brief: "Native return", role: "specialist", blockedBy: [] })).mission
  const report = { taskKey: "native-work", outcome: "completed" as const, summary: "Read result", evidence: [], next: [], final: false }
  mission = (await f.control().lifecycle(f.action(mission, "pause"))).mission
  await assert.rejects(f.control().report(mission.coordinatorSessionId, report), code("mission-not-running"))
  assert.equal((await f.control().snapshot()).missions[0].reports.length, 0)
  mission = (await f.control().lifecycle(f.action(mission, "start"))).mission
  mission = (await f.control().report(mission.coordinatorSessionId, report)).mission
  assert.equal(mission.tasks[0].status, "completed")
  assert.equal(f.calls.some(call => call.action === "report" || call.action === "assignment"), false)
  mission = (await f.control().lifecycle(f.action(mission, "stop"))).mission
  await assert.rejects(f.control().report(mission.coordinatorSessionId, report), code("mission-not-running"))
})

test("Play starts a prepared mission once; Pause gates delegation and report wakeups until resume", async () => {
  const f = fixture()
  let mission = await f.create()
  assert.equal(mission.runState, "prepared")
  await assert.rejects(f.delegate(mission, "before-start"), code("mission-not-running"))
  const start = f.action(mission, "start")
  mission = (await f.control().lifecycle(start)).mission
  await f.control().lifecycle(start)
  assert.deepEqual(f.calls.map(call => call.action), ["start"])
  mission = (await f.delegate(mission, "one")).mission
  mission = (await f.delegate(mission, "two")).mission
  const first = mission.tasks[0].actorSessionId!
  const second = mission.tasks[1].actorSessionId!
  mission = (await f.control().lifecycle(f.action(mission, "pause"))).mission
  assert.equal(mission.runState, "paused")
  assert.deepEqual(f.calls.filter(call => call.action === "pause").map(call => call.sessionID).sort(), [mission.coordinatorSessionId, first, second].sort())
  await assert.rejects(f.delegate(mission, "while-paused"), code("mission-not-running"))
  await f.control().report(first, { missionID: mission.id, taskKey: "one", outcome: "completed", summary: "Saved", evidence: [], next: [], final: false })
  assert.equal(f.calls.filter(call => call.action === "report").length, 0)
  assert.deepEqual(await f.control().retryPendingNotifications(), { attempted: 0, failed: 0 })
  mission = (await f.control().snapshot()).missions[0]
  assert.equal(mission.reports[0].notificationStatus, "pending")
  const beforeResume = f.calls.length
  mission = (await f.control().lifecycle(f.action(mission, "start"))).mission
  assert.deepEqual(f.calls.slice(beforeResume).map(call => call.sessionID).sort(), [mission.coordinatorSessionId, second].sort())
  await f.control().retryPendingNotifications()
  assert.equal(f.calls.filter(call => call.action === "report").length, 1)
})

test("unknown ACKs leave immutable original targets pending and explicit retry sends no assignments", async () => {
  for (const reply of [undefined, null, { applied: true }, { nativeAcknowledgement: {} }, { nativeAcknowledgement: { interrupted: true } }]) {
    const f = fixture(), mission = await f.create(), start = f.action(mission, "start")
    const known = f.transport.lifecycle!
    f.transport.lifecycle = async (_, input) => { f.calls.push({ action: "unknown", ...input }); return reply }
    await assert.rejects(f.control().lifecycle(start), code("control-pending"))
    const pending = (await f.control().snapshot()).missions[0].control!
    assert.deepEqual(pending.pending, [mission.coordinatorSessionId])
    assert.deepEqual(pending.receipts, [])
    assert.equal([...f.values.values()].some(value => (value as any).type === "mission.control-applied"), false)
    f.transport.lifecycle = known
    const settled = (await f.control().lifecycle(start)).mission.control!
    assert.equal(settled.id, pending.id)
    assert.deepEqual(settled.targets, pending.targets)
    assert.deepEqual(settled.pending, [])
    assert.deepEqual(f.calls.map(call => call.action), ["unknown", "start"])
  }
})

test("wrong target/action/operation native ACKs cannot settle a valid saved intent", async () => {
  for (const change of [{ sessionID: "ses_other" }, { missionID: "msn_other" }, { operationID: "evt_other" }, { action: "stop" }]) {
    const f = fixture(), mission = await f.create(), request = f.action(mission, "start"), original = f.transport.lifecycle!
    f.transport.lifecycle = async (...args) => {
      const reply = await original(...args) as { nativeAcknowledgement: Record<string, unknown> }
      return { nativeAcknowledgement: { ...reply.nativeAcknowledgement, ...change } }
    }
    await assert.rejects(f.control().lifecycle(request), code("control-pending"))
    assert.deepEqual((await f.control().snapshot()).missions[0].control?.pending, [mission.coordinatorSessionId])
  }
})

test("lost native response is uncertain until explicit retry of the same stable original operation", async () => {
  const f = fixture(), mission = await f.create(), request = f.action(mission, "start")
  f.state.afterNative = () => { throw new Error("Lost native response") }
  await assert.rejects(f.control().lifecycle(request), code("control-pending"))
  const pending = (await f.control().snapshot()).missions[0].control!
  assert.deepEqual(pending.receipts, [])
  assert.deepEqual(pending.pending, [mission.coordinatorSessionId])
  f.state.afterNative = () => {}
  const settled = (await f.control().lifecycle(request)).mission.control!
  assert.equal(settled.id, pending.id)
  assert.deepEqual(f.calls.map(call => call.operationID), [pending.id, pending.id])
  const bytes = structuredClone([...f.values])
  await f.control().lifecycle(request)
  assert.deepEqual([...f.values], bytes)
  assert.equal(f.calls.length, 2)
})

test("lost receipt preserves pending original targets; retry saves only actual newly observed interrupt:false", async () => {
  const f = fixture()
  let mission = (await f.control().lifecycle(f.action(await f.create(), "start"))).mission
  f.state.loseReceipt = true
  const request = f.action(mission, "pause")
  await assert.rejects(f.control().lifecycle(request), code("control-pending"))
  mission = (await f.control().snapshot()).missions[0]
  assert.deepEqual(mission.control?.pending, [mission.coordinatorSessionId])
  f.state.interrupted = false
  mission = (await f.control().lifecycle(request)).mission
  const receipt = mission.control?.receipts?.[0]
  assert.equal(receipt?.acknowledgementState, "known")
  assert.equal(receipt?.nativeAcknowledgement?.disposition, "interrupt-observed")
  if (receipt?.nativeAcknowledgement?.disposition !== "interrupt-observed") throw new Error("Wrong ACK")
  assert.deepEqual(receipt.nativeAcknowledgement.interrupt, { interrupted: false })
  const bytes = structuredClone([...f.values]), count = f.calls.length
  await f.control().lifecycle(request)
  assert.equal(f.calls.length, count)
  assert.deepEqual([...f.values], bytes)
})

test("captured native settlement after availability revocation cannot append a late receipt", async () => {
  const f = fixture(), mission = await f.create(), request = f.action(mission, "start")
  f.state.afterNative = () => { f.state.active = false }
  await assert.rejects(f.control().lifecycle(request), code("control-pending"))
  f.state.active = true
  assert.deepEqual((await f.control().snapshot()).missions[0].control?.pending, [mission.coordinatorSessionId])
  assert.equal([...f.values.values()].some(value => (value as any).type === "mission.control-applied"), false)
})

test("durable native acknowledgements survive reconstruction without upgrading admission to consumption", async () => {
  const f = fixture(), mission = await f.create()
  const started = (await f.control().lifecycle(f.action(mission, "start"))).mission.control!
  const restarted = (await f.control().snapshot()).missions[0].control!
  assert.deepEqual(restarted.receipts, started.receipts)
  assert.equal(restarted.receipts?.[0].nativeAcknowledgement?.disposition, "start-admitted")
  assert.equal(restarted.receipts?.[0].acknowledgementState, "known")
  assert.equal("consumed" in restarted, false)
})

test("Stop is terminal across restart and stale Play retries; conversations and results remain", async () => {
  const f = fixture()
  let mission = await f.create()
  const start = f.action(mission, "start")
  mission = (await f.control().lifecycle(start)).mission
  mission = (await f.delegate(mission, "worker")).mission
  const stop = f.action(mission, "stop")
  mission = (await f.control().lifecycle(stop)).mission
  assert.equal(mission.status, "stopped")
  assert.equal(mission.runState, "stopped")
  assert.equal(mission.control?.pending.length, 0)
  const count = f.calls.length
  assert.equal((await f.control().lifecycle(start)).mission.status, "stopped")
  await f.control().lifecycle(stop)
  assert.equal(f.calls.length, count)
  await assert.rejects(f.control().lifecycle(f.action(mission, "start")), code("mission-finished"))
  await assert.rejects(f.delegate(mission, "after-stop"), code("mission-not-running"))
  assert.equal(f.native.size, 2)
  assert.equal(mission.tasks.length, 1)
})

test("partial control failures persist target receipts and retries act only on remaining actors", async () => {
  const f = fixture()
  let mission = (await f.control().lifecycle(f.action(await f.create(), "start"))).mission
  mission = (await f.delegate(mission, "worker")).mission
  const actor = mission.tasks[0].actorSessionId!
  f.failing.add(actor)
  const pause = f.action(mission, "pause")
  await assert.rejects(f.control().lifecycle(pause), code("control-pending"))
  mission = (await f.control().snapshot()).missions[0]
  assert.equal(mission.runState, "paused")
  assert.deepEqual(mission.control?.pending, [actor])
  await assert.rejects(f.control().lifecycle({ ...pause, action: "stop" }), code("request-conflict"))
  f.failing.clear()
  const count = f.calls.length
  mission = (await f.control().lifecycle(pause)).mission
  assert.deepEqual(f.calls.slice(count).map(call => call.sessionID), [actor])
  assert.deepEqual(mission.control?.pending, [])
  assert.ok([...f.values.values()].every(value => parseMissionEvent(value)))
})

test("late admitted reports survive terminal Stop without waking or completing withdrawn work", async () => {
  const f = fixture()
  let mission = (await f.control().lifecycle(f.action(await f.create(), "start"))).mission
  mission = (await f.delegate(mission, "worker")).mission
  const actor = mission.tasks[0].actorSessionId!
  mission = (await f.control().lifecycle(f.action(mission, "stop"))).mission
  const calls = f.calls.length
  const input = { missionID: mission.id, taskKey: "worker", outcome: "completed" as const, summary: "Existing work finished before Stop", evidence: [], next: [], final: false }
  const saved = await f.control().report(actor, input)
  assert.equal(saved.disposition, "reported")
  assert.equal(saved.mission.status, "stopped")
  assert.equal(saved.mission.tasks[0].status, "withdrawn")
  assert.equal(saved.mission.tasks[0].report, undefined)
  assert.equal(saved.mission.tasks[0].lateReports?.length, 1)
  assert.equal(saved.mission.reports[0].notificationStatus, "pending")
  assert.equal((await f.control().report(actor, input)).disposition, "existing")
  assert.deepEqual(await f.control().retryPendingNotifications(), { attempted: 0, failed: 0 })
  assert.equal(f.calls.length, calls, "proof conservation cannot resume a stopped coordinator")
  const afterRestart = (await f.control().snapshot()).missions[0]
  assert.equal(afterRestart.tasks[0].lateReports?.length, 1)
  assert.equal(afterRestart.status, "stopped")
})

test("Stop can supersede an incomplete start while CAS prevents stale new actions", async () => {
  const f = fixture()
  let mission = await f.create()
  f.failing.add(mission.coordinatorSessionId)
  const start = f.action(mission, "start")
  await assert.rejects(f.control().lifecycle(start), code("control-pending"))
  mission = (await f.control().snapshot()).missions[0]
  await assert.rejects(f.delegate(mission, "while-starting"), code("control-pending"))
  await assert.rejects(f.control().report(mission.coordinatorSessionId, { final: true, outcome: "completed", summary: "Premature", evidence: [], next: [] }), code("control-pending"))
  await assert.rejects(f.control().lifecycle({ ...f.action(mission, "stop"), expectedRevision: start.expectedRevision }), code("revision-conflict"))
  mission = (await f.control().snapshot()).missions[0]
  f.failing.clear()
  mission = (await f.control().lifecycle(f.action(mission, "stop"))).mission
  const count = f.calls.length
  await f.control().lifecycle(start)
  assert.equal(f.calls.length, count)
  assert.equal(mission.status, "stopped")
})

test("Stop supersedes pending Pause reservations at the physical journal limit without replay", async () => {
  const f = fixture()
  let mission = (await f.control().lifecycle(f.action(await f.create(), "start"))).mission
  const prefix = `${MISSION_JOURNAL_STORAGE_PREFIX}/${new MissionJournal(f.storage, "project", "/repo").projectToken}`
  for (let index = 0; f.values.size < 1997; index++) {
    const event = { version: 1 as const, missionID: mission.id, projectID: mission.projectID, id: `evt_update_${index}`,
      type: "mission.updated" as const, requestID: `update-${index}`, expectedRevision: 3 + index,
      objective: "Fixture", notesSpecified: false, createdAt: 2000 + index }
    assert.ok(parseMissionEvent(event))
    f.values.set(`${prefix}/${mission.id}/${event.id}`, event)
  }
  mission = (await f.control().snapshot()).missions[0]
  f.failing.add(mission.coordinatorSessionId)
  const pause = f.action(mission, "pause")
  await assert.rejects(f.control().lifecycle(pause), code("control-pending"))
  mission = (await f.control().snapshot()).missions[0]
  assert.equal(f.values.size, 1998)
  assert.equal(mission.control?.pending.length, 1)
  f.failing.clear()
  const stop = f.action(mission, "stop")
  mission = (await f.control().lifecycle(stop)).mission
  assert.equal(f.values.size, 2000)
  assert.equal(mission.status, "stopped")
  assert.deepEqual(mission.control?.pending, [])
  assert.deepEqual(f.calls.map(call => call.action), ["start", "pause", "stop"])
  const bytes = structuredClone([...f.values])
  await f.control().lifecycle(stop)
  await f.control().lifecycle(pause)
  assert.deepEqual([...f.values], bytes)
  assert.equal(f.calls.length, 3)
})

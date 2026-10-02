import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl, MissionControlError } from "./control"
import type { MissionInputTransport, NativeMissionSession } from "./control-types"
import type { MissionJsonValue, MissionMap } from "./model"
import { parseMissionEvent, type MissionStorage } from "./journal"

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    get: async key => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)) },
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
    },
  }
  const control = () => new MissionControl({ project: { id: "project", canonical: "/repo", location: { directory: "/repo" } }, storage,
    now: () => now++, transport, sessions: {
      get: async ({ sessionID }) => { if (!native.has(sessionID)) throw new Error("missing"); return native.get(sessionID)! },
      create: async input => { const session = { ...input, projectID: "project" }; native.set(session.id, session); return session },
      prompt: async () => { throw new Error("Transport required") }, synthetic: async () => { throw new Error("Transport required") },
    },
  })
  const create = async () => (await control().create({ requestID: "create", objective: "Fixture", template: "custom", prepared: true })).mission
  const action = (mission: MissionMap, action: "start" | "pause" | "stop", requestID = `${action}-${mission.revision}`) => ({ missionID: mission.id, action, expectedRevision: mission.revision, requestID })
  const delegate = (mission: MissionMap, key: string) => control().delegate(mission.coordinatorSessionId, { missionID: mission.id, taskKey: key, title: key, brief: key, role: "worker", blockedBy: [], delivery: "queue" })
  return { control, create, calls, failing, action, delegate, values, native }
}
const code = (value: string) => (error: unknown) => error instanceof MissionControlError && error.code === value

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

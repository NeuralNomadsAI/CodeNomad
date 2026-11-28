import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect, Schema } from "effect"
import { Automation } from "@opencode/schema/automation"
import type { MissionDocument, MissionCalendar } from "../../missions/mission-document"
import type { MissionCalendarOwnerSlot } from "../../missions/mission-calendar-owner-state"
import { acquireNativeScheduledPassageCoverage } from "./native-scheduled-passage-coverage"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import type { MissionNativeService } from "./native-service-adapter"
import { MISSION_WAKE_CODE } from "./native-mission-automation"

const current = () => true as const, at = 1000, signal = new AbortController().signal
async function fixture(count = 2, model: typeof NATIVE_SCHEDULE_CARRIER_MODEL | null = NATIVE_SCHEDULE_CARRIER_MODEL) {
  let enabled = true, effectCalls = 0, mutate: (() => void) | undefined
  const infos = new Map<string, Automation.Info>()
  const calendars: MissionCalendar[] = Array.from({ length: count }, (_, slot) => ({ role: "principal", slot, timeGeneration: 1,
    sessionID: `ses_carrier_${slot}`, scheduleID: `aut_calendar_${slot}`, highWater: 0, pendingWake: null, wakePreparing: null }))
  const descriptors: MissionCalendarOwnerSlot[] = calendars.map(calendar => ({ ...calendar, creation: "adopted", ambiguous: [],
    name: `Owned calendar ${calendar.slot}`, when: { type: "every", every: "15 minutes", tz: "UTC" }, endsAt: null }))
  const doc = { id: "review", projectID: "project", timeGeneration: 1, calendars,
    calendarOwner: { slots: descriptors } } as unknown as MissionDocument
  for (const descriptor of descriptors) {
    infos.set(descriptor.scheduleID!, Schema.decodeUnknownSync(Automation.Info)({ id: descriptor.scheduleID, sessionID: descriptor.sessionID,
      name: descriptor.name, trigger: descriptor.when, tz: "UTC", projectID: "project", directory: "/project",
      action: { type: "code", code: MISSION_WAKE_CODE },
      status: "active", nextDueAt: at + 900_000, runCount: 1, time: { created: at, updated: at } }))
    const calendar = calendars[descriptor.slot]
    calendar.wakePreparing = { scheduleID: calendar.scheduleID, run: 1, messageID: `msg_${calendar.scheduleID}_1`, dueAt: at }
  }
  const native = { location: { directory: "/project" },
    get: async ({ sessionID }: { sessionID: string }) => {
      const calendar = calendars.find(item => item.sessionID === sessionID)!
      return { id: sessionID, projectID: "project", location: { directory: "/project" }, ...(model ? { model } : {}),
        metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: { missionID: doc.id, timeGeneration: 1, role: calendar.role, slot: calendar.slot } } }
    },
  } as unknown as MissionNativeService
  const scheduleTag = Context.Service<never, unknown>("@opencode/Automation")
  const service = {
    get: (id: string) => Effect.sync(() => { effectCalls++; const row = infos.get(id); if (effectCalls === count) { const callback = mutate; mutate = undefined; callback?.() } return row }),
    enabled: () => Effect.suspend(() => Effect.succeed(enabled)),
  }
  const graph = Context.make(scheduleTag, service)
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromiseWith(graph)(effect)
  const coverage = await run(acquireNativeScheduledPassageCoverage(native, run))
  const window = { incarnation: "process_one", cutoff: at, timeGeneration: 1,
    principalIDs: calendars.map(item => item.scheduleID).sort(), completed: false, suppress: false }
  return { doc, window, infos, coverage, native, graph, run, calls: () => effectCalls,
    set enabled(value: boolean) { enabled = value }, set mutate(value: (() => void) | undefined) { mutate = value } }
}

test("all eight principals need exact preparations and a future/done native barrier; stable coverage rechecks every principal", async () => {
  const f = await fixture(8)
  const result = await f.coverage.coverage(f.doc, f.window, current, signal)
  assert.equal(result.complete, true); assert.equal(result.wakes.length, 8); assert.equal(f.calls(), 16)
  assert.equal(result.current(), true)
  const first = f.doc.calendars[0]
  const verified = await f.coverage.verifyWake(f.doc, { missionID: "review", generation: 1, scheduleID: first.scheduleID,
    sessionID: first.sessionID, run: 1, messageID: `msg_${first.scheduleID}_1` }, current, signal)
  assert.equal(verified.wake.dueAt, at)
})

test("OFF, missing preparation, partial principal inventory and old due barrier all refuse fan-in", async () => {
  const f = await fixture()
  f.enabled = false
  await assert.rejects(f.coverage.coverage(f.doc, f.window, current, signal), /disabled/)
  f.enabled = true
  assert.equal((await f.coverage.coverage(f.doc, { ...f.window, principalIDs: [f.window.principalIDs[0]] }, current, signal)).complete, false)
  const calendar = f.doc.calendars[1], original = calendar.wakePreparing
  calendar.wakePreparing = null
  await assert.rejects(f.coverage.coverage(f.doc, f.window, current, signal), /wake proof unavailable/)
  calendar.wakePreparing = original
  f.doc.calendars[0].wakePreparing = null
  const id = f.doc.calendars[0].scheduleID, info = f.infos.get(id)!
  f.infos.set(id, { ...info, nextDueAt: info.time.created })
  assert.equal((await f.coverage.coverage(f.doc, f.window, current, signal)).complete, false)
})

test("changed row during another principal read or more than 256 outstanding occurrences stays unknown", async () => {
  const f = await fixture()
  const id = f.doc.calendars[0].scheduleID, info = f.infos.get(id)!
  f.mutate = () => f.infos.set(id, { ...info, runCount: 2 })
  assert.equal((await f.coverage.coverage(f.doc, f.window, current, signal)).complete, false)
  f.infos.set(id, { ...info, runCount: 257 })
  assert.equal((await f.coverage.coverage(f.doc, f.window, current, signal)).complete, false)
})

test("only exact positively covered wake preparation is ready; unknown preparation and wrong wake time fail closed", async () => {
  const f = await fixture()
  const calendar = f.doc.calendars[0]
  calendar.wakePreparing = { scheduleID: calendar.scheduleID, run: 1, messageID: `msg_${calendar.scheduleID}_1`, dueAt: at }
  assert.equal((await f.coverage.coverage(f.doc, f.window, current, signal)).complete, true)
  await assert.rejects(f.coverage.verifyWake(f.doc, { missionID: "review", generation: 1, scheduleID: calendar.scheduleID,
    sessionID: calendar.sessionID, run: 1, messageID: `msg_${calendar.scheduleID}_1`, dueAt: at + 1 }, current, signal), /time differs/)
  await assert.rejects(Effect.runPromise(acquireNativeScheduledPassageCoverage(f.native, f.run)), /coverage unavailable/)
})

test("eight principal native ACKs must advance past the frozen cutoff before full coverage is ready", async () => {
  const f = await fixture(8), original = new Map(f.infos)
  for (const calendar of f.doc.calendars.slice(1)) {
    calendar.wakePreparing = null
    const info = original.get(calendar.scheduleID)!
    f.infos.set(info.id, { ...info, runCount: 0, nextDueAt: info.time.created })
  }
  const before = structuredClone(f.doc)
  assert.equal((await f.coverage.coverage(f.doc, f.window, current, signal)).complete, false)
  assert.deepEqual(f.doc, before)
  for (const [id, info] of original) f.infos.set(id, { ...info, runCount: id === f.doc.calendars[0].scheduleID ? 1 : 0 })
  const covered = await f.coverage.coverage(f.doc, f.window, current, signal)
  assert.equal(covered.complete, true); assert.equal(covered.wakes.length, 1)
  assert.deepEqual(f.doc, before)
})

test("a code run is covered by its admission alone, while its program runs and once OpenCode counts it", async () => {
  const f = await fixture(2), [running, idle] = f.doc.calendars
  for (const calendar of f.doc.calendars) {
    const info = f.infos.get(calendar.scheduleID)!
    f.infos.set(info.id, { ...info, action: { type: "code", code: MISSION_WAKE_CODE }, runCount: 0,
      nextDueAt: calendar === running ? info.time.created : info.nextDueAt })
    calendar.wakePreparing = null
  }
  assert.equal((await f.coverage.coverage(f.doc, f.window, current, signal)).complete, false, "a due run Missions has not admitted")
  running.wakePreparing = { scheduleID: running.scheduleID, run: 1, messageID: `msg_${running.scheduleID}_1`, dueAt: at }
  let covered = await f.coverage.coverage(f.doc, f.window, current, signal)
  assert.equal(covered.complete, true); assert.deepEqual(covered.wakes, [running.wakePreparing])
  const wake = { missionID: "review", generation: 1, scheduleID: running.scheduleID, sessionID: running.sessionID, run: 1, messageID: `msg_${running.scheduleID}_1` }
  assert.deepEqual((await f.coverage.verifyWake(f.doc, wake, current, signal)).wake, running.wakePreparing)
  const info = f.infos.get(running.scheduleID)!
  f.infos.set(info.id, { ...info, runCount: 1, nextDueAt: f.infos.get(idle.scheduleID)!.nextDueAt })
  covered = await f.coverage.coverage(f.doc, f.window, current, signal)
  assert.equal(covered.complete, true); assert.deepEqual(covered.wakes, [running.wakePreparing])
  f.infos.set(info.id, { ...info, runCount: 2 })
  await assert.rejects(f.coverage.coverage(f.doc, f.window, current, signal), /wake proof unavailable/, "a run counted without admission")
  running.wakePreparing = null
  f.infos.set(info.id, { ...info, runCount: 1 })
  await assert.rejects(f.coverage.verifyWake(f.doc, wake, current, signal), /wake proof unavailable/)
})

test("model-less carriers cover Code Mode rows and refuse legacy prompt rows", async () => {
  const f = await fixture(1, null), calendar = f.doc.calendars[0], info = f.infos.get(calendar.scheduleID)!
  f.infos.set(info.id, { ...info, action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL,
    to: { session: info.sessionID! } } })
  const before = structuredClone(f.doc)
  await assert.rejects(f.coverage.coverage(f.doc, f.window, current, signal), /schedule-calendar-requires-code/)
  await assert.rejects(f.coverage.verifyWake(f.doc, { missionID: f.doc.id, generation: 1, scheduleID: calendar.scheduleID,
    sessionID: calendar.sessionID, run: 1, messageID: `msg_${calendar.scheduleID}_1` }, current, signal), /schedule-calendar-requires-code/)
  assert.deepEqual(f.doc, before)
  f.infos.set(info.id, { ...info, action: { type: "code", code: MISSION_WAKE_CODE }, runCount: 0, nextDueAt: info.time.created })
  calendar.wakePreparing = { scheduleID: calendar.scheduleID, run: 1, messageID: `msg_${calendar.scheduleID}_1`, dueAt: at }
  const covered = await f.coverage.coverage(f.doc, f.window, current, signal)
  assert.equal(covered.complete, true); assert.deepEqual(covered.wakes, [calendar.wakePreparing])
})
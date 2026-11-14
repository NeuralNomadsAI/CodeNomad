import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect, Schema } from "effect"
import { Schedule } from "@opencode/schema/schedule"
import { SessionMessage } from "@opencode/schema/session-message"
import type { MissionDocument, MissionCalendar } from "../../missions/mission-document"
import type { MissionCalendarOwnerSlot } from "../../missions/mission-calendar-owner-state"
import { acquireNativeScheduledPassageCoverage } from "./native-scheduled-passage-coverage"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import type { MissionNativeService } from "./native-service-adapter"

const current = () => true as const, at = 1000, signal = new AbortController().signal
async function fixture(count = 2) {
  let enabled = true, effectCalls = 0, mutate: (() => void) | undefined
  const infos = new Map<string, Schedule.Info>(), messages = new Map<string, typeof SessionMessage.Info.Type>()
  const calendars: MissionCalendar[] = Array.from({ length: count }, (_, slot) => ({ role: "principal", slot, timeGeneration: 1,
    sessionID: `ses_carrier_${slot}`, scheduleID: `sch_calendar_${slot}`, highWater: 0, pendingWake: null, wakePreparing: null }))
  const descriptors: MissionCalendarOwnerSlot[] = calendars.map(calendar => ({ ...calendar, creation: "adopted", ambiguous: [],
    name: `Owned calendar ${calendar.slot}`, when: { type: "every", every: "15 minutes", tz: "UTC" }, endsAt: null }))
  const doc = { id: "review", projectID: "project", timeGeneration: 1, calendars,
    calendarOwner: { slots: descriptors } } as unknown as MissionDocument
  for (const descriptor of descriptors) {
    infos.set(descriptor.scheduleID!, Schema.decodeUnknownSync(Schedule.Info)({ id: descriptor.scheduleID, sessionID: descriptor.sessionID,
      name: descriptor.name, when: descriptor.when, tz: "UTC", action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL },
      status: "active", nextDueAt: at + 900_000, runCount: 1, time: { created: at, updated: at } }))
    messages.set(`msg_${descriptor.scheduleID}_1`, Schema.decodeUnknownSync(SessionMessage.Info)({ type: "user",
      id: `msg_${descriptor.scheduleID}_1`, text: NATIVE_SCHEDULE_CARRIER_SIGNAL, time: { created: at },
      metadata: { schedule: { id: descriptor.scheduleID, run: 1, dueAt: at, late: false } } }))
  }
  const native = { location: { directory: "/project" },
    get: async ({ sessionID }: { sessionID: string }) => {
      const calendar = calendars.find(item => item.sessionID === sessionID)!
      return { id: sessionID, projectID: "project", location: { directory: "/project" }, model: NATIVE_SCHEDULE_CARRIER_MODEL,
        metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: { missionID: doc.id, timeGeneration: 1, role: calendar.role, slot: calendar.slot } } }
    },
    message: async ({ messageID }: { messageID: string }) => {
      const callback = mutate; mutate = undefined; callback?.()
      return messages.get(messageID)
    },
  } as unknown as MissionNativeService
  const scheduleTag = Context.Service<never, unknown>("@opencode/Schedule")
  const service = {
    get: (id: string) => Effect.sync(() => { effectCalls++; return infos.get(id) }),
    enabled: () => Effect.suspend(() => Effect.succeed(enabled)),
  }
  const graph = Context.make(scheduleTag, service)
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromiseWith(graph)(effect)
  const coverage = await run(acquireNativeScheduledPassageCoverage(native, run))
  const window = { incarnation: "process_one", cutoff: at, timeGeneration: 1,
    principalIDs: calendars.map(item => item.scheduleID).sort(), completed: false, suppress: false }
  return { doc, window, infos, messages, coverage, native, graph, run, calls: () => effectCalls,
    set enabled(value: boolean) { enabled = value }, set mutate(value: (() => void) | undefined) { mutate = value } }
}

test("all eight principals need exact messages and a future/done native barrier; stable coverage rechecks every principal", async () => {
  const f = await fixture(8)
  const result = await f.coverage.coverage(f.doc, f.window, current, signal)
  assert.equal(result.complete, true); assert.equal(result.wakes.length, 8); assert.equal(f.calls(), 16)
  assert.equal(result.current(), true)
  const first = f.doc.calendars[0]
  const verified = await f.coverage.verifyWake(f.doc, { missionID: "review", generation: 1, scheduleID: first.scheduleID,
    sessionID: first.sessionID, run: 1, messageID: `msg_${first.scheduleID}_1` }, current, signal)
  assert.equal(verified.wake.dueAt, at)
})

test("OFF, missing message, partial principal inventory and old due barrier all refuse fan-in", async () => {
  const f = await fixture()
  f.enabled = false
  await assert.rejects(f.coverage.coverage(f.doc, f.window, current, signal), /disabled/)
  f.enabled = true
  assert.equal((await f.coverage.coverage(f.doc, { ...f.window, principalIDs: [f.window.principalIDs[0]] }, current, signal)).complete, false)
  const key = `msg_${f.doc.calendars[1].scheduleID}_1`, original = f.messages.get(key)!
  f.messages.delete(key)
  await assert.rejects(f.coverage.coverage(f.doc, f.window, current, signal), /wake proof unavailable/)
  f.messages.set(key, original)
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

test("only exact positively covered wake preparation is ready; unknown preparation and wrong message time fail closed", async () => {
  const f = await fixture()
  const calendar = f.doc.calendars[0]
  calendar.wakePreparing = { scheduleID: calendar.scheduleID, run: 1, messageID: `msg_${calendar.scheduleID}_1`, dueAt: at }
  assert.equal((await f.coverage.coverage(f.doc, f.window, current, signal)).complete, true)
  calendar.wakePreparing.dueAt++
  assert.equal((await f.coverage.coverage(f.doc, f.window, current, signal)).complete, false)
  calendar.wakePreparing = null
  await assert.rejects(f.coverage.verifyWake(f.doc, { missionID: "review", generation: 1, scheduleID: calendar.scheduleID,
    sessionID: calendar.sessionID, run: 1, messageID: `msg_${calendar.scheduleID}_1`, dueAt: at + 1 }, current, signal), /time differs/)
  await assert.rejects(Effect.runPromise(acquireNativeScheduledPassageCoverage(f.native, f.run)), /coverage unavailable/)
})

test("eight principal native ACKs must advance past the frozen cutoff before full coverage is ready", async () => {
  const f = await fixture(8), original = new Map(f.infos)
  for (const calendar of f.doc.calendars.slice(1)) {
    const info = original.get(calendar.scheduleID)!
    f.infos.set(info.id, { ...info, runCount: 0, nextDueAt: info.time.created })
  }
  const before = structuredClone(f.doc)
  assert.equal((await f.coverage.coverage(f.doc, f.window, current, signal)).complete, false)
  assert.deepEqual(f.doc, before)
  for (const [id, info] of original) f.infos.set(id, info)
  const covered = await f.coverage.coverage(f.doc, f.window, current, signal)
  assert.equal(covered.complete, true); assert.equal(covered.wakes.length, 8)
  assert.deepEqual(f.doc, before)
})

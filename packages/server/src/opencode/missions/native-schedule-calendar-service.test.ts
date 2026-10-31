import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { Location } from "@opencode/schema/location"
import { Schedule } from "@opencode/schema/schedule"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Plugin } from "@opencode/plugin/effect"
import { acquireNativeScheduleCalendarService } from "./native-schedule-calendar-service"
import type { NativeScheduleCalendarTarget } from "./native-schedule-calendar-service"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"

async function facade(t: test.TestContext, availability: (state: { enabled: boolean; closed: boolean }) => Effect.Effect<void>) {
  const state: { enabled: boolean; closed: boolean; row?: string; runCount?: number } = { enabled: true, closed: false }, created: any[] = []
  const directory = path.resolve("native-calendar-scope-unit-only")
  const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory, canonical: directory } })
  const selected: NativeScheduleCalendarTarget = { missionID: "calendar_scope", descriptor: { role: "principal", slot: 0, timeGeneration: 1,
    sessionID: `ses_cn_schedule_${"a".repeat(40)}`, name: "cm_scope", when: { type: "every", every: "900000 millis", tz: "UTC" }, endsAt: null,
    creation: "attempted", scheduleID: null, ambiguous: [], anchorAt: 1 } }
  const info = (input: any) => Schema.decodeUnknownSync(Schedule.Info)({ id: "sch_scope", sessionID: input.sessionID, name: input.name,
    when: input.when, tz: "UTC", action: input.action, status: "active", runCount: input.runCount ?? 0, time: { created: 1, updated: 1 } })
  const schedules = { create: (input: unknown) => Effect.sync(() => { created.push(structuredClone(input)); return info(input) }),
    list: () => Effect.succeed([]), get: () => state.runCount === undefined ? Effect.fail({ _tag: "Schedule.NotFoundError" }) : Effect.succeed(info({
      sessionID: selected.descriptor.sessionID, name: selected.descriptor.name, when: selected.descriptor.when,
      action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL }, runCount: state.runCount })), pause: () => Effect.die("unexpected pause"),
    resume: () => Effect.die("unexpected resume"), remove: () => Effect.void, enabled: () => Effect.succeed(state.enabled) }
  const carrierID = selected.descriptor.sessionID
  const ctx = { location, session: { get: () => Effect.succeed({ id: carrierID, projectID: "project", location: { directory },
    model: { ...NATIVE_SCHEDULE_CARRIER_MODEL }, metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: {
      missionID: "calendar_scope", timeGeneration: 1, role: "principal", slot: 0 } } }) } } as unknown as Plugin.Context
  const scope = await Effect.runPromise(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const native = await Effect.runPromise(acquireNativeScheduleCalendarService(ctx, "build", () => true, undefined, () => availability(state)).pipe(
    Effect.provideService(Context.Service<never, unknown>("@opencode/Schedule"), schedules),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Location"), location),
    Effect.provideService(Context.Service<never, unknown>("@opencode/LocationLifecycle"), { isClosed: () => state.closed }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Config"), { entries: () => Effect.succeed([{ type: "document", info: { experimental: { schedules: state.enabled } } }]) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Session"), { remove: () => Effect.void, active: Effect.succeed(new Set()) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/storage/Database"), { db: { $client: { unsafe: () => ({ withoutTransform: Effect.sync(() => state.row === undefined ? [] : [{ data: state.row }]) }) } } }),
    Effect.provideService(Scope.Scope, scope)))
  return { native, selected, state, created, scope }
}

test("native facade pins caller descriptors across asynchronous provider checks and retires with its Scope", async t => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const f = await facade(t, () => Effect.promise(async () => { enter(); await gate }))
  const original = structuredClone(f.selected), result = f.native.create(f.selected, () => true)
  await entered
  f.selected.descriptor.sessionID = "ses_foreign"; f.selected.descriptor.when = { type: "every", every: "1800000 millis", tz: "UTC" }
  release(); await result
  assert.equal(f.created[0].sessionID, original.descriptor.sessionID)
  assert.deepEqual(f.created[0].when, original.descriptor.when)
  await Effect.runPromise(Scope.close(f.scope, Exit.void))
  await assert.rejects(f.native.create(original, () => true), /Location retired/)
  assert.equal(f.created.length, 1)
})

test("provider async completion cannot bypass a new effective OFF or a closed Location graph", async t => {
  const f = await facade(t, state => Effect.sync(() => { state.enabled = false }))
  await assert.rejects(f.native.create(f.selected, () => true), /schedules disabled/)
  assert.equal(f.created.length, 0)
  f.state.enabled = true; f.state.closed = true
  await assert.rejects(f.native.create(f.selected, () => true), /Location retired/)
  assert.equal(f.created.length, 0)
})

test("prepared wake ACK decodes encoded native SQL timestamps and keeps partial or absent proof closed", async t => {
  const f = await facade(t, () => Effect.void)
  const wake = { scheduleID: "sch_scope", run: 1, messageID: "msg_sch_scope_1", dueAt: 1 }
  f.state.runCount = 1
  const native = Schema.decodeUnknownSync(SessionMessage.User)({ id: wake.messageID, type: "user", text: NATIVE_SCHEDULE_CARRIER_SIGNAL,
    metadata: { schedule: { id: wake.scheduleID, run: 1, dueAt: 1, late: false } }, time: { created: 1 } })
  const encoded = Schema.encodeSync(SessionMessage.User)(native)
  f.state.row = JSON.stringify(encoded)
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), true)
  f.state.row = JSON.stringify({ ...encoded, metadata: { schedule: { id: wake.scheduleID, run: 1, dueAt: 1 } } })
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), false)
  f.state.row = JSON.stringify(encoded); f.state.runCount = 0
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), false)
  f.state.runCount = 1; f.state.row = undefined
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), false)
})

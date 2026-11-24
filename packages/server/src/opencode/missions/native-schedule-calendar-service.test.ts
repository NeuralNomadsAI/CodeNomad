import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { Location } from "@opencode/schema/location"
import { Automation } from "@opencode/schema/automation"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Plugin } from "@opencode/plugin/effect"
import { acquireNativeScheduleCalendarService } from "./native-schedule-calendar-service"
import type { NativeScheduleCalendarTarget } from "./native-schedule-calendar-service"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import { matchMissionAutomation, MISSION_WAKE_CODE, MISSION_WAKE_PERMISSIONS, runningMissionCodeWake } from "./native-mission-automation"

async function facade(t: test.TestContext, availability: (state: { enabled: boolean; closed: boolean }) => Effect.Effect<void, unknown>,
  options: { model?: { providerID: string; id: string }; onSessionGet?: (state: { enabled: boolean; closed: boolean }) => Effect.Effect<void> } = { model: { ...NATIVE_SCHEDULE_CARRIER_MODEL } }) {
  const state: { enabled: boolean; closed: boolean; row?: string; duplicate?: boolean; runCount?: number; action?: Automation.Info["action"]
    status?: Automation.Info["status"]; permissions?: unknown[]; present?: boolean; model?: { providerID: string; id: string } } = {
    enabled: true, closed: false, present: true, model: options.model }, created: any[] = [], createdSessions: any[] = []
  const directory = path.resolve("native-calendar-scope-unit-only")
  const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory, canonical: directory } })
  const selected: NativeScheduleCalendarTarget = { missionID: "calendar_scope", descriptor: { role: "principal", slot: 0, timeGeneration: 1,
    sessionID: `ses_cn_schedule_${"a".repeat(40)}`, name: "cm_scope", when: { type: "every", every: "900000 millis", tz: "UTC" }, endsAt: null,
    creation: "attempted", scheduleID: null, ambiguous: [], anchorAt: 1 } }
  const info = (input: any) => Schema.decodeUnknownSync(Automation.Info)({ id: "aut_scope", sessionID: input.sessionID, name: input.name,
    directory, projectID: "project", trigger: input.trigger ?? input.when, tz: "UTC",
    action: state.action ?? { ...input.action, to: { session: input.sessionID } },
    status: state.status ?? "active", runCount: input.runCount ?? 0, time: { created: 1, updated: 1 } })
  const schedules = { create: (input: unknown) => Effect.sync(() => { created.push(structuredClone(input)); return info(input) }),
    list: () => Effect.succeed(state.runCount === undefined ? [] : [info({ sessionID: selected.descriptor.sessionID, name: selected.descriptor.name,
      when: selected.descriptor.when, action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL }, runCount: state.runCount })]),
    get: () => state.runCount === undefined ? Effect.fail({ _tag: "Automation.NotFoundError" }) : Effect.succeed(info({
      sessionID: selected.descriptor.sessionID, name: selected.descriptor.name, when: selected.descriptor.when,
      action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL }, runCount: state.runCount })), pause: () => Effect.die("unexpected pause"),
    resume: () => Effect.succeed(info({ sessionID: selected.descriptor.sessionID, name: selected.descriptor.name,
      when: selected.descriptor.when, action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL }, runCount: state.runCount ?? 0 })),
    remove: () => Effect.void, enabled: () => Effect.succeed(state.enabled) }
  const carrierID = selected.descriptor.sessionID
  const ctx = { location, session: {
    get: () => Effect.gen(function* () {
      if (options.onSessionGet) yield* options.onSessionGet(state)
      if (!state.present) return yield* Effect.fail({ _tag: "Session.NotFoundError" })
      return { id: carrierID, projectID: "project", location: { directory },
        ...(state.model ? { model: { ...state.model } } : {}),
        permissions: structuredClone(state.permissions), metadata: { [NATIVE_SCHEDULE_CARRIER_MARKER]: {
          missionID: "calendar_scope", timeGeneration: 1, role: "principal", slot: 0 } } }
    }),
    create: (input: any) => Effect.sync(() => {
      createdSessions.push(structuredClone(input))
      state.present = true; state.model = input.model; state.permissions = structuredClone(input.permissions)
    }),
    update: (input: { permissions: unknown[] }) => Effect.sync(() => { state.permissions = structuredClone(input.permissions) }) } } as unknown as Plugin.Context
  const scope = await Effect.runPromise(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const native = await Effect.runPromise(acquireNativeScheduleCalendarService(ctx, "build", () => true, undefined, () => availability(state)).pipe(
    Effect.provideService(Context.Service<never, unknown>("@opencode/Automation"), schedules),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Location"), location),
    Effect.provideService(Context.Service<never, unknown>("@opencode/LocationLifecycle"), { isClosed: () => state.closed }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Config"), { entries: () => Effect.succeed([{ type: "document", info: { experimental: { schedules: state.enabled } } }]) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Flag"), { resolve: () => ({ automations: { enabled: state.enabled, source: "config" } }) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Session"), { remove: () => Effect.void, active: Effect.succeed(new Set()) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/storage/Database"), { db: { $client: { unsafe: () => ({
      withoutTransform: Effect.sync(() => state.row === undefined ? [] : [{ id: JSON.parse(state.row).id, type: "user", data: state.row },
        ...(state.duplicate ? [{ id: "msg_sch_scope_1", type: "user", data: null }] : [])]),
    }) } } }),
    Effect.provideService(Scope.Scope, scope)))
  return { native, selected, state, created, createdSessions, scope }
}

test("native facade pins caller descriptors across asynchronous carrier checks and retires with its Scope", async t => {
  let enter!: () => void, release!: () => void, calls = 0
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const f = await facade(t, () => Effect.die("code create never needs local provider"), {
    onSessionGet: () => ++calls === 1 ? Effect.promise(async () => { enter(); await gate }) : Effect.void,
  })
  const original = structuredClone(f.selected), result = f.native.create(f.selected, () => true)
  await entered
  f.selected.descriptor.sessionID = "ses_foreign"; f.selected.descriptor.when = { type: "every", every: "1800000 millis", tz: "UTC" }
  release(); await result
  assert.equal(f.created[0].sessionID, original.descriptor.sessionID)
  assert.deepEqual(f.created[0].trigger, original.descriptor.when)
  await Effect.runPromise(Scope.close(f.scope, Exit.void))
  await assert.rejects(f.native.create(original, () => true), /Location retired/)
  assert.equal(f.created.length, 1)
})

test("legacy prompt resume checks provider availability and cannot bypass a new effective OFF or closed Location graph", async t => {
  const f = await facade(t, state => Effect.sync(() => { state.enabled = false }))
  f.state.runCount = 0; f.state.status = "paused"
  await assert.rejects(f.native.resume(f.selected, "sch_scope", () => true), /schedules disabled/)
  f.state.enabled = true; f.state.closed = true
  await assert.rejects(f.native.resume(f.selected, "sch_scope", () => true), /Location retired/)
})

test("Code Mode carriers carry no model and work without local provider, while foreign models and prompt rows on them fail closed", async t => {
  const f = await facade(t, () => Effect.fail(new Error("schedule-provider-unavailable")), { model: undefined })
  const current = () => true as const
  f.state.present = false
  await f.native.ensureCarrier(f.selected, current)
  assert.equal(f.createdSessions.length, 1)
  assert.equal("model" in f.createdSessions[0], false)
  assert.deepEqual(f.createdSessions[0].permissions, MISSION_WAKE_PERMISSIONS)
  await f.native.create(f.selected, current)
  f.state.runCount = 0; f.state.action = { type: "code", code: MISSION_WAKE_CODE }; f.state.status = "paused"
  assert.equal((await f.native.list(f.selected, current))[0].code, true)
  assert.equal((await f.native.resume(f.selected, "sch_scope", current)).code, true)
  f.state.action = { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL, to: { session: Session.ID.make(f.selected.descriptor.sessionID) } }
  await assert.rejects(f.native.list(f.selected, current), /carrier differs/)
  await assert.rejects(f.native.get(f.selected, "sch_scope", current), /carrier differs/)
  f.state.action = { type: "code", code: MISSION_WAKE_CODE }
  f.state.model = { providerID: "remote", id: "paid" }
  await assert.rejects(f.native.list(f.selected, current), /carrier differs/)
  f.state.model = { ...NATIVE_SCHEDULE_CARRIER_MODEL }
  f.state.action = { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL, to: { session: Session.ID.make(f.selected.descriptor.sessionID) } }
  await assert.rejects(f.native.resume(f.selected, "sch_scope", current), /schedule-provider-unavailable/)
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
  f.state.row = JSON.stringify({ ...encoded, id: "msg_aut_scope_1",
    metadata: { automation: { id: "aut_scope", run: 1, dueAt: 1, late: false } } })
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), true)
  f.state.duplicate = true
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), false, "an oversized conflicting legacy row still counts")
  f.state.duplicate = false
  f.state.row = JSON.stringify({ ...encoded, metadata: { schedule: { id: wake.scheduleID, run: 1, dueAt: 1 } } })
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), false)
  f.state.row = JSON.stringify(encoded); f.state.runCount = 0
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), false)
  f.state.runCount = 1; f.state.row = undefined
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), false)
})

test("migrated calendars accept only the equivalent Windows directory spelling", async t => {
  const { selected } = await facade(t, () => Effect.void)
  const slot = { ...selected.descriptor, creation: "adopted" as const, scheduleID: "sch_scope" }
  const info = Schema.decodeUnknownSync(Automation.Info)({ id: "aut_scope", sessionID: slot.sessionID,
    name: slot.name, projectID: "project", directory: "D:/work/demo", trigger: slot.when, tz: "UTC",
    action: { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL, to: { session: slot.sessionID } },
    status: "active", runCount: 1, time: { created: 1, updated: 1 } })
  const match = (directory: string, projectID = "project") =>
    matchMissionAutomation(info, slot, { directory, projectID }, NATIVE_SCHEDULE_CARRIER_SIGNAL)
  assert.equal(match("D:\\work\\demo"), true)
  assert.equal(match("D:\\work\\different"), false)
  assert.equal(match("D:\\work\\demo", "other"), false)
  assert.equal(matchMissionAutomation({ ...info, directory: "/work/one\\two" }, slot,
    { directory: "/work/one/two", projectID: "project" }, NATIVE_SCHEDULE_CARRIER_SIGNAL), false)
})

for (const action of [{ type: "code", code: "return true" }, { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL, to: { session: "ses_foreign" } }])
  test(`native ${action.type} action for a different target is refused before adoption or effects`, async t => {
    const f = await facade(t, () => Effect.void), current = () => true as const
    f.state.runCount = 0
    assert.equal((await f.native.list(f.selected, current)).length, 1)
    assert.equal((await f.native.get(f.selected, "sch_scope", current))!.id, "sch_scope")
    f.state.action = Schema.decodeUnknownSync(Automation.Action)(action)
    await assert.rejects(f.native.list(f.selected, current), /Info differs/)
    await assert.rejects(f.native.get(f.selected, "sch_scope", current), /Info differs/)
    for (const action of ["pause", "resume", "remove"] as const)
      await assert.rejects(f.native[action](f.selected, "sch_scope", current), /Info differs/)
    await assert.rejects(f.native.create(f.selected, current), /Info differs/)
  })

test("new calendars run the fixed Code Mode wake from a carrier that allows only it", async t => {
  const f = await facade(t, () => Effect.void), current = () => true as const
  await f.native.create(f.selected, current)
  assert.deepEqual(f.created[0].action, { type: "code", code: MISSION_WAKE_CODE })
  assert.deepEqual(f.state.permissions, MISSION_WAKE_PERMISSIONS)
  f.state.runCount = 0; f.state.action = { type: "code", code: MISSION_WAKE_CODE }
  assert.equal((await f.native.list(f.selected, current))[0].code, true)
  f.state.action = { type: "code", code: MISSION_WAKE_CODE, args: { other: true } }
  await assert.rejects(f.native.list(f.selected, current), /Info differs/)
})

test("a carrier with rules of its own never receives the code wake", async t => {
  const f = await facade(t, () => Effect.void)
  f.state.permissions = [{ action: "execute", resource: "*", effect: "deny" }]
  await assert.rejects(f.native.create(f.selected, () => true), /permissions differ/)
  assert.equal(f.created.length, 0)
  assert.deepEqual(f.state.permissions, [{ action: "execute", resource: "*", effect: "deny" }])
})

test("a prepared code wake is acknowledged once counted, or once its row can no longer run it", async t => {
  const f = await facade(t, () => Effect.void), wake = { scheduleID: "aut_scope", run: 1, messageID: "msg_aut_scope_1", dueAt: 1 }
  f.state.action = { type: "code", code: MISSION_WAKE_CODE }; f.state.runCount = 0
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), false, "an active row may still run the program")
  f.state.status = "paused"
  // OpenCode counts a returned program even after a pause.
  await runningMissionCodeWake(wake.scheduleID, wake.run, async () =>
    assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), false, "a program still in flight"))
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), true)
  assert.equal(await f.native.wakeAcknowledged(f.selected, { ...wake, run: 2, messageID: "msg_aut_scope_2" }, () => true), false)
  f.state.status = "active"; f.state.runCount = 1
  assert.equal(await f.native.wakeAcknowledged(f.selected, wake, () => true), true)
})
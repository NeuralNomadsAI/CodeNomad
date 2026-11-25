import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { Location } from "@opencode/schema/location"
import { Automation } from "@opencode/schema/automation"
import { Session } from "@opencode/schema/session"
import type { Plugin } from "@opencode/plugin/effect"
import { acquireNativeScheduleCalendarService } from "./native-schedule-calendar-service"
import type { NativeScheduleCalendarTarget } from "./native-schedule-calendar-service"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { NATIVE_SCHEDULE_CARRIER_MARKER, NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import { matchMissionAutomation, MISSION_WAKE_CODE, MISSION_WAKE_PERMISSIONS, runningMissionCodeWake } from "./native-mission-automation"

async function facade(t: test.TestContext, options: { model?: { providerID: string; id: string };
    onSessionGet?: () => Effect.Effect<void>; onRowGet?: () => void;
    onSchedulesEnabled?: () => Effect.Effect<void> } = { model: { ...NATIVE_SCHEDULE_CARRIER_MODEL } }) {
  const state: { enabled: boolean; closed: boolean; runCount?: number; action?: Automation.Info["action"]
    status?: Automation.Info["status"]; permissions?: unknown[]; present?: boolean; model?: { providerID: string; id: string } } = {
    enabled: true, closed: false, present: true, model: options.model }, created: any[] = [], createdSessions: any[] = [], resumes: string[] = [], pauses: string[] = []
  const directory = path.resolve("native-calendar-scope-unit-only")
  const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory, canonical: directory } })
  const selected: NativeScheduleCalendarTarget = { missionID: "calendar_scope", descriptor: { role: "principal", slot: 0, timeGeneration: 1,
    sessionID: `ses_cn_schedule_${"a".repeat(40)}`, name: "cm_scope", when: { type: "every", every: "900000 millis", tz: "UTC" }, endsAt: null,
    creation: "attempted", scheduleID: null, ambiguous: [], anchorAt: 1 } }
  const info = (input: any) => Schema.decodeUnknownSync(Automation.Info)({ id: "aut_scope", sessionID: input.sessionID, name: input.name,
    directory, projectID: "project", trigger: input.trigger ?? input.when, tz: "UTC",
    action: state.action ?? { ...input.action, to: { session: input.sessionID } },
    status: state.status ?? "active", runCount: input.runCount ?? 0, time: { created: 1, updated: 1 } })
  const prompt = { type: "prompt", prompt: NATIVE_SCHEDULE_CARRIER_SIGNAL }
  const schedules = { create: (input: unknown) => Effect.sync(() => { created.push(structuredClone(input)); return info(input) }),
    list: () => Effect.succeed(state.runCount === undefined ? [] : [info({ sessionID: selected.descriptor.sessionID, name: selected.descriptor.name,
      when: selected.descriptor.when, action: prompt, runCount: state.runCount })]),
    get: () => { options.onRowGet?.(); return state.runCount === undefined ? Effect.fail({ _tag: "Automation.NotFoundError" }) : Effect.succeed(info({
      sessionID: selected.descriptor.sessionID, name: selected.descriptor.name, when: selected.descriptor.when,
      action: prompt, runCount: state.runCount })) },
    pause: (id: string) => Effect.sync(() => { pauses.push(id); state.status = "paused"; return info({ sessionID: selected.descriptor.sessionID,
      name: selected.descriptor.name, when: selected.descriptor.when, action: prompt, runCount: state.runCount ?? 0 }) }),
    resume: (id: string) => Effect.sync(() => { resumes.push(id); state.status = "active"; return info({ sessionID: selected.descriptor.sessionID,
      name: selected.descriptor.name, when: selected.descriptor.when, action: prompt, runCount: state.runCount ?? 0 }) }),
    remove: () => Effect.sync(() => { delete state.runCount }),
    enabled: () => Effect.gen(function* () {
      if (options.onSchedulesEnabled) yield* options.onSchedulesEnabled()
      return state.enabled
    }) }
  const carrierID = selected.descriptor.sessionID
  const ctx = { location, session: {
    get: () => Effect.gen(function* () {
      if (options.onSessionGet) yield* options.onSessionGet()
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
  const native = await Effect.runPromise(acquireNativeScheduleCalendarService(ctx, "build", () => true).pipe(
    Effect.provideService(Context.Service<never, unknown>("@opencode/Automation"), schedules),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Location"), location),
    Effect.provideService(Context.Service<never, unknown>("@opencode/LocationLifecycle"), { isClosed: () => state.closed }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Config"), { entries: () => Effect.succeed([{ type: "document", info: { automations: state.enabled } }]) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Flag"), { resolve: () => ({ part_rows: { enabled: true, source: "default" } }) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/Session"), { remove: () => Effect.void, active: Effect.succeed(new Set()) }),
    Effect.provideService(Context.Service<never, unknown>("@opencode/storage/Database"), { db: { $client: { unsafe: () => ({
      withoutTransform: Effect.succeed([]),
    }) } } }),
    Effect.provideService(Scope.Scope, scope)))
  return { native, selected, state, created, createdSessions, resumes, pauses, scope }
}

test("native facade pins caller descriptors across asynchronous carrier checks and retires with its Scope", async t => {
  let enter!: () => void, release!: () => void, calls = 0
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const f = await facade(t, {
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

test("Code Mode carriers carry no model and work without a provider and reject foreign models", async t => {
  const f = await facade(t, { model: undefined })
  const current = () => true as const
  f.state.present = false
  await f.native.ensureCarrier(f.selected, current)
  assert.equal(f.createdSessions.length, 1)
  assert.equal("model" in f.createdSessions[0], false)
  assert.deepEqual(f.createdSessions[0].permissions, MISSION_WAKE_PERMISSIONS)
  await f.native.create(f.selected, current)
  f.state.runCount = 0; f.state.action = { type: "code", code: MISSION_WAKE_CODE }; f.state.status = "paused"
  assert.equal((await f.native.list(f.selected, current))[0].code, true)
  const resumed = await f.native.resume(f.selected, "sch_scope", current)
  assert.equal(resumed.code, true)
  assert.equal(resumed.status, "active")
  assert.deepEqual(f.resumes, ["aut_scope"])
  f.state.model = { providerID: "remote", id: "paid" }
  await assert.rejects(f.native.list(f.selected, current), /carrier differs/)
})

test("prompt calendar is visible for Pause and Delete but Resume and wake ACK refuse it", async t => {
  const current = () => true as const
  for (const model of [undefined, NATIVE_SCHEDULE_CARRIER_MODEL]) {
    const f = await facade(t, { model })
    f.state.runCount = 0
    assert.equal((await f.native.list(f.selected, current))[0].code, false)
    assert.equal((await f.native.get(f.selected, "sch_scope", current))?.code, false)
    await assert.rejects(f.native.resume(f.selected, "sch_scope", current), /schedule-calendar-requires-code/)
    await assert.rejects(f.native.wakeAcknowledged(f.selected, { scheduleID: "sch_scope", run: 1, dueAt: 1000, messageID: "msg_sch_scope_1" }, current), /schedule-calendar-requires-code/)
    assert.deepEqual(f.resumes, [])
    assert.equal((await f.native.pause(f.selected, "sch_scope", current)).status, "paused")
    await f.native.remove(f.selected, "sch_scope", current)
    assert.equal(await f.native.get(f.selected, "sch_scope", current), undefined)
  }
})

test("Get and mutations observe the carrier and row together after earlier waits", { timeout: 3000 }, async t => {
  for (const action of ["get", "resume", "pause"] as const) {
    let switched!: () => void
    const gate = new Promise<void>(resolve => { switched = resolve })
    const f = await facade(t, {
      onSessionGet: () => Effect.promise(() => gate),
      onRowGet: () => { f.state.model = { providerID: "foreign", id: "paid" }; switched() },
    })
    f.state.runCount = 0; f.state.action = { type: "code", code: MISSION_WAKE_CODE }
    await assert.rejects(f.native[action](f.selected, "sch_scope", () => true), /carrier differs/)
    assert.deepEqual([...f.resumes, ...f.pauses], [])
  }
})

test("Code Mode calendar create validates ownership, model and permissions on the same fresh session read", async t => {
  const current = () => true as const
  let reads = 0
  const f = await facade(t, {
    model: undefined,
    onSessionGet: () => Effect.sync(() => { if (++reads === 2) f.state.model = { providerID: "remote", id: "paid" } }),
  })
  await assert.rejects(f.native.create(f.selected, current), /carrier differs/)
  assert.deepEqual(f.created, [])

  const foreign = await facade(t, { model: { providerID: "remote", id: "paid" } })
  foreign.state.permissions = MISSION_WAKE_PERMISSIONS.map(rule => ({ ...rule }))
  await assert.rejects(foreign.native.create(foreign.selected, current), /carrier differs/)
  assert.deepEqual(foreign.created, [])

  // OFF landing during the first carrier read is seen by the final read before the native create.
  const offDuringSession = await facade(t, {
    model: undefined,
    onSessionGet: () => Effect.sync(() => { offDuringSession.state.enabled = false }),
  })
  await assert.rejects(offDuringSession.native.create(offDuringSession.selected, current), /schedules disabled/)
  assert.deepEqual(offDuringSession.created, [])
})

test("migrated calendars accept only the equivalent Windows directory spelling", async t => {
  const { selected } = await facade(t)
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
    const f = await facade(t), current = () => true as const
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
  const f = await facade(t), current = () => true as const
  await f.native.create(f.selected, current)
  assert.deepEqual(f.created[0].action, { type: "code", code: MISSION_WAKE_CODE })
  assert.deepEqual(f.state.permissions, MISSION_WAKE_PERMISSIONS)
  f.state.runCount = 0; f.state.action = { type: "code", code: MISSION_WAKE_CODE }
  assert.equal((await f.native.list(f.selected, current))[0].code, true)
  f.state.action = { type: "code", code: MISSION_WAKE_CODE, args: { other: true } }
  await assert.rejects(f.native.list(f.selected, current), /Info differs/)
})

test("a carrier with rules of its own never receives the code wake", async t => {
  const f = await facade(t)
  f.state.permissions = [{ action: "execute", resource: "*", effect: "deny" }]
  await assert.rejects(f.native.create(f.selected, () => true), /permissions differ/)
  assert.equal(f.created.length, 0)
  assert.deepEqual(f.state.permissions, [{ action: "execute", resource: "*", effect: "deny" }])
})

test("a prepared code wake is acknowledged once counted, or once its row can no longer run it", async t => {
  const f = await facade(t), wake = { scheduleID: "aut_scope", run: 1, messageID: "msg_aut_scope_1", dueAt: 1 }
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

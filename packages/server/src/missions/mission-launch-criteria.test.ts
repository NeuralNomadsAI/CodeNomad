import assert from "node:assert/strict"
import test from "node:test"
import { MissionDocumentPassageEngine, type DocumentPassagePorts, type DocumentPassageWake } from "./mission-document-passage-engine"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "./mission-document-store"
import { missionDocumentChanges as changes, missionTemporalPolicy } from "./mission-document-state"
import { missionCalendarPlans } from "./mission-calendar-plan"
import { missionSourceKey, type MissionCalendar, type MissionDocument, type MissionWake } from "./mission-document"
import { missionConfigurationSchema, missionLaunchLimit, missionLaunchModel, missionLaunchPolicySchema, missionPrincipalCount,
  missionSlotEndsAt, requiresMissionCalendar, type MissionConfiguration, type MissionLaunchPolicy } from "./launch-policy"
import type { MissionJsonValue } from "./model"
import { ownerFixture } from "../opencode/missions/native-schedule-owner-test-fixture"
import Ajv from "ajv"
import { missionScheduleRpcMethods } from "./mission-schedule-contract"
import { missionScheduleView } from "./mission-schedule-view"

const current = () => true as const, start = Date.parse("2026-10-01T00:00:00Z")
const daily = { kind: "cron" as const, expression: "0 9 * * *", zone: "Europe/Paris" }
const evening = { kind: "cron" as const, expression: "0 18 * * *", zone: "Europe/Paris" }
const commits = { kind: "branch-commits" as const, directory: "/project", ref: "refs/heads/main" }
const files = { kind: "files-changed" as const, paths: ["src/b.ts", "src/a.ts"] }
const legacyEnds = { maxLaunches: null, afterMs: null, at: null }
const selection = { agent: "worker", model: { providerID: "unit", id: "model" } }
const configuration = (launch: MissionLaunchPolicy): MissionConfiguration => ({ title: "Criteria", objective: "Do useful work", template: "custom",
  taskMode: "native", profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory: "/project" }],
  watchedConversationIDs: [], profiles: { coordinator: selection, roles: { specialist: selection } }, launch })

test("criteria codec: triggers OR, conditions need a trigger, bounded principals and unique events across roles", () => {
  const parsed = missionLaunchPolicySchema.parse({ when: [daily, files], onlyIf: [] })
  assert.ok("when" in parsed)
  assert.deepEqual(parsed.when[1], { kind: "files-changed", paths: ["src/a.ts", "src/b.ts"] })
  assert.equal(missionPrincipalCount(parsed), 2, "one schedule plus the internal event check")
  assert.equal(missionPrincipalCount({ when: [daily], onlyIf: [files] }), 1, "conditions need no check of their own")
  assert.equal(missionPrincipalCount({ when: [daily, commits], onlyIf: [files] }), 2)
  for (const invalid of [
    { when: [], onlyIf: [files] },
    { when: [daily], onlyIf: [daily] },
    { when: [commits], onlyIf: [commits] },
    { when: [daily, daily], onlyIf: [] },
    { when: [commits, commits], onlyIf: [] },
    { when: [...Array.from({ length: 8 }, (_, hour) => ({ ...daily, expression: `0 ${hour} * * *` })), files], onlyIf: [] },
    { when: [{ ...daily, expression: "* * * * * *" }], onlyIf: [] },
    { when: [daily], onlyIf: [], until: null },
    { when: [daily], onlyWithNews: false, until: null },
    { when: [{ kind: "every", intervalMs: 900_000 }], onlyIf: [] },
  ]) assert.equal(missionLaunchPolicySchema.safeParse(invalid).success, false, JSON.stringify(invalid))
  assert.ok(missionLaunchPolicySchema.safeParse({ when: Array.from({ length: 8 }, (_, hour) => ({ ...daily, expression: `0 ${hour} * * *` })),
    onlyIf: [files] }).success, "eight schedules fit with conditions only")
  const empty = { when: [], onlyIf: [] }
  assert.equal(requiresMissionCalendar(empty), false); assert.equal(missionLaunchLimit(empty), 1)
  assert.equal(missionLaunchLimit({ when: [files], onlyIf: [] }), null, "events repeat")
  assert.equal(missionSlotEndsAt({ when: [daily], onlyIf: [] }, start), null, "criteria have no end date")
})

test("stored legacy policies keep their bytes and read as criteria with their former timing and limits", () => {
  const cases: { legacy: MissionLaunchPolicy; schedules: string[]; triggers: number; conditions: number; limit: number | null; principals: number }[] = [
    { legacy: { timing: { kind: "immediate" }, condition: null, ends: legacyEnds }, schedules: [], triggers: 0, conditions: 0, limit: 1, principals: 0 },
    { legacy: { timing: { kind: "immediate" }, condition: files, ends: legacyEnds }, schedules: [], triggers: 1, conditions: 0, limit: 1, principals: 1 },
    { legacy: { timing: daily, condition: commits, ends: { ...legacyEnds, maxLaunches: 4 } }, schedules: ["cron"], triggers: 0, conditions: 1, limit: 4, principals: 1 },
    { legacy: { timing: { kind: "every", intervalMs: 5_400_000 }, condition: null, ends: legacyEnds }, schedules: ["every"], triggers: 0, conditions: 0, limit: null, principals: 1 },
    { legacy: { timing: { kind: "at", at: start + 60_000, zone: "UTC" }, condition: files, ends: legacyEnds }, schedules: ["at"], triggers: 0, conditions: 1, limit: 1, principals: 1 },
    { legacy: { timing: { kind: "in", delayMs: 60_000 }, condition: null, ends: legacyEnds }, schedules: ["in"], triggers: 0, conditions: 0, limit: 1, principals: 1 },
    { legacy: { timing: { kind: "multi", calendars: [{ expression: "0 9 * * *", zone: "UTC" }, { expression: "0 18 * * *", zone: "UTC" }] },
      condition: null, ends: { ...legacyEnds, afterMs: 3_600_000 } }, schedules: ["cron", "cron"], triggers: 0, conditions: 0, limit: null, principals: 2 },
  ]
  for (const item of cases) {
    const stored = JSON.parse(JSON.stringify(item.legacy))
    const parsed = missionLaunchPolicySchema.parse(stored)
    assert.deepEqual(parsed, missionLaunchPolicySchema.parse(JSON.parse(JSON.stringify(parsed))), "no shape rewrite on read")
    assert.ok("timing" in parsed, "legacy bytes remain legacy")
    const model = missionLaunchModel(parsed)
    assert.deepEqual(model.schedules.map(schedule => schedule.kind), item.schedules)
    assert.equal(model.triggers.length, item.triggers); assert.equal(model.conditions.length, item.conditions)
    assert.equal(missionLaunchLimit(parsed), item.limit); assert.equal(missionPrincipalCount(parsed), item.principals)
  }
  assert.equal(missionSlotEndsAt(cases.at(-1)!.legacy, start), start + 3_600_000, "relative end keeps its first-Play origin")
})

async function fixture(launch: MissionLaunchPolicy) {
  const values = new Map<string, MissionJsonValue>()
  let now = start + 1000, admitted = 0, triggers = false, conditions = false, terminal = false, failed = false
  const storage: MissionDocumentStorage = { get: async key => structuredClone(values.get(key)),
    compareAndSet: async (key, value, revision, guard) => {
      guard(); assert.equal((values.get(key) as { revision: number } | undefined)?.revision ?? null, revision); values.set(key, structuredClone(value))
    } }
  const store = new NativeMissionDocumentStore(storage, "project", "/project")
  const events = missionLaunchModel(missionLaunchPolicySchema.parse(launch)).events
  const checkpoints = () => events.map(condition => ({ key: missionSourceKey(condition), kind: condition.kind, placementDigest: "b".repeat(64), value: { now } }))
  let doc = await store.create("criteria", configuration(launch), start, current)
  doc = await store.change(doc.id, doc.revision, current, next => changes.play(next, "first_play", start, checkpoints()))
  const calendars: MissionCalendar[] = [...Array.from({ length: missionPrincipalCount(launch) }, (_, slot): MissionCalendar => ({ role: "principal", slot,
    timeGeneration: 1, scheduleID: `sch_principal_${slot}`, sessionID: `ses_principal_${slot}`, highWater: 0, pendingWake: null, wakePreparing: null })),
  { role: "reconciliation", slot: 0, timeGeneration: 1, scheduleID: "sch_auxiliary", sessionID: "ses_auxiliary", highWater: 0, pendingWake: null, wakePreparing: null }]
  await store.change(doc.id, doc.revision, current, next => changes.synchronized(next, "first_play", calendars))
  const read = async () => (await store.read("criteria")) as MissionDocument
  const occurrences: MissionWake[] = [], runs = new Map<string, number>()
  const wake = (slot: number): DocumentPassageWake => {
    const calendar = calendars[slot], run = (runs.get(calendar.scheduleID) ?? 0) + 1
    runs.set(calendar.scheduleID, run)
    const value = { scheduleID: calendar.scheduleID, run, messageID: `msg_${calendar.scheduleID}_${run}`, dueAt: now }
    occurrences.push(value)
    return { ...value, missionID: "criteria", generation: 1, sessionID: calendar.sessionID }
  }
  const auxiliary = (): DocumentPassageWake => {
    const run = (runs.get("sch_auxiliary") ?? 0) + 1
    runs.set("sch_auxiliary", run)
    return { scheduleID: "sch_auxiliary", run, messageID: `msg_sch_auxiliary_${run}`, dueAt: now, missionID: "criteria", generation: 1, sessionID: "ses_auxiliary" }
  }
  const ports: DocumentPassagePorts = { incarnation: "process", now: () => now, current,
    verifyWake: async (_doc, value) => ({ wake: { scheduleID: value.scheduleID, run: value.run, messageID: value.messageID, dueAt: value.dueAt! }, current }),
    coverage: async value => ({ complete: true, wakes: occurrences.filter(item => item.run > (value.calendars.find(calendar => calendar.scheduleID === item.scheduleID)?.highWater ?? Infinity)), current }),
    snapshot: async () => ({ news: { triggers, conditions }, checkpoints: checkpoints(), current }),
    admit: async value => {
      if (value.pending!.admittedAt === null) admitted++
      return { kind: value.pending!.admittedAt === null ? "admitted" : "recorded", passageID: value.pending!.id,
        messageID: value.pending!.messageID, coordinatorSessionID: value.pending!.coordinatorSessionID, at: now }
    },
    observe: async () => terminal ? { outcome: failed ? "failed" : "completed", current } : undefined,
  }
  const engine = new MissionDocumentPassageEngine(store, ports)
  return { store, read, wake, auxiliary, engine, launches: () => admitted, tick: (ms = 60_000) => { now += ms },
    set triggers(value: boolean) { triggers = value }, set conditions(value: boolean) { conditions = value }, set terminal(value: boolean) { terminal = value }, set failed(value: boolean) { failed = value } }
}
const run = (f: Awaited<ReturnType<typeof fixture>>, wake: DocumentPassageWake) => f.engine.wake({ missionID: "criteria", wake })

test("any trigger launches: a schedule on its own, a trigger event check only after a change", async () => {
  const f = await fixture({ when: [daily, commits], onlyIf: [] })
  assert.deepEqual(missionCalendarPlans(await f.read(), start + 1).map(plan => plan.when.type), ["every", "cron", "every"])
  assert.equal(await run(f, f.wake(1)), "ignored", "an unchanged event check never launches")
  assert.equal(await run(f, f.wake(0)), "started", "a schedule launches without news")
  f.terminal = true; await f.engine.reconcile({ missionID: "criteria" }); f.terminal = false
  f.tick(); f.triggers = true
  assert.equal(await run(f, f.wake(1)), "started", "a new commit launches between schedules")
  assert.equal(f.launches(), 2)
})

test("conditions gate every schedule slot: a slot without a changed condition is skipped", async () => {
  const f = await fixture({ when: [daily, evening], onlyIf: [commits, files] })
  const plans = missionCalendarPlans(await f.read(), start + 1)
  assert.deepEqual(plans.map(plan => plan.when.type), ["every", "cron", "cron"], "no separate event check")
  assert.equal(await run(f, f.wake(0)), "ignored", "a slot without news is skipped")
  assert.equal((await f.read()).checks!.count, 1)
  f.tick(); f.conditions = true
  assert.equal(await run(f, f.wake(1)), "started")
  assert.equal(f.launches(), 1)
})

test("conditions also gate trigger events: a changed trigger waits for a changed condition", async () => {
  const f = await fixture({ when: [commits], onlyIf: [files] })
  f.conditions = true
  assert.equal(await run(f, f.wake(0)), "ignored", "a changed condition alone never triggers")
  f.tick(); f.conditions = false; f.triggers = true
  assert.equal(await run(f, f.wake(0)), "ignored", "a new commit alone is not enough")
  // Baselines advance only with a passage: the commit is still news at the next check.
  f.tick(); f.conditions = true
  assert.equal(await run(f, f.wake(0)), "started")
  assert.equal(f.launches(), 1)
})

test("a running passage is never doubled: later triggers group into one passage after it settles", async () => {
  const f = await fixture({ when: [daily, evening, files], onlyIf: [] })
  assert.equal(await run(f, f.wake(0)), "started")
  const first = (await f.read()).pending!
  f.tick(); assert.equal(await run(f, f.wake(1)), "pending")
  f.tick(); f.triggers = true; assert.equal(await run(f, f.wake(2)), "pending")
  f.tick(); assert.equal(await run(f, f.wake(0)), "pending")
  const waiting = await f.read()
  assert.equal(waiting.pending!.id, first.id); assert.equal(f.launches(), 1)
  assert.deepEqual({ ...waiting.deferred, dueAt: undefined }, { afterPassageID: first.id, dueAt: undefined, scheduled: true })
  f.tick(); f.terminal = true
  assert.equal(await f.engine.reconcile({ missionID: "criteria" }), "settled")
  const after = await f.read()
  assert.equal(f.launches(), 2, "exactly one grouped passage")
  assert.equal(after.history.length, 2); assert.equal(after.deferred ?? null, null)
  assert.equal(after.history[1].origin.kind, "deferred")
  assert.notEqual(after.history[1].id, first.id)
  assert.equal(await f.engine.reconcile({ missionID: "criteria" }), "idle", "the grouped passage never repeats")
  assert.equal(f.launches(), 2)
  const wire = new Ajv().compile(missionScheduleRpcMethods.scheduleRead.output)
  assert.equal(wire(JSON.parse(JSON.stringify(missionScheduleView(after)))), true, JSON.stringify(wire.errors))
})

test("grouped triggers still respect conditions, a grouped event check its trigger, and Pause", async () => {
  const gated = await fixture({ when: [daily], onlyIf: [files] })
  gated.conditions = true; assert.equal(await run(gated, gated.wake(0)), "started"); gated.conditions = false
  gated.tick(); await run(gated, gated.wake(0))
  assert.equal((await gated.read()).deferred!.scheduled, true)
  gated.terminal = true; await gated.engine.reconcile({ missionID: "criteria" })
  assert.equal(gated.launches(), 1, "no condition since the passage: the grouped slot is skipped")
  assert.equal((await gated.read()).deferred ?? null, null)

  const evented = await fixture({ when: [commits], onlyIf: [] })
  evented.triggers = true; assert.equal(await run(evented, evented.wake(0)), "started"); evented.triggers = false
  evented.tick(); await run(evented, evented.wake(0))
  assert.equal((await evented.read()).deferred!.scheduled, false)
  evented.terminal = true; await evented.engine.reconcile({ missionID: "criteria" })
  assert.equal(evented.launches(), 1, "a grouped event check launches only with a changed trigger")

  const paused = await fixture({ when: [daily], onlyIf: [] })
  await run(paused, paused.wake(0)); paused.tick(); await run(paused, paused.wake(0))
  const doc = await paused.read()
  assert.ok(doc.deferred)
  await paused.store.change(doc.id, doc.revision, current, next => { next.state = "paused" })
  paused.terminal = true; await paused.engine.reconcile({ missionID: "criteria" })
  assert.equal(paused.launches(), 1)
})

test("a stored legacy end date still bounds grouped triggers until the schedule is edited", async () => {
  const ending = await fixture({ timing: daily, condition: null, ends: { ...legacyEnds, at: start + 90_000 } })
  await run(ending, ending.wake(0)); ending.tick(); ending.tick()
  await run(ending, ending.wake(0))
  assert.equal((await ending.read()).deferred ?? null, null, "a slot after the end date never waits")
  ending.terminal = true; await ending.engine.reconcile({ missionID: "criteria" })
  assert.equal(ending.launches(), 1)
})

test("a failed passage drops its grouped triggers; recovery resumes at a future slot", async () => {
  const f = await fixture({ when: [daily], onlyIf: [] })
  await run(f, f.wake(0)); f.tick(); await run(f, f.wake(0))
  assert.ok((await f.read()).deferred)
  f.failed = true; f.terminal = true
  assert.equal(await f.engine.reconcile({ missionID: "criteria" }), "settled")
  const failed = await f.read()
  assert.equal(failed.blocked, "failed"); assert.equal(failed.deferred ?? null, null)
  await f.store.change(failed.id, failed.revision, current, next => { next.blocked = null })
  assert.equal(await f.engine.reconcile({ missionID: "criteria" }), "idle")
  assert.equal(f.launches(), 1)
})

test("an overlap window stored before grouping existed never turns its wakes into a passage", async () => {
  const f = await fixture({ when: [daily, evening], onlyIf: [] })
  await run(f, f.wake(0))
  const doc = await f.read()
  f.tick()
  await f.store.change(doc.id, doc.revision, current, next => {
    next.fanIn = { incarnation: "older", cutoff: start + 120_000, timeGeneration: 1, principalIDs: ["sch_principal_0", "sch_principal_1"], completed: false, suppress: true }
  })
  f.wake(1)
  f.terminal = true
  await f.engine.reconcile({ missionID: "criteria" })
  const settled = await f.read()
  assert.equal(settled.deferred ?? null, null); assert.equal(f.launches(), 1)
  assert.equal(settled.calendars.find(item => item.scheduleID === "sch_principal_1")!.highWater, 1)
})

test("Pause and Resume through the calendar owner drop a grouped launch", async t => {
  for (const action of ["pause", "resume"] as const) {
    const f = await ownerFixture(t, { kind: "cron", expression: "0 9 * * *", zone: "UTC" }, 3)
    await f.control("play")
    const doc = await f.read()
    // A settled passage owes one grouped launch, as after an overlap.
    await f.store.change(doc.id, doc.revision, f.current, next => {
      changes.reserve(next, { kind: "manual", requestID: `manual_${action}` }, f.now + 1, [])
      changes.admitted(next, next.pending!.id, f.now + 1); changes.settle(next, next.pending!.id, "completed", f.now + 2)
      next.deferred = { afterPassageID: next.history.at(-1)!.id, dueAt: f.now + 1, scheduled: true }
      if (action === "resume") next.state = "paused"
    })
    await f.control(action)
    assert.equal((await f.read()).deferred ?? null, null, action)
  }
})

test("an equivalent criteria save of a legacy schedule keeps its calendars; its end date goes with any save", async () => {
  const f = await fixture({ timing: daily, condition: commits, ends: legacyEnds })
  const before = await f.read()
  const same = configuration({ when: [daily], onlyIf: [commits] })
  assert.deepEqual(missionTemporalPolicy(missionConfigurationSchema.parse(same)), missionTemporalPolicy(before.configuration))
  const saved = await f.store.change(before.id, before.revision, current, next => changes.configure(next, same, start + 2000))
  assert.equal(saved.timeGeneration, before.timeGeneration); assert.deepEqual(saved.calendars, before.calendars)
  assert.equal(saved.synchronization, null)
  const triggered = configuration({ when: [daily, commits], onlyIf: [] })
  const replaced = await f.store.change(saved.id, saved.revision, current, next => changes.configure(next, triggered, start + 3000))
  assert.equal(replaced.timeGeneration, before.timeGeneration + 1, "the internal event check is a new calendar")
  assert.equal(replaced.synchronization?.kind, "replace")

  const ending = await fixture({ timing: daily, condition: null, ends: { ...legacyEnds, at: start + 86_400_000 } })
  const dated = await ending.read()
  assert.equal(dated.slotEndsAt, start + 86_400_000)
  const edited = await ending.store.change(dated.id, dated.revision, current, next => changes.configure(next, configuration({ when: [daily], onlyIf: [] }), start + 2000))
  assert.equal(edited.slotEndsAt, null, "saving an edit removes the stored end date")
})

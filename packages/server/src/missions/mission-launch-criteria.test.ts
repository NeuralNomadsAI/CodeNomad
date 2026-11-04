import assert from "node:assert/strict"
import test from "node:test"
import { MissionDocumentPassageEngine, type DocumentPassagePorts, type DocumentPassageWake } from "./mission-document-passage-engine"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "./mission-document-store"
import { missionDocumentChanges as changes, missionFallbackClear, missionTemporalPolicy } from "./mission-document-state"
import { missionCalendarPlans } from "./mission-calendar-plan"
import { missionSourceKey, type MissionCalendar, type MissionDocument, type MissionWake } from "./mission-document"
import { missionConfigurationSchema, missionCriteriaStructure, missionLaunchLimit, missionLaunchModel, missionLaunchPolicySchema, missionPrincipalCount,
  missionSlotEndsAt, requiresMissionCalendar, type MissionConfiguration, type MissionLaunchPolicy } from "./launch-policy"
import type { MissionJsonValue } from "./model"
import { ownerFixture } from "../opencode/missions/native-schedule-owner-test-fixture"
import Ajv from "ajv"
import { missionScheduleRpcMethods } from "./mission-schedule-contract"
import { missionScheduleView } from "./mission-schedule-view"

const current = () => true as const, start = Date.parse("2026-10-01T00:00:00Z")
const daily = { kind: "cron" as const, expression: "0 9 * * *", zone: "Europe/Paris" }
const evening = { kind: "cron" as const, expression: "0 18 * * *", zone: "Europe/Paris" }
const night = { kind: "cron" as const, expression: "0 20 * * *", zone: "Europe/Paris" }
const commits = { kind: "branch-commits" as const, directory: "/project", ref: "refs/heads/main" }
const files = { kind: "files-changed" as const, paths: ["src/b.ts", "src/a.ts"] }
const messages = { kind: "conversation-message" as const, conversationID: "ses_followed" }
const legacyEnds = { maxLaunches: null, afterMs: null, at: null }
const selection = { agent: "worker", model: { providerID: "unit", id: "model" } }
const configuration = (launch: MissionLaunchPolicy): MissionConfiguration => ({ title: "Criteria", objective: "Do useful work", template: "custom",
  taskMode: "native", profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory: "/project" }],
  watchedConversationIDs: [], profiles: { coordinator: selection, roles: { specialist: selection } }, launch })

test("the shared parser reads groups: connectors, roles, conditions and fallbacks", () => {
  const read = (kinds: string) => {
    const { connectors, roles, plans } = missionCriteriaStructure(kinds.split(",").map(kind => ({ kind: kind === "H" ? "cron" : "files-changed" })))
    return { connectors, roles, plans: Object.fromEntries(plans) }
  }
  assert.deepEqual(read("E,E"), { connectors: ["or"], roles: ["trigger", "trigger"], plans: {} })
  assert.deepEqual(read("H,H,E,E"), { connectors: ["or", "if", "or"], roles: ["trigger", "trigger", "condition", "condition"],
    plans: { 0: { conditions: [2, 3], fallback: false, group: 0 }, 1: { conditions: [2, 3], fallback: false, group: 0 } } })
  assert.deepEqual(read("E,H,E,H"), { connectors: ["else", "if", "else"], roles: ["trigger", "trigger", "condition", "trigger"],
    plans: { 1: { conditions: [2], fallback: true, group: 1 }, 3: { conditions: [], fallback: true, group: 3 } } })
  assert.deepEqual(read("H,E,H"), { connectors: ["if", "else"], roles: ["trigger", "condition", "trigger"],
    plans: { 0: { conditions: [1], fallback: false, group: 0 }, 2: { conditions: [], fallback: true, group: 2 } } })
  assert.deepEqual(read("E,H,H,E,E,H"), { connectors: ["else", "or", "if", "or", "else"], roles: ["trigger", "trigger", "trigger", "condition", "condition", "trigger"],
    plans: { 1: { conditions: [3, 4], fallback: true, group: 1 }, 2: { conditions: [3, 4], fallback: true, group: 1 }, 5: { conditions: [], fallback: true, group: 3 } } })
  const model = missionLaunchModel(missionLaunchPolicySchema.parse({ when: [commits, evening, messages, night] }))
  assert.deepEqual(model.triggers, [commits]); assert.deepEqual(model.conditions, [messages])
  assert.deepEqual(model.plans, [{ conditions: [messages], fallback: true, group: 1 }, { conditions: [], fallback: true, group: 3 }], "commits else 18:00 if messages else 20:00")
})

test("criteria codec: one ordered list, bounded principals and events, unique criteria", () => {
  const parsed = missionLaunchPolicySchema.parse({ when: [daily, files] })
  assert.ok("when" in parsed)
  assert.deepEqual(parsed.when[1], { kind: "files-changed", paths: ["src/a.ts", "src/b.ts"] })
  assert.equal(missionPrincipalCount(parsed), 1, "a condition needs no check of its own")
  assert.equal(missionPrincipalCount({ when: [files, daily] }), 2, "a fallback schedule plus the internal event check")
  assert.equal(missionPrincipalCount({ when: [daily, evening] }), 2)
  for (const invalid of [
    { when: [daily, daily] },
    { when: [commits, commits] },
    { when: [commits, daily, commits] },
    { when: [files, ...Array.from({ length: 8 }, (_, hour) => ({ ...daily, expression: `0 ${hour} * * *` }))] },
    { when: [daily, ...Array.from({ length: 9 }, (_, index) => ({ kind: "files-changed" as const, paths: [`f${index}.ts`] }))] },
    { when: [{ ...daily, expression: "* * * * * *" }] },
    { when: [daily], onlyIf: [files] },
    { when: [daily], until: null },
    { when: [daily], onlyWithNews: false, until: null },
    { when: [{ kind: "every", intervalMs: 900_000 }] },
  ]) assert.equal(missionLaunchPolicySchema.safeParse(invalid).success, false, JSON.stringify(invalid))
  assert.ok(missionLaunchPolicySchema.safeParse({ when: [...Array.from({ length: 8 }, (_, hour) => ({ ...daily, expression: `0 ${hour} * * *` })), files] }).success,
    "eight schedules fit when the events after them are conditions")
  const empty = { when: [] }
  assert.equal(requiresMissionCalendar(empty), false); assert.equal(missionLaunchLimit(empty), 1)
  assert.equal(missionLaunchLimit({ when: [files] }), null, "events repeat")
  assert.equal(missionSlotEndsAt({ when: [daily] }, start), null, "criteria have no end date")
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
    assert.ok(model.plans.every(plan => !plan.fallback && plan.conditions.length === item.conditions), "a legacy condition gates every schedule")
    assert.equal(missionLaunchLimit(parsed), item.limit); assert.equal(missionPrincipalCount(parsed), item.principals)
  }
  assert.equal(missionSlotEndsAt(cases.at(-1)!.legacy, start), start + 3_600_000, "relative end keeps its first-Play origin")
})

async function fixture(launch: MissionLaunchPolicy) {
  const values = new Map<string, MissionJsonValue>()
  let now = start + 60_000, admitted = 0, changed: string[] = [], terminal = false, failed = false, admission: "admitted" | "unknown" = "admitted"
  const storage: MissionDocumentStorage = { get: async key => structuredClone(values.get(key)),
    compareAndSet: async (key, value, revision, guard) => {
      guard(); assert.equal((values.get(key) as { revision: number } | undefined)?.revision ?? null, revision); values.set(key, structuredClone(value))
    } }
  const store = new NativeMissionDocumentStore(storage, "project", "/project")
  const model = missionLaunchModel(missionLaunchPolicySchema.parse(launch)), events = model.events
  const checkpoints = () => events.map(condition => ({ key: missionSourceKey(condition), kind: condition.kind, placementDigest: "b".repeat(64), value: { now } }))
  let doc = await store.create("criteria", configuration(launch), start, current)
  doc = await store.change(doc.id, doc.revision, current, next => changes.play(next, "first_play", start, checkpoints()))
  // Principal calendars are armed at Play, as the calendar owner records their anchor.
  const calendars: MissionCalendar[] = [...Array.from({ length: missionPrincipalCount(launch) }, (_, slot): MissionCalendar => ({ role: "principal", slot,
    timeGeneration: 1, scheduleID: `sch_principal_${slot}`, sessionID: `ses_principal_${slot}`, highWater: 0, pendingWake: null, wakePreparing: null, armedAt: start })),
  { role: "reconciliation", slot: 0, timeGeneration: 1, scheduleID: "sch_auxiliary", sessionID: "ses_auxiliary", highWater: 0, pendingWake: null, wakePreparing: null }]
  await store.change(doc.id, doc.revision, current, next => changes.synchronized(next, "first_play", calendars))
  const read = async () => (await store.read("criteria")) as MissionDocument
  const occurrences: MissionWake[] = [], runs = new Map<string, number>()
  const wake = (slot: number): DocumentPassageWake => {
    const calendar = calendars[slot], run = (runs.get(calendar.scheduleID) ?? 0) + 1
    runs.set(calendar.scheduleID, run)
    const value = { scheduleID: calendar.scheduleID, run, messageID: `msg_${calendar.scheduleID}_${run}`, dueAt: now - 5_000 }
    occurrences.push(value)
    return { ...value, missionID: "criteria", generation: 1, sessionID: calendar.sessionID }
  }
  const ports: DocumentPassagePorts = { incarnation: "process", now: () => now, current,
    verifyWake: async (_doc, value) => ({ wake: { scheduleID: value.scheduleID, run: value.run, messageID: value.messageID, dueAt: value.dueAt! }, current }),
    coverage: async value => ({ complete: true, wakes: occurrences.filter(item => item.run > (value.calendars.find(calendar => calendar.scheduleID === item.scheduleID)?.highWater ?? Infinity)), current }),
    snapshot: async () => {
      const news = (items: typeof events) => items.some(item => changed.includes(missionSourceKey(item)))
      return { news: { triggers: news(model.triggers), conditions: news(model.conditions), changed: [...changed] }, checkpoints: checkpoints(), current }
    },
    admit: async value => {
      if (admission === "unknown") return { kind: "unknown" }
      if (value.pending!.admittedAt === null) admitted++
      return { kind: value.pending!.admittedAt === null ? "admitted" : "recorded", passageID: value.pending!.id,
        messageID: value.pending!.messageID, coordinatorSessionID: value.pending!.coordinatorSessionID, at: now }
    },
    observe: async () => terminal ? { outcome: failed ? "failed" : "completed", current } : undefined,
  }
  const engine = new MissionDocumentPassageEngine(store, ports)
  return { store, read, wake, engine, launches: () => admitted, tick: (ms = 60_000) => { now += ms }, get now() { return now },
    /** The events with news since the last successful passage. */
    changed: (...items: { kind: string; paths?: string[] }[]) => {
      changed = items.map(item => missionSourceKey((item.paths ? { ...item, paths: [...item.paths].sort() } : item) as typeof commits))
    },
    settle: async (outcome: "completed" | "failed" = "completed") => {
      terminal = true; failed = outcome === "failed"
      await engine.reconcile({ missionID: "criteria" }); terminal = false; failed = false
    },
    set admission(value: "admitted" | "unknown") { admission = value } }
}
const run = (f: Awaited<ReturnType<typeof fixture>>, wake: DocumentPassageWake) => f.engine.wake({ missionID: "criteria", wake })
const day = 86_400_000

test("a leading schedule launches at its slots; leading events launch on each new occurrence (E, E is an OR)", async () => {
  const scheduled = await fixture({ when: [daily] })
  assert.equal(await run(scheduled, scheduled.wake(0)), "started", "a schedule launches without news")
  const f = await fixture({ when: [commits, files] })
  assert.deepEqual(missionCalendarPlans(await f.read(), start + 1).map(plan => plan.when.type), ["every", "every"], "one 15-minute event check")
  assert.equal(await run(f, f.wake(0)), "ignored", "an unchanged event check never launches")
  f.tick(); f.changed(files)
  assert.equal(await run(f, f.wake(0)), "started", "either event launches")
  assert.equal(f.launches(), 1)
})

test("H, H, E, E: both schedules launch only if one of the two events changed; a false if skips without consuming sources", async () => {
  const f = await fixture({ when: [daily, evening, commits, files] })
  assert.deepEqual(missionCalendarPlans(await f.read(), start + 1).map(plan => plan.when.type), ["every", "cron", "cron"], "conditions have no check of their own")
  const references = (await f.read()).checkpoints
  assert.equal(await run(f, f.wake(0)), "ignored", "09:00 without news is skipped")
  assert.deepEqual((await f.read()).checkpoints, references, "a skipped slot consumes no source")
  f.tick(); f.changed(files)
  assert.equal(await run(f, f.wake(1)), "started", "18:00 with changed files launches")
  assert.equal(f.launches(), 1)
})

test("commits else 18:00 if messages else 20:00: each fallback reads its own period since its previous slot", async () => {
  const f = await fixture({ when: [commits, evening, messages, night] })
  const [at18, at20, check] = [0, 1, 2]
  // Day 1: a commit launches; both fallbacks of that period are skipped.
  f.tick(); f.changed(commits)
  assert.equal(await run(f, f.wake(check)), "started"); await f.settle(); f.changed()
  f.tick(); f.changed(messages)
  assert.equal(await run(f, f.wake(at18)), "ignored", "18:00: the commit passage ran in its period")
  f.tick()
  assert.equal(await run(f, f.wake(at20)), "ignored", "20:00: a passage ran in its period")
  // Day 2: no commit but new messages: 18:00 launches, then 20:00 is skipped.
  f.tick(day)
  assert.equal(await run(f, f.wake(at18)), "started", "18:00: no passage since the previous 18:00 and messages changed"); await f.settle(); f.changed()
  f.tick()
  assert.equal(await run(f, f.wake(at20)), "ignored", "20:00: the 18:00 passage ran in its period")
  // Day 3: neither commits nor messages: 18:00 is skipped, 20:00 launches without a condition.
  f.tick(day)
  assert.equal(await run(f, f.wake(at18)), "ignored", "18:00 needs new messages")
  f.tick()
  assert.equal(await run(f, f.wake(at20)), "started", "20:00 is the unconditional last fallback"); await f.settle()
  // Day 4: new messages: 18:00 is an else of the commits only, so yesterday's 20:00 never hides it.
  f.tick(day); f.changed(messages)
  assert.equal(await run(f, f.wake(at18)), "started", "18:00 ignores passages of the fallback after it"); await f.settle(); f.changed()
  f.tick(); assert.equal(await run(f, f.wake(at20)), "ignored")
  // Days 5 and 6: nothing new: 20:00 launches on consecutive days; its own passage never hides its next slot.
  f.tick(day); assert.equal(await run(f, f.wake(at18)), "ignored")
  f.tick(); assert.equal(await run(f, f.wake(at20)), "started"); await f.settle()
  f.tick(day); assert.equal(await run(f, f.wake(at18)), "ignored")
  f.tick(); assert.equal(await run(f, f.wake(at20)), "started", "the previous 20:00 passage is its own")
  assert.equal(f.launches(), 6)
})

test("H, E, H: 09:00 if commits else 18:00; E, H, H, E, E, H: a fallback group shares its conditions", async () => {
  const f = await fixture({ when: [daily, commits, evening] })
  assert.equal(await run(f, f.wake(0)), "ignored", "09:00 without commits")
  f.tick()
  assert.equal(await run(f, f.wake(1)), "started", "18:00: no passage since it was armed")
  const g = await fixture({ when: [files, daily, evening, commits, messages, night] })
  const model = missionLaunchModel((await g.read()).configuration.launch)
  assert.deepEqual(model.plans.map(plan => [plan.conditions.length, plan.fallback]), [[2, true], [2, true], [0, true]])
  g.tick(); g.changed(messages)
  assert.equal(await run(g, g.wake(1)), "started", "18:00 of the first fallback group with a new message")
})

test("an admitted passage counts for a fallback period even when it failed or was Run now; an unadmitted one is uncertain", async () => {
  const f = await fixture({ when: [commits, evening] })
  const doc = await f.read(), id = "sch_principal_0"
  assert.equal(missionFallbackClear(doc, id, start + 10_000), true, "nothing ran since arming")
  const withPassage = (admittedAt: number | null, outcome: "completed" | "failed", kind: "manual" | "immediate") => {
    const next = structuredClone(doc)
    changes.reserve(next, { kind: "manual", requestID: `run_${kind}_${outcome}` }, start + 2000, next.checkpoints)
    if (admittedAt !== null) changes.admitted(next, next.pending!.id, admittedAt)
    return next
  }
  const manual = withPassage(start + 3000, "completed", "manual")
  assert.equal(missionFallbackClear(manual, id, start + 10_000), false, "an admitted Run now counts while pending")
  changes.settle(manual, manual.pending!.id, "failed", start + 4000)
  assert.equal(missionFallbackClear(manual, id, start + 10_000), false, "a failed but admitted passage still counts")
  assert.equal(missionFallbackClear(manual, id, start + 1500), true, "only passages for slots within the period count")
  const uncertain = withPassage(null, "completed", "manual")
  assert.equal(missionFallbackClear(uncertain, id, start + 10_000), false, "an unadmitted pending passage blocks a safe decision")
  const rearmed = structuredClone(manual)
  rearmed.calendars.find(item => item.scheduleID === id)!.armedAt = start + 5000
  assert.equal(missionFallbackClear(rearmed, id, start + 10_000), true, "a calendar armed after the passage starts a new period")
  rearmed.calendars.find(item => item.scheduleID === id)!.lastDueAt = start + 1500
  assert.equal(missionFallbackClear(rearmed, id, start + 10_000), false, "after a slot, the period starts at that slot")
  // A grouped passage counts when it came from the criteria above the fallback, never from the fallback itself.
  const grouped = (scheduleIDs: string[]) => {
    const next = structuredClone(manual)
    next.history = next.history.map(item => ({ ...item, origin: { kind: "deferred" as const, afterPassageID: item.id, dueAt: item.dueAt, scheduleIDs } }))
    return next
  }
  assert.equal(missionFallbackClear(grouped(["sch_principal_1"]), id, start + 10_000), false, "a grouped event check counts")
  assert.equal(missionFallbackClear(grouped([id]), id, start + 10_000), true, "the fallback's own grouped slot does not")
})

test("a grouped launch is decided at its slot from the news observed then, never re-read when it launches", async () => {
  const f = await fixture({ when: [commits, evening] })
  f.tick(); f.changed(commits)
  assert.equal(await run(f, f.wake(1)), "started")
  f.tick(); assert.equal(await run(f, f.wake(0)), "pending")
  assert.equal((await f.read()).deferred ?? null, null, "18:00: the running commit passage covers its period")
  // A check without a new commit during the passage is not owed, even when a commit lands before settlement.
  f.changed(); f.tick(); assert.equal(await run(f, f.wake(1)), "pending")
  assert.equal((await f.read()).deferred ?? null, null)
  f.changed(commits); await f.settle()
  assert.equal(f.launches(), 1, "a commit after the check waits for the next check")
  // A check that saw a commit during a passage launches once after it, whatever the news then.
  f.tick(); assert.equal(await run(f, f.wake(1)), "started")
  f.tick(); assert.equal(await run(f, f.wake(1)), "pending")
  assert.deepEqual((await f.read()).deferred?.scheduleIDs, ["sch_principal_1"])
  f.changed(); await f.settle()
  assert.equal(f.launches(), 3)
  const [owner, grouped] = (await f.read()).history.slice(-2)
  assert.deepEqual(grouped.origin, { kind: "deferred", afterPassageID: owner.id, dueAt: grouped.dueAt, scheduleIDs: ["sch_principal_1"] })
})

test("a stored legacy frequency with a condition keeps its exact gate on every calendar, without an event check", async () => {
  const f = await fixture({ timing: { kind: "multi", calendars: [{ expression: "0 9 * * *", zone: "Europe/Paris" }, { expression: "0 18 * * *", zone: "Europe/Paris" }] },
    condition: commits, ends: legacyEnds })
  assert.deepEqual(missionCalendarPlans(await f.read(), start + 1).map(plan => plan.when.type), ["every", "cron", "cron"], "the armed calendars stay as they are")
  assert.equal(await run(f, f.wake(0)), "ignored")
  f.tick(); assert.equal(await run(f, f.wake(1)), "ignored", "either calendar needs a new commit")
  f.tick(); f.changed(commits)
  assert.equal(await run(f, f.wake(1)), "started")
})

test("a running passage is never doubled: later triggers group into one passage after it settles", async () => {
  const f = await fixture({ when: [daily, evening] })
  assert.equal(await run(f, f.wake(0)), "started")
  const first = (await f.read()).pending!
  f.tick(); assert.equal(await run(f, f.wake(1)), "pending")
  f.tick(); assert.equal(await run(f, f.wake(0)), "pending")
  const waiting = await f.read()
  assert.equal(waiting.pending!.id, first.id); assert.equal(f.launches(), 1)
  assert.deepEqual({ ...waiting.deferred, dueAt: undefined }, { afterPassageID: first.id, dueAt: undefined, scheduleIDs: ["sch_principal_1", "sch_principal_0"] })
  f.tick(); await f.settle()
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

test("grouped triggers keep their slot's conditions, a grouped event check its trigger, and Pause", async () => {
  const gated = await fixture({ when: [daily, files] })
  gated.changed(files); assert.equal(await run(gated, gated.wake(0)), "started"); gated.changed()
  gated.tick(); await run(gated, gated.wake(0))
  assert.equal((await gated.read()).deferred ?? null, null, "no new files at the slot: nothing is owed")
  gated.changed(files); await gated.settle()
  assert.equal(gated.launches(), 1, "files changed after the slot never revive it")
  gated.tick(); assert.equal(await run(gated, gated.wake(0)), "started")
  gated.tick(); await run(gated, gated.wake(0))
  assert.deepEqual((await gated.read()).deferred!.scheduleIDs, ["sch_principal_0"], "new files at the slot: one grouped launch")
  gated.changed(); await gated.settle()
  assert.equal(gated.launches(), 3)

  const evented = await fixture({ when: [commits] })
  evented.changed(commits); assert.equal(await run(evented, evented.wake(0)), "started"); evented.changed()
  evented.tick(); await run(evented, evented.wake(0))
  assert.equal((await evented.read()).deferred ?? null, null, "a grouped event check needs a changed trigger at its slot")
  await evented.settle()
  assert.equal(evented.launches(), 1)

  const paused = await fixture({ when: [daily] })
  await run(paused, paused.wake(0)); paused.tick(); await run(paused, paused.wake(0))
  const doc = await paused.read()
  assert.ok(doc.deferred)
  await paused.store.change(doc.id, doc.revision, current, next => { next.state = "paused" })
  await paused.settle()
  assert.equal(paused.launches(), 1)
})

test("a stored legacy schedule never groups an overlapping slot, whatever its end date", async () => {
  for (const at of [null, start + 90_000]) {
    const legacy = await fixture({ timing: daily, condition: null, ends: { ...legacyEnds, at } })
    await run(legacy, legacy.wake(0)); legacy.tick()
    assert.equal(await run(legacy, legacy.wake(0)), "pending")
    assert.equal((await legacy.read()).deferred ?? null, null)
    await legacy.settle()
    assert.equal(legacy.launches(), 1)
  }
})

test("a failed passage drops its grouped triggers; recovery resumes at a future slot", async () => {
  const f = await fixture({ when: [daily] })
  await run(f, f.wake(0)); f.tick(); await run(f, f.wake(0))
  assert.ok((await f.read()).deferred)
  await f.settle("failed")
  const failed = await f.read()
  assert.equal(failed.blocked, "failed"); assert.equal(failed.deferred ?? null, null)
  await f.store.change(failed.id, failed.revision, current, next => { next.blocked = null })
  assert.equal(await f.engine.reconcile({ missionID: "criteria" }), "idle")
  assert.equal(f.launches(), 1)
})

test("an uncertain admission keeps its passage pending and never replays it", async () => {
  const f = await fixture({ when: [commits, evening] })
  f.admission = "unknown"; f.tick(); f.changed(commits)
  assert.equal(await run(f, f.wake(1)), "unknown")
  const doc = await f.read()
  assert.equal(doc.pending!.admittedAt, null)
  assert.equal(missionFallbackClear(doc, "sch_principal_0", f.now + 60_000), false, "no fallback decision while admission is unproven")
  f.tick(); assert.notEqual(await run(f, f.wake(0)), "started")
  assert.equal(f.launches(), 0)
})

test("an overlap window stored before grouping existed never turns its wakes into a passage", async () => {
  const f = await fixture({ when: [daily, evening] })
  await run(f, f.wake(0))
  const doc = await f.read()
  f.tick()
  await f.store.change(doc.id, doc.revision, current, next => {
    next.fanIn = { incarnation: "older", cutoff: start + 120_000, timeGeneration: 1, principalIDs: ["sch_principal_0", "sch_principal_1"], completed: false, suppress: true }
  })
  f.wake(1)
  await f.settle()
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
      next.deferred = { afterPassageID: next.history.at(-1)!.id, dueAt: f.now + 1, scheduleIDs: [next.calendars.find(item => item.role === "principal")!.scheduleID] }
      if (action === "resume") next.state = "paused"
    })
    await f.control(action)
    assert.equal((await f.read()).deferred ?? null, null, action)
  }
})

test("an equivalent criteria save of a legacy schedule keeps its calendars; its end date goes with any save", async () => {
  const f = await fixture({ timing: daily, condition: commits, ends: legacyEnds })
  const before = await f.read()
  const same = configuration({ when: [daily, commits] })
  assert.deepEqual(missionTemporalPolicy(missionConfigurationSchema.parse(same)), missionTemporalPolicy(before.configuration))
  const saved = await f.store.change(before.id, before.revision, current, next => changes.configure(next, same, start + 2000))
  assert.equal(saved.timeGeneration, before.timeGeneration); assert.deepEqual(saved.calendars, before.calendars)
  assert.equal(saved.synchronization, null)
  const triggered = configuration({ when: [commits] })
  const replaced = await f.store.change(saved.id, saved.revision, current, next => changes.configure(next, triggered, start + 3000))
  assert.equal(replaced.timeGeneration, before.timeGeneration + 1, "an event trigger replaces the schedule calendar")
  assert.equal(replaced.synchronization?.kind, "replace")

  const ending = await fixture({ timing: daily, condition: null, ends: { ...legacyEnds, at: start + 86_400_000 } })
  const dated = await ending.read()
  assert.equal(dated.slotEndsAt, start + 86_400_000)
  const edited = await ending.store.change(dated.id, dated.revision, current, next => changes.configure(next, configuration({ when: [daily] }), start + 2000))
  assert.equal(edited.slotEndsAt, null, "saving an edit removes the stored end date")
})

test("the calendar owner arms new principal calendars at their anchor; a kept calendar that becomes a fallback starts at the edit", async t => {
  const f = await ownerFixture(t, { kind: "cron", expression: "0 9 * * *", zone: "UTC" }, 3)
  await f.control("play")
  let played = await f.read()
  const first = played.calendars.find(item => item.role === "principal")!
  assert.equal(typeof first.armedAt, "number", "Play arms the calendar")
  // Its latest slot, as a processed wake records it.
  played = await f.store.change(played.id, played.revision, f.current, next => { next.calendars.find(item => item.role === "principal")!.lastDueAt = first.armedAt! + 1 })
  f.advance(60_000)
  const nine = { kind: "cron" as const, expression: "0 9 * * *", zone: "UTC" }, six = { ...nine, expression: "0 18 * * *" }
  await f.control("configure", "add_evening", { ...played.configuration, launch: { when: [nine, six] } })
  const edited = await f.read()
  const [kept, added] = [0, 1].map(slot => edited.calendars.find(item => item.role === "principal" && item.slot === slot)!)
  assert.ok(edited.timeGeneration > played.timeGeneration && kept.scheduleID !== first.scheduleID, "the edit re-arms every calendar")
  assert.deepEqual([kept.armedAt, kept.lastDueAt], [first.armedAt, first.armedAt! + 1], "the unchanged 09:00 keeps its period origin")
  assert.ok(added.armedAt! > first.armedAt! && added.lastDueAt === undefined, "the new 18:00 starts at its activation")
  assert.deepEqual([kept.formerIDs, added.formerIDs], [[first.scheduleID], undefined], "the 09:00 answers for the calendar it replaced")

  // A kept legacy calendar has no arming time: once it is an else fallback, its first period starts at the edit.
  // (The codec stores legacy calendars sorted: 18:00 first.)
  const legacy = await fixture({ timing: { kind: "multi", calendars: [daily, evening].map(({ expression, zone }) => ({ expression, zone })) }, condition: null, ends: legacyEnds })
  let doc = await legacy.read()
  doc = await legacy.store.change(doc.id, doc.revision, current, next => { for (const calendar of next.calendars) delete calendar.armedAt })
  const saved = await legacy.store.change(doc.id, doc.revision, current, next => changes.configure(next, configuration({ when: [evening, commits, daily] }), start + 7000,
    [{ key: missionSourceKey(commits), kind: commits.kind, placementDigest: "b".repeat(64), value: { now: 0 } }]))
  assert.deepEqual(saved.calendars.map(item => item.scheduleID), doc.calendars.map(item => item.scheduleID), "the calendars are kept")
  assert.deepEqual(saved.calendars.filter(item => item.role === "principal").map(item => item.armedAt), [start + 7000, start + 7000])
})

test("after an outage, a fan-in passage counts only for the calendars that decided it", async () => {
  const f = await fixture({ when: [commits, evening, messages, night] })
  const [at18, at20, check] = [0, 1, 2]
  // The missed 18:00 and 20:00 slots and a later event check fan in: only 20:00 launches.
  f.tick(); f.wake(at18); f.tick(); f.wake(at20); f.tick()
  assert.equal(await run(f, f.wake(check)), "started")
  const passage = (await f.read()).pending!
  assert.equal(passage.origin.kind === "wake" && passage.origin.wakes.length, 3, "the origin keeps every grouped wake")
  assert.deepEqual(passage.launchedBy, ["sch_principal_1"], "20:00 alone decided the launch")
  await f.settle()
  // Next day: no commit launched anything, so 18:00 with new messages launches.
  f.tick(day); f.changed(messages)
  assert.equal(await run(f, f.wake(at18)), "started")
  assert.equal(f.launches(), 2)
})

test("passages of a replaced calendar keep their schedule's group; a removed schedule's still count", async () => {
  const f = await fixture({ when: [commits, evening, messages, night] })
  const doc = await f.read(), at18 = "sch_principal_0", at20 = doc.calendars.find(item => item.scheduleID === "sch_principal_1")!
  const withPassage = (scheduleID: string, formerIDs?: string[]) => {
    const next = structuredClone(doc)
    if (formerIDs) next.calendars.find(item => item.scheduleID === at20.scheduleID)!.formerIDs = formerIDs
    const wake = { scheduleID, run: 1, messageID: `msg_${scheduleID}_1`, dueAt: start + 2000 }
    next.history.push({ ...structuredClone(next.history[0] ?? {}), id: "psg_replaced", dueAt: wake.dueAt, admittedAt: start + 2500,
      origin: { kind: "wake", wakes: [wake] }, launchedBy: [scheduleID] } as MissionDocument["history"][number])
    return next
  }
  assert.equal(missionFallbackClear(withPassage("sch_old_20", ["sch_old_20"]), at18, start + 10_000), true,
    "a 20:00 passage recorded under its replaced calendar never hides 18:00")
  assert.equal(missionFallbackClear(withPassage("sch_removed"), at18, start + 10_000), false, "a removed schedule's passage counts")
  assert.equal(missionFallbackClear(doc, at18, start), false, "a period whose origin is not before the slot is uncertain")
})

test("forged period origins and grouped calendars are refused", async () => {
  const f = await fixture({ when: [commits, evening] })
  const doc = await f.read(), principal = (next: MissionDocument) => next.calendars.find(item => item.role === "principal")!
  const forged: [string, (next: MissionDocument) => void][] = [
    ["an origin on the reconciliation calendar", next => { next.calendars.find(item => item.role === "reconciliation")!.armedAt = start }],
    ["a slot on the reconciliation calendar", next => { next.calendars.find(item => item.role === "reconciliation")!.lastDueAt = start }],
    ["an arming before the document", next => { principal(next).armedAt = start - 1 }],
    ["an arming after its latest slot", next => { principal(next).lastDueAt = start + 1000; principal(next).armedAt = start + 2000 }],
    ["a calendar replacing itself", next => { principal(next).formerIDs = [principal(next).scheduleID] }],
    ["former identifiers on the reconciliation calendar", next => { next.calendars.find(item => item.role === "reconciliation")!.formerIDs = ["sch_old"] }],
  ]
  for (const [name, use] of forged)
    await assert.rejects(f.store.change(doc.id, doc.revision, current, use), /Invalid Mission document/, name)
  f.changed(commits); assert.equal(await run(f, f.wake(1)), "started")
  const pending = await f.read()
  await assert.rejects(f.store.change(pending.id, pending.revision, current, next => {
    next.deferred = { afterPassageID: next.pending!.id, dueAt: f.now, scheduleIDs: ["sch_auxiliary"] }
  }), /Invalid Mission document/, "a grouped launch names principal calendars only")
  await assert.rejects(f.store.change(pending.id, pending.revision, current, next => {
    next.calendars.find(item => item.scheduleID === "sch_principal_1")!.lastDueAt = next.pending!.dueAt - 1
  }), /Invalid Mission document/, "the latest slot is never before the reserved one")
})

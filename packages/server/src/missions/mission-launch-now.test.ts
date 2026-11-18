import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { missionCriteriaStructure, missionLaunchModel, missionLaunchPolicySchema, missionPrincipalCount, requiresMissionCalendar,
  type MissionLaunchPolicy } from "./launch-policy"
import { missionDocumentChanges as changes, missionLaunches } from "./mission-document-state"
import { missionCalendarPlans } from "./mission-calendar-plan"
import { missionSourceKey, type MissionDocument, type MissionWake } from "./mission-document"
import { MissionDocumentPassageEngine, type DocumentPassagePorts } from "./mission-document-passage-engine"
import { NativeMissionDocumentStore } from "./mission-document-store"
import { missionScheduleRpcMethods } from "./mission-schedule-contract"
import { missionScheduleView } from "./mission-schedule-view"
import { ownerFixture } from "../opencode/missions/native-schedule-owner-test-fixture"
import { preparationFixture } from "./mission-preparation-test-fixture"

const now = { kind: "now" as const }, daily = { kind: "cron" as const, expression: "0 9 * * *", zone: "UTC" }
const files = { kind: "files-changed" as const, paths: ["input.txt"] }, current = () => true as const
const checkpoints = (doc: MissionDocument) => missionLaunchModel(doc.configuration.launch).events.map(event => ({
  kind: event.kind, key: missionSourceKey(event), placementDigest: "b".repeat(64), value: { revision: 0 },
}))

async function fixture(t: test.TestContext, launch: MissionLaunchPolicy) {
  const f = await ownerFixture(t, undefined, 3, async doc => ({ checkpoints: checkpoints(doc), current }))
  await f.control("configure", "set_criteria", { ...f.configuration, launch })
  let clock = f.now, changed = false, terminal = false, uncertain = false, admissions = 0
  const occurrences: MissionWake[] = []
  const tick = (ms = 1000) => { clock += ms; f.advance(ms) }
  const ports: DocumentPassagePorts = {
    incarnation: "now-test", now: () => clock, current,
    verifyWake: async (_doc, wake) => ({ wake: { scheduleID: wake.scheduleID, messageID: wake.messageID, run: wake.run, dueAt: wake.dueAt! }, current }),
    coverage: async doc => ({ complete: true, wakes: occurrences.filter(wake =>
      wake.run > (doc.calendars.find(item => item.scheduleID === wake.scheduleID)?.highWater ?? Infinity)), current }),
    snapshot: async doc => ({ news: { triggers: changed, conditions: changed, changed: changed ? [missionSourceKey(files)] : [] },
      checkpoints: checkpoints(doc), current }),
    admit: async doc => {
      if (uncertain) return { kind: "unknown" }
      const pending = doc.pending!
      if (pending.admittedAt === null) admissions++
      return { kind: pending.admittedAt === null ? "admitted" : "recorded", passageID: pending.id,
        coordinatorSessionID: pending.coordinatorSessionID, messageID: pending.messageID, at: pending.admittedAt ?? clock }
    },
    observe: async () => terminal ? { outcome: "completed", current } : undefined,
  }
  let engine = new MissionDocumentPassageEngine(f.store, ports)
  return { ...f, tick, get engine() { return engine }, get clock() { return clock }, admissions: () => admissions,
    get changed() { return changed }, set changed(value: boolean) { changed = value },
    get uncertain() { return uncertain }, set uncertain(value: boolean) { uncertain = value },
    restart: () => {
      const store = new NativeMissionDocumentStore({
        get: async key => structuredClone(f.values.get(key)),
        compareAndSet: async (key, value, expected, guard) => {
          guard(); assert.equal((f.values.get(key) as { revision: number } | undefined)?.revision ?? null, expected)
          f.values.set(key, structuredClone(value))
        },
      }, "project", f.directory)
      engine = new MissionDocumentPassageEngine(store, { ...ports, incarnation: "restarted" })
      return f.makeOwner(store)
    },
    wake: async (slot = 0) => {
      const doc = await f.read(), calendar = doc.calendars.find(item => item.role === "principal" && item.slot === slot)!
      const info = f.calendars.get(calendar.scheduleID)!, dueAt = info.nextDueAt!
      if (clock < dueAt) tick(dueAt - clock)
      const run = ++info.runCount
      if (info.when.type === "at") { info.status = "done"; info.nextDueAt = null }
      const wake = { scheduleID: calendar.scheduleID, run, messageID: `msg_${calendar.scheduleID}_${run}`, dueAt }
      occurrences.push(wake)
      return { ...wake, missionID: doc.id, generation: doc.timeGeneration, sessionID: calendar.sessionID }
    },
    settle: async () => { terminal = true; const result = await engine.reconcile({ missionID: (await f.read()).id }); terminal = false; return result },
  }
}

test("now is a strict unique schedule criterion, shares OR/if/else grouping and consumes principal capacity", () => {
  for (const when of [[now], [now, daily], [files, now], [now, files], [files, now, files]]) {
    const result = missionLaunchPolicySchema.safeParse({ when })
    assert.equal(result.success, when.length < 3)
  }
  assert.equal(missionLaunchPolicySchema.safeParse({ when: [now, now] }).success, false)
  assert.equal(missionLaunchPolicySchema.safeParse({ when: [{ ...now, at: 1 }] }).success, false)
  assert.equal(missionLaunchPolicySchema.safeParse({ timing: now, condition: null, ends: { maxLaunches: null, afterMs: null, at: null } }).success, false)
  assert.equal(missionLaunchPolicySchema.safeParse({ when: [now, ...Array.from({ length: 8 }, (_, hour) => ({ ...daily, expression: `0 ${hour} * * *` }))] }).success, false)
  assert.deepEqual(missionCriteriaStructure([now, daily, files]).connectors, ["or", "if"])
  assert.deepEqual(missionCriteriaStructure([files, now, daily]).connectors, ["else", "or"])
  assert.equal(missionPrincipalCount({ when: [files, now] }), 2)
  assert.equal(missionPrincipalCount({ when: [now, files] }), 1)
  assert.equal(requiresMissionCalendar({ when: [now] }), false)
  assert.deepEqual(missionLaunchModel({ when: [now] }), missionLaunchModel({ when: [] }), "sole now uses first-Play journal admission")
  assert.deepEqual(missionLaunchModel({ when: [now, files] }).events, [files])
})

test("mixed now creates paused without native effects and freezes its one-shot at Play, independent of creation and auxiliary delay", async t => {
  const f = await fixture(t, { when: [now, daily] }), prepared = await f.read()
  assert.equal(prepared.oneShotAt, null); assert.equal(prepared.firstPlayedAt, null)
  assert.equal(prepared.pending, null); assert.equal(f.calls.length, 0)
  f.tick(60_000); f.delayAuxiliary(30_000)
  const played = await f.control("play"), slot = played.calendarOwner!.slots.find(item => item.role === "principal")!
  assert.equal(played.firstPlayedAt, f.clock)
  assert.equal(played.oneShotAt, f.clock + 1)
  assert.deepEqual(slot.when, { type: "at", at: new Date(f.clock + 1).toISOString(), tz: "UTC" })
  assert.equal(slot.anchorAt, f.clock)
  assert.equal(f.calendars.get(slot.scheduleID!)!.nextDueAt, played.oneShotAt)
  assert.equal(played.launchedCount, 0)
  assert.equal(missionCalendarPlans(played, f.clock + 100_000)[1].anchorAt, slot.anchorAt, "a late reconstruction keeps the original instant")
  const wire = new Ajv().compile(missionScheduleRpcMethods.scheduleRead.output)
  assert.equal(wire(JSON.parse(JSON.stringify(missionScheduleView(played)))), true, JSON.stringify(wire.errors))
})

test("mixed now survives a cold reader, exact Play replay, Pause/Resume and uncertain passage admission without a second launch", async t => {
  const f = await fixture(t, { when: [now, files] }), before = await f.read()
  const play = { missionID: before.id, requestID: "original_play", expectedRevision: before.revision, action: "play" as const }
  const played = await f.owner.control(play), creates = f.calls.filter(call => call.startsWith("create:")).length
  const owner = f.restart()
  await owner.control(play)
  assert.equal(f.calls.filter(call => call.startsWith("create:")).length, creates)
  await f.control("pause"); f.tick(30_000); await f.control("resume")
  assert.equal((await f.read()).oneShotAt, played.oneShotAt)
  assert.deepEqual((await f.read()).calendars, played.calendars)
  f.uncertain = true; f.changed = true
  const wake = await f.wake()
  assert.equal(await f.engine.wake({ missionID: played.id, wake }), "unknown")
  const identity = structuredClone((await f.read()).pending)
  f.restart()
  assert.equal(await f.engine.wake({ missionID: played.id, wake }), "ignored")
  assert.equal(await f.engine.reconcile({ missionID: played.id }), "unknown")
  assert.equal((await f.read()).pending!.messageID, identity!.messageID)
  f.uncertain = false
  assert.equal(await f.engine.reconcile({ missionID: played.id }), "pending")
  assert.equal(f.admissions(), 1)
  await f.settle(); await owner.reconcile(played.id)
  const done = await f.read()
  assert.equal(done.state, "finished"); assert.equal(done.launchedCount, 1)
  assert.equal(f.calendars.size, 0)
  await assert.rejects(f.control("play", "another_play"), /cannot resume/)
})

test("sole now retains default profiles, editable preparation, exact first-Play recovery and one-time journal lifecycle", async () => {
  const f = await preparationFixture(), launch = { when: [now] }
  const prepared = await f.control.configurePreparation({ ...f.request, configuration: { ...f.original.configuration, launch } }, f.native, current)
  assert.equal(prepared.firstPlayedAt, null); assert.equal(prepared.oneShotAt, null)
  assert.equal(prepared.configuration.profiles, undefined)
  assert.equal(prepared.calendarOwner, null); assert.equal(prepared.scheduleActivation, null)
  assert.equal(f.admissions.length, 0)
  assert.equal(f.sessions.get(prepared.oneTime!.coordinatorSessionID)!.agent, "default-agent")
  assert.deepEqual(missionScheduleView(prepared).document!.edit, { structural: true, template: true, reason: null, templateReason: null })
  const mission = (await f.control.snapshot()).missions[0]
  const play = { missionID: mission.id, requestID: "sole_now_play", expectedRevision: mission.revision, action: "start" as const }
  f.fail("admission-after")
  await assert.rejects(f.control.lifecycle(play), /retry the remaining native controls/)
  const identity = (await f.read()).oneTime!.firstPlay!
  await f.control.lifecycle(play); await f.control.lifecycle(play)
  const played = await f.read()
  assert.equal(f.admissions.length, 1); assert.equal(played.launchedCount, 1)
  assert.equal(played.oneTime!.firstPlay!.messageID, identity.messageID)
  assert.deepEqual(played.configuration.launch, launch)
  assert.equal(played.oneShotAt, null); assert.equal(played.calendars.length, 0)
  assert.equal(missionScheduleView(played).document!.edit.structural, false)
})

test("events before now are repeatable triggers with a once-now else fallback; events after now only condition that one slot", async t => {
  const fallback = await fixture(t, { when: [files, now] }), played = await fallback.control("play")
  assert.equal(await fallback.engine.wake({ missionID: played.id, wake: await fallback.wake() }), "started", "no earlier event passage: now fallback launches")
  await fallback.settle()
  fallback.changed = true
  assert.equal(await fallback.engine.wake({ missionID: played.id, wake: await fallback.wake(1) }), "started", "leading events keep triggering after now")
  assert.equal(fallback.admissions(), 2)

  const gated = await fixture(t, { when: [now, files] }), armed = await gated.control("play")
  const wake = await gated.wake()
  assert.equal(await gated.engine.wake({ missionID: armed.id, wake }), "ignored", "no change since first-Play baseline")
  gated.changed = true; gated.tick()
  assert.equal(await gated.engine.wake({ missionID: armed.id, wake }), "ignored", "a later change never revives the sole consumed slot")
  const done = await gated.owner.reconcile(armed.id)
  assert.equal(done.state, "finished"); assert.equal(done.launchedCount, 0)
  const changed = await fixture(t, { when: [now, files] }), ready = await changed.control("play")
  changed.changed = true
  assert.equal(await changed.engine.wake({ missionID: ready.id, wake: await changed.wake() }), "started")
})

test("now OR cron keeps recurring slots and Run now independent; manual replay never recreates the now slot", async t => {
  const f = await fixture(t, { when: [now, daily] }), played = await f.control("play")
  assert.equal(await f.engine.wake({ missionID: played.id, wake: await f.wake() }), "started")
  await f.settle()
  const before = await f.read(), request = { missionID: before.id, requestID: "manual_after_now", expectedRevision: before.revision }
  f.tick()
  assert.equal(await f.engine.runNow(request), "pending")
  await f.settle(); f.restart()
  assert.equal(await f.engine.runNow(request), "settled")
  assert.equal(f.admissions(), 2)
  assert.equal((await f.read()).oneShotAt, played.oneShotAt)
  assert.equal(await f.engine.wake({ missionID: played.id, wake: await f.wake(1) }), "started")
  assert.equal(f.admissions(), 3)
})

test("timing edits keep an unchanged now instant and consumed slot; newly adding now anchors at that edit", async t => {
  const f = await fixture(t, { when: [now, daily] }), played = await f.control("play")
  await f.engine.wake({ missionID: played.id, wake: await f.wake() }); await f.settle()
  f.tick()
  const edited = await f.control("configure", "add_evening", { ...played.configuration,
    launch: { when: [now, daily, { ...daily, expression: "0 18 * * *" }] } })
  assert.equal(edited.calendarOwner!.operation.pending, false)
  assert.equal(edited.oneShotAt, played.oneShotAt)
  const kept = edited.calendars.find(item => item.role === "principal" && item.slot === 0)!
  assert.equal(kept.lastDueAt, played.oneShotAt)
  assert.equal(missionLaunches(edited, [{ scheduleID: kept.scheduleID, dueAt: edited.oneShotAt! }], { triggers: false, conditions: false }), false)
  assert.equal(await f.engine.wake({ missionID: edited.id, wake: await f.wake() }), "ignored")
  assert.equal(f.admissions(), 1)

  const added = await fixture(t, { when: [daily] }), original = await added.control("play")
  added.tick(60_000)
  const withNow = await added.control("configure", "add_now", { ...original.configuration, launch: { when: [now, daily] } })
  assert.equal(withNow.oneShotAt, added.clock + 1)
  assert.equal(withNow.calendarOwner!.slots.find(item => item.role === "principal" && item.slot === 0)!.anchorAt, added.clock)
})

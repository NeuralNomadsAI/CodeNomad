import assert from "node:assert/strict"
import test from "node:test"
import { preparationFixture, scheduledPreparation, followedPreparationFixture } from "./mission-preparation-test-fixture"
import type { MissionLaunchPolicy } from "./launch-policy"
import { missionScheduleView } from "./mission-schedule-view"
import { missionDocumentChanges } from "./mission-document-state"
import { deleteDormantMissionJournal } from "./mission-dormant-journal"
import { finishMissionDocumentDeletion } from "./mission-document-deletion"
import { ownerFixture } from "../opencode/missions/native-schedule-owner-test-fixture"
import { MissionDocumentPassageEngine } from "./mission-document-passage-engine"
import { MissionJournal } from "./journal"

const current = () => true as const

test("followed scheduled preparation returns immediate; Play freezes the qualified envelope across lost ACK and replay", async () => {
  const f = await followedPreparationFixture()
  const scheduled = await f.control.configurePreparation({ ...f.request,
    configuration: { ...scheduledPreparation(f), watchedConversationIDs: [f.source.id] } }, f.native, current)
  const returned = await f.control.configurePreparation({ ...f.request, requestID: "return_followed", expectedRevision: scheduled.revision,
    configuration: { ...f.request.configuration, watchedConversationIDs: [f.source.id] } }, f.native, current)
  assert.equal(returned.id, f.original.id); assert.equal(f.reads, 0); assert.equal(f.admissions.length, 0)
  const row = (await f.control.snapshot()).missions[0]
  const input = { missionID: row.id, requestID: "play_followed", expectedRevision: row.revision, action: "start" as const }
  f.fail("admission-after")
  await assert.rejects(f.control.lifecycle(input), /retry the remaining/)
  const frozen = (await f.read()).oneTime!.firstPlay!
  assert.match(frozen.inputText!, /Context present at Play/); assert.match(frozen.inputText!, /untrusted source data/)
  assert.equal(f.reads, 1); assert.equal(f.admissions.length, 1)
  f.messages[0].text = "Newer text after original Play"
  f.available(false)
  await assert.rejects(f.control.lifecycle({ ...input, requestID: "bypass_unknown",
    expectedRevision: (await f.control.snapshot()).missions[0].revision }), /pending control/)
  await f.control.lifecycle(input)
  await f.control.lifecycle(input)
  const played = await f.read()
  assert.equal(played.oneTime!.firstPlay!.inputText, frozen.inputText)
  assert.equal(f.admissions[0].text, frozen.inputText)
  assert.equal(played.launchedCount, 1); assert.equal(f.reads, 1); assert.equal(f.admissions.length, 1)
  assert.deepEqual(played.calendars, []); assert.equal(played.calendarOwner, null)
  await assert.rejects(f.store.change(played.id, played.revision, current, value => { value.oneTime!.firstPlay!.inputText = "changed" }), /monotone/)
})

for (const failure of ["unavailable", "moved", "carrier", "own-family", "capacity"] as const) test(`immediate followed ${failure} blocks before first-Play intent or admission`, async () => {
  const f = await followedPreparationFixture()
  const doc = await f.control.configurePreparation({ ...f.request,
    configuration: { ...f.request.configuration, watchedConversationIDs: [f.source.id] } }, f.native, current)
  if (failure === "unavailable") f.available(false)
  if (failure === "moved") f.source.location.directory = "/foreign"
  if (failure === "carrier") f.source.metadata = { "codenomad.schedule-carrier": {} }
  if (failure === "own-family") f.source.metadata = { "codenomad.mission": { missionID: doc.id } }
  if (failure === "capacity") f.messages[0].text = "x".repeat(16384)
  const row = (await f.control.snapshot()).missions[0]
  await assert.rejects(f.control.lifecycle({ missionID: row.id, requestID: "blocked_play", expectedRevision: row.revision, action: "start" }), /context is incomplete/)
  assert.deepEqual(await f.read(), doc); assert.equal(f.admissions.length, 0)
  assert.equal((await f.control.snapshot()).missions[0].control, undefined)
})

test("lost first-Play document ACK retains frozen source bytes before journal publication", async () => {
  const f = await followedPreparationFixture()
  await f.control.configurePreparation({ ...f.request,
    configuration: { ...f.request.configuration, watchedConversationIDs: [f.source.id] } }, f.native, current)
  const row = (await f.control.snapshot()).missions[0]
  const input = { missionID: row.id, requestID: "lost_snapshot_ack", expectedRevision: row.revision, action: "start" as const }
  f.fail("document-after")
  await assert.rejects(f.control.lifecycle(input), /document-after/)
  const frozen = (await f.read()).oneTime!.firstPlay!.inputText
  assert.equal(f.admissions.length, 0); assert.equal(f.reads, 1)
  f.available(false)
  await assert.rejects(f.control.lifecycle({ ...input, requestID: "different_snapshot" }), /first Play is unresolved/)
  await f.control.lifecycle(input)
  assert.equal(f.admissions.length, 1); assert.equal(f.admissions[0].text, frozen)
  assert.equal(f.reads, 1); assert.equal((await f.read()).launchedCount, 1)
})

for (const timing of [{ kind: "every", intervalMs: 900000 }, { kind: "in", delayMs: 60000 },
  { kind: "at", at: Date.now() + 3600000, zone: "UTC" }] as MissionLaunchPolicy["timing"][]) {
  test(`never-launched immediate → ${timing.kind} → immediate retains its receipt, identity and paused state`, async () => {
    const f = await preparationFixture(), configuration = scheduledPreparation(f, timing)
    const converted = await f.control.configurePreparation({ ...f.request, configuration }, f.native, current)
    assert.equal(converted.id, f.original.id); assert.equal(converted.dormantJournal?.revision, f.mission.revision + 1)
    assert.equal(missionScheduleView(converted).document!.kind, "schedule")
    assert.equal(converted.firstPlayedAt, null); assert.equal(converted.state, "paused")
    assert.equal(converted.calendarOwner, null); assert.deepEqual(converted.calendars, []); assert.equal(f.admissions.length, 0)
    assert.equal((await f.control.create(f.creation)).mission.id, converted.id)
    const list = await f.control.list()
    assert.equal(list.missions.length, 0); assert.deepEqual(list.summaries, [])
    assert.equal((await f.control.mission(converted.id)).mission, undefined)
    const journal = (await f.control.snapshot()).missions[0]
    await assert.rejects(f.control.lifecycle({ missionID: journal.id, requestID: "wrong_play", expectedRevision: journal.revision, action: "start" }), /calendar owns/)
    await assert.rejects(f.control.update({ missionID: journal.id, requestID: "wrong_text", expectedRevision: journal.revision, objective: "wrong" }), /calendar owns/)
    await assert.rejects(f.control.delete({ missionID: journal.id, requestID: "wrong_delete", expectedRevision: journal.revision }), /calendar deletion/)
    const returned = await f.control.configurePreparation({ ...f.request, requestID: "return_immediate", expectedRevision: converted.revision }, f.native, current)
    assert.equal(returned.dormantJournal, null); assert.equal(returned.id, converted.id)
    assert.deepEqual({ ...returned.oneTime, coordinatorSessionID: f.original.oneTime!.coordinatorSessionID }, f.original.oneTime)
    const row = (await f.control.list()).missions[0]
    assert.equal(row.id, returned.id)
    const played = (await f.control.lifecycle({ missionID: row.id, requestID: "converted_play", expectedRevision: row.revision, action: "start" })).mission
    assert.equal(played.document!.launchedCount, 1); assert.equal(f.admissions.length, 1)
    assert.equal(f.admissions[0].sessionID, returned.oneTime!.coordinatorSessionID)
  })
}

for (const direction of ["to-calendar", "to-immediate"]) for (const fault of ["native-after", "journal-after", "document-before", "document-after"]) {
  test(`${direction}: lost ${fault} fences Play/text/Delete, resumes the original and never arms a calendar`, async () => {
    const f = await preparationFixture()
    if (direction === "to-immediate") await f.control.configurePreparation({ ...f.request, configuration: scheduledPreparation(f) }, f.native, current)
    const before = await f.read(), input = { ...f.request, requestID: "convert_original", expectedRevision: before.revision,
      configuration: direction === "to-immediate" ? f.request.configuration : scheduledPreparation(f) }
    f.fail(fault)
    await assert.rejects(f.control.configurePreparation(input, f.native, current), new RegExp(fault))
    const partial = await f.read(), journal = (await f.control.snapshot()).missions[0]
    if (partial.preparation!.pending) {
      await assert.rejects(f.control.lifecycle({ missionID: journal.id, requestID: "racing_play", expectedRevision: journal.revision, action: "start" }), /unresolved/)
      await assert.rejects(f.control.update({ missionID: journal.id, requestID: "racing_text", expectedRevision: journal.revision, objective: "wrong" }), /unresolved/)
      await assert.rejects(f.control.delete({ missionID: journal.id, requestID: "racing_delete", expectedRevision: journal.revision }), /pending|calendar deletion/)
      await assert.rejects(f.control.configurePreparation({ ...input, requestID: "bypass" }, f.native, current), /unresolved/)
    }
    const saved = await f.control.configurePreparation(input, f.native, current)
    assert.equal(saved.preparation!.pending, false); assert.equal(saved.firstPlayedAt, null)
    assert.deepEqual(saved.calendars, []); assert.equal(saved.calendarOwner, null); assert.equal(f.admissions.length, 0)
    assert.equal(f.created, direction === "to-immediate" ? 3 : 2)
    assert.deepEqual(await f.control.configurePreparation(input, f.native, current), saved)
  })
}

for (const purged of [false, true]) test(`dormant journal and document delete together; lost retirement/compaction ACK replays exactly (purged: ${purged})`, async () => {
  const f = await preparationFixture(), converted = await f.control.configurePreparation({ ...f.request, configuration: scheduledPreparation(f) }, f.native, current)
  const deletion = { missionID: converted.id, requestID: "delete_converted", expectedRevision: converted.revision, deleteManagedSessions: false }
  await f.store.withExclusion(async locked => {
    let doc = await locked.change(converted.id, converted.revision, current, value => {
      missionDocumentChanges.requestDeletion(value, deletion.requestID, Date.now(), { expectedRevision: deletion.expectedRevision, deleteManagedSessions: false })
      value.synchronization = null
    })
    await assert.rejects(locked.compact(doc.id, doc.revision, Date.now(), current), /pending/)
    let lost = true
    const storage = { ...f.storage, set: async (...args: Parameters<typeof f.storage.set>) => {
      await f.storage.set(...args)
      if (lost && (args[1] as { type?: string })?.type === "mission.deleted") { lost = false; throw new Error("lost retirement ACK") }
    } }
    await assert.rejects(deleteDormantMissionJournal(locked, storage, doc, current), /lost retirement ACK/)
    assert.equal((await f.control.snapshot()).missions.length, 0)
    if (purged) assert.equal(await new MissionJournal(storage, doc.projectID, doc.projectCanonical).purgeDeleted({ all: true }), 3)
    await deleteDormantMissionJournal(locked, storage, doc, current)
    const read = await locked.read(doc.id); assert.ok(read && !("deletedAt" in read)); doc = read
    assert.equal(doc.dormantJournal!.deleted, true)
    const compareAndSet = f.storage.compareAndSet
    let loseCompaction = true
    f.storage.compareAndSet = async (...args) => {
      await compareAndSet(...args)
      if (loseCompaction && args[1] && typeof args[1] === "object" && "deletedAt" in args[1]) {
        loseCompaction = false; throw new Error("lost compaction ACK")
      }
    }
    await assert.rejects(finishMissionDocumentDeletion(use => use(locked), use => use(locked), deletion, Date.now(), current, true), /pending/)
    await finishMissionDocumentDeletion(use => use(locked), use => use(locked), deletion, Date.now(), current, true)
  })
  const tombstone = await f.store.read(converted.id)
  assert.ok(tombstone && "deletedAt" in tombstone)
  assert.equal((await f.control.list()).missions.length, 0)
  assert.equal((await f.control.mission(converted.id)).mission, undefined)
  assert.equal((await f.control.snapshot()).discardedEvents, 0)
  await assert.rejects(f.control.create(f.creation), /deleted/)
  assert.equal(f.sessions.size, 2)
})

test("real preparation/calendar/passage owners: first Play arms only the converted policy; its first wake admits that frozen generation", async t => {
  const calendar = await ownerFixture(t), f = await preparationFixture(calendar.directory)
  const configuration = scheduledPreparation(f)
  let doc = await f.control.configurePreparation({ ...f.request, configuration }, f.native, current)
  assert.equal(calendar.calls.length, 0)
  doc = await f.store.change(doc.id, doc.revision, current, value => { value.scheduleActivation = { requestID: "activation", expectedRevision: value.revision,
    authority: "0".repeat(64), state: "ready", targets: [], effectiveOrigin: calendar.directory } })
  calendar.advance(2000)
  const owner = calendar.makeOwner(f.store)
  doc = await owner.control({ missionID: doc.id, requestID: "converted_first_play", expectedRevision: doc.revision, action: "play" })
  assert.equal(doc.calendarOwner!.operation.pending, false)
  assert.equal(doc.calendars.length, 2); assert.equal(f.admissions.length, 0)
  const principal = doc.calendars.find(item => item.role === "principal")!, native = calendar.calendars.get(principal.scheduleID)!
  assert.equal(native.when.type, "every"); assert.equal(native.nextDueAt, doc.firstPlayedAt! + 900000)
  const wake = { scheduleID: principal.scheduleID, run: 1, messageID: `msg_${principal.scheduleID}_1`, dueAt: native.nextDueAt! }
  let admissions = 0
  const engine = new MissionDocumentPassageEngine(f.store, { incarnation: "converted_owner", current, now: () => wake.dueAt,
    verifyWake: async () => ({ wake, current }), coverage: async () => ({ complete: true, wakes: [wake], current }),
    snapshot: async () => ({ changed: true, checkpoints: [], current }),
    admit: async value => {
      admissions++; assert.deepEqual(value.pending!.configuration, configuration)
      assert.equal(value.pending!.configurationGeneration, doc.configurationGeneration)
      assert.notEqual(value.pending!.coordinatorSessionID, doc.oneTime!.coordinatorSessionID)
      return { kind: "admitted", passageID: value.pending!.id, coordinatorSessionID: value.pending!.coordinatorSessionID, messageID: value.pending!.messageID, at: wake.dueAt }
    }, observe: async () => undefined })
  assert.equal(await engine.wake({ missionID: doc.id, wake: { ...wake, missionID: doc.id, generation: doc.timeGeneration, sessionID: principal.sessionID } }), "started")
  assert.equal((await f.read()).launchedCount, 1); assert.equal(admissions, 1)
  await assert.rejects(f.control.configurePreparation({ ...f.request, requestID: "after_play", expectedRevision: (await f.read()).revision }, f.native, current), /locked/)
  assert.equal((await f.control.list()).missions.length, 0)
})

test("event-only conversion retains its exact sources and return to immediate clears only a settled activation", async () => {
  const f = await preparationFixture(), configuration = scheduledPreparation(f, { kind: "immediate" })
  configuration.launch.condition = { kind: "files-changed", paths: ["src/example.ts"] }
  configuration.watchedConversationIDs = ["ses_followed"]
  let doc = await f.control.configurePreparation({ ...f.request, configuration }, f.native, current)
  assert.deepEqual(doc.configuration.launch.condition, configuration.launch.condition)
  assert.deepEqual(doc.configuration.watchedConversationIDs, configuration.watchedConversationIDs)
  assert.equal(doc.firstPlayedAt, null); assert.deepEqual(doc.checkpoints, [])
  doc = await f.store.change(doc.id, doc.revision, current, value => { value.scheduleActivation = {
    requestID: "ready_setting", expectedRevision: doc.revision, authority: "0".repeat(64), state: "ready", targets: [], effectiveOrigin: "/fixture" } })
  doc = await f.control.configurePreparation({ ...f.request, requestID: "keep_followed", expectedRevision: doc.revision,
    configuration: { ...f.request.configuration, watchedConversationIDs: configuration.watchedConversationIDs } }, f.native, current)
  assert.deepEqual(doc.configuration.watchedConversationIDs, ["ses_followed"])
  assert.equal(doc.dormantJournal, null); assert.equal(doc.scheduleActivation, null)
  assert.equal(doc.firstPlayedAt, null); assert.equal(f.admissions.length, 0)
  const row = (await f.control.snapshot()).missions[0]
  await assert.rejects(f.control.lifecycle({ missionID: doc.id, requestID: "unknown_sources", expectedRevision: row.revision, action: "start" }), /context unavailable/)
  assert.deepEqual(await f.read(), doc, "missing reader blocks before first-Play intent")
})

for (const expired of [false, true]) test(`converted immediate first Play freezes retained ends before admission (expired: ${expired})`, async () => {
  const f = await preparationFixture()
  const scheduled = await f.control.configurePreparation({ ...f.request, configuration: scheduledPreparation(f) }, f.native, current)
  const ends = { maxLaunches: 4, at: expired ? f.original.createdAt - 1 : null, afterMs: 3600000 }
  const doc = await f.control.configurePreparation({ ...f.request, requestID: "back_with_ends", expectedRevision: scheduled.revision,
    configuration: { ...f.request.configuration, launch: { ...f.request.configuration.launch, ends } } }, f.native, current)
  const mission = (await f.control.snapshot()).missions[0]
  const play = () => f.control.lifecycle({ missionID: doc.id, requestID: "play_with_ends", expectedRevision: mission.revision, action: "start" })
  if (expired) {
    await assert.rejects(play(), /slot end has passed/)
    assert.deepEqual(await f.read(), doc); assert.equal(f.admissions.length, 0)
  } else {
    await play()
    const played = await f.read()
    assert.equal(played.slotEndsAt, played.firstPlayedAt! + 3600000)
    assert.equal(played.launchedCount, 1); assert.equal(f.admissions.length, 1)
  }
})

import assert from "node:assert/strict"
import test from "node:test"
import { preparationFixture } from "./mission-preparation-test-fixture"
import { missionScheduleView } from "./mission-schedule-view"
import { isMissionCoordinatorSession } from "./session-identity"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX } from "./journal"
import { MISSION_MAX_EVENTS, missionLifecycleReserve } from "./model"

test("real preparation owner publishes journal/document/new empty coordinator and Play uses its new selection", async () => {
  const f = await preparationFixture()
  const changed = await f.control.configurePreparation(f.request, f.native, () => true)
  const mission = (await f.control.snapshot()).missions[0]
  assert.equal(mission.template, "delivery"); assert.equal(mission.title, "Edited title"); assert.equal(mission.taskMode, "independent")
  assert.deepEqual(mission.profiles, f.request.configuration.profiles)
  assert.notEqual(mission.coordinatorSessionId, f.mission.coordinatorSessionId)
  assert.ok(isMissionCoordinatorSession(mission.coordinatorSessionId, mission.id), "creation readback retains the Mission-derived ownership suffix")
  assert.equal(mission.coordinatorSessionId, changed.oneTime!.coordinatorSessionID)
  assert.deepEqual({ ...changed.oneTime, coordinatorSessionID: f.original.oneTime!.coordinatorSessionID }, f.original.oneTime)
  assert.equal(f.created, 2); assert.equal(f.admissions.length, 0); assert.equal(changed.firstPlayedAt, null)
  assert.equal(mission.runState, "prepared"); assert.equal(missionScheduleView(changed).document!.control!.pending, false)
  assert.deepEqual((await f.control.create(f.creation)).mission, mission, "creation replay preserves its immutable receipt")
  assert.deepEqual(await f.control.configurePreparation(f.request, f.native, () => true), changed)
  await assert.rejects(f.control.configurePreparation({ ...f.request, configuration: { ...f.request.configuration, title: "Conflicting" } }, f.native, () => true), /conflict/)
  const played = (await f.control.lifecycle({ missionID: mission.id, requestID: "play_edited", expectedRevision: mission.revision, action: "start" })).mission
  assert.equal(played.document!.launchedCount, 1)
  assert.equal(f.admissions[0].sessionID, mission.coordinatorSessionId)
  assert.deepEqual(f.admissions[0].profile.model, f.request.configuration.profiles.coordinator.model)
  assert.equal(f.admissions[0].profile.agent, "coordinator")
  assert.deepEqual(await f.control.configurePreparation(f.request, f.native, () => true), await f.read(), "completed replay is observation-only after Play")
})

for (const at of ["native-after", "journal-before", "journal-after", "document-before", "document-after"]) test(`lost ${at} keeps the original preparation; replay adopts exactly once`, async () => {
  const f = await preparationFixture(); f.fail(at)
  await assert.rejects(f.control.configurePreparation(f.request, f.native, () => true), new RegExp(at))
  const partial = await f.read()
  assert.equal(partial.preparation!.requestID, f.request.requestID)
  if (partial.preparation!.pending) {
    const mission = (await f.control.snapshot()).missions[0]
    await assert.rejects(f.control.lifecycle({ missionID: mission.id, requestID: "racing_play", expectedRevision: mission.revision, action: "start" }), /unresolved/)
    await assert.rejects(f.control.update({ missionID: mission.id, requestID: "racing_text", expectedRevision: mission.revision, objective: "Racing text" }), /unresolved/)
    await assert.rejects(f.control.delete({ missionID: mission.id, requestID: "racing_delete", expectedRevision: mission.revision }), /pending/)
    await assert.rejects(f.control.configurePreparation({ ...f.request, requestID: "new_identity" }, f.native, () => true), /unresolved/)
  }
  await f.control.configurePreparation(f.request, f.native, () => true)
  const saved = await f.read()
  assert.equal(saved.preparation!.pending, false); assert.equal(f.created, 2); assert.equal(f.sessions.size, 2); assert.equal(f.admissions.length, 0)
  const rows = (await f.control.list()).missions
  assert.equal(rows.length, 1); assert.equal(rows[0].id, f.mission.id); assert.equal(rows[0].revision, f.mission.revision + 1)
  await f.control.delete({ missionID: rows[0].id, expectedRevision: rows[0].revision, requestID: "delete_edited" })
  assert.equal((await f.control.snapshot()).missions.length, 0, "tombstone leaves no ghost journal row")
  assert.equal(f.sessions.size, 2, "both retained conversations survive deletion")
})

test("missing attempted replacement stays unknown; occupied old/new coordinators and stale revision stay locked", async () => {
  const f = await preparationFixture(); f.fail("native-after")
  await assert.rejects(f.control.configurePreparation(f.request, f.native, () => true))
  const doc = await f.read(), replacement = doc.preparation!.coordinatorSessionID
  f.sessions.delete(replacement)
  await assert.rejects(f.control.configurePreparation(f.request, f.native, () => true), /unconfirmed/)
  assert.equal(f.created, 2)
  const g = await preparationFixture()
  g.occupied.add(g.mission.coordinatorSessionId)
  await assert.rejects(g.control.configurePreparation(g.request, g.native, () => true), /not empty/)
  assert.equal((await g.read()).preparation, undefined)
  g.occupied.clear()
  await assert.rejects(g.control.configurePreparation({ ...g.request, expectedRevision: 100 }, g.native, () => true), /revision/)
  assert.equal(g.created, 1)
})

test("an omitted requested selection creates a fresh native-default coordinator, never switches an existing one", async () => {
  const f = await preparationFixture()
  const explicit = await f.control.configurePreparation(f.request, f.native, () => true)
  const { profiles: _profiles, ...configuration } = f.request.configuration
  const doc = await f.control.configurePreparation({ ...f.request, requestID: "return_to_defaults", expectedRevision: explicit.revision, configuration }, f.native, () => true)
  assert.equal(doc.configuration.profiles, undefined)
  assert.equal(f.sessions.get(doc.oneTime!.coordinatorSessionID)!.agent, "default-agent")
  assert.equal(f.sessions.get(explicit.oneTime!.coordinatorSessionID)!.agent, "coordinator")
  assert.equal(f.created, 3)
})

test("preparation refuses document-lock contention before native effects instead of waiting while holding the journal writer", async () => {
  const f = await preparationFixture()
  await f.store.withExclusion(async () => {
    await assert.rejects(f.control.configurePreparation(f.request, f.native, () => true), /busy/)
  })
  assert.equal(f.created, 1); assert.equal((await f.read()).preparation, undefined)
  await f.control.configurePreparation(f.request, f.native, () => true)
  assert.equal(f.created, 2)
})

test("an unresolved original payload is immutable and a changed replacement stays fenced", async () => {
  const f = await preparationFixture(); f.fail("native-after")
  await assert.rejects(f.control.configurePreparation(f.request, f.native, () => true))
  const partial = await f.read()
  await assert.rejects(f.store.change(partial.id, partial.revision, () => true, doc => { doc.preparation!.configuration.title = "Changed" }), /immutable/)
  f.occupied.add(partial.preparation!.coordinatorSessionID)
  await assert.rejects(f.control.configurePreparation(f.request, f.native, () => true), /not empty/)
  assert.equal(f.admissions.length, 0)
})

test("the exact durable preparation admits its execution budget before any native replacement read or creation", async () => {
  const f = await preparationFixture()
  let admitted = false
  const native = { ...f.native, read: async (id: string) => {
    if (id !== f.mission.coordinatorSessionId) assert.equal(admitted, true)
    return f.native.read(id)
  } }
  await f.control.configurePreparation(f.request, native, () => true, doc => {
    assert.equal(doc.preparation!.pending, true)
    assert.equal(doc.preparation!.requestID, f.request.requestID)
    assert.equal(doc.preparation!.expectedRevision, f.request.expectedRevision)
    admitted = true
  })
  assert.equal(admitted, true); assert.equal(f.created, 2)
})

test("an attached external coordinator keeps structural fields locked while journal text edits remain available", async () => {
  const f = await preparationFixture()
  f.sessions.set("ses_attached", { id: "ses_attached", projectID: "project", location: { directory: "/fixture" } })
  const mission = (await f.control.create({ requestID: "attached_creation", objective: "Attached work", template: "custom", coordinatorSessionID: "ses_attached" })).mission
  const doc = await f.store.read(mission.id)
  assert.ok(doc && !("deletedAt" in doc))
  assert.deepEqual(missionScheduleView(doc).document!.edit, { structural: false, template: false, reason: "journal", templateReason: "journal" })
  await assert.rejects(f.control.configurePreparation({ ...f.request, missionID: mission.id, expectedRevision: doc.revision }, f.native, () => true), /ownership/)
  const edited = (await f.control.update({ missionID: mission.id, requestID: "attached_text", expectedRevision: mission.revision, objective: "Updated attached work" })).mission
  assert.equal(edited.objective, "Updated attached work"); assert.equal(edited.coordinatorSessionId, "ses_attached")
  assert.equal(f.created, 1)
})

test("a full preparation refuses a replacement before native creation or document intent; replaced coordinators stay retained on cleanup", async () => {
  const f = await preparationFixture()
  const journal = new MissionJournal(f.storage, "project", "/fixture")
  const prefix = `${MISSION_JOURNAL_STORAGE_PREFIX}/${journal.projectToken}/${f.mission.id}/`
  for (let index = 0; [...f.values.keys()].filter(key => key.startsWith(prefix)).length < MISSION_MAX_EVENTS - missionLifecycleReserve(1, true) - 2; index++) {
    f.values.set(`${prefix}evt_capacity_${index}`, { version: 1, type: "mission.updated", id: `evt_capacity_${index}`,
      missionID: f.mission.id, projectID: "project", requestID: `capacity_${index}`, expectedRevision: index + 1,
      objective: "Prepared", notesSpecified: false, createdAt: f.mission.updatedAt + index + 1 })
  }
  await assert.rejects(f.control.configurePreparation(f.request, f.native, () => true), /safety limit/)
  assert.equal(f.created, 1)
  assert.equal((await f.read()).preparation, undefined)
  const g = await preparationFixture()
  await g.control.configurePreparation(g.request, g.native, () => true)
  const mission = (await g.control.snapshot()).missions[0]
  const result = await g.control.delete({ missionID: mission.id, requestID: "cleanup_replaced", expectedRevision: mission.revision, deleteManagedSessions: true })
  assert.deepEqual([result.cleanup?.removed, result.cleanup?.retained, result.cleanup?.pending], [0, 0, 0])
  assert.equal(g.sessions.size, 2)
  assert.ok(g.sessions.has(g.mission.coordinatorSessionId) && g.sessions.has(mission.coordinatorSessionId))
})

import assert from "node:assert/strict"
import test from "node:test"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { prepareMissionPassageText, recordMissionPassageText } from "../../missions/mission-passage-text"
import { MissionDocumentPassageEngine } from "../../missions/mission-document-passage-engine"
import { nativeScheduleOwnerControlReceipt } from "./native-schedule-owner"
import type { MissionStorage } from "../../missions/journal"
import { ownerFixture } from "./native-schedule-owner-test-fixture"

for (const paused of [false, true]) for (const archiveBeforeReplay of [false, true]) test(`an admitted ${paused ? "paused" : "running"} passage text edit survives lost ACK ${archiveBeforeReplay ? "and passage archive/reconciliation" : "with immediate exact replay"}, preserving tasks, identities, profiles and prompts`, async t => {
  const f = await ownerFixture(t)
  let doc = await f.control("play")
  doc = await f.store.change(doc.id, doc.revision, f.current, value => {
    changes.reserve(value, { kind: "manual", requestID: "manual_passage" }, f.now, [])
    changes.admitted(value, value.pending!.id, f.now)
  })
  const storage: MissionStorage = {
    get: async key => structuredClone(f.values.get(key)),
    set: async (key, value, guard) => { guard?.(); f.values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => ({ entries: [...f.values].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
      .sort(([a], [b]) => a < b ? -1 : 1).slice(0, limit).map(([key, value]) => ({ key, value })) }),
  }
  const passage = missionDocumentPassage(storage, doc, f.current), pending = structuredClone(doc.pending!)
  const base = { version: 1 as const, projectID: doc.projectID, missionID: pending.missionID, createdAt: f.now }
  await passage.journal.append({ ...base, type: "mission.created", id: "evt_creation", projectCanonical: doc.projectCanonical,
    objective: pending.configuration.objective, template: "custom", profiles: pending.configuration.profiles, taskMode: "native",
    coordinator: { sessionID: pending.coordinatorSessionID, title: "Coordinator", location: { directory: f.directory } } })
  await passage.journal.append({ ...base, type: "task.created", id: "evt_task", createdAt: f.now + 1,
    task: { id: "tsk_work", key: "work", title: "Work", brief: "Admitted brief", role: "specialist", blockedBy: [], execution: f.configuration.profiles!.roles!.specialist,
      executionMode: { kind: "native", parentTaskKey: null } } })
  await passage.journal.append({ ...base, type: "task.native-bound", id: "evt_binding", createdAt: f.now + 2, taskKey: "work",
    actor: { sessionID: "ses_child", title: "Child", managed: false, location: { directory: f.directory } },
    binding: { generation: 1, parentSessionID: pending.coordinatorSessionID, parentMessageID: "msg_call", toolCallID: "call_child" } })
  if (paused) doc = await f.control("pause")
  const before = (await passage.journal.snapshot()).missions[0]
  const textEdit = {
    prepareTextEdit: async (locked: typeof f.store, value: typeof doc, configuration: typeof doc.configuration) => {
      locked.assertActive(); return prepareMissionPassageText(storage, value, configuration, f.current, f.now + 3)
    },
    recordTextEdit: async (locked: typeof f.store, value: typeof doc, publish: boolean) => {
      locked.assertActive(); return recordMissionPassageText(storage, value, f.current, publish)
    },
  }
  const owner = f.makeOwner(f.store, textEdit)
  const input = { missionID: doc.id, expectedRevision: doc.revision, requestID: "edit_passage", action: "configure" as const,
    configuration: { ...doc.configuration, objective: "Updated contract", notes: "Updated notes" } }
  doc = await owner.control(input)
  const after = (await passage.journal.snapshot()).missions[0]
  assert.equal(doc.calendarOwner!.operation.pending, false)
  assert.equal(doc.configuration.objective, input.configuration.objective); assert.equal(doc.configuration.notes, input.configuration.notes)
  assert.deepEqual(doc.pending, pending)
  assert.equal(after.objective, input.configuration.objective); assert.equal(after.notes, input.configuration.notes)
  assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.actors, before.actors); assert.deepEqual(after.profiles, before.profiles)
  assert.equal(after.history.at(-1)!.source, "user"); assert.equal(after.history.at(-1)!.requestID, input.requestID)
  await owner.control(input)
  assert.equal((await passage.journal.snapshot()).missions[0].revision, after.revision, "exact replay does not duplicate history")
  assert.ok(f.calls.every(call => !/prompt|admit/.test(call)), "configuration never sends work")
  const changed = { ...input, requestID: "structural_refusal", expectedRevision: doc.revision,
    configuration: { ...input.configuration, title: "Cannot reconfigure admitted work" } }
  await assert.rejects(owner.control(changed), /locked/)
  assert.equal((await passage.journal.snapshot()).missions[0].revision, after.revision)
  const write = storage.set
  let lost = true
  storage.set = async (key, value, guard) => {
    if ((value as { type?: string }).type === "mission.updated") {
      const intent = (await f.read()).calendarOwner!.operation
      assert.equal(intent.requestID, "edit_lost_journal")
      assert.equal(intent.expectedRevision, doc.revision)
      assert.equal(intent.textEdit!.expectedJournalRevision, after.revision)
      assert.equal(intent.textEdit!.configuration.notes, "Retain original request")
    }
    await write(key, value, guard)
    if (lost && (value as { type?: string }).type === "mission.updated") { lost = false; throw new Error("Journal ACK lost") }
  }
  const uncertain = { ...input, requestID: "edit_lost_journal", expectedRevision: doc.revision,
    configuration: { ...input.configuration, notes: "Retain original request" } }
  await assert.rejects(owner.control(uncertain), /ACK lost/)
  assert.equal((await f.read()).configuration.notes, input.configuration.notes, "uncertain journal publication never acknowledges a future-only edit")
  assert.equal(nativeScheduleOwnerControlReceipt(await f.read(), uncertain.requestID)?.pending, true)
  await assert.rejects(owner.control({ ...uncertain, expectedRevision: uncertain.expectedRevision + 1 }), /request conflict/)
  await assert.rejects(owner.control({ ...uncertain, configuration: { ...uncertain.configuration, notes: "Another payload" } }), /request conflict/)
  await assert.rejects(owner.control({ ...uncertain, expectedRevision: (await f.read()).revision, requestID: "new_identity" }), /unresolved/)
  const held = await f.read()
  await assert.rejects(f.store.change(held.id, held.revision, f.current, value => {
    value.calendarOwner!.operation.textEdit!.configuration.notes = "Overwrite the original intent"
  }), /immutable/)
  const saved = [...f.values].find(([, value]) => (value as { requestID?: string }).requestID === uncertain.requestID
    && (value as { type?: string }).type === "mission.updated")!
  f.values.delete(saved[0])
  storage.set = async () => { throw new Error("Reconciliation must not publish a missing event") }
  const unconfirmed = await f.makeOwner(f.store, textEdit).reconcile(doc.id)
  assert.deepEqual(unconfirmed, held, "missing receipt keeps the exact intent, payload and future text unchanged")
  const checked = await f.makeOwner(f.store, textEdit).control({ missionID: doc.id, expectedRevision: unconfirmed.revision,
    requestID: "check_original_edit", action: "check" })
  assert.deepEqual(checked.calendarOwner!.operation, held.calendarOwner!.operation, "Check observes the original edit without replacing its identity")
  assert.equal(nativeScheduleOwnerControlReceipt(checked, uncertain.requestID)?.pending, true)
  f.values.set(...saved)
  storage.set = write
  if (archiveBeforeReplay) {
    await passage.journal.append({ ...base, id: "evt_finished", type: "mission.finished", outcome: "completed", summary: "Delivered", createdAt: f.now + 4 })
    const engine = new MissionDocumentPassageEngine(f.store, {
      incarnation: "text_edit_race", now: () => f.now + 5, current: f.current,
      verifyWake: async () => { throw new Error("No new wake") }, snapshot: async () => { throw new Error("No new passage") },
      coverage: async () => ({ complete: true, wakes: [], current: f.current }),
      admit: async value => {
        assert.deepEqual(value.pending, pending)
        return { kind: "recorded", passageID: pending.id, messageID: pending.messageID, coordinatorSessionID: pending.coordinatorSessionID, at: pending.admittedAt! }
      },
      observe: async () => {
        assert.equal((await passage.journal.snapshot()).missions[0].status, "completed")
        return { outcome: "completed", current: f.current }
      },
    })
    assert.equal(await engine.reconcile({ missionID: doc.id }), "settled")
    const archived = await f.read()
    assert.equal(archived.pending, null); assert.equal(archived.history[0].id, pending.id)
    assert.equal(archived.configuration.notes, input.configuration.notes)
    assert.equal(nativeScheduleOwnerControlReceipt(archived, uncertain.requestID)?.pending, true)
    storage.set = async (key, value, guard) => {
      assert.notEqual((value as { type?: string }).type, "mission.updated", "reconciliation only reads the original journal receipt")
      await write(key, value, guard)
    }
    // A freshly acquired owner recovers only the durable intent, after archive.
    await f.makeOwner(f.store, textEdit).reconcile(doc.id)
    assert.equal(nativeScheduleOwnerControlReceipt(await f.read(), uncertain.requestID)?.pending, false)
  }
  await f.makeOwner(f.store, textEdit).control(uncertain)
  const recovered = (await passage.journal.snapshot()).missions[0]
  assert.equal(recovered.history.filter(change => change.requestID === uncertain.requestID).length, 1)
  assert.equal(recovered.notes, uncertain.configuration.notes)
  const settled = await f.read()
  assert.equal(settled.configuration.notes, uncertain.configuration.notes)
  assert.deepEqual(settled.pending, archiveBeforeReplay ? null : pending)
  if (!archiveBeforeReplay) {
    const configuration = { ...settled.configuration }
    delete configuration.notes
    const cleared = await owner.control({ missionID: doc.id, requestID: "clear_notes", expectedRevision: settled.revision,
      action: "configure", configuration })
    assert.equal(cleared.configuration.notes, undefined)
    assert.equal((await passage.journal.snapshot()).missions[0].notes, undefined)
    assert.deepEqual(cleared.pending, pending)
  }
  assert.ok(f.calls.every(call => !/prompt|admit/.test(call)), "recovery never sends work")
})

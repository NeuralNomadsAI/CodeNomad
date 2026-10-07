import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import { MissionJournal, stableToken, type MissionStorage } from "./journal"
import { MISSION_SCHEMA_VERSION, type MissionCreatedEvent, type MissionJsonValue } from "./model"
import { archiveRecurrencePassage, type RecurrenceArchiveAuthorization } from "./recurrence-archive"
import { RECURRENCE_STORAGE_PREFIX, type RecurrenceConfig, type RecurrenceResult } from "./recurrence-contract"
import { recurrencePassage } from "./recurrence-passage"
import { MissionRecurrenceRunner, type RecurrenceAuthorizedAdmission } from "./recurrence-runner"
import { NativeMissionRecurrenceStore } from "./recurrence-store"

const projectID = "project", canonical = "/owned/project"
const config: RecurrenceConfig = {
  consigne: "Review", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
  profiles: { coordinator: { agent: "worker", model: { providerID: "provider", id: "model" } },
    roles: { specialist: { agent: "worker", model: { providerID: "provider", id: "model" } } } },
  taskMode: "native", roots: [{ mode: "directory-only", directory: canonical }],
  watchedConversationIDs: ["ses_watched"], publication: { policy: "draft-only", conversationIDs: [] },
}
async function fixture() {
  const values = new Map<string, MissionJsonValue>(), reads: string[] = []
  let active = true, now = Date.parse("2026-10-01T06:00:00Z"), effects = 0, preparation = () => {}
  const current = () => { if (!active) throw new Error("revoked") }
  const storage: MissionStorage = {
    get: async key => { reads.push(key); return structuredClone(values.get(key)) },
    set: async (key, value, fence) => { preparation(); fence?.(); values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      reads.push(prefix)
      const all = [...values].filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([a], [b]) => a < b ? -1 : 1)
      const entries = all.slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries, ...(all.length > limit ? { next: entries.at(-1)!.key } : {}) }
    },
  }
  const store = new NativeMissionRecurrenceStore(storage, projectID, canonical)
  let doc = await store.create("daily_review", config, now, current)
  doc = await store.setState(doc.id, doc.revision, "running", current)
  const created = (missionID: string, sessionID: string): MissionCreatedEvent => ({
    version: MISSION_SCHEMA_VERSION, type: "mission.created", id: "evt_created", projectID, missionID,
    projectCanonical: canonical, objective: "Review", template: "custom", profiles: config.profiles,
    taskMode: config.taskMode, coordinator: { sessionID, title: "Review", location: { directory: canonical } }, createdAt: now,
  })
  const admission: RecurrenceAuthorizedAdmission = {
    authorize: async () => current,
    admit: async (doc, beforeEffect) => {
      const fence = await beforeEffect()
      const scope = recurrencePassage(storage, doc, fence, () => now)
      await scope.journal.append(created(scope.missionID, `ses_${scope.passageID}`), fence)
      effects++
      return { kind: "accepted", passageID: scope.passageID, messageID: scope.messageID,
        missionID: scope.missionID, conversationID: `ses_${scope.passageID}` }
    },
  }
  const runner = new MissionRecurrenceRunner(store, admission, () => now)
  // Fixture authority only; production native terminal/reference reads remain
  // an external integration gate, distinct from admission.authorize("settle").
  const archiveAuthority: RecurrenceArchiveAuthorization = async () => current
  const result = async (): Promise<RecurrenceResult> => {
    const doc = (await store.read("daily_review"))!, ack = doc.pending!.admission!
    return { passageID: ack.passageID, messageID: ack.messageID, missionID: ack.missionID,
      conversationID: ack.conversationID, outcome: "completed", artifactMessageIDs: [ack.messageID],
      cursors: [{ conversationID: "ses_watched", messageID: ack.messageID }] }
  }
  const finish = async () => {
    const doc = (await store.read("daily_review"))!, scope = recurrencePassage(storage, doc, current, () => now)
    await scope.journal.append({ version: MISSION_SCHEMA_VERSION, type: "mission.finished", id: "evt_finished",
      projectID, missionID: scope.missionID, createdAt: now + 2, outcome: "completed", summary: "Done" }, current)
    return archiveRecurrencePassage(store, storage, doc.id, await result(), now + 3, archiveAuthority)
  }
  return { values, reads, storage, store, runner, admission, archiveAuthority, current, created, result, finish,
    get now() { return now }, set now(value: number) { now = value }, effects: () => effects,
    revokeDuringPreparation: () => { preparation = () => { active = false } } }
}

test("40 real passage journals archive 30 references without consuming ordinary map/event capacity or touching old bytes", async () => {
  const f = await fixture(), ordinary = new MissionJournal(f.storage, projectID, canonical, () => f.now)
  for (let index = 0; index < 20; index++) await ordinary.append(f.created(`msn_ordinary_${index}`, `ses_ordinary_${index}`))
  f.values.set("codenomad-missions/v1/do-not-touch", { original: true })
  f.values.set("codenomad-missions/authority-v2/do-not-touch", { original: true })
  const original = structuredClone([...f.values])
  let firstScope: ReturnType<typeof recurrencePassage> | undefined
  for (let day = 0; day < 40; day++) {
    f.now = Date.parse("2026-10-01T08:00:00Z") + day * 86_400_000
    assert.equal(await f.runner.tick("daily_review"), "accepted")
    const doc = (await f.store.read("daily_review"))!
    const scope = recurrencePassage(f.storage, doc, f.current, () => f.now)
    firstScope ??= scope
    assert.equal((await scope.journal.snapshot()).missions.length, 1)
    // Total passage history exceeds the ordinary 2000-event ceiling, while
    // each actual MissionJournal remains subject to its unchanged safety limit.
    for (let update = 0; update < 50; update++) await scope.journal.append({
      version: MISSION_SCHEMA_VERSION, type: "mission.updated", id: `evt_update_${String(update).padStart(3, "0")}`,
      projectID, missionID: scope.missionID, createdAt: f.now + 1, requestID: `update_${update}`,
      expectedRevision: update + 1, objective: "Review", notesSpecified: false,
    }, f.current)
    await f.finish()
  }
  const doc = (await f.store.read("daily_review"))!
  assert.equal(doc.history.length, 30)
  assert.equal(doc.settledCount, 40)
  assert.equal(doc.cursors.length, 1)
  assert.equal((await ordinary.snapshot()).missions.length, 20)
  for (const [key, value] of original) {
    if (!key.startsWith(`${RECURRENCE_STORAGE_PREFIX}/project/`)) assert.deepEqual(f.values.get(key), value)
  }
  assert.equal((await firstScope!.journal.snapshot()).missions[0].status, "completed", "rollover never deletes old passage evidence")
  assert.equal(await f.runner.tick(doc.id), "not-due")
  assert.ok(!f.reads.some(key => key.includes("do-not-touch")))
})

test("exact archive IDs, terminal journal and authority are required; unknown effects never expire or replay", async () => {
  const f = await fixture()
  f.now += 86_400_000
  assert.equal(await f.runner.tick("daily_review"), "accepted")
  const result = await f.result(), before = structuredClone([...f.values])
  for (const field of ["passageID", "messageID", "missionID", "conversationID"] as const) {
    await assert.rejects(archiveRecurrencePassage(f.store, f.storage, "daily_review", { ...result, [field]: "foreign" }, f.now, f.archiveAuthority), /identity conflict/)
  }
  await assert.rejects(archiveRecurrencePassage(f.store, f.storage, "daily_review", result, f.now, f.archiveAuthority), /unsettled/)
  await assert.rejects(archiveRecurrencePassage(f.store, f.storage, "daily_review", result, f.now,
    async () => { throw new Error("unowned") }), /unowned/)
  assert.deepEqual([...f.values], before)
  f.now += 400 * 86_400_000
  assert.equal(await f.runner.tick("daily_review"), "pending")
  assert.equal(f.effects(), 1)
  await f.finish()
})

test("scoped adapter rejects foreign keys/pages and repeats fences after native async preparation", async () => {
  const f = await fixture()
  f.now += 86_400_000
  await f.runner.tick("daily_review")
  const doc = (await f.store.read("daily_review"))!, scope = recurrencePassage(f.storage, doc, f.current)
  await assert.rejects(scope.journal.append(f.created("msn_foreign", "ses_foreign")), /scope conflict/)
  await assert.rejects(scope.storage.get("codenomad-missions/authority-v2/namespace"), /scope conflict/)
  const scan = f.storage.scan
  f.storage.scan = async () => ({ entries: [{ key: "foreign/key", value: {} }] })
  await assert.rejects(scope.journal.snapshot(), /placement/)
  f.storage.scan = scan
  const before = structuredClone([...f.values])
  f.revokeDuringPreparation()
  await assert.rejects(scope.journal.append({ ...f.created(scope.missionID, "ses_same"), id: "evt_late" }), /revoked/)
  assert.deepEqual([...f.values], before)
})

test("archive ACK loss retains durable references and original dedup without deleting or replaying", async () => {
  const f = await fixture()
  f.now += 86_400_000
  await f.runner.tick("daily_review")
  const nativeSet = f.storage.set
  f.storage.set = async (key, value, fence) => {
    await nativeSet(key, value, fence)
    if (key.startsWith(`${RECURRENCE_STORAGE_PREFIX}/project/`) && (value as { settledCount?: number }).settledCount === 1) {
      throw new Error("archive ACK lost")
    }
  }
  await assert.rejects(f.finish(), /ACK lost/)
  f.storage.set = nativeSet
  const doc = (await new NativeMissionRecurrenceStore(f.storage, projectID, canonical).read("daily_review"))!
  assert.equal(doc.pending, null)
  assert.equal(doc.history.length, 1)
  assert.equal(doc.cursors.length, 1)
  assert.equal(await f.runner.tick(doc.id), "not-due")
  assert.equal(f.effects(), 1)
  assert.equal([...f.values.keys()].filter(key => key.startsWith(`${RECURRENCE_STORAGE_PREFIX}/passages/`)).length, 2)
})

test("dedicated archive authority receives detached exact terminal/reference inputs; denial retains pending", async () => {
  const f = await fixture()
  f.now += 86_400_000
  await f.runner.tick("daily_review")
  const doc = (await f.store.read("daily_review"))!, result = await f.result()
  const before = structuredClone([...f.values])
  let checked = false
  await assert.rejects(archiveRecurrencePassage(f.store, f.storage, doc.id, result, f.now, async (document, proposed) => {
    checked = true
    assert.deepEqual(document, doc)
    assert.deepEqual(proposed, result)
    assert.notEqual(proposed, result)
    assert.notEqual(proposed.cursors, result.cursors)
    assert.notEqual(proposed.artifactMessageIDs, result.artifactMessageIDs)
    document.config.watchedConversationIDs.length = 0
    proposed.cursors[0].messageID = "msg_mutated"
    proposed.artifactMessageIDs.length = 0
    throw new Error("native reference provenance unknown")
  }), /provenance unknown/)
  assert.equal(checked, true)
  assert.deepEqual([...f.values], before)
  assert.equal(result.cursors[0].messageID, result.messageID)
  assert.deepEqual(result.artifactMessageIDs, [result.messageID])
  await f.finish()
})

test("real native-return reports need no coordinator notification, while routed reports still block archive", async () => {
  for (const delivery of ["native-return", "coordinator-notification"] as const) {
    const f = await fixture()
    f.now += 86_400_000
    await f.runner.tick("daily_review")
    const doc = (await f.store.read("daily_review"))!, scope = recurrencePassage(f.storage, doc, f.current)
    const base = { version: MISSION_SCHEMA_VERSION, projectID, missionID: scope.missionID }
    const binding = { generation: 1, parentSessionID: doc.pending!.admission!.conversationID,
      parentMessageID: "msg_parent", toolCallID: "call_native" }
    await scope.journal.append({ ...base, id: "evt_task", createdAt: f.now + 1, type: "task.created",
      task: { id: "tsk_work", key: "work", title: "Work", brief: "Review", role: "specialist", blockedBy: [],
        executionMode: { kind: "native", parentTaskKey: null } } })
    await scope.journal.append({ ...base, id: "evt_bound", createdAt: f.now + 2, type: "task.native-bound",
      taskKey: "work", actor: { sessionID: "ses_child", title: "Child", managed: true, location: { directory: canonical } }, binding })
    await scope.journal.append({ ...base, id: "evt_report", createdAt: f.now + 3, type: "task.reported",
      report: { id: "rpt_work", taskKey: "work", sessionId: "ses_child", outcome: "completed", summary: "Done",
        evidence: [], next: [], createdAt: f.now + 3, nativeCall: binding, delivery } })
    await scope.journal.append({ ...base, id: "evt_return", createdAt: f.now + 4, type: "task.native-call-ended",
      taskKey: "work", childSessionID: "ses_child", binding, outcome: "returned" })
    f.now += 10
    const mission = (await scope.journal.snapshot()).missions[0]
    assert.equal(mission.reports[0].notificationStatus, "pending")
    assert.equal(mission.tasks[0].nativeExecution?.ended, "returned")
    if (delivery === "native-return") assert.equal((await f.finish()).pending, null)
    else {
      await assert.rejects(f.finish(), /unsettled journal/)
      assert.ok((await f.store.read(doc.id))!.pending)
    }
  }
})

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("archive and real MissionControl deletion/cleanup share the business lock through ledger finish", async () => {
  for (const order of ["archive-first", "delete-first"] as const) {
    const f = await fixture()
    f.now += 86_400_000
    await f.runner.tick("daily_review")
    const doc = (await f.store.read("daily_review"))!, result = await f.result()
    const scope = recurrencePassage(f.storage, doc, f.current)
    const base = { version: MISSION_SCHEMA_VERSION, projectID, missionID: scope.missionID }
    const taskID = "tsk_cleanup", childID = `ses_${stableToken(`${scope.missionID}\0task\0${taskID}`, 26)}`
    await scope.journal.append({ ...base, id: "evt_task", createdAt: f.now + 1, type: "task.created",
      task: { id: taskID, key: "cleanup", title: "Work", brief: "Work", role: "specialist", blockedBy: [] } })
    await scope.journal.append({ ...base, id: "evt_dispatch", createdAt: f.now + 2, type: "task.dispatching",
      taskKey: "cleanup", admissionID: "msg_child", delivery: "queue",
      actor: { sessionID: childID, title: "Child", managed: true, location: { directory: canonical } } })
    await scope.journal.append({ ...base, id: "evt_finished", createdAt: f.now + 3, type: "mission.finished",
      outcome: "completed", summary: "Done" })
    const mission = (await scope.journal.snapshot()).missions[0]
    const cleanupEntered = signal(), releaseCleanup = signal(), archiveValidated = signal(), releaseArchive = signal()
    let authorized = false
    const control = new MissionControl({ project: { id: projectID, canonical, location: { directory: canonical } },
      storage: scope.storage, now: () => f.now + 10,
      sessions: { get: async () => { throw new Error("Unexpected native read") },
        create: async () => { throw new Error("Unexpected native create") }, prompt: async () => {}, synthetic: async () => {} },
      transport: { prompt: async () => {}, synthetic: async () => {}, cleanup: async () => {
        cleanupEntered.resolve()
        await releaseCleanup.promise
        throw new Error("Unknown cleanup; preserve conversation")
      } },
    })
    const remove = () => control.delete({ missionID: scope.missionID, requestID: "explicit_delete",
      expectedRevision: mission.revision, deleteManagedSessions: true })
    const archive = () => archiveRecurrencePassage(f.store, f.storage, doc.id, result, f.now + 20, async () => {
      authorized = true
      return f.current
    })
    if (order === "archive-first") {
      const read = f.store.read.bind(f.store)
      let reads = 0
      f.store.read = async id => {
        if (++reads === 2) { archiveValidated.resolve(); await releaseArchive.promise }
        return read(id)
      }
      const archiving = archive()
      await archiveValidated.promise // after journal validation, before finish
      const deleting = remove(), deleted = assert.rejects(deleting, /cleanup is pending/)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal((await scope.journal.events()).events.some(event => event.type === "mission.deleted"), false)
      releaseArchive.resolve()
      assert.equal((await archiving).pending, null)
      await cleanupEntered.promise
      releaseCleanup.resolve()
      await deleted
    } else {
      const deleting = remove(), deleted = assert.rejects(deleting, /cleanup is pending/)
      await cleanupEntered.promise
      const archiving = archive(), rejected = assert.rejects(archiving, /unsettled journal/)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(authorized, false, "archive cannot enter while deletion/cleanup owns the business lock")
      assert.ok((await f.store.read(doc.id))!.pending)
      releaseCleanup.resolve()
      await deleted
      await rejected
      assert.ok((await f.store.read(doc.id))!.pending, "pending cannot clear from a stale pre-deletion journal")
    }
    assert.equal((await scope.journal.snapshot()).cleanups?.[0].pending, 1)
  }
})

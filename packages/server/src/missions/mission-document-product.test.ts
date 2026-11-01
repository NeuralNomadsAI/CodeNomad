import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { MissionControl } from "./control"
import type { NativeMissionSession } from "./control-types"
import { MissionJournal, type MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "./mission-document-store"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { controlResumeAdmissionID, controlReceiptID } from "./receipt-identity"
import { applyMissionDocumentActivation as activate } from "./mission-document-activation-rpc"
import { canonicalAuthority } from "./authority-protocol"
import { parseMissionDocument, MISSION_DOCUMENT_PREFIX } from "./mission-document"
import { MISSION_LIFECYCLE_TEXT_LIMIT } from "./lifecycle-input"
import { missionIsRunning } from "./lifecycle-model"
import { missionWorkRemains } from "../opencode/missions/lifetime"

const applyMissionDocumentActivation = (store: Parameters<typeof activate>[0], input: unknown, current: () => true) =>
  activate(store, input, current, "/project")

function fixture(unified = true) {
  const values = new Map<string, MissionJsonValue>(), sessions = new Map<string, NativeMissionSession>()
  let now = 1_790_000_000_000, created = 0, failJournal = false, loseAdmission = false, failReceipt = false, transportCalls = 0
  let failDeleteJournal = false, failCompaction = false, loseCompaction = false, failCleanup = false, cleanupCalls = 0
  let failReadAfterDelete = false, failDocumentRead = false, failDocumentReceipt = false
  const admissions = new Map<string, unknown>()
  const storage: MissionStorage & MissionDocumentStorage = {
    get: async key => {
      if (failDocumentRead && key.includes("documents-v1") && key.includes("/missions/")) {
        failDocumentRead = false; throw new Error("document read unavailable")
      }
      return structuredClone(values.get(key))
    },
    set: async (key, value, guard) => {
      guard?.()
      if (failJournal && value && typeof value === "object" && "type" in value && value.type === "mission.created") {
        failJournal = false; throw new Error("lost journal write")
      }
      if (failReceipt && value && typeof value === "object" && "type" in value && value.type === "mission.control-applied") {
        failReceipt = false; throw new Error("lost receipt write")
      }
      if (failDeleteJournal && value && typeof value === "object" && "type" in value && value.type === "mission.deleted") {
        failDeleteJournal = false; throw new Error("lost deletion write")
      }
      if (failDocumentReceipt && value && typeof value === "object" && "type" in value && value.type === "mission.document-cleaned") {
        failDocumentReceipt = false; throw new Error("lost document receipt write")
      }
      values.set(key, structuredClone(value))
      if (failReadAfterDelete && value && typeof value === "object" && "type" in value && value.type === "mission.deleted") {
        failReadAfterDelete = false; failDocumentRead = true
      }
    },
    compareAndSet: async (key, value, expected, guard) => {
      guard()
      if (((values.get(key) as { revision: number } | undefined)?.revision ?? null) !== expected) throw new Error("CAS conflict")
      const compaction = value && typeof value === "object" && "deletedAt" in value
      if (compaction && failCompaction) { failCompaction = false; throw new Error("compaction failed") }
      values.set(key, structuredClone(value))
      if (compaction && loseCompaction) { loseCompaction = false; throw new Error("compaction reply lost") }
    },
    scan: async ({ prefix, after, limit = 100 }) => {
      const all = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a < b ? -1 : 1)
      const entries = all.slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries, ...(all.length > limit ? { next: entries.at(-1)!.key } : {}) }
    },
    remove: async key => { values.delete(key) },
  }
  const documents = new NativeMissionDocumentStore(storage, "project", "/project")
  const journal = new MissionJournal(storage, "project", "/project")
  const access = <T>(use: (store: NativeMissionDocumentStore) => Promise<T>) => use(documents)
  const options: ConstructorParameters<typeof MissionControl>[0] = { project: { id: "project", canonical: "/project", location: { directory: "/project" } },
    storage, documents: unified ? access : undefined, documentReads: unified ? access : undefined, now: () => now,
    sessions: { get: async ({ sessionID }) => { const session = sessions.get(sessionID); if (!session) throw new Error("not found"); return session },
      create: async input => { created++; const session = { ...input, projectID: "project" }; sessions.set(session.id, session); return session },
      prompt: async () => assert.fail("creation must never prompt"), synthetic: async () => assert.fail("use lifecycle transport") },
    transport: { prompt: async () => assert.fail("unexpected prompt"), synthetic: async () => assert.fail("unexpected synthetic"),
      cleanup: async () => {
        cleanupCalls++
        if (failCleanup) { failCleanup = false; throw new Error("native cleanup unknown") }
        return { outcome: "retained", reason: "guarded" }
      },
      lifecycle: async (_coordinator, input) => {
        transportCalls++
        const mission = (await control.snapshot()).missions.find(value => value.id === input.missionID)!, operation = mission.control!
        if (mission.document) assert.equal(mission.document.firstPlayedAt !== null, true, "durable consent precedes admission")
        if (operation.action !== "start") return { nativeAcknowledgement: { missionID: mission.id, operationID: operation.id,
          sessionID: input.sessionID, action: operation.action, disposition: "interrupt-observed", interrupt: { interrupted: true }, cancellations: [] } }
        const id = controlResumeAdmissionID(operation.id, input.sessionID)
        const admission = admissions.get(id) ?? { id, sessionID: input.sessionID, type: "synthetic", delivery: "queue", time: { created: now },
          payload: { text: "Start original mission", metadata: { "codenomad.mission": { version: 1, kind: "lifecycle", missionID: mission.id, operationID: operation.id } } } }
        admissions.set(id, admission)
        if (loseAdmission) { loseAdmission = false; throw new Error("native ACK lost") }
        return { nativeAcknowledgement: { missionID: mission.id, operationID: operation.id, sessionID: input.sessionID,
          action: "start", disposition: "start-admitted", admission } }
      } },
  }
  const control: MissionControl = new MissionControl(options)
  return { control, documents, journal, values, admissions, sessions, access, get created() { return created },
    get transportCalls() { return transportCalls }, failReceipt: () => { failReceipt = true },
    get cleanupCalls() { return cleanupCalls }, failCleanup: () => { failCleanup = true },
    continueWithDocuments: (documents = access) => new MissionControl({ ...options, documents, documentReads: access }),
    failDelete: () => { failDeleteJournal = true }, failCompact: () => { failCompaction = true }, loseCompact: () => { loseCompaction = true },
    failReadAfterDelete: () => { failReadAfterDelete = true }, failDocumentReceipt: () => { failDocumentReceipt = true },
    advance: () => { now += 60_000 }, failCreation: () => { failJournal = true }, loseAdmission: () => { loseAdmission = true } }
}

test("product create is paused, projects the stored document and Play replays one original admission", async () => {
  const f = fixture(), input = { requestID: "create-original", objective: "Do useful work", template: "custom" as const }
  const first = (await f.control.create(input)).mission
  assert.equal(first.runState, "prepared")
  assert.equal(first.document!.state, "paused")
  assert.equal(first.document!.firstPlayedAt, null)
  assert.equal(f.admissions.size, 0)
  assert.equal(f.created, 1, "an unprompted coordinator is permitted")
  assert.deepEqual((await f.control.create(input)).mission, first)
  assert.equal(f.created, 1)
  const request = { missionID: first.id, requestID: "play-original", expectedRevision: first.revision, action: "start" as const }
  const played = (await f.control.lifecycle(request)).mission
  assert.equal(played.document!.launchedCount, 1)
  assert.equal(played.document!.firstPlay!.requestID, request.requestID)
  assert.ok(played.document!.firstPlay!.admittedAt !== null)
  await f.control.lifecycle(request)
  assert.equal(f.admissions.size, 1)
  const ajv = new Ajv({ allErrors: true }), validate = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.lifecycle.output)
  assert.equal(validate({ mission: played }), true, JSON.stringify(validate.errors))
  const listed = await f.control.list(), read = await f.control.mission(first.id)
  for (const [method, value] of [["list", listed], ["mission", read]] as const) {
    const valid = ajv.compile(CODENOMAD_MISSIONS_RPC.methods[method].output)
    assert.ok(valid(value), JSON.stringify(valid.errors))
  }
  for (const compact of [listed.missions[0], read.mission!]) {
    assert.deepEqual(compact.document, played.document, "bounded document metadata survives compaction whole")
    assert.equal("objective" in compact, false)
    assert.ok(compact.bodies?.objective)
    assert.equal("inputText" in compact.document!.firstPlay!, false)
  }
  const full = (await f.control.snapshot()).missions[0]
  assert.equal(full.objective, input.objective)
  assert.equal(full.bodies, undefined, "internal snapshots stay full")
  assert.deepEqual(full.document, played.document)
  await assert.rejects(f.control.lifecycle({ ...request, requestID: "second-play" }), /reload|valid|conflict/i)
  assert.equal(f.admissions.size, 1)
  const declared = await f.control.declare(first.coordinatorSessionId, { missionID: first.id, taskKey: "review", title: "Review", brief: "Review work",
    role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } })
  assert.equal(declared.mission.document!.everCreatedTask, true)
})

test("existing user objective/notes updates keep unified stored configuration current without prompting", async () => {
  const f = fixture(), mission = (await f.control.create({ requestID: "create-original", objective: "Work", template: "custom" })).mission
  const update = { missionID: mission.id, requestID: "edit-original", expectedRevision: mission.revision, objective: "Clarified work", notes: "Keep this note" }
  const changed = (await f.control.update(update)).mission
  assert.equal(changed.document!.configurationGeneration, 2)
  const saved = await f.documents.read(mission.id)
  assert.ok(saved && !("deletedAt" in saved))
  assert.equal(saved.configuration.objective, update.objective)
  assert.equal(saved.configuration.notes, update.notes)
  assert.equal(f.admissions.size, 0)
  assert.equal((await f.control.update(update)).mission.document!.configurationGeneration, 2)
})

test("coordinator inspect-start uses unified paused creation and exact native-call replay without creating another root", async () => {
  const f = fixture(), sessionID = "ses_attached"
  f.sessions.set(sessionID, { id: sessionID, projectID: "project", location: { directory: "/project" }, title: "Existing conversation" })
  const input = { start: { objective: "Plan useful work", template: "custom" as const } }
  const first = (await f.control.inspect(sessionID, input, "call-original")).mission!
  assert.equal(first.runState, "prepared")
  assert.equal(first.document!.firstPlayedAt, null)
  assert.equal(first.coordinatorSessionId, sessionID)
  assert.deepEqual((await f.control.inspect(sessionID, input, "call-original")).mission, first)
  assert.equal(f.created, 0)
  assert.equal(f.admissions.size, 0)
})

test("lost creation publication keeps stable coordinator identity and refuses a conflicting original request", async () => {
  const f = fixture(), input = { requestID: "create-original", objective: "Do useful work", template: "custom" as const }
  f.failCreation()
  await assert.rejects(f.control.create(input), /lost journal/)
  const originalSession = [...f.sessions.keys()][0]
  f.advance()
  await assert.rejects(f.control.create({ ...input, objective: "changed" }), /different|request|used/i)
  assert.equal(f.created, 1)
  const mission = (await f.control.create(input)).mission
  assert.equal(mission.coordinatorSessionId, originalSession)
  assert.equal(f.created, 1)
  assert.equal(mission.document!.firstPlayedAt, null)
  assert.equal(f.admissions.size, 0)
})

test("lost Play acknowledgement retains original durable request and counts exact native readback once", async () => {
  const f = fixture(), mission = (await f.control.create({ requestID: "create-original", objective: "Work", template: "custom" })).mission
  const request = { missionID: mission.id, requestID: "play-original", expectedRevision: mission.revision, action: "start" as const }
  f.loseAdmission()
  await assert.rejects(f.control.lifecycle(request), /retry/)
  const uncertain = (await f.control.snapshot()).missions[0]
  assert.equal(uncertain.document!.launchedCount, 0)
  assert.equal(uncertain.document!.firstPlay!.admittedAt, null)
  assert.equal(f.admissions.size, 1)
  await assert.rejects(f.control.lifecycle({ ...request, requestID: "different", expectedRevision: uncertain.revision }), /pending/)
  const replayed = (await f.control.lifecycle(request)).mission
  assert.equal(replayed.document!.launchedCount, 1)
  assert.equal(replayed.document!.firstPlay!.messageID, [...f.admissions.keys()][0])
  assert.equal(f.admissions.size, 1)
})

test("recorded first-Play ACK repairs a lost journal receipt after native history pruning without transport; Resume still sends normally", async () => {
  const f = fixture(), mission = (await f.control.create({ requestID: "create-ack-gap", objective: "Work", template: "custom" })).mission
  const request = { missionID: mission.id, requestID: "play-ack-gap", expectedRevision: mission.revision, action: "start" as const }
  f.failReceipt()
  await assert.rejects(f.control.lifecycle(request), /retry/)
  const doc = await f.documents.read(mission.id)
  assert.ok(doc && !("deletedAt" in doc))
  const play = doc.oneTime!.firstPlay!, acknowledgement = structuredClone(play.acknowledgement!)
  assert.equal(doc.launchedCount, 1)
  assert.ok(play.admittedAt !== null)
  assert.equal(f.transportCalls, 1)
  assert.deepEqual(acknowledgement.admission, f.admissions.get(play.messageID))
  assert.equal((await f.control.snapshot()).missions[0].control!.pending.length, 1)
  assert.equal("acknowledgement" in (await f.control.snapshot()).missions[0].document!.firstPlay!, false)
  f.admissions.clear()
  f.advance()
  const repaired = (await f.control.lifecycle(request)).mission
  assert.equal(f.transportCalls, 1, "durable admission forbids every further original transport call")
  assert.equal(f.admissions.size, 0, "a pruned native message is never recreated")
  assert.equal(repaired.document!.launchedCount, 1)
  assert.deepEqual(repaired.control!.pending, [])
  assert.equal(repaired.control!.receipts![0].receiptID, controlReceiptID(play.operationID, mission.coordinatorSessionId))
  assert.deepEqual(repaired.control!.receipts![0].nativeAcknowledgement, acknowledgement)
  const validate = new Ajv({ allErrors: true }).compile(CODENOMAD_MISSIONS_RPC.methods.lifecycle.output)
  assert.equal(validate({ mission: repaired }), true, JSON.stringify(validate.errors))
  await assert.rejects(f.documents.change(doc.id, doc.revision, () => true, next => {
    next.oneTime!.firstPlay!.acknowledgement!.admission.payload.text = "Replacement acknowledgement"
  }), /monotone/)
  const paused = (await f.control.lifecycle({ missionID: mission.id, requestID: "pause-after-repair", expectedRevision: repaired.revision, action: "pause" })).mission
  const resumed = (await f.control.lifecycle({ missionID: mission.id, requestID: "resume-new-operation", expectedRevision: paused.revision, action: "start" })).mission
  assert.equal(f.transportCalls, 3, "Pause and the distinct Resume retain their ordinary transport path")
  assert.notEqual(resumed.control!.id, play.operationID)
  assert.equal(resumed.document!.launchedCount, 1)
  const saved = await f.documents.read(mission.id)
  assert.ok(saved && !("deletedAt" in saved))
  assert.deepEqual(saved.oneTime!.firstPlay!.acknowledgement, acknowledgement)
})

test("stored first-Play evidence is bounded, identity-correlated and mandatory once admitted; invalid storage never authorizes resend", async () => {
  const f = fixture(), mission = (await f.control.create({ requestID: "create-validated-ack", objective: "Work", template: "custom" })).mission
  const request = { missionID: mission.id, requestID: "play-validated-ack", expectedRevision: mission.revision, action: "start" as const }
  f.failReceipt()
  await assert.rejects(f.control.lifecycle(request), /retry/)
  const doc = await f.documents.read(mission.id)
  assert.ok(doc && !("deletedAt" in doc))
  const mutations = [
    (value: typeof doc) => { value.oneTime!.firstPlay!.acknowledgement!.missionID = "wrong-mission" },
    (value: typeof doc) => { value.oneTime!.firstPlay!.acknowledgement!.sessionID = "ses_wrong" },
    (value: typeof doc) => { value.oneTime!.firstPlay!.acknowledgement!.operationID = "wrong-operation" },
    (value: typeof doc) => { value.oneTime!.firstPlay!.acknowledgement!.admission.id = "msg_wrong" },
    (value: typeof doc) => { value.oneTime!.firstPlay!.acknowledgement!.admission.payload.text = "x".repeat(MISSION_LIFECYCLE_TEXT_LIMIT + 1) },
    (value: typeof doc) => { value.oneTime!.firstPlay!.admittedAt!++ },
    (value: typeof doc) => { value.oneTime!.firstPlay!.acknowledgement = null },
  ]
  for (const mutate of mutations) {
    const invalid = structuredClone(doc)
    mutate(invalid)
    assert.throws(() => parseMissionDocument(invalid, doc))
  }
  const maximum = structuredClone(doc)
  maximum.oneTime!.firstPlay!.acknowledgement!.admission.payload.text = "x".repeat(MISSION_LIFECYCLE_TEXT_LIMIT)
  assert.equal(parseMissionDocument(maximum, doc).oneTime!.firstPlay!.acknowledgement!.admission.payload.text.length, MISSION_LIFECYCLE_TEXT_LIMIT)
  const missing = JSON.parse(JSON.stringify(doc))
  delete missing.oneTime.firstPlay.acknowledgement
  const key = [...f.values.keys()].find(key => key.includes("documents-v1") && key.endsWith(mission.id))!
  f.values.set(key, missing)
  f.admissions.clear()
  const bytes = canonicalAuthority([...f.values])
  await assert.rejects(f.control.lifecycle(request))
  assert.equal(f.transportCalls, 1)
  assert.equal(f.admissions.size, 0)
  assert.equal(canonicalAuthority([...f.values]), bytes, "missing proof is retained without migration or repair")
})

test("journal-only missions retain Play/Pause/Resume, declarations, native continuation and final report without conversion", async () => {
  const f = fixture(false), input = { requestID: "create-original", objective: "Work", template: "custom" as const, prepared: true }
  const mission = (await f.control.create(input)).mission
  const control = f.continueWithDocuments()
  const before = canonicalAuthority([...f.values])
  const projected = (await control.snapshot()).missions[0]
  assert.equal(projected.document, undefined)
  assert.equal(projected.controlUnavailable, undefined)
  assert.equal((await control.list()).missions[0].controlUnavailable, undefined)
  assert.equal((await control.mission(mission.id)).mission!.controlUnavailable, undefined)
  assert.equal(missionIsRunning({ ...projected, runState: "running" }), true)
  assert.equal((await control.create(input)).mission.id, mission.id)
  assert.equal(canonicalAuthority([...f.values]), before)
  let current = (await control.lifecycle({ missionID: mission.id, requestID: "play-existing", expectedRevision: mission.revision, action: "start" })).mission
  current = (await control.lifecycle({ missionID: mission.id, requestID: "pause-existing", expectedRevision: current.revision, action: "pause" })).mission
  current = (await control.lifecycle({ missionID: mission.id, requestID: "resume-existing", expectedRevision: current.revision, action: "start" })).mission
  for (const [taskKey, reuseFromTaskKey] of [["first", undefined], ["continued", "first"]] as const) {
    await control.declare(mission.coordinatorSessionId, { missionID: mission.id, taskKey, title: taskKey, brief: "Continue work", role: "specialist", blockedBy: [],
      executionMode: { kind: "native", parentTaskKey: null, ...(reuseFromTaskKey ? { reuseFromTaskKey } : {}) } })
    await control.report(mission.coordinatorSessionId, { missionID: mission.id, taskKey, outcome: "completed", summary: "Done", evidence: [], next: [], final: false })
  }
  const result = await control.report(mission.coordinatorSessionId, { missionID: mission.id, outcome: "completed", summary: "Delivered", evidence: [], next: [], final: true })
  assert.equal(result.mission.status, "completed")
  assert.equal([...f.values.keys()].some(key => key.includes("documents-v1")), false)
  assert.equal(f.created, 1)
  assert.ok(f.sessions.has(mission.coordinatorSessionId))
})

test("journal-only Stop and inspect-start replay preserve their exact current journal identities", async () => {
  const f = fixture(false), sessionID = "ses_existing"
  f.sessions.set(sessionID, { id: sessionID, projectID: "project", location: { directory: "/project" } })
  const input = { start: { objective: "Work", template: "custom" as const } }
  const original = (await f.control.inspect(sessionID, input, "original-call")).mission!
  const control = f.continueWithDocuments()
  assert.equal((await control.inspect(sessionID, input, "original-call")).mission!.id, original.id)
  const stopped = (await control.lifecycle({ missionID: original.id, requestID: "stop-existing", expectedRevision: original.revision, action: "stop" })).mission
  assert.equal(stopped.status, "stopped")
  assert.equal(stopped.document, undefined)
  assert.equal([...f.values.keys()].some(key => key.includes("documents-v1")), false)
})

test("existing running missions remain controllable without the new SQL capability, while new unified creation still fails safely", async () => {
  const f = fixture(false), input = { requestID: "existing-running", objective: "Work", template: "custom" as const }
  const original = (await f.control.create(input)).mission
  const control = f.continueWithDocuments(async () => { throw new Error("Document SQL unavailable") })
  assert.equal((await control.create(input)).mission.runState, "running")
  let current = (await control.lifecycle({ missionID: original.id, requestID: "pause-running", expectedRevision: original.revision, action: "pause" })).mission
  current = (await control.lifecycle({ missionID: original.id, requestID: "resume-running", expectedRevision: current.revision, action: "start" })).mission
  current = (await control.lifecycle({ missionID: original.id, requestID: "stop-running", expectedRevision: current.revision, action: "stop" })).mission
  await control.delete({ missionID: original.id, requestID: "delete-running", expectedRevision: current.revision })
  await assert.rejects(control.create({ requestID: "new-unified", objective: "New work", template: "custom" }), /Document SQL unavailable/)
  assert.equal(f.created, 1)
  assert.equal([...f.values.keys()].some(key => key.includes("documents-v1")), false)
})

test("product deletion compacts the existing document, retains exact replay options and preserves native conversations", async () => {
  const f = fixture(), creation = { requestID: "create-delete", objective: "Work", template: "custom" as const, prepared: true }
  const mission = (await f.control.create(creation)).mission
  const input = { missionID: mission.id, requestID: "d".repeat(128), expectedRevision: mission.revision }
  assert.equal((await f.control.delete(input)).cleanup!.documentPending, false)
  const tombstone = await f.documents.read(mission.id)
  assert.ok(tombstone && "deletedAt" in tombstone)
  assert.equal(tombstone.requestID, input.requestID)
  assert.equal(tombstone.expectedRevision, input.expectedRevision)
  assert.equal(tombstone.deleteManagedSessions, false)
  assert.equal((await f.control.delete(input)).cleanup!.documentPending, false)
  const bytes = canonicalAuthority([...f.values])
  await assert.rejects(f.control.delete({ ...input, deleteManagedSessions: true }), /different request/)
  assert.equal(canonicalAuthority([...f.values]), bytes)
  await assert.rejects(f.control.create(creation), /deleted/)
  assert.ok(f.sessions.has(mission.coordinatorSessionId))
  assert.equal(f.created, 1)
  assert.equal(f.transportCalls, 0)
})

test("a full tombstone registry leaves the stopped complete map visible and preserves the original deletion request", async () => {
  const f = fixture(), mission = (await f.control.create({ requestID: "create-capacity", objective: "Work", template: "custom" })).mission
  const registryKey = `${MISSION_DOCUMENT_PREFIX}/project/${f.documents.projectToken}/tombstones`
  f.values.set(registryKey, { version: 1, revision: 4096, entries: Array.from({ length: 4096 }, (_, index) => ({
    id: `deleted_${index}`, requestID: "delete-original", deletedAt: 1000,
  })) })
  const input = { missionID: mission.id, requestID: "delete-capacity", expectedRevision: mission.revision }
  await assert.rejects(f.control.delete(input), /reconciliation is pending/)
  const saved = await f.documents.read(mission.id)
  assert.ok(saved && !("deletedAt" in saved))
  assert.equal(saved.state, "stopped")
  assert.equal(saved.deletion!.requestID, input.requestID)
  assert.equal((await f.control.snapshot()).missions[0].id, mission.id)
  assert.equal((await f.control.snapshot()).missions[0].document!.deletion!.expectedRevision, input.expectedRevision)
  await assert.rejects(f.control.delete({ ...input, requestID: "evade-capacity" }), /different request/)
  assert.equal((f.values.get(registryKey) as { entries: unknown[] }).entries.length, 4096)
  assert.ok(f.sessions.has(mission.coordinatorSessionId))
})

test("unresolved document reconciliation blocks journal deletion and only its exact retry can compact after settlement", async () => {
  const f = fixture(), mission = (await f.control.create({ requestID: "create-unsettled-delete", objective: "Work", template: "custom" })).mission
  const doc = (await f.documents.read(mission.id))!
  await f.documents.change(mission.id, doc.revision, () => true, next => {
    next.synchronization = { requestID: "unresolved-native-arm", kind: "arm", retiredCalendars: [] }
  })
  const input = { missionID: mission.id, requestID: "delete-unsettled", expectedRevision: mission.revision }
  await assert.rejects(f.control.delete(input), /reconciliation is pending/)
  const saved = await f.documents.read(mission.id)
  assert.ok(saved && !("deletedAt" in saved))
  assert.equal(saved.synchronization!.requestID, "unresolved-native-arm")
  assert.equal(saved.state, "stopped")
  assert.equal((await f.control.snapshot()).missions.length, 1)
  // The owning native reconciliation has now proved the outstanding arm absent.
  await f.documents.change(mission.id, saved.revision, () => true, next => { next.synchronization = null })
  assert.equal((await f.control.delete(input)).cleanup!.documentPending, false)
  assert.ok("deletedAt" in (await f.documents.read(mission.id))!)
  assert.equal(f.transportCalls, 0)
})

for (const failure of ["journal", "compact-before", "compact-after"] as const) test(`deletion ${failure} failure retains the original identity and exact retry finishes without deleting conversations`, async () => {
  const f = fixture(), mission = (await f.control.create({ requestID: `create-${failure}`, objective: "Work", template: "custom" })).mission
  const input = { missionID: mission.id, requestID: `delete-${failure}`, expectedRevision: mission.revision }
  if (failure === "journal") f.failDelete()
  else if (failure === "compact-before") f.failCompact()
  else f.loseCompact()
  await assert.rejects(f.control.delete(input))
  const saved = await f.documents.read(mission.id)
  assert.ok(saved)
  if (!("deletedAt" in saved)) {
    assert.equal(saved.state, "stopped")
    assert.equal(saved.deletion!.requestID, input.requestID)
  } else assert.equal(saved.requestID, input.requestID)
  assert.equal((await f.control.delete(input)).cleanup!.documentPending, false)
  assert.ok("deletedAt" in (await f.documents.read(mission.id))!)
  assert.ok(f.sessions.has(mission.coordinatorSessionId))
  assert.equal(f.transportCalls, 0)
})

test("opt-in native cleanup uncertainty retains the full document until the original journal cleanup settles", async () => {
  const f = fixture(), created = (await f.control.create({ requestID: "create-cleanup", objective: "Work", template: "custom" })).mission
  await f.control.lifecycle({ missionID: created.id, requestID: "play-cleanup", expectedRevision: created.revision, action: "start" })
  await assert.rejects(f.control.delegate(created.coordinatorSessionId, { missionID: created.id, taskKey: "worker", title: "Worker", brief: "Work",
    role: "specialist", blockedBy: [], delivery: "queue", executionMode: { kind: "independent", reason: "location", explanation: "Owned fixture root" } }))
  const mission = (await f.control.snapshot()).missions[0]
  assert.equal(mission.actors.length, 2)
  const input = { missionID: mission.id, requestID: "delete-cleanup", expectedRevision: mission.revision, deleteManagedSessions: true }
  f.failCleanup()
  await assert.rejects(f.control.delete(input), /cleanup is pending/)
  const saved = await f.documents.read(mission.id)
  assert.ok(saved && !("deletedAt" in saved))
  assert.equal(saved.deletion!.deleteManagedSessions, true)
  assert.equal(f.cleanupCalls, 1)
  f.failCompact()
  await assert.rejects(f.control.delete(input), /document cleanup confirmation is pending/)
  const onlyDocumentPending = (await f.control.snapshot()).cleanups![0]
  assert.equal(onlyDocumentPending.pending, 0)
  assert.equal(onlyDocumentPending.documentPending, true)
  assert.equal(f.cleanupCalls, 2)
  const result = await f.control.delete(input)
  assert.equal(result.deleted, true)
  assert.equal(result.cleanup!.pending, 0)
  assert.equal(result.cleanup!.documentPending, false)
  assert.equal(f.cleanupCalls, 2)
  assert.ok("deletedAt" in (await f.documents.read(mission.id))!)
  assert.equal(f.sessions.size, 2, "the known retained cleanup preserves both native conversations")
})

for (const deleteManagedSessions of [false, true]) for (const failure of ["compact", "lost-ack", "read", "receipt"] as const) {
  test(`document-only cleanup remains durably pending after ${failure} (opt-in=${deleteManagedSessions}) until exact retry`, async () => {
    const f = fixture(), mission = (await f.control.create({ requestID: `create-${failure}`, objective: "Work", template: "custom" })).mission
    const input = { missionID: mission.id, requestID: `delete-${failure}`, expectedRevision: mission.revision, deleteManagedSessions }
    if (failure === "compact") f.failCompact()
    else if (failure === "lost-ack") f.loseCompact()
    else if (failure === "read") f.failReadAfterDelete()
    else f.failDocumentReceipt()
    await assert.rejects(f.control.delete(input), /document cleanup confirmation is pending/)
    const snapshot = await f.control.snapshot(), listed = await f.control.list(), single = await f.control.mission(mission.id)
    assert.equal(snapshot.missions.length, 0)
    assert.equal(listed.missions.length, 0)
    assert.equal(single.mission, undefined)
    for (const view of [snapshot, listed, single]) {
      const cleanup = view.cleanups!.find(cleanup => cleanup.missionID === mission.id)!
      assert.equal(cleanup.pending, 0)
      assert.equal(cleanup.documentPending, true)
      assert.equal(cleanup.requestID, input.requestID)
      assert.equal(cleanup.expectedRevision, input.expectedRevision)
      assert.equal(cleanup.deleteManagedSessions, deleteManagedSessions)
    }
    assert.equal(missionWorkRemains(snapshot), true)
    await assert.rejects(f.control.delete({ ...input, expectedRevision: input.expectedRevision + 1 }), /different request/)
    await assert.rejects(f.control.delete({ ...input, deleteManagedSessions: !deleteManagedSessions }), /different request/)
    const result = await f.control.delete(input)
    assert.equal(result.cleanup!.pending, 0)
    assert.equal(result.cleanup!.documentPending, false)
    assert.equal((await f.control.mission(mission.id)).cleanups![0].documentPending, false)
    assert.equal(f.created, 1)
    assert.ok(f.sessions.has(mission.coordinatorSessionId))
  })
}

test("document-only pending survives newer settled histories, index hints and purge; exact confirmation finally permits purge", async () => {
  const f = fixture(), mission = (await f.control.create({ requestID: "old-document-pending", objective: "Work", template: "custom" })).mission
  const input = { missionID: mission.id, requestID: "delete-old-document", expectedRevision: mission.revision }
  f.failCompact()
  await assert.rejects(f.control.delete(input))
  await f.control.list() // Build the ordinary activation index before newer writes.
  for (let index = 0; index < 25; index++) {
    f.advance()
    const newer = (await f.control.create({ requestID: `newer-${index}`, objective: "Newer", template: "custom" })).mission
    await f.control.delete({ missionID: newer.id, requestID: `delete-newer-${index}`, expectedRevision: newer.revision })
  }
  const cleanups = (await f.control.list()).cleanups!
  assert.equal(cleanups.length, 21)
  assert.equal(cleanups[0].missionID, mission.id)
  assert.equal(cleanups[0].pending, 0)
  assert.equal(cleanups[0].documentPending, true)
  assert.equal(await f.journal.readHints(hints => hints.openIDs().includes(mission.id)), true)
  await f.journal.purgeDeleted({ all: true })
  assert.equal(await f.journal.deletionRecord(mission.id), undefined, "unconfirmed evidence cannot be replaced by a settled deletion record")
  assert.equal((await f.control.mission(mission.id)).cleanups![0].documentPending, true)
  assert.equal((await f.control.list()).cleanups![0].documentPending, true)
  assert.equal((await f.control.delete(input)).cleanup!.documentPending, false)
  assert.equal(await f.journal.readHints(hints => hints.openIDs().includes(mission.id)), false)
  await f.journal.purgeDeleted({ all: true })
  assert.equal((await f.journal.deletionRecord(mission.id))!.documentCleanup, true)
  assert.equal((await f.control.delete(input)).cleanup!.documentPending, false)
})

test("an already-marked unified deletion cannot confirm through the journal-only path when its document is missing", async () => {
  const f = fixture(), mission = (await f.control.create({ requestID: "create-missing-document", objective: "Work", template: "custom" })).mission
  const input = { missionID: mission.id, requestID: "delete-missing-document", expectedRevision: mission.revision }
  f.failCompact()
  await assert.rejects(f.control.delete(input), /document cleanup confirmation is pending/)
  const key = [...f.values.keys()].find(key => key.includes("documents-v1") && key.endsWith(`/missions/${mission.id}`))!
  const saved = structuredClone(f.values.get(key)!)
  f.values.delete(key)
  const before = canonicalAuthority([...f.values])
  await assert.rejects(f.control.delete(input), /reconciliation is pending/)
  assert.equal(canonicalAuthority([...f.values]), before, "missing required data is neither recreated nor confirmed")
  for (const view of [await f.control.snapshot(), await f.control.list(), await f.control.mission(mission.id)]) {
    assert.equal(view.cleanups!.find(cleanup => cleanup.missionID === mission.id)!.documentPending, true)
  }
  assert.equal((await f.journal.missionEvents(mission.id)).events.some(event => event.type === "mission.document-cleaned"), false)
  f.values.set(key, saved) // Restore the same authoritative fixture bytes, not a migration.
  assert.equal((await f.control.delete(input)).cleanup!.documentPending, false)
})

test("activation RPC persists authority and attempted barriers before acknowledgement, remains paused through readiness", async () => {
  const f = fixture(), selection = { agent: "worker", model: { providerID: "provider", id: "model" } }
  const doc = await f.documents.create("scheduled", { title: "Scheduled", objective: "Work", template: "custom", taskMode: "native",
    profiles: { coordinator: selection, roles: { specialist: selection } }, profileID: "profile", executionHost: "local",
    roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [],
    launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { at: null, afterMs: null, maxLaunches: null } },
  }, 1000, () => true)
  let identity = { missionID: doc.id, requestID: "activate-original", expectedRevision: doc.revision }
  const targets = ["global", "project"].map(scope => ({ scope: scope as "global" | "project", path: `/${scope}/opencode.jsonc`,
    expectation: "d".repeat(64), resultDigest: "b".repeat(64), attempted: false, acknowledged: false }))
  let request = { ...identity, action: "prepare", authority: "a".repeat(64), targets }
  await assert.rejects(activate(f.documents, request, () => true, "/another-location"), /Location differs/)
  let result = await applyMissionDocumentActivation(f.documents, request, () => true)
  const preparedRevision = result.document.revision
  result = await applyMissionDocumentActivation(f.documents, request, () => true)
  assert.equal(result.document.revision, preparedRevision)
  const originalIdentity = identity
  result = await applyMissionDocumentActivation(f.documents, { ...identity, action: "failed", errorCode: "configuration-conflict" }, () => true)
  identity = { ...identity, requestID: "activate-refreshed", expectedRevision: result.document.revision }
  request = { ...request, ...identity }
  result = await applyMissionDocumentActivation(f.documents, request, () => true)
  await assert.rejects(applyMissionDocumentActivation(f.documents, { ...originalIdentity, action: "attempting", scope: "global", resultDigest: "b".repeat(64) }, () => true), /conflict/)
  await assert.rejects(applyMissionDocumentActivation(f.documents, { ...identity, action: "ready", effectiveOrigin: "/project/opencode.jsonc" }, () => true), /pending/)
  for (const scope of ["global", "project"]) {
    const target = { ...identity, scope, resultDigest: "b".repeat(64) }
    await applyMissionDocumentActivation(f.documents, { ...target, action: "attempting" }, () => true)
    if (scope === "global") {
      const current = (await f.documents.read(doc.id))!
      await assert.rejects(applyMissionDocumentActivation(f.documents, { ...request, requestID: "cannot-bypass-attempt", expectedRevision: current.revision }, () => true), /conflict/)
    }
    await applyMissionDocumentActivation(f.documents, { ...target, action: "acknowledged" }, () => true)
  }
  result = await applyMissionDocumentActivation(f.documents, { ...identity, action: "ready", effectiveOrigin: "/project/opencode.jsonc" }, () => true)
  assert.equal(result.document.state, "paused")
  assert.equal(result.document.firstPlayedAt, null)
  assert.equal(result.document.scheduleActivation!.state, "ready")
  await assert.rejects(applyMissionDocumentActivation(f.documents, { ...request, authority: "c".repeat(64) }, () => true), /conflict/)
  assert.ok(!canonicalAuthority(result).includes("password"))
})

test("a durable paused/stopped document blocks new work even when the journal control publication has not caught up", async () => {
  const f = fixture(), created = (await f.control.create({ requestID: "create-gap", objective: "Work", template: "custom" })).mission
  await f.control.lifecycle({ missionID: created.id, requestID: "play-gap", expectedRevision: created.revision, action: "start" })
  for (const state of ["paused", "stopped"] as const) {
    const doc = (await f.documents.read(created.id))!
    await f.documents.change(created.id, doc.revision, () => true, next => { next.state = state })
    const before = canonicalAuthority([...f.values])
    const mission = (await f.control.snapshot()).missions[0]
    assert.equal(mission.runState, "running", "this is the gap before the business journal's control intent")
    assert.equal(mission.document?.state, state)
    await assert.rejects(f.control.declare(created.coordinatorSessionId, { missionID: created.id,
      taskKey: "must-not-start", title: "Blocked", brief: "No new work", role: "specialist", blockedBy: [],
      executionMode: { kind: "native", parentTaskKey: null } }), /not running/)
    assert.equal(canonicalAuthority([...f.values]), before)
    assert.equal(f.admissions.size, 1)
  }
})

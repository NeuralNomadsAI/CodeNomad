import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { Context, Effect, Schema } from "effect"
import { SessionMessage } from "@opencode/schema/session-message"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import type { MissionConfiguration } from "../../missions/launch-policy"
import { MissionJournal, type MissionStorage } from "../../missions/journal"
import { controlOperationID, controlReceiptID, controlResumeAdmissionID } from "../../missions/receipt-identity"
import type { MissionJsonValue } from "../../missions/model"
import type { MissionDocument } from "../../missions/mission-document"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { documentWatchCheckpointSchema } from "../../missions/mission-document-passage-input"
import { createMissionConditionReader, assertMissionSourceAcyclic } from "./native-mission-condition-reader"
import { prepareNativeDocumentSources } from "./native-scheduled-passage-sources"
import { nativePassageMessageDigest, type MissionNativeService } from "./native-service-adapter"
import type { NativePassageObservation } from "./native-passage-observation"
import { acquireNativeSourceFence, type NativeSourceFence } from "./native-source-fence"

const at = Date.parse("2026-10-01T00:00:00Z"), current = () => true as const
const config = (): MissionConfiguration => ({ title: "Source fixture", objective: "Observe explicit source", template: "custom", taskMode: "native",
  profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [],
  profiles: { coordinator: { agent: "worker", model: { providerID: "fixture", id: "model" } },
    roles: { specialist: { agent: "worker", model: { providerID: "fixture", id: "model" } } } },
  launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { maxLaunches: null, afterMs: null, at: null } } })
async function fixture() {
  const values = new Map<string, MissionJsonValue>(), states = new Map<string, { active: boolean; message: string }>()
  const storage: MissionStorage = { get: async key => structuredClone(values.get(key)), set: async (key, value) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a < b ? -1 : 1)
        .slice(0, limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
      return { entries, ...(entries.length === limit ? { next: entries.at(-1)!.key } : {}) }
    } }
  const conditional: MissionDocumentStorage = { get: storage.get, compareAndSet: async (key, value, revision, guard) => {
    guard(); assert.equal((values.get(key) as { revision: number } | undefined)?.revision ?? null, revision); values.set(key, structuredClone(value))
  } }
  const store = new NativeMissionDocumentStore(conditional, "project", "/project")
  const native = { location: { directory: "/project", project: { id: "project" } }, assertCurrent: current,
    get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID: "project", location: { directory: "/project" } }),
  } as unknown as MissionNativeService
  const observation: NativePassageObservation = { assertCurrent: current, assertScheduleCurrent: current, exists: async id => states.has(id),
    session: async id => ({ id, projectID: "project", directory: "/project", active: states.get(id)?.active ?? false,
      inbox: 0, suspended: false, runningTools: 0, failed: false, messagePresent: true,
      terminal: { inputMessageID: states.get(id)?.message ?? "msg_first", messageID: "msg_idle", outcome: "succeeded" } }),
    children: async () => [], requests: async () => false }
  const fence = (): NativeSourceFence => ({ document() {}, journal() {}, conversation() {}, message() {}, family() {}, current })
  const reader = () => createMissionConditionReader({ store, storage, native, observation, fence, signal: new AbortController().signal, current })
  const read = async (id: string) => (await store.read(id)) as MissionDocument
  const mutate = async (id: string, use: (doc: MissionDocument) => void) => { const doc = await read(id); return store.change(id, doc.revision, current, use) }
  async function success(id: string, number: number, outcome: "completed" | "failed" = "completed") {
    let doc = await mutate(id, next => { next.blocked = null; changes.reserve(next, { kind: "manual", requestID: `manual_${number}` }, at + number * 1000, []) })
    const pending = doc.pending!, passage = missionDocumentPassage(storage, doc, current)
    states.set(pending.coordinatorSessionID, { active: false, message: pending.messageID })
    await passage.journal.append({ version: 1, id: `created_${number}`, projectID: doc.projectID, missionID: pending.missionID,
      createdAt: at + number * 1000, type: "mission.created", projectCanonical: "/project", objective: "source", template: "custom",
      coordinator: { sessionID: pending.coordinatorSessionID, title: "source", location: { directory: "/project" } } })
    await passage.journal.append({ version: 1, id: `finished_${number}`, projectID: doc.projectID, missionID: pending.missionID,
      createdAt: at + number * 1000 + 1, type: "mission.finished", outcome, summary: "Done" })
    doc = await mutate(id, next => { changes.admitted(next, pending.id, at + number * 1000); changes.settle(next, pending.id, outcome, at + number * 1000 + 2) })
    return { doc, pending }
  }
  await store.create("source", config(), at, current)
  await mutate("source", next => { changes.play(next, "play_source", at, []); next.synchronization = null })
  await store.create("target", config(), at, current)
  return { values, storage, store, native, observation, states, reader, read, mutate, success }
}

test("schedule success baselines, groups successes, freezes proof, survives reader restart, refuses cycles and lost windows", async () => {
  const f = await fixture(), doc = await f.read("target")
  doc.configuration.launch.condition = { kind: "schedule-success", missionID: "source" }
  await f.success("source", 1)
  const baseline = await f.reader()(doc)
  assert.equal(baseline.changed, false); doc.checkpoints = [baseline.checkpoint]
  await f.success("source", 2, "failed")
  assert.equal((await f.reader()(doc)).changed, false)
  const first = await f.success("source", 3); await f.success("source", 4)
  const result = await f.reader()(JSON.parse(JSON.stringify(doc)))
  assert.equal(result.changed, true)
  assert.equal((result.checkpoint.value as { proofs: unknown[] }).proofs.length, 2)
  f.states.get(first.pending.coordinatorSessionID)!.active = true
  assert.equal((await f.reader()(doc)).changed, false)
  f.states.get(first.pending.coordinatorSessionID)!.active = false
  doc.checkpoints = [result.checkpoint]
  assert.equal((await f.reader()(doc)).changed, false)
  await f.mutate("source", next => { next.configuration.launch.condition = { kind: "schedule-success", missionID: "target" } })
  await assert.rejects(assertMissionSourceAcyclic(doc, f.store), /cycle/)
  await f.mutate("source", next => { next.configuration.launch.condition = null })
  doc.checkpoints = [baseline.checkpoint]
  for (let n = 5; n <= 35; n++) await f.success("source", n)
  await assert.rejects(f.reader()(doc), /coverage unavailable/)
})

test("a once source requires completed journal and whole-family terminal evidence, never Stop/inactivity", async () => {
  const f = await fixture(), doc = await f.read("target")
  await f.mutate("source", next => { next.configuration.launch.timing = { kind: "immediate" } })
  doc.configuration.launch.condition = { kind: "mission-completed", missionID: "source" }
  const baseline = await f.reader()(doc); assert.equal(baseline.changed, false); doc.checkpoints = [baseline.checkpoint]
  const completed = await f.success("source", 1)
  f.states.get(completed.pending.coordinatorSessionID)!.active = true
  assert.equal((await f.reader()(doc)).changed, false)
  f.states.get(completed.pending.coordinatorSessionID)!.active = false
  const success = await f.reader()(doc); assert.equal(success.changed, true)
  doc.checkpoints = [success.checkpoint]
  assert.equal((await f.reader()(doc)).changed, false)
  doc.checkpoints = []
  assert.equal((await f.reader()(doc)).changed, false, "already completed at Play is baseline")
  await f.mutate("source", next => { changes.requestDeletion(next, "delete_source", at + 2000) })
  await assert.rejects(f.reader()(doc), /coverage unavailable/)
})

for (const kind of ["schedule-success", "mission-completed"] as const) test(`${kind} blocks missing correlation instead of reporting no change`, async () => {
  const f = await fixture(), doc = await f.read("target")
  if (kind === "mission-completed") await f.mutate("source", next => { next.configuration.launch.timing = { kind: "immediate" } })
  doc.configuration.launch.condition = { kind, missionID: "source" }
  doc.checkpoints = [(await f.reader()(doc)).checkpoint]
  const success = await f.success("source", 1)
  assert.equal((await f.reader()(doc)).changed, true)
  const session = f.observation.session
  f.observation.session = async (...args) => ({ ...await session(...args), terminal: undefined, messagePresent: false })
  await assert.rejects(f.reader()(doc), /coverage unavailable/)
  f.states.get(success.pending.coordinatorSessionID)!.active = true
  assert.equal((await f.reader()(doc)).changed, false, "positive live activity remains a waiting condition")
})

test("journal-only completion resolves its authorized linked placement and pins it across reads", async () => {
  const f = await fixture(), doc = await f.read("target"), missionID = "journal_source", sessionID = "ses_journal_source"
  const operationID = controlOperationID(missionID, "play_source"), inputID = controlResumeAdmissionID(operationID, sessionID)
  const journal = new MissionJournal(f.storage, "project", "/project"), common = { version: 1 as const, projectID: "project", missionID }
  await journal.append({ ...common, type: "mission.created", id: "journal_created", createdAt: at, projectCanonical: "/project",
    objective: "Linked source", template: "custom", coordinator: { sessionID, title: "Source", location: { directory: "/linked" } } })
  await journal.append({ ...common, type: "mission.control-requested", id: operationID, createdAt: at + 1, requestID: "play_source",
    expectedRevision: 1, action: "start", targets: [{ sessionID, location: { directory: "/linked" } }] })
  await journal.append({ ...common, type: "mission.control-applied", id: controlReceiptID(operationID, sessionID), createdAt: at + 2,
    operationID, sessionID, nativeAcknowledgement: { missionID, operationID, sessionID, action: "start", disposition: "start-admitted",
      admission: { id: inputID, sessionID, type: "synthetic", delivery: "queue", time: { created: at + 1 },
        payload: { text: "Start", description: "Start", metadata: { "codenomad.mission": { version: 1, missionID, operationID, kind: "lifecycle" } } } } } })
  let directory = "/linked", borrowed = 0
  f.native.get = async () => ({ id: sessionID, projectID: "project", location: { directory } })
  const session = f.observation.session
  f.observation.session = async (...args) => ({ ...await session(...args), directory: "/linked" })
  f.states.set(sessionID, { active: false, message: inputID })
  const reader = createMissionConditionReader({ store: f.store, storage: f.storage, native: f.native, observation: f.observation,
    observationFor: async placement => { assert.equal(placement.directory, "/linked"); borrowed++; return f.observation },
    fence: () => ({ document() {}, journal() {}, conversation() {}, message() {}, family() {}, current }),
    signal: new AbortController().signal, current })
  doc.configuration.roots.push({ mode: "directory-only", directory: "/linked" })
  doc.configuration.launch.condition = { kind: "mission-completed", missionID }
  doc.checkpoints = [(await reader(doc)).checkpoint]
  await journal.append({ ...common, type: "mission.finished", id: "journal_finished", createdAt: at + 3, outcome: "completed", summary: "Done" })
  assert.equal((await reader(doc)).changed, true); assert.equal(borrowed, 1)
  directory = "/project"
  await assert.rejects(reader(doc), /coverage unavailable/, "coordinator moved away from its journal placement")
  directory = "/linked"; doc.configuration.roots.pop()
  await assert.rejects(reader(doc), /coverage unavailable/, "linked placement requires explicit authorization")
})

test("conversation baseline, exact stable prefixes, technical/self exclusion, remove/re-add and frozen pending text", async () => {
  const f = await fixture(), doc = await f.read("target"), signal = new AbortController().signal
  doc.configuration.launch.condition = { kind: "conversation-message", conversationID: "ses_followed" }
  const anchor = Schema.decodeUnknownSync(SessionMessage.Info)({ id: "msg_anchor", type: "user", text: "before Play", time: { created: at } })
  f.native.sourceBaseline = async () => anchor
  f.native.message = async () => anchor
  let messages = [] as Awaited<ReturnType<MissionNativeService["sourceMessages"]>>
  f.native.sourceMessages = async () => structuredClone(messages)
  const baseline = await prepareNativeDocumentSources(doc, f.native, signal, current)
  assert.equal(baseline.changed, false); assert.equal(documentWatchCheckpointSchema.parse(baseline.checkpoints[0].value).messageID, anchor.id)
  doc.firstPlayedAt = at; doc.checkpoints = baseline.checkpoints
  messages = [{ id: "msg_technical", type: "technical", text: "", nativeDigest: "a".repeat(64) }]
  assert.equal((await prepareNativeDocumentSources(doc, f.native, signal, current)).changed, false)
  messages.push({ id: "msg_new", type: "user", text: "stable new text", nativeDigest: "b".repeat(64) })
  const snapshot = await prepareNativeDocumentSources(doc, f.native, signal, current)
  assert.equal(snapshot.changed, true)
  assert.equal(documentWatchCheckpointSchema.parse(snapshot.checkpoints[0].value).source!.messages.at(-1)!.text, "stable new text")
  messages[1].text = "later text"
  assert.equal(documentWatchCheckpointSchema.parse(snapshot.checkpoints[0].value).source!.messages.at(-1)!.text, "stable new text")
  const removed = JSON.parse(JSON.stringify(doc)); removed.configuration.launch.condition = null
  assert.equal((await prepareNativeDocumentSources(removed, f.native, signal, current)).checkpoints.length, 0)
  assert.equal((await prepareNativeDocumentSources(JSON.parse(JSON.stringify(doc)), f.native, signal, current)).changed, true)
  f.native.message = async () => ({ ...anchor, text: "rewritten" } as typeof anchor)
  await assert.rejects(prepareNativeDocumentSources(doc, f.native, signal, current), /anchor changed/)
  f.native.message = async () => anchor
  const get = f.native.get
  f.native.get = async value => ({ ...await get(value), metadata: { "codenomad.mission": { document: { missionID: doc.id } } } } as never)
  await assert.rejects(prepareNativeDocumentSources(doc, f.native, signal, current), /excluded/)
  assert.equal(nativePassageMessageDigest(anchor).length, 64)
})

test("conversation exclusion walks passage ancestry, rejects cycles and recognizes the carrier marker", async () => {
  const f = await fixture(), doc = await f.read("target"), signal = new AbortController().signal
  doc.configuration.launch.condition = { kind: "conversation-message", conversationID: "ses_grandchild" }
  f.native.sourceBaseline = async () => undefined
  const get = f.native.get
  f.native.get = async input => ({ ...await get(input), ...(input.sessionID === "ses_grandchild" ? { parentID: "ses_child" }
    : input.sessionID === "ses_child" ? { parentID: "ses_passage" } : {}) })
  doc.history = [{ coordinatorSessionID: "ses_passage" }] as MissionDocument["history"]
  await assert.rejects(prepareNativeDocumentSources(doc, f.native, signal, current), /excluded/)
  doc.history = []
  f.native.get = async input => ({ ...await get(input), metadata: { "codenomad.schedule-carrier": { owner: "fixture" } } })
  await assert.rejects(prepareNativeDocumentSources(doc, f.native, signal, current), /excluded/)
  f.native.get = async input => ({ ...await get(input), parentID: input.sessionID })
  await assert.rejects(prepareNativeDocumentSources(doc, f.native, signal, current), /excluded/)
  let parentsPinned = 0
  f.native.get = async input => ({ ...await get(input), ...(input.sessionID === "ses_grandchild" ? { parentID: "ses_foreign_root" } : {}) })
  const fence: NativeSourceFence = { document() {}, journal() {}, message() {}, family() {}, current,
    conversation(id) { if (id === "ses_foreign_root") parentsPinned++ } }
  assert.equal((await prepareNativeDocumentSources(doc, f.native, signal, current, undefined, fence)).changed, false)
  assert.equal(parentsPinned, 1, "allowed ancestry remains pinned against moves before CAS")
})

for (const mutation of ["reattach", "move", "carrier"] as const) test(`ancestor ${mutation} during its native read invalidates the pinned SQL proof`, async t => {
  const f = await fixture(), doc = await f.read("target"), db = new DatabaseSync(":memory:")
  t.after(() => db.close())
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,
    metadata TEXT,revert TEXT,time_suspended INTEGER); CREATE TABLE session_message(id TEXT,seq INTEGER,session_id TEXT);
    INSERT INTO session_v2(id,parent_id,project_id,directory) VALUES('ses_followed','ses_ancestor','project','/project');
    INSERT INTO session_v2(id,project_id,directory) VALUES('ses_ancestor','project','/project')`)
  const database = Context.Service<never, unknown>("@opencode/storage/Database")
  const client = Object.assign(() => {}, { unsafe: (sql: string, args: readonly unknown[]) => ({
    withoutTransform: Effect.sync(() => db.prepare(sql).all(...args as []).map(row => ({ ...row }))) }) })
  const fence = await Effect.runPromise(Effect.provide(acquireNativeSourceFence(current), Context.make(database, { db: { $client: client } })))
  let started!: () => void, release!: () => void
  const reading = new Promise<void>(resolve => { started = resolve }), resumed = new Promise<void>(resolve => { release = resolve })
  f.native.get = async ({ sessionID }) => {
    const row = db.prepare("SELECT * FROM session_v2 WHERE id=?").get(sessionID)!
    const snapshot = { id: String(row.id), projectID: String(row.project_id), location: { directory: String(row.directory) },
      ...(row.parent_id == null ? {} : { parentID: String(row.parent_id) }),
      ...(row.metadata == null ? {} : { metadata: JSON.parse(String(row.metadata)) }) }
    if (sessionID === "ses_ancestor") { started(); await resumed }
    return snapshot
  }
  doc.configuration.launch.condition = { kind: "conversation-message", conversationID: "ses_followed" }
  doc.history = [{ coordinatorSessionID: "ses_target_coordinator" }] as MissionDocument["history"]
  f.native.sourceBaseline = async () => undefined
  const pending = prepareNativeDocumentSources(doc, f.native, new AbortController().signal, current, undefined, fence())
  const rejected = assert.rejects(pending, /changed during preparation/)
  await reading
  if (mutation === "reattach") db.exec("UPDATE session_v2 SET parent_id='ses_target_coordinator' WHERE id='ses_ancestor'")
  else if (mutation === "move") db.exec("UPDATE session_v2 SET directory='/forbidden' WHERE id='ses_ancestor'")
  else db.prepare("UPDATE session_v2 SET metadata=? WHERE id='ses_ancestor'").run(JSON.stringify({ "codenomad.schedule-carrier": {} }))
  release()
  await rejected
})

import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect } from "effect"
import { RECURRENCE_STORAGE_PREFIX, recurrenceConfigSchema, recurrencePassageID, recurrenceMessageID } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"
import { readNativeRecurrenceControlStatus } from "./native-recurrence-control-status"
import { readNativeRecurrenceRunNow } from "./native-recurrence-manual"

test("lost control replies read exact request/revision status without starting Jobs or changing KV", async () => {
  const db = new DatabaseSync(":memory:")
  try {
    db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER,time_updated INTEGER)")
    const selection = { agent: "worker", model: { providerID: "provider", id: "model" } }
    const config = recurrenceConfigSchema.parse({ title: "Review", template: "custom", consigne: "Review", taskMode: "native",
      clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "local", watchedConversationIDs: [],
      roots: [{ mode: "directory-only", directory: "/project" }], profiles: { coordinator: selection, roles: { specialist: selection } } })
    const key = `${RECURRENCE_STORAGE_PREFIX}/project/${stableToken("project\0/project", 24)}/schedule_one`
    const control = { requestID: "request_one", expectedRevision: 0, revision: 1, state: "running", action: "play",
      controlsComplete: false, targetsKnown: true, targets: [] }
    const doc = { version: 1, projectID: "project", projectCanonical: "/project", id: "schedule_one", revision: 1,
      scheduleRevision: 0, createdAt: 1, state: "running", config, lastDaily: null, pending: null, history: [], settledCount: 0, cursors: [], controls: [control] }
    db.prepare("INSERT INTO kv VALUES(?,?,0,0)").run(key, JSON.stringify(doc))
    const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly unknown[]) => ({ withoutTransform: Effect.sync(() => db.prepare(sql).all(...params as [])) }) })
    const graph = Context.make(Context.Service<never, unknown>("@opencode/storage/Database"), { db: { $client: client,
      transaction: () => Effect.die("read must not mutate") } })
    const ctx = { location: { directory: "/project", project: { id: "project", canonical: "/project" } }, storage: {
      get: (target: string) => Effect.sync(() => { const row = db.prepare("SELECT value FROM kv WHERE key=?").get(target) as { value: string } | undefined; return row && JSON.parse(row.value) }),
      set: () => Effect.die("No writes"), scan: () => Effect.die("No scans") } } as never
    const input = { scheduleID: "schedule_one", requestID: "request_one", expectedRevision: 0, action: "play" }
    const read = (request = input) => Effect.runPromiseWith(graph)(readNativeRecurrenceControlStatus(ctx, request))
    assert.equal((await read()).outcome, "unknown")
    control.controlsComplete = true
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify(doc), key)
    const bytes = (db.prepare("SELECT value FROM kv").get() as { value: string }).value
    assert.equal((await read()).outcome, "committed")
    assert.equal((await read({ ...input, expectedRevision: 1 })).outcome, "unknown")
    assert.equal((await read({ ...input, requestID: "request_foreign" })).outcome, "unknown")
    const manual = await Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, { scheduleID: "schedule_one", requestID: "manual_unknown", expectedRevision: 1 }))
    assert.equal(manual.outcome, "unknown")
    assert.equal((db.prepare("SELECT value FROM kv").get() as { value: string }).value, bytes)
    const due = { kind: "manual" as const, requestID: "manual_one", expectedRevision: 2, at: 2 }
    const passageID = recurrencePassageID(stableToken("project\0/project", 24), "schedule_one", 0, due)
    const passage = { id: passageID, messageID: recurrenceMessageID(passageID), scheduleRevision: 0, createdAt: 2, due }
    const manualDoc = { ...doc, revision: 3, pending: { passage, admission: null } }
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify(manualDoc), key)
    const manualInput = { scheduleID: "schedule_one", requestID: "manual_one", expectedRevision: 2 }
    assert.equal((await Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, manualInput))).outcome, "unknown")
    const admission = { kind: "accepted", passageID, messageID: passage.messageID, missionID: "mission_one", conversationID: "session_one" }
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify({ ...manualDoc, revision: 4, pending: { passage, admission } }), key)
    const accepted = await Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, manualInput))
    assert.equal(accepted.outcome, "accepted"); assert.equal(accepted.passageID, passageID)
    assert.equal((await Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, { ...manualInput, expectedRevision: 3 }))).outcome, "unknown")
  } finally { db.close() }
})

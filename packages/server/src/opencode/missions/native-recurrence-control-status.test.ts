import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect } from "effect"
import { RECURRENCE_STORAGE_PREFIX, recurrenceConfigSchema, recurrencePassageID, recurrenceMessageID, recurrenceCoordinatorSessionID } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"
import { readNativeRecurrenceControlStatus } from "./native-recurrence-control-status"
import { readNativeRecurrenceRunNow } from "./native-recurrence-manual"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"

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
    const store = new NativeMissionRecurrenceStore({
      get: async target => {
        const row = db.prepare("SELECT value FROM kv WHERE key=?").get(target) as { value: string } | undefined
        return row && JSON.parse(row.value)
      },
      set: async (target, value, current) => {
        current?.()
        db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify(value), target)
      },
      scan: async () => { throw new Error("No inventory scan") },
    }, "project", "/project")
    assert.equal((await read()).outcome, "unknown")
    control.controlsComplete = true
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify(doc), key)
    const bytes = (db.prepare("SELECT value FROM kv").get() as { value: string }).value
    assert.equal((await read()).outcome, "committed")
    assert.equal((await read({ ...input, expectedRevision: 1 })).outcome, "unknown")
    // No record at a later revision with nothing evicted: provably never applied.
    assert.deepEqual(await read({ ...input, requestID: "request_foreign" }), { version: 1, scheduleID: "schedule_one",
      requestID: "request_foreign", expectedRevision: 0, outcome: "rejected", reason: "revision-conflict" })
    // An admissible unrecorded request at the current revision may still be in flight.
    assert.equal((await read({ ...input, requestID: "request_foreign", expectedRevision: 1, action: "pause" })).outcome, "unknown")
    const manual = await Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, { scheduleID: "schedule_one", requestID: "manual_unknown", expectedRevision: 1 }))
    assert.equal(manual.outcome, "unknown")
    assert.equal((db.prepare("SELECT value FROM kv").get() as { value: string }).value, bytes)
    for (const action of ["play", "pause", "stop", "resume", "check"] as const) {
      const state = action === "pause" ? "paused" : action === "stop" ? "stopped" : "running"
      const partial = { ...control, action, state, controlsComplete: false }
      const write = (value: unknown) => db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify(value), key)
      const currentBytes = () => (db.prepare("SELECT value FROM kv").get() as { value: string }).value
      write({ ...doc, state, controls: [partial] })
      const before = currentBytes()
      assert.equal((await read({ ...input, action })).outcome, "unknown", `${action} retains its own partial proof`)
      assert.equal(currentBytes(), before, "partial receipt lookup never starts or retries work")
      write({ ...doc, state, controls: [{ ...partial, controlsComplete: true }] })
      const complete = currentBytes()
      assert.equal((await read({ ...input, action })).outcome, "committed", `${action} complete receipt`)
      assert.equal(currentBytes(), complete, "complete receipt lookup preserves bytes and revision")
      if (action === "pause" || action === "stop") {
        write({ ...doc, state, revision: 2, controls: [partial,
          { ...control, action: "check", state, requestID: "check_complete", expectedRevision: 1, revision: 2 }] })
        const checked = currentBytes()
        assert.equal((await read({ ...input, requestID: "check_complete", expectedRevision: 1, action: "check" })).outcome, "committed")
        assert.equal((await read({ ...input, action })).outcome, "unknown", "daily Check never substitutes for an original actor proof")
        assert.equal(currentBytes(), checked)
      }
      const due = { kind: "manual" as const, requestID: "pending_manual", expectedRevision: 0, at: 2 }
      const passageID = recurrencePassageID(store.projectToken, doc.id, 0, due)
      write({ ...doc, state: "paused", pending: { admission: null, passage: {
        id: passageID, messageID: recurrenceMessageID(passageID),
        coordinatorSessionID: recurrenceCoordinatorSessionID("project", passageID, 2),
        scheduleRevision: 0, createdAt: 2, due,
      } }, controls: [{ ...partial, controlsComplete: true }] })
      for (let i = 0; i < 65; i++) {
        const before = (await store.read(doc.id))!
        const admitted = await store.beginControl(doc.id, { requestID: `evict_${i}`, action: "check",
          expectedRevision: before.revision }, () => true)
        await store.recordControl(doc.id, { ...admitted.controls.at(-1)!, controlsComplete: true, targetsKnown: true }, () => true)
      }
      const evicted = (await store.read(doc.id))!, evictedBytes = currentBytes()
      assert.equal(evicted.controls.length, 64)
      assert.ok(!evicted.controls.some(item => item.requestID === input.requestID))
      assert.equal((await read({ ...input, action })).outcome, "unknown", `${action} eviction retains uncertainty`)
      await assert.rejects(store.beginControl(doc.id, { ...input, action }, () => true), "eviction never admits an original resend")
      assert.equal(currentBytes(), evictedBytes)
    }
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(bytes, key)
    const due = { kind: "manual" as const, requestID: "manual_one", expectedRevision: 2, at: 2 }
    const passageID = recurrencePassageID(stableToken("project\0/project", 24), "schedule_one", 0, due)
    const passage = { id: passageID, messageID: recurrenceMessageID(passageID), coordinatorSessionID: recurrenceCoordinatorSessionID("project", passageID, 2), scheduleRevision: 0, createdAt: 2, due }
    const manualDoc = { ...doc, revision: 3, pending: { passage, admission: null } }
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify(manualDoc), key)
    const manualInput = { scheduleID: "schedule_one", requestID: "manual_one", expectedRevision: 2 }
    assert.equal((await Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, manualInput))).outcome, "unknown")
    const admission = { kind: "accepted", passageID, messageID: passage.messageID, missionID: "mission_one", conversationID: "session_one" }
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify({ ...manualDoc, revision: 4, pending: { passage, admission } }), key)
    const accepted = await Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, manualInput))
    assert.equal(accepted.outcome, "accepted"); assert.equal(accepted.passageID, passageID)
    const stale = await Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, { ...manualInput, expectedRevision: 3 }))
    assert.deepEqual([stale.outcome, stale.reason, stale.passageID], ["rejected", "revision-conflict", null], "no reservation, later revision")
    assert.equal((await Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, { ...manualInput, expectedRevision: 4 }))).outcome, "rejected",
      "a pending passage refuses another Run now at its own revision")
    db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify({ ...manualDoc, revision: 4,
      pending: { passage, admission }, controls: [...doc.controls, { ...control, requestID: manualInput.requestID,
        expectedRevision: 2, revision: 3, action: "run-now" }] }), key)
    for (let i = 0; i < 31; i++) {
      let current = (await store.read(doc.id))!
      if (i) {
        current = await store.reserveManual(doc.id, `manual_later_${i}`, current.revision, 2 + i,
          { profileID: "profile", executionHost: "local", configYamlPath: "/profile/config.yaml" }, () => true)
        current = await store.recordAdmission(doc.id, { kind: "accepted",
          passageID: current.pending!.passage.id, messageID: current.pending!.passage.messageID,
          missionID: `mission_${i}`, conversationID: `session_${i}` }, 2 + i, () => true)
      }
      const acknowledgement = current.pending!.admission!
      await store.finish(doc.id, { passageID: acknowledgement.passageID, messageID: acknowledgement.messageID,
        missionID: acknowledgement.missionID, conversationID: acknowledgement.conversationID,
        outcome: "completed", artifactMessageIDs: [], cursors: [] }, 2 + i, () => true)
    }
    for (let i = 0; i < 65; i++) {
      const current = (await store.read(doc.id))!
      const admitted = await store.beginControl(doc.id, { requestID: `manual_evict_${i}`,
        action: i % 2 ? "resume" : "pause", expectedRevision: current.revision }, () => true)
      await store.recordControl(doc.id, { ...admitted.controls.at(-1)!, controlsComplete: true, targetsKnown: true }, () => true)
    }
    const evictedManual = (await store.read(doc.id))!
    assert.equal(evictedManual.history.length, 30)
    assert.ok(!evictedManual.history.some(item => item.passage.id === passageID))
    assert.ok(!evictedManual.controls.some(item => item.requestID === manualInput.requestID))
    const evictedManualBytes = (db.prepare("SELECT value FROM kv").get() as { value: string }).value
    assert.equal((await Effect.runPromiseWith(graph)(readNativeRecurrenceRunNow(ctx, manualInput))).outcome, "unknown")
    await assert.rejects(store.reserveManual(doc.id, manualInput.requestID, manualInput.expectedRevision, 40,
      { profileID: "profile", executionHost: "local", configYamlPath: "/profile/config.yaml" }, () => true))
    assert.equal((db.prepare("SELECT value FROM kv").get() as { value: string }).value, evictedManualBytes)
  } finally { db.close() }
})

import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { controlNativeMissionSchedule } from "./native-mission-schedule-control"
import { missionSchedulePayloadDigest } from "../../missions/mission-schedule-contract"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { nativeMissionScheduleControlExecution } from "./native-mission-schedule-authority"
import { missionDocumentChanges } from "../../missions/mission-document-state"

test("a refused coordinator selection returns the exact create or configure identity without writing", async t => {
  const f = await ownerFixture(t), before = await f.read()
  const author = { coordinatorSessionID: "ses_author" }
  const configuration = { ...before.configuration, coordinatorSessionID: "ses_source",
    watchedConversationIDs: ["ses_source"], coordinatorSelectionAuthor: author }
  const saved = structuredClone([...f.values])
  for (const action of ["create", "configure"] as const) {
    const request = { missionID: action === "create" ? "new_schedule" : before.id,
      requestID: `refused_${action}`, expectedRevision: action === "create" ? 0 : before.revision,
      action, configuration, ...(action === "create" ? { creation: { author, requestID: "refused_create", digest: "a".repeat(64) } } : {}),
      transport: { principal: { kind: "agent", author } } }
    const result = await Effect.runPromise(controlNativeMissionSchedule(f.ctx, {
      request, before: action === "create" ? undefined : before, store: f.store, current: f.current,
    } as never, undefined, Effect.runPromise).pipe(Effect.scoped))
    assert.deepEqual(result, { document: null, pending: false, refusal: { missionID: request.missionID,
      requestID: request.requestID, expectedRevision: request.expectedRevision, action,
      payloadDigest: missionSchedulePayloadDigest(request), reason: "coordinator-is-source" } })
    assert.deepEqual([...f.values], saved)
  }
})

test("exact completed calendar controls return read-only receipts for human and agent entries", async t => {
  for (const action of ["play", "pause", "stop", "resume", "configure"] as const) {
    const f = await ownerFixture(t)
    if (action !== "play") await f.control("play")
    if (action === "resume") await f.control("pause")
    const before = await f.read()
    const configuration = action === "configure" ? { ...before.configuration, title: "Edited",
      coordinatorSelectionAuthor: { coordinatorSessionID: "ses_agent" } } : undefined
    const input = { missionID: before.id, requestID: `exact_${action}`, expectedRevision: before.revision, action,
      ...(configuration ? { configuration } : {}) }
    await f.owner.control(input)
    const complete = await f.read(), saved = structuredClone([...f.values]), calls = f.calls.length
    for (const principal of [{ kind: "human" as const, sessionID: "cookie" },
      { kind: "agent" as const, author: { coordinatorSessionID: "ses_agent" } }]) {
      const request = { ...input, transport: { principal, issuedAt: Date.now() } }
      const execute = (value = request) => Effect.runPromise(controlNativeMissionSchedule(f.ctx, {
        request: value, before: complete, store: f.store,
        ...nativeMissionScheduleControlExecution(value as never, f.current),
      } as never, undefined, Effect.runPromise).pipe(Effect.scoped))
      const result = await execute()
      assert.equal(result.pending, false, `${principal.kind} ${action}`)
      assert.equal(result.document?.revision, complete.revision)
      assert.deepEqual([...f.values], saved)
      assert.equal(f.calls.length, calls)
      const conflict = await execute({ ...request, expectedRevision: request.expectedRevision + 1 })
      assert.ok("refusal" in conflict && conflict.refusal?.reason === "control-conflict")
      if (configuration) {
        const changed = await execute({ ...request, configuration: { ...configuration, title: "Changed replay" } })
        assert.ok("refusal" in changed && changed.refusal?.reason === "control-conflict")
      }
    }
  }
})

test("admitted Run now replay reads its retained manual proof without reconciling or publishing", async t => {
  const f = await ownerFixture(t)
  await f.control("play")
  const before = await f.read()
  const input = { missionID: before.id, requestID: "manual_exact", expectedRevision: before.revision, action: "run-now" as const }
  await f.store.change(before.id, before.revision, f.current, doc => {
    missionDocumentChanges.reserve(doc, { kind: "manual", requestID: input.requestID }, f.now + 1, [])
    doc.pending!.manualExpectedRevision = input.expectedRevision
  })
  const reserved = await f.read(), request = { ...input, transport: { sessionID: "cookie", issuedAt: Date.now() } }
  await assert.rejects(Effect.runPromise(controlNativeMissionSchedule(f.ctx, {
    request, store: f.store, ...nativeMissionScheduleControlExecution(request as never, f.current),
  } as never, undefined, Effect.runPromise).pipe(Effect.scoped)), "unadmitted originals keep their recovery path")
  await f.store.change(reserved.id, reserved.revision, f.current, doc => {
    missionDocumentChanges.admitted(doc, doc.pending!.id, f.now + 2)
  })
  const saved = structuredClone([...f.values]), complete = await f.read()
  for (const principal of [{ kind: "human", sessionID: "cookie" }, { kind: "agent", author: { coordinatorSessionID: "ses_agent" } }]) {
    const request = { ...input, transport: { principal, issuedAt: Date.now() } }
    const result = await Effect.runPromise(controlNativeMissionSchedule(f.ctx, {
      request, store: f.store, ...nativeMissionScheduleControlExecution(request as never, f.current),
    } as never, undefined, Effect.runPromise).pipe(Effect.scoped))
    assert.equal(result.pending, false)
    assert.equal(result.document?.revision, complete.revision)
    assert.deepEqual([...f.values], saved)
  }
})

test("partial calendar receipts keep reconciliation available instead of returning a completed replay", async t => {
  const f = await ownerFixture(t)
  f.loseCreateACK()
  const before = await f.read(), request = { missionID: before.id, requestID: "partial_play", expectedRevision: before.revision,
    action: "play" as const, transport: { sessionID: "cookie", issuedAt: Date.now() } }
  const partial = await f.owner.control(request)
  assert.equal(partial.calendarOwner?.operation.pending, true)
  // No native service graph is supplied: reaching it proves the partial request
  // was kept on the recovery path, rather than acknowledged by the replay guard.
  await assert.rejects(Effect.runPromise(controlNativeMissionSchedule(f.ctx, {
    request, store: f.store, ...nativeMissionScheduleControlExecution(request as never, f.current),
  } as never, undefined, Effect.runPromise).pipe(Effect.scoped)))
  assert.equal((await f.owner.control(request)).calendarOwner?.operation.pending, false)
})

test("a complete calendar receipt with missing actor proof retains its recovery path", async t => {
  const f = await ownerFixture(t)
  await f.control("play")
  let doc = await f.read()
  doc = await f.store.change(doc.id, doc.revision, f.current, value => {
    missionDocumentChanges.reserve(value, { kind: "manual", requestID: "actor_pending" }, f.now + 1, [])
    missionDocumentChanges.admitted(value, value.pending!.id, f.now + 2)
  })
  const request = { missionID: doc.id, requestID: "actor_pause", expectedRevision: doc.revision, action: "pause" as const,
    transport: { sessionID: "cookie", issuedAt: Date.now() } }
  assert.equal((await f.owner.control(request)).calendarOwner?.operation.pending, false)
  await assert.rejects(Effect.runPromise(controlNativeMissionSchedule(f.ctx, {
    request, store: f.store, ...nativeMissionScheduleControlExecution(request as never, f.current),
  } as never, undefined, Effect.runPromise).pipe(Effect.scoped)))
  assert.equal((await f.read()).pending?.id, doc.pending!.id)
})

test("completed Pause still reconciles an unadmitted manual original after a lost reply", async t => {
  const f = await ownerFixture(t)
  await f.control("play")
  let doc = await f.read()
  doc = await f.store.change(doc.id, doc.revision, f.current, value => {
    missionDocumentChanges.reserve(value, { kind: "manual", requestID: "unadmitted_manual" }, f.now + 1, [])
  })
  const request = { missionID: doc.id, requestID: "pause_unadmitted", expectedRevision: doc.revision, action: "pause" as const,
    transport: { sessionID: "cookie", issuedAt: Date.now() } }
  assert.equal((await f.owner.control(request)).calendarOwner?.operation.pending, false)
  await assert.rejects(Effect.runPromise(controlNativeMissionSchedule(f.ctx, {
    request, store: f.store, ...nativeMissionScheduleControlExecution(request as never, f.current),
  } as never, undefined, Effect.runPromise).pipe(Effect.scoped)))
  assert.equal((await f.read()).pending?.id, doc.pending!.id)
})

test("native deletion conflicts are input-bound refusals and exact tombstone replay stays read-only", async () => {
  const tombstone = { id: "deleted_schedule", deletedAt: 100, requestID: "delete_original", expectedRevision: 5, deleteManagedSessions: false }
  const original = { missionID: tombstone.id, requestID: tombstone.requestID, expectedRevision: 5, action: "delete" as const,
    transport: { sessionID: "human_cookie" } }
  const execute = (request: object) => Effect.runPromise(controlNativeMissionSchedule({} as never, {
    request, store: { read: async () => structuredClone(tombstone) }, current: () => true,
  } as never, undefined, Effect.runPromise).pipe(Effect.scoped))
  const recovered = await execute(original)
  assert.ok("deleted" in recovered && recovered.deleted)
  assert.equal(recovered.pending, false)
  const agentReplay = await execute({ ...original, transport: { principal: { kind: "agent", author: { coordinatorSessionID: "ses_agent" } } } })
  assert.deepEqual(agentReplay, recovered)
  for (const patch of [{ requestID: "another_delete" }, { expectedRevision: 6 }, { deleteManagedSessions: true }]) {
    const request = { ...original, ...patch }, result = await execute(request)
    assert.ok("refusal" in result)
    assert.deepEqual(result.refusal, { missionID: original.missionID, requestID: request.requestID, action: "delete",
      expectedRevision: request.expectedRevision, payloadDigest: missionSchedulePayloadDigest(request), reason: "control-conflict" })
    assert.equal(result.pending, false)
  }
})

test("check racing with compaction returns exact replay for recorded checks and pre-write refusal for fresh checks", async () => {
  const tombstone = {
    id: "deleted_schedule", deletedAt: 100, requestID: "delete_original", expectedRevision: 5, deleteManagedSessions: false,
    checks: [{ requestID: "check_recorded", expectedRevision: 6 }],
  }
  const execute = (request: object) => Effect.runPromise(controlNativeMissionSchedule({} as never, {
    request, store: { read: async () => structuredClone(tombstone) }, current: () => true,
  } as never, undefined, Effect.runPromise).pipe(Effect.scoped))
  const replayed = await execute({ missionID: tombstone.id, requestID: "check_recorded", expectedRevision: 6, action: "check" as const, transport: { sessionID: "human_cookie" } })
  assert.ok("deleted" in replayed && replayed.deleted)
  assert.equal(replayed.pending, false)
  assert.deepEqual("checkReceipt" in replayed ? replayed.checkReceipt : undefined, { id: tombstone.id, requestID: "check_recorded", expectedRevision: 6, action: "check" })
  for (const fresh of [
    { missionID: tombstone.id, requestID: "check_fresh_after_compact", expectedRevision: 6, action: "check" as const, transport: { sessionID: "human_cookie" } },
    { missionID: tombstone.id, requestID: "check_recorded", expectedRevision: 7, action: "check" as const, transport: { sessionID: "human_cookie" } },
  ]) {
    const refused = await execute(fresh)
    assert.ok("refusal" in refused)
    assert.equal(refused.pending, false)
    assert.deepEqual(refused.refusal, { missionID: tombstone.id, requestID: fresh.requestID, action: "check",
      expectedRevision: fresh.expectedRevision, payloadDigest: missionSchedulePayloadDigest({}), reason: "control-conflict" })
  }
})

test("native manual passage identities refuse changed revision or another action before native effects", async t => {
  const f = await ownerFixture(t), document = await f.read()
  const snapshot = { ...document, pending: { origin: { kind: "manual", requestID: "manual_original" }, manualExpectedRevision: 5 } }
  for (const [action, expectedRevision] of [["run-now", 6], ["pause", 5]] as const) {
    const request = { missionID: document.id, requestID: "manual_original", action, expectedRevision, transport: { sessionID: "human_cookie" } }
    const result = await Effect.runPromise(controlNativeMissionSchedule({} as never, {
      request, store: { read: async () => structuredClone(snapshot) }, current: () => true,
    } as never, undefined, Effect.runPromise).pipe(Effect.scoped))
    assert.ok("refusal" in result)
    assert.equal(result.refusal?.reason, "control-conflict")
    assert.equal(result.pending, false)
    assert.equal(f.calls.length, 0)
  }
})

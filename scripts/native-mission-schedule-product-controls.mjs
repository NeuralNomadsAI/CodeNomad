// Focused journeys for the actual product fixture. Called only after its owner's
// explicit final-ready build; this module provisions no daemon and edits no SQL.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"

const clockRpc = { id: "codenomad.schedule-clock-qualification", methods: { tick: {
  input: { type: "object" }, output: { type: "object" },
} }, events: {} }
const preparingRpc = { id: "codenomad.product-qualification", methods: { armPreparing: {
  input: { type: "object" }, output: { type: "object" },
} }, events: {} }
const locationOf = fixture => ({ location: { directory: fixture.project }, signal: AbortSignal.timeout(20000) })
const originalCount = (state, id) => state.start.filter(message => message.id === id).length
const principalRows = state => state.schedules.filter(row => row.role === "principal")
const removed = rows => rows.every(row => !row.sessionPresent && !row.schedulePresent && !row.reverseIndexPresent)

function terminal(fixture, sessionID) {
  return fixture.readSQL(db => {
    const row = db.prepare("SELECT id,data FROM session_message WHERE session_id=? AND type='idle' ORDER BY seq DESC LIMIT 1").get(sessionID)
    return row && { id: row.id, outcome: JSON.parse(row.data).outcome }
  })
}

async function tickAuxiliary(fixture, state, name) {
  const auxiliary = state.schedules.find(row => row.role === "reconciliation" && row.status === "active")
  assert(Number.isSafeInteger(auxiliary?.next_due_at), "The pending passage must retain its real active auxiliary")
  assert(principalRows(state).every(row => row.status !== "active"), "Every principal must be paused/done before a qualification tick")
  await fixture.save(`${name}-before-tick`, state)
  await fixture.client().rpc(clockRpc).tick({ at: auxiliary.next_due_at + 1 }, locationOf(fixture))
  return auxiliary
}

async function waitBusinessSuccess(fixture, id, count) {
  const admitted = await fixture.until(() => {
    const state = fixture.snapshot(id)
    return state.document.pending?.admittedAt != null && state.document.launchedCount === count ? state : false
  })
  const pending = admitted.document.pending
  assert.equal(originalCount(admitted, pending.messageID), 1)
  await fixture.until(async () => {
    if (terminal(fixture, pending.coordinatorSessionID)?.outcome !== "succeeded") return false
    const journal = await fixture.business(admitted.document)
    return journal.missions[0]?.status === "completed"
  })
  return admitted
}

async function waitInterrupted(fixture, id, pending, name, requestedAt) {
  const proof = await fixture.until(async () => {
    const state = fixture.snapshot(id), claim = state.claims.find(row => row.id === pending.coordinatorSessionID)
    const idle = terminal(fixture, pending.coordinatorSessionID), events = await fixture.maintenanceEvents()
    const interrupted = events.find(event => event.kind === "terminal" && event.type === "session.execution.interrupted" && event.sessionID === pending.coordinatorSessionID
      && (event.nativeCreatedAt ?? event.at) >= requestedAt)
    return claim?.time_suspended === null && state.inboxCount === 0 && fixture.providerOpen() === 0 && interrupted
      ? { state, idle, interrupted } : false
  })
  assert.equal(proof.state.document.launchedCount, 1)
  assert.equal(originalCount(proof.state, pending.messageID), 1)
  assert(!fixture.reported(pending.coordinatorSessionID), "Pause/Stop must interrupt before the held model can report")
  await fixture.save(name, proof)
  return proof.state
}

async function waitCleanup(fixture, id, expected, name) {
  const proof = await fixture.until(() => {
    const state = fixture.snapshot(id), rows = fixture.technicalRows()
    const terminalState = expected === "deleted" ? Number.isSafeInteger(state.document.deletedAt) : state.document.state === expected
    return terminalState && !state.document.pending && removed(rows) ? { state, rows } : false
  })
  await fixture.save(name, proof)
  return proof
}

async function pausedManual(fixture) {
  fixture.result.stage = "paused-manual-create-play-pause"
  const id = await fixture.create("paused_manual", { kind: "every", intervalMs: 900000 }, 3)
  fixture.result.documentID = id
  await fixture.activate(id); await fixture.control(id, "play"); fixture.learnTechnical(fixture.snapshot(id))
  await fixture.control(id, "pause")
  const paused = fixture.snapshot(id), principals = principalRows(paused)
  assert.equal(paused.document.state, "paused"); assert.equal(paused.document.launchedCount, 0)
  assert(principals.length && principals.every(row => row.status === "paused" && row.run_count === 0))
  await fixture.save("paused-before-manual", paused)
  fixture.hold(false)
  const passages = []
  for (const count of [1, 2]) {
    fixture.result.stage = `paused-manual-${count}-run-now`
    await fixture.control(id, "run-now") // New human request exactly once; no Resume.
    const admitted = await waitBusinessSuccess(fixture, id, count)
    assert.equal(admitted.document.state, "paused"); assert.equal(admitted.document.pending.origin.kind, "manual")
    assert(principalRows(admitted).every(row => row.status === "paused" && row.run_count === 0))
    passages.push({ passageID: admitted.document.pending.id, rootID: admitted.document.pending.coordinatorSessionID, messageID: admitted.document.pending.messageID })
    await fixture.save(`manual-${count}-admitted`, admitted)
    await tickAuxiliary(fixture, fixture.snapshot(id), `manual-${count}`)
    const settled = await fixture.until(() => {
      const state = fixture.snapshot(id), rows = fixture.technicalRows()
      return state.document.pending === null && state.document.settledCount === count && rows.every(row => row.sessionPresent && row.nativeClaim === null && row.inboxCount === 0) ? state : false
    })
    assert.equal(settled.document.state, "paused"); assert.equal(settled.document.launchedCount, count)
    assert.equal(settled.document.history.at(-1).outcome, "completed")
    for (const original of principals) {
      const row = principalRows(settled).find(row => row.id === original.id)
      assert(row && row.status === "paused" && row.run_count === 0)
      assert.equal(row.native_when, original.native_when); assert.equal(row.time_created, original.time_created)
    }
    await fixture.save(`manual-${count}-settled-paused`, settled)
  }
  assert.equal(new Set(passages.map(passage => passage.passageID)).size, 2)
  assert.equal(new Set(passages.map(passage => passage.rootID)).size, 2)
  fixture.result.pausedManual = { actualManualPassages: passages, launchedCount: 2, settledCount: 2, desiredStateRetained: "paused", maxLaunches: 3, automaticResume: false }
  await fixture.control(id, "stop", { allowPending: true })
  await waitCleanup(fixture, id, "stopped", "paused-manual-final-stop-cleanup")
}

async function activeControl(fixture, flagOff) {
  const id = await fixture.create(flagOff ? "flag_off_pause" : "stop_pending", { kind: "every", intervalMs: 900000 }, 3)
  fixture.result.documentID = id
  await fixture.activate(id); await fixture.control(id, "play"); fixture.learnTechnical(fixture.snapshot(id))
  fixture.result.stage = "active-control-initial-run-now"
  await fixture.control(id, "run-now")
  const active = await fixture.until(() => {
    const state = fixture.snapshot(id), pending = state.document.pending
    return pending?.admittedAt != null && state.document.launchedCount === 1 && state.claims.some(row => row.id === pending.coordinatorSessionID && Number.isSafeInteger(row.time_suspended) && row.time_suspended > 0)
      && fixture.providerOpen() > 0 ? state : false
  })
  const pending = active.document.pending
  await fixture.save("active-before-human-control", active)
  let flagChanged = false
  try {
    if (flagOff) {
      fixture.result.stage = "flag-off-before-pause"
      flagChanged = true; await fixture.nativeFlag(false)
      const afterFlag = fixture.snapshot(id)
      await fixture.save("flag-off-before-pause", afterFlag)
      assert(afterFlag.claims.some(row => row.id === pending.coordinatorSessionID && row.time_suspended != null) && fixture.providerOpen() > 0,
        "Optional case unqualified: native flag reload already interrupted the actor before Pause")
    }
    const requestedAt = Date.now(), action = flagOff ? "pause" : "stop"
    fixture.result.stage = flagOff ? "flag-off-human-pause" : "human-stop-pending"
    await fixture.control(id, action, { allowPending: true })
    const wanted = fixture.snapshot(id)
    assert.equal(wanted.document.state, flagOff ? "paused" : "stopped")
    if (flagOff) assert.equal(wanted.document.calendarOwner.operation.pending, true, "The flag-OFF case must retain unresolved calendar work")
    await fixture.save("wanted-intent-after-control", wanted)
    if (fixture.controlTrace) {
      const raw = await readFile(fixture.controlTrace.logFile)
      assert(raw.length <= 1024 * 1024)
      const records = raw.toString("utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      assert(records.length, "The true product-context trace must contain records")
      const trace = { records, firstError: records.find(record => /failure|catch/.test(record.stage)) ?? null,
        scope: "actual codenomad.missions controller context; logging-only scratch variant, no fallback" }
      await fixture.save("true-product-stop-trace", trace); fixture.result.trueProductStopTrace = trace
      return // Preserve original 503/pending as failure evidence, not a Stop success.
    }
    if (fixture.diagnoseStop) {
      assert(!flagOff)
      const original = fixture.result.http.at(-1)
      const definition = { id: "codenomad.stop-diagnostic", methods: { probe: { input: { type: "object" }, output: { type: "object" } } }, events: {} }
      fixture.result.stage = "stop-diagnostic-fresh-rpc"
      const diagnostic = await fixture.client().rpc(definition).probe({ missionID: id, pendingID: pending.id, requestID: original.requestID }, locationOf(fixture))
      await fixture.save("stop-diagnostic-rpc", diagnostic)
      fixture.result.stopDiagnostic = diagnostic
      await fixture.save("stop-after-diagnostic", fixture.snapshot(id))
      return // Diagnostic interruption only; never a product-success claim.
    }
    const interrupted = await waitInterrupted(fixture, id, pending, "actual-native-actor-interrupted", requestedAt)
    if (flagOff) {
      await fixture.nativeFlag(true); flagChanged = false // Owned config cleanup only, never Resume.
      await fixture.control(id, "check", { allowPending: true })
      const events = await fixture.maintenanceEvents()
      assert(!events.some(event => event.kind === "execution-started" && event.sessionID === pending.coordinatorSessionID && event.at > requestedAt))
      assert.equal(fixture.snapshot(id).claims.find(row => row.id === pending.coordinatorSessionID).time_suspended, null)
      await fixture.control(id, "stop", { allowPending: true })
    }
    const unsettled = fixture.snapshot(id)
    if (unsettled.document.pending) await tickAuxiliary(fixture, unsettled, "stopped-observation")
    const cleaned = await waitCleanup(fixture, id, "stopped", "stopped-pending-cleanup")
    assert.equal(cleaned.state.document.launchedCount, 1); assert.equal(cleaned.state.document.settledCount, 1)
    assert.equal(cleaned.state.document.history[0].outcome, "ended-without-report")
    fixture.result.activeControl = { action, flagOff, wantedStored: true, nativeActorInterrupted: true, noReportBeforeInterruption: true,
      noAutomaticResume: true, originalMessageID: pending.messageID, rootID: pending.coordinatorSessionID, count: interrupted.document.launchedCount,
      cleanupWithoutSQLWrites: true }
  } finally {
    if (flagChanged) await fixture.nativeFlag(true) // Preserve the fixture's native config even when qualification fails.
  }
}

function preparationIn(state, sessionID, messageID) {
  return [...state.document.calendars ?? [], ...state.document.synchronization?.retiredCalendars ?? []]
    .find(calendar => calendar.sessionID === sessionID && calendar.wakePreparing?.messageID === messageID)?.wakePreparing
}

async function preparingControl(fixture, deleting) {
  const id = await fixture.create(deleting ? "delete_preparing" : "stop_preparing", { kind: "at", at: Date.now() + fixture.delayMs, zone: "UTC" })
  fixture.result.documentID = id
  await fixture.activate(id); await fixture.control(id, "play")
  const armed = fixture.snapshot(id); fixture.learnTechnical(armed)
  const principal = armed.schedules.find(row => row.role === "principal"), token = randomUUID()
  fixture.secret(token)
  assert(principal.next_due_at >= Date.now() + 6000)
  let frame, release, releasedAt, releaseReason
  const unlock = reason => { if (!releasedAt) { releasedAt = Date.now(); releaseReason = reason }; release?.() }
  const barrier = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/hold-preparing" || request.headers["x-fixture-barrier"] !== token) return response.writeHead(403).end()
    let timer
    try {
      let raw = ""; for await (const bytes of request) { raw += bytes; if (raw.length > 16384) throw Error("preparing-barrier-input-bound") }
      const input = JSON.parse(raw)
      assert.equal(input.sessionID, principal.session_id); assert.equal(input.schedule?.id, principal.id)
      assert.equal(input.messageID, `msg_${input.schedule.id}_${input.schedule.run}`); assert(!frame)
      frame = { ...input, observedAt: Date.now() }
      timer = setTimeout(() => unlock("barrier-budget-expired"), 6000)
      response.once("close", () => unlock(releasedAt ? releaseReason : "barrier-client-aborted"))
      await new Promise(resolve => { release = resolve })
      if (!response.destroyed) response.writeHead(200, { "content-type": "application/json" }).end('{"resume":true}')
    } catch { if (!response.destroyed) response.writeHead(400).end() }
    finally { clearTimeout(timer) }
  })
  try {
    await new Promise(resolve => barrier.listen(0, "127.0.0.1", resolve)); assert.notEqual(barrier.address().port, 28894)
    // Register after the product hooks using the observer's own public lifetime.
    await fixture.client().rpc(preparingRpc).armPreparing({ sessionID: principal.session_id, missionID: id,
      url: `http://127.0.0.1:${barrier.address().port}/hold-preparing`, token }, locationOf(fixture))
    fixture.result.stage = "genuine-current-wake-preparing"
    const held = await fixture.until(() => { const state = fixture.snapshot(id); return frame && preparationIn(state, frame.sessionID, frame.messageID) ? state : false }, fixture.delayMs + 10000)
    assert.equal(held.document.launchedCount, 0); assert.equal(held.sessions.length, 0)
    await fixture.save("genuine-wake-preparing-held", { state: held, frame })
    const action = deleting ? "delete" : "stop"
    await fixture.control(id, action, { allowPending: true })
    const originalControl = fixture.result.http.at(-1), during = fixture.snapshot(id)
    assert(!releasedAt, "The original pre-inbox prompt must still be held at the control readback")
    assert.equal(during.document.state, "stopped"); assert.equal(during.document.launchedCount, 0)
    assert(preparationIn(during, frame.sessionID, frame.messageID), "Stop/Delete must retain the original unacknowledged preparation")
    assert(fixture.technicalRows().find(row => row.sessionID === frame.sessionID)?.sessionPresent)
    if (deleting) assert.equal(during.document.deletion.requestID, originalControl.requestID)
    await fixture.save("control-retains-current-preparation", { state: during, frame, originalControl })
    unlock("control-proof-recorded")
    const nativeACK = await fixture.until(() => fixture.readSQL(db => {
      const row = db.prepare("SELECT id,data FROM session_message WHERE id=? AND session_id=? AND type='user'").get(frame.messageID, frame.sessionID)
      if (!row) return false
      const data = JSON.parse(row.data), schedule = data.metadata?.schedule
      return schedule?.id === frame.schedule.id && schedule.run === frame.schedule.run && schedule.dueAt === frame.schedule.dueAt
        ? { id: row.id, scheduleID: schedule.id, run: schedule.run, dueAt: schedule.dueAt } : false
    }))
    await fixture.save("genuine-original-native-ack", nativeACK)
    await fixture.until(() => fixture.technicalRows().filter(row => row.sessionID === frame.sessionID).every(row => row.nativeClaim === null && row.inboxCount === 0))
    await fixture.control(id, "check", { allowPending: true }) // Explicit fresh human Check; never a blind original resend.
    const clean = await waitCleanup(fixture, id, deleting ? "deleted" : "stopped", "current-preparation-final-cleanup")
    if (deleting) { assert.equal(clean.state.document.requestID, originalControl.requestID); assert.equal(clean.state.document.expectedRevision, originalControl.expectedRevision) }
    else assert.equal(clean.state.document.launchedCount, 0)
    assert.equal(fixture.calls.length, 0)
    fixture.result.currentPreparation = { action, heldMs: releasedAt - frame.observedAt, releaseReason, genuineNativeACK: nativeACK,
      preparationRetainedBeforeACK: true, noBusinessAdmission: true, exactCleanup: true }
  } finally { unlock("fixture-finally"); barrier.closeAllConnections(); if (barrier.listening) await new Promise(resolve => barrier.close(resolve)) }
}

export async function runProductControlJourney(kind, fixture) {
  if (kind === "paused-manual") return pausedManual(fixture)
  if (kind === "stop-pending" || kind === "flag-off-pause") return activeControl(fixture, kind === "flag-off-pause")
  return preparingControl(fixture, kind === "delete-preparing")
}

import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { controlNativeMissionSchedule } from "./native-mission-schedule-control"
import { nativeMissionScheduleControlExecution } from "./native-mission-schedule-authority"
import { nativeMissionScheduleResult } from "./native-mission-schedule-result"
import { nativeScheduleOwnerControlReceipt } from "./native-schedule-owner"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"

const principals = [{ kind: "human" as const, sessionID: "cookie" },
  { kind: "agent" as const, author: { coordinatorSessionID: "ses_agent" } }]

for (const action of ["play", "pause", "stop", "resume", "configure", "delete"] as const) {
  test(`${action} replay requires its own retained calendar receipt after 17 Checks`, async t => {
    const f = await ownerFixture(t)
    const ctx = { ...f.ctx, agent: { ...f.ctx.agent, list: () => Effect.die(new Error("reconciliation-acquired")) } }
    if (action !== "play") await f.control("play")
    if (action === "resume") await f.control("pause")
    const before = await f.read()
    const configuration = action === "configure" ? { ...before.configuration, title: "Edited",
      coordinatorSelectionAuthor: { coordinatorSessionID: "ses_agent" } } : undefined
    const input = { missionID: before.id, requestID: `original_${action}`, expectedRevision: before.revision, action,
      ...(configuration ? { configuration } : {}) }
    await f.owner.control(input)
    for (let i = 0; i < 17; i++) await f.control("check", `evict_${i}`)
    const doc = await f.read(), saved = structuredClone([...f.values]), calls = [...f.calls]
    assert.equal(doc.calendarOwner!.receipts.length, 16)
    assert.equal(nativeScheduleOwnerControlReceipt(doc, input.requestID), undefined)
    assert.equal((await nativeMissionScheduleResult(f.ctx, doc, Effect.runPromise, false, input.requestID)).pending, true)
    for (const principal of principals) {
      const request = { ...input, transport: { principal, issuedAt: Date.now() } }
      // Recovery needs the actual native graph, deliberately absent here. A
      // calendar-only shortcut would incorrectly return success instead.
      await assert.rejects(Effect.runPromise(controlNativeMissionSchedule(ctx, {
        request, before: doc, store: f.store, ...nativeMissionScheduleControlExecution(request as never, f.current),
      } as never, undefined, Effect.runPromise).pipe(Effect.scoped)), /reconciliation-acquired/)
    }
    assert.deepEqual([...f.values], saved)
    assert.deepEqual(f.calls, calls)
  })
}

test("Run now replay stays unknown once its own passage leaves the thirty-result window", async t => {
  const f = await ownerFixture(t, undefined, 100)
  const ctx = { ...f.ctx, agent: { ...f.ctx.agent, list: () => Effect.die(new Error("reconciliation-acquired")) } }
  await f.control("play")
  const before = await f.read()
  const input = { missionID: before.id, requestID: "manual_0", expectedRevision: before.revision, action: "run-now" as const }
  for (let i = 0; i < 31; i++) {
    const doc = await f.read()
    await f.store.change(doc.id, doc.revision, f.current, value => {
      changes.reserve(value, { kind: "manual", requestID: `manual_${i}` }, f.now + i * 3 + 1, [])
      value.pending!.manualExpectedRevision = doc.revision
      changes.admitted(value, value.pending!.id, f.now + i * 3 + 2)
      changes.settle(value, value.pending!.id, "completed", f.now + i * 3 + 3)
    })
  }
  const doc = await f.read(), saved = structuredClone([...f.values])
  assert.equal(doc.history.length, 30)
  assert.ok(!doc.history.some(item => item.origin.kind === "manual" && item.origin.requestID === input.requestID))
  assert.equal((await nativeMissionScheduleResult(f.ctx, doc, Effect.runPromise, false, input.requestID)).pending, true)
  for (const principal of principals) {
    const request = { ...input, transport: { principal, issuedAt: Date.now() } }
    await assert.rejects(Effect.runPromise(controlNativeMissionSchedule(ctx, {
      request, before: doc, store: f.store, ...nativeMissionScheduleControlExecution(request as never, f.current),
    } as never, undefined, Effect.runPromise).pipe(Effect.scoped)), /reconciliation-acquired/)
  }
  assert.deepEqual([...f.values], saved)
})

test("completed Check replays still acquire reconciliation with no pending passage", async t => {
  const f = await ownerFixture(t)
  const ctx = { ...f.ctx, agent: { ...f.ctx.agent, list: () => Effect.die(new Error("reconciliation-acquired")) } }
  await f.control("play")
  const before = await f.read()
  const input = { missionID: before.id, requestID: "original_check", expectedRevision: before.revision, action: "check" as const }
  const doc = await f.owner.control(input)
  assert.equal(nativeScheduleOwnerControlReceipt(doc, input.requestID)?.pending, false)
  assert.equal(doc.pending, null)
  for (const principal of principals) {
    const request = { ...input, transport: { principal, issuedAt: Date.now() } }
    await assert.rejects(Effect.runPromise(controlNativeMissionSchedule(ctx, {
      request, before: doc, store: f.store, ...nativeMissionScheduleControlExecution(request as never, f.current),
    } as never, undefined, Effect.runPromise).pipe(Effect.scoped)), /reconciliation-acquired/)
  }
})

import assert from "node:assert/strict"
import test from "node:test"
import { structuralDerivedFixture, freshSignal } from "./derived-call-business.test"
import { DerivedCallPublication, derivedCallEventID } from "./derived-call-publication"
import { derivedNativeBinding } from "./derived-call-business"
import type { MissionNativeReportRequest } from "./control-types"
import type { MissionEvent, MissionJsonValue } from "./model"

// Real journal/crypto/authority code with explicitly injected structural trust.
// No actual host channel, native invocation/provider/family or commit proof.
test("binding publication and authority activation are explicit separate phases over the shared journal", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body()
  await g.start(body); g.native(body)
  const input = g.request(body, "bind"), result = await g.publication.publishBinding(input, freshSignal())
  assert.equal(result.eventID, derivedCallEventID(body.reservationID, "bind"))
  assert.equal((await g.authority.read(body.reservationID))!.state, "invoking")
  const mission = await g.mission(), task = mission.tasks[0]
  assert.deepEqual(task.nativeExecution?.binding, derivedNativeBinding(body)); assert.equal(task.actorSessionId, "ses_child")
  const record = await g.publication.activateBinding(input, freshSignal()); await g.refresh()
  assert.equal(record.state, "active"); assert.equal(record.child!.projectID, body.projectID)
  assert.deepEqual(record.child!.location, { directory: g.f.project })
  await assert.rejects(g.publication.publishBinding(input, freshSignal()))
  assert.equal(g.forwarded[0].nonce, input.nonce); assert.equal(g.forwarded[0].incarnationID, input.incarnationID)
  assert.equal(g.forwarded[0].proof, input.proof, "original channel proof is forwarded by identity, never reissued/selected")
})

test("native report/end evidence stays historical after later continuation, but old end cannot settle the later call", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const original = await g.body()
  await g.start(original); await g.bind(original); await g.end(original)
  const next = await g.body("work", { toolCallID: "call_continue", parentMessageID: "msg_continue", choice: { kind: "continue", sessionID: "ses_child" } })
  await g.start(next); await g.bind(next)
  const oldChild = (await g.authority.read(original.reservationID))!.child!
  assert.equal(await g.business.accepted(original, oldChild, "report"), true)
  assert.equal(await g.business.accepted(original, oldChild, "end"), true)
  const observation = await g.business.observe(original, original.task, true)
  assert.equal(observation.current, false); assert.equal(observation.binding!.toolCallID, original.toolCallID)
  assert.equal(observation.binding!.ended, "returned")
  await assert.rejects(g.business.accepted(original, oldChild, "execute"), /authorization-blocked/)
  const report = await g.authority.authorize(original.reservationID, "report", g.context(original, "report", "ses_child"), freshSignal())
  assert.equal(report.late, true); assert.equal(report.assertCurrent(), true)
  const end = { ...g.request(original, "end", "ses_child", "returned"), outcome: "returned" as const }
  await assert.rejects(g.publication.publishEnd(end, freshSignal()))
  const execution = (await g.mission()).tasks[0].nativeExecution!
  assert.equal(execution.binding.toolCallID, next.toolCallID); assert.equal(execution.ended, undefined)
})

test("same-task continuation publishes call-started and call-ended, retaining actor identity and original binding", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const original = await g.body()
  await g.start(original); await g.bind(original); await g.end(original, "ses_child", "error")
  const before = (await g.mission()).actors.find(actor => actor.sessionId === "ses_child")!
  const next = await g.body("work", { toolCallID: "call_next", parentMessageID: "msg_next", choice: { kind: "continue", sessionID: "ses_child" } })
  await g.start(next); await g.bind(next)
  const started = await g.journal.event(next.missionID, derivedCallEventID(next.reservationID, "bind"))
  assert.equal(started?.type, "task.native-call-started")
  await g.end(next)
  const ended = await g.journal.event(next.missionID, derivedCallEventID(next.reservationID, "end"))
  assert.equal(ended?.type, "task.native-call-ended")
  const after = await g.mission()
  assert.deepEqual(after.tasks[0].nativeBinding, derivedNativeBinding(original), "error-ended original identity is never replaced by continuation")
  assert.equal(after.tasks[0].nativeExecution!.binding.toolCallID, next.toolCallID)
  assert.deepEqual(after.actors.find(actor => actor.sessionId === "ses_child"), before)
})

test("late end observation with no publication receipt cannot end a later continuation by borrowing accepted historical evidence", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const original = await g.body()
  await g.start(original); await g.bind(original)
  await g.journal.append({ ...g.base(), type: "task.native-returned", taskKey: "work", childSessionID: "ses_child", binding: derivedNativeBinding(original) })
  const oldEnd = { ...g.request(original, "end", "ses_child", "returned"), outcome: "returned" as const }
  await g.publication.endAuthority(oldEnd, freshSignal()); await g.refresh()
  const next = await g.body("work", { toolCallID: "call_after_external_return", parentMessageID: "msg_after_external_return",
    choice: { kind: "continue", sessionID: "ses_child" } })
  await g.start(next); await g.bind(next)
  assert.equal(await g.journal.event(original.missionID, derivedCallEventID(original.reservationID, "end")), undefined)
  await assert.rejects(g.publication.publishEnd(oldEnd, freshSignal()), /authorization-blocked/)
  const latest = (await g.mission()).tasks[0].nativeExecution!
  assert.equal(latest.binding.toolCallID, next.toolCallID); assert.equal(latest.ended, undefined)
  assert.equal(await g.journal.event(original.missionID, derivedCallEventID(original.reservationID, "end")), undefined)
})

test("explicit new-task reuse preserves existing title, full location and managed identity", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("source", { title: "Owned original actor title" })
  const source = await g.body("source"); await g.start(source); await g.bind(source); await g.report(source); await g.end(source)
  const actor = (await g.mission()).actors.find(actor => actor.sessionId === "ses_child")!
  await g.task("reuse", { title: "Different task title", blockedBy: ["source"], executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "source" } })
  const next = await g.body("reuse", { choice: { kind: "reuse", sessionID: "ses_child", fromTask: source.task } })
  await g.start(next); await g.bind(next)
  const event = await g.journal.event(next.missionID, derivedCallEventID(next.reservationID, "bind"))
  assert.equal(event?.type, "task.native-bound")
  if (event?.type !== "task.native-bound") assert.fail("wrong event kind")
  assert.equal(event.actor.title, actor.title); assert.equal(event.actor.managed, actor.managed)
  assert.deepEqual(event.actor.location, actor.location)
  assert.equal((await g.mission()).actors.filter(actor => actor.sessionId === "ses_child").length, 1)
})

test("binding does not demand idle again after the admitted original native continuation has entered", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const original = await g.body()
  await g.start(original); await g.bind(original); await g.end(original, "ses_child", "error")
  const next = await g.body("work", { toolCallID: "call_entered", parentMessageID: "msg_entered", choice: { kind: "continue", sessionID: "ses_child" } })
  await g.start(next) // genuine production admission must check idle HERE, before original executor entry
  g.native(next); g.setIdle(false) // injected test activity represents that same original call, not another caller
  const input = g.request(next, "bind")
  await g.publication.publishBinding(input, freshSignal()); await g.publication.activateBinding(input, freshSignal())
  assert.equal((await g.authority.read(next.reservationID))!.state, "active")
  assert.equal((await g.mission()).tasks[0].nativeExecution!.binding.toolCallID, next.toolCallID)
})

test("actual guarded storage write rechecks native/currentness after its policy await", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); await g.start(body); g.native(body)
  const input = g.request(body, "bind"), before = structuredClone([...g.values])
  g.beforeWrite(async () => { await Promise.resolve(); g.setClaim(false) })
  await assert.rejects(g.publication.publishBinding(input, freshSignal()), /policy-unqualified/)
  assert.deepEqual([...g.values], before, "no write after the last await loses qualification")
  assert.equal((await g.authority.read(body.reservationID))!.state, "invoking")
})

test("a lost journal-write reply leaves shared binding and invoking authority independently ambiguous without replay", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); await g.start(body); g.native(body)
  const input = g.request(body, "bind")
  g.afterWrite(() => { throw new Error("lost shared native write acknowledgement") })
  await assert.rejects(g.publication.publishBinding(input, freshSignal()), /lost shared native write/)
  g.afterWrite()
  assert.equal((await g.mission()).tasks[0].actorSessionId, "ses_child")
  assert.equal((await g.authority.read(body.reservationID))!.state, "invoking")
  const bytes = JSON.stringify([...g.values])
  await assert.rejects(g.publication.publishBinding(input, freshSignal()), /request-conflict/)
  assert.equal(JSON.stringify([...g.values]), bytes)
})

test("a stored but refused projection cannot activate authority and is never repaired", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); await g.start(body); g.native(body)
  g.afterWrite(() => {
    const entry = [...g.values.entries()].find(([, value]) => (value as unknown as MissionEvent).id === derivedCallEventID(body.reservationID, "bind"))
    if (entry) { const event = structuredClone(entry[1]) as unknown as Extract<MissionEvent, { type: "task.native-bound" }>
      event.binding.generation = 9; g.values.set(entry[0], event as unknown as MissionJsonValue) }
  })
  const input = g.request(body, "bind")
  await assert.rejects(g.publication.publishBinding(input, freshSignal()), /observation-unavailable/)
  const before = JSON.stringify([...g.values])
  await assert.rejects(g.publication.activateBinding(input, freshSignal()))
  assert.equal((await g.authority.read(body.reservationID))!.state, "invoking")
  assert.equal(JSON.stringify([...g.values]), before)
})

test("shared executor-end and authority terminal receipts are independent, with no automatic completion retry", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); await g.start(body); await g.bind(body)
  const input = { ...g.request(body, "end", "ses_child", "returned"), outcome: "returned" as const }
  await g.publication.publishEnd(input, freshSignal())
  assert.equal((await g.authority.read(body.reservationID))!.state, "active")
  assert.equal((await g.mission()).tasks[0].nativeExecution!.ended, "returned")
  await assert.rejects(g.publication.publishEnd(input, freshSignal()), /request-conflict/)
  await assert.rejects(g.publication.endAuthority({ ...input, proof: {} }, freshSignal()))
  assert.equal((await g.authority.read(body.reservationID))!.state, "active")
  await g.publication.endAuthority(input, freshSignal()); await g.refresh()
  assert.equal((await g.authority.read(body.reservationID))!.ended, "returned")
})

test("report callback handoff authenticates actual child report Tool/message separately from parent native-call tuple", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); await g.start(body); await g.bind(body)
  const request: MissionNativeReportRequest = { contract: { missionID: body.missionID, taskKey: body.task.taskKey, generation: body.task.generation },
    sessionID: "ses_child", toolCallID: "call_actual_report", messageID: "msg_actual_report" }
  const input = { ...g.context(body, "report", "ses_child", undefined, request), reservationID: body.reservationID, request }
  const auth = await g.publication.authorizeReport(input, freshSignal())
  assert.deepEqual(auth.call, derivedNativeBinding(body)); assert.equal(auth.current(), true)
  const forwarded = g.forwarded.at(-1)!
  assert.deepEqual(forwarded.reportRequest, request); assert.equal(forwarded.nonce, input.nonce); assert.equal(forwarded.proof, input.proof)
  await assert.rejects(g.publication.authorizeReport({ ...input, request: { ...request, toolCallID: "call_sibling_report" } }, freshSignal()))
  await assert.rejects(g.publication.authorizeReport({ ...input, request: { ...request, sessionID: "ses_sibling" } }, freshSignal()), /binding-mismatch/)
  g.setClaim(false); assert.throws(() => auth.current(), /policy-unqualified/)
  assert.deepEqual((await g.mission()).reports, [], "authorization publishes no report or coordinator notification")
})

test("missing/forged channel context cannot publish, and nonce/incarnation are never minted or inferred", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); await g.start(body); g.native(body)
  assert.throws(() => new DerivedCallPublication({ authority: g.authority, business: g.business, channel: undefined! }), /policy-unqualified/)
  const input = g.request(body, "bind")
  for (const change of [{ nonce: "" }, { incarnationID: "" }, { proof: undefined }, { nonce: "foreign-nonce" }, { incarnationID: "foreign-writer" }, { proof: {} }]) {
    await assert.rejects(g.publication.publishBinding({ ...input, ...change }, freshSignal()))
  }
  assert.equal((await g.mission()).tasks[0].nativeBinding, undefined)
})

test("promise/thenable/nonliteral write leases never pass a mandatory publication fence", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); await g.start(body); g.native(body)
  for (const result of [undefined, Promise.resolve(true), { then() { throw new Error("must not assimilate") } }]) {
    const publication = new DerivedCallPublication({ authority: g.authority, business: g.business,
      channel: { async authorize() { return { assertCurrent: () => result as unknown as true } } } })
    await assert.rejects(publication.publishBinding(g.request(body, "bind"), freshSignal()), /policy-unqualified/)
    assert.equal((await g.mission()).tasks[0].nativeBinding, undefined)
  }
})

test("pre-aborted publication does not publish or activate the original native call", async t => {
  const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); await g.start(body); g.native(body)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(g.publication.publishBinding(g.request(body, "bind"), abort.signal))
  assert.equal((await g.authority.read(body.reservationID))!.state, "invoking")
  assert.equal((await g.mission()).tasks[0].nativeBinding, undefined)
})

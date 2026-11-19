import assert from "node:assert/strict"
import test from "node:test"
import { automaticMissionStartID } from "../../missions/preparation-result"
import { ownerFixture } from "./native-schedule-owner-test-fixture"

test("agent first Play consumes creation in the intent CAS, and every second Play refuses without effects", async t => {
  const f = await ownerFixture(t), creationRequestID = "agent_create", creationDigest = "a".repeat(64)
  const author = { coordinatorSessionID: "ses_author" }, requestID = automaticMissionStartID(creationRequestID)
  let doc = await f.store.create("agent_calendar", f.configuration, f.now, f.current, null, {
    requestID: creationRequestID, digest: creationDigest, author,
    input: { objective: f.configuration.objective, template: "custom", startOnCreation: true },
    automaticStart: { requestID, attempted: false },
  })
  doc = await f.store.change(doc.id, doc.revision, f.current, value => {
    value.scheduleActivation = { requestID: "activation", expectedRevision: 0, authority: "0".repeat(64), state: "ready", targets: [], effectiveOrigin: f.directory }
  })
  const input = { missionID: doc.id, requestID, expectedRevision: doc.revision, action: "play" as const,
    automaticStart: { author, creationRequestID, creationDigest } }
  const prepared = await f.owner.prepareControl(input)
  assert.equal(prepared.revision, doc.revision + 1)
  assert.equal(prepared.creation?.automaticStart?.attempted, true)
  assert.equal(prepared.calendarOwner?.operation.requestID, requestID)
  assert.equal(prepared.calendarOwner?.operation.expectedRevision, input.expectedRevision)
  assert.deepEqual(f.calls, [])
  const before = structuredClone(prepared)
  for (const action of ["play", "resume", "pause", "stop", "check", "configure", "delete"] as const) {
    await assert.rejects(f.owner.prepareControl({ ...input, action, expectedRevision: prepared.revision }), /first Play unavailable/)
    assert.deepEqual(await f.store.read(doc.id), before)
    assert.deepEqual(f.calls, [])
  }
})

test("agent first Play revalidates the author, request, digest and fresh slot before publication", async t => {
  const f = await ownerFixture(t), creationRequestID = "agent_create", author = { coordinatorSessionID: "ses_author" }
  const requestID = automaticMissionStartID(creationRequestID), creationDigest = "a".repeat(64)
  const doc = await f.store.create("agent_calendar", f.configuration, f.now, f.current, null, {
    requestID: creationRequestID, digest: creationDigest, author,
    input: { objective: f.configuration.objective, template: "custom", startOnCreation: true },
    automaticStart: { requestID, attempted: false },
  })
  const input = { missionID: doc.id, requestID, expectedRevision: doc.revision, action: "play" as const,
    automaticStart: { author, creationRequestID, creationDigest } }
  for (const automaticStart of [
    { ...input.automaticStart, author: { coordinatorSessionID: "ses_other" } },
    { ...input.automaticStart, creationRequestID: "other" },
    { ...input.automaticStart, creationDigest: "b".repeat(64) },
  ]) {
    await assert.rejects(f.owner.prepareControl({ ...input, automaticStart }), /first Play unavailable/)
    assert.deepEqual(await f.store.read(doc.id), doc)
    assert.deepEqual(f.calls, [])
  }
})

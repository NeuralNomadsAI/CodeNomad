import assert from "node:assert/strict"
import test from "node:test"
import { controlOperationID, controlReceiptID, hasInvalidControlHistory, isControlReceipt } from "./receipt-identity"
import { projectLifecycle, type MissionControlRequestedEvent, type MissionNativeAcknowledgement } from "./lifecycle-model"
import type { MissionEvent } from "./model"

const intent: MissionControlRequestedEvent = { version: 1, type: "mission.control-requested", missionID: "msn_fixture", projectID: "project",
  id: controlOperationID("msn_fixture", "pause"), requestID: "pause", expectedRevision: 1, action: "pause", createdAt: 1,
  targets: [{ sessionID: "ses_actor", location: { directory: "/repo" } }] }
const ack: MissionNativeAcknowledgement = { missionID: intent.missionID, operationID: intent.id, sessionID: "ses_actor", action: "pause",
  disposition: "interrupt-observed", interrupt: { interrupted: false }, cancellations: [] }
const receipt = (nativeAcknowledgement?: MissionNativeAcknowledgement): MissionEvent => ({ version: 1, type: "mission.control-applied",
  id: controlReceiptID(intent.id, "ses_actor"), projectID: intent.projectID, missionID: intent.missionID, operationID: intent.id,
  sessionID: "ses_actor", createdAt: 2, ...(nativeAcknowledgement ? { nativeAcknowledgement } : {}) })

test("canonical interrupted:false receipt remains known without asserting activity or suspension", () => {
  assert.equal(isControlReceipt(receipt(ack), intent, "ses_actor"), true)
  const projection = projectLifecycle([intent, receipt(ack)])
  assert.deepEqual(projection.control?.pending, [])
  assert.deepEqual(projection.control?.receipts, [{ receiptID: controlReceiptID(intent.id, "ses_actor"), sessionID: "ses_actor",
    acknowledgementState: "known", nativeAcknowledgement: ack }])
  assert.equal("activity" in projection, false)
})

test("historical canonical receipts are retained explicitly unknown, never upgraded to a native ACK", () => {
  const projection = projectLifecycle([intent, receipt()])
  assert.deepEqual(projection.control?.pending, [])
  assert.deepEqual(projection.control?.receipts, [{ receiptID: controlReceiptID(intent.id, "ses_actor"), sessionID: "ses_actor", acknowledgementState: "unknown" }])
})

test("ACK target, action, operation or mission substitution fails closed and retains pending", () => {
  for (const changes of [{ action: "stop" }, { sessionID: "ses_other" }, { missionID: "msn_other" }, { operationID: "evt_other" },
    { interrupt: { interrupted: "false" } }, { disposition: "unknown" }]) {
    const bad = receipt({ ...ack, ...changes } as MissionNativeAcknowledgement)
    assert.equal(isControlReceipt(bad, intent, "ses_actor"), false)
    assert.equal(hasInvalidControlHistory([intent, bad]), true)
    assert.deepEqual(projectLifecycle([intent, bad]).control?.pending, ["ses_actor"])
  }
})

test("native acknowledgement cannot repair a foreign or noncanonical receipt identity", () => {
  for (const changes of [{ id: "evt_other" }, { sessionID: "ses_other" }, { projectID: "foreign" }, { missionID: "msn_other" }, { operationID: "evt_other" }]) {
    assert.equal(isControlReceipt({ ...receipt(ack), ...changes } as MissionEvent, intent, "ses_actor"), false)
  }
})

test("conflicting duplicate receipt bytes are damaged evidence, not last-writer-wins", () => {
  const second = receipt({ ...ack, interrupt: { interrupted: true } })
  assert.equal(hasInvalidControlHistory([intent, receipt(ack), second]), true)
  assert.equal(projectLifecycle([intent, receipt(ack), second]).controlUnavailable, true)
  assert.deepEqual(projectLifecycle([intent, receipt(ack), second]).control?.pending, ["ses_actor"])
})

test("superseding operations do not reuse earlier native ACKs or receipt identities", () => {
  const stop: MissionControlRequestedEvent = { ...intent, action: "stop", requestID: "stop", id: controlOperationID(intent.missionID, "stop"), expectedRevision: 3, createdAt: 3 }
  const projected = projectLifecycle([intent, receipt(ack), stop])
  assert.equal(projected.control?.id, stop.id)
  assert.deepEqual(projected.control?.pending, ["ses_actor"])
  assert.deepEqual(projected.control?.receipts, [])
})

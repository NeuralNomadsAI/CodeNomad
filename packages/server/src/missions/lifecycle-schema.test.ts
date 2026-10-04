import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { lifecycleOperationSchema, nativeAcknowledgementSchema, parseMissionLifecycleReply, parseMissionNativeAcknowledgement } from "./lifecycle-schema"
import { controlResumeAdmissionID } from "./receipt-identity"

const identity = { missionID: "msn_fixture", operationID: "evt_control", sessionID: "ses_actor" }
const expected = { ...identity, action: "start" as const }
const start = () => ({ ...expected, disposition: "start-admitted", admission: {
  id: controlResumeAdmissionID(identity.operationID, identity.sessionID), sessionID: identity.sessionID,
  type: "synthetic", delivery: "queue", time: { created: 123 }, payload: { text: "Continue existing work",
    description: "Existing lifecycle input", metadata: { "codenomad.mission": { version: 1, missionID: identity.missionID,
      operationID: identity.operationID, kind: "lifecycle" }, other: { native: [false, null, 1] } } },
} })
const interrupt = (action = "pause") => ({ ...identity, action, disposition: "interrupt-observed", interrupt: { interrupted: false }, cancellations: [] })

test("strict lifecycle replies preserve the exact full native admission without mutation or coercion", () => {
  const ack = start(), before = structuredClone(ack)
  assert.deepEqual(parseMissionLifecycleReply({ nativeAcknowledgement: ack }, expected), ack)
  assert.deepEqual(ack, before)
})

test("boolean interrupted:false and target-missing are distinct known observations", () => {
  assert.deepEqual(parseMissionNativeAcknowledgement(interrupt()), interrupt())
  const missing = { ...identity, action: "stop", disposition: "target-missing" }
  assert.deepEqual(parseMissionNativeAcknowledgement(missing), missing)
  assert.equal(parseMissionNativeAcknowledgement({ ...missing, action: "start" }), undefined)
})

test("unknown/legacy transport replies never become new native acknowledgements", () => {
  for (const value of [undefined, null, true, {}, { applied: true }, interrupt(), { nativeAcknowledgement: undefined },
    { nativeAcknowledgement: interrupt(), applied: true }, { nativeAcknowledgement: { ...interrupt(), activity: "idle" } }]) {
    assert.equal(parseMissionLifecycleReply(value, { ...identity, action: "pause" }), undefined)
  }
})

test("target, operation, mission and action must match exactly", () => {
  for (const changes of [{ sessionID: "ses_other" }, { operationID: "evt_other" }, { missionID: "msn_other" }, { action: "stop" as const }]) {
    assert.equal(parseMissionNativeAcknowledgement(interrupt(), { ...identity, action: "pause", ...changes }), undefined)
  }
})

test("start admission must be queued and carry the actual stable message and lifecycle correlation", () => {
  for (const changes of ["id", "session", "delivery", "type", "time", "metadata", "kind", "operation"] as const) {
    const ack: any = start()
    if (changes === "id") ack.admission.id = "msg_other"
    if (changes === "session") ack.admission.sessionID = "ses_other"
    if (changes === "delivery") ack.admission.delivery = "steer"
    if (changes === "type") ack.admission.type = "user"
    if (changes === "time") ack.admission.time.created = NaN
    if (changes === "metadata") delete ack.admission.payload.metadata
    if (changes === "kind") ack.admission.payload.metadata["codenomad.mission"].kind = "assignment"
    if (changes === "operation") ack.admission.payload.metadata["codenomad.mission"].operationID = "evt_other"
    assert.equal(parseMissionNativeAcknowledgement(ack, expected), undefined, changes)
  }
})

test("cancellation receipts are bounded, unique and never permitted for Pause", () => {
  for (const cancellations of [[{ inboxID: "inb_one", disposition: "native-acknowledged" }],
    [{ inboxID: "inb_one", disposition: "native-acknowledged" }, { inboxID: "inb_one", disposition: "observed-absent" }],
    Array.from({ length: 129 }, (_, i) => ({ inboxID: `inb_${i}`, disposition: "observed-absent" }))]) {
    const ack = { ...interrupt(), cancellations }
    assert.equal(parseMissionNativeAcknowledgement(ack), undefined)
    if (cancellations.length > 1) assert.equal(parseMissionNativeAcknowledgement({ ...ack, action: "stop" }), undefined)
  }
  const ack = { ...interrupt("stop"), cancellations: [{ inboxID: "inb_one", disposition: "observed-absent" }] }
  assert.deepEqual(parseMissionNativeAcknowledgement(ack), ack)
})

test("non-JSON, cyclic or oversized native metadata is rejected rather than silently normalized", () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  for (const value of [undefined, NaN, () => {}, cyclic, "x".repeat(16_385), new Date()]) {
    const ack: any = start(); ack.admission.payload.metadata.other = value
    assert.equal(parseMissionNativeAcknowledgement(ack), undefined)
  }
})

test("RPC operation schemas expose known/unknown receipts while retaining historical absence", () => {
  const ajv = new Ajv({ allErrors: true })
  const ackValid = ajv.compile(nativeAcknowledgementSchema)
  assert.equal(ackValid(start()), true)
  assert.equal(ackValid(interrupt()), true)
  const validate = ajv.compile(lifecycleOperationSchema)
  const operation = { missionID: identity.missionID, action: "start", requestID: "request", expectedRevision: 1, id: identity.operationID, pending: [],
    targets: [{ sessionID: identity.sessionID, location: { directory: "/repo" } }] }
  assert.equal(validate(operation), true)
  const receipt = { receiptID: "evt_receipt", sessionID: identity.sessionID, acknowledgementState: "known", nativeAcknowledgement: start() }
  assert.equal(validate({ ...operation, receipts: [receipt] }), true)
  assert.equal(validate({ ...operation, receipts: [{ ...receipt, acknowledgementState: "unknown" }] }), false)
  const historical = { receiptID: "evt_receipt", sessionID: identity.sessionID, acknowledgementState: "unknown" }
  assert.equal(validate({ ...operation, receipts: [historical] }), true)
  assert.equal(validate({ ...operation, receipts: [{ ...historical, acknowledgementState: "known" }] }), false)
})

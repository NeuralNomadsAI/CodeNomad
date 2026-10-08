import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { recurrenceHumanRequestID } from "./recurrence-authority-contract"
import { controlOperationID, controlReceiptID } from "./receipt-identity"
import { lifecycleOperationReadSchema } from "./lifecycle-schema"
import { Effect } from "effect"
import { withNativeRecurrenceRpc } from "../opencode/missions/managed-owner-plugin"

test("native read registration preserves the separately qualified control and exact status handlers", async () => {
  const control = () => Effect.fail(new Error("control not invoked")), status = () => Effect.fail(new Error("status not invoked"))
  let captured: Record<string, unknown> = {}
  const rpc = { register: (_definition: unknown, handlers: Record<string, unknown>) => Effect.sync(() => { captured = handlers }) }
  const entry = withNativeRecurrenceRpc({ rpc } as never)
  await Effect.runPromise(Effect.scoped(entry.register(CODENOMAD_MISSIONS_RPC, { recurrenceControl: control, recurrenceControlStatus: status } as never)))
  assert.equal(captured.recurrenceControl, control)
  assert.equal(captured.recurrenceControlStatus, status)
  for (const method of ["recurrenceRead", "recurrenceCreate", "recurrencePassageRead", "recurrenceCurrent", "recurrenceCurrentContent"])
    assert.equal(typeof captured[method], "function")
  assert.ok(CODENOMAD_MISSIONS_RPC.methods.recurrenceControl)
  assert.ok(CODENOMAD_MISSIONS_RPC.methods.recurrenceControlStatus)
})

test("the joined native RPC keeps schedule lookup, archive pages and current passage distinct with strict outputs", () => {
  const methods = CODENOMAD_MISSIONS_RPC.methods
  const ajv = new Ajv({ allErrors: true })
  const lookup = ajv.compile(methods.recurrenceRead.input)
  assert.equal(lookup({ id: "rec_schedule" }), true)
  assert.equal(lookup({ scheduleID: "rec_schedule", passageID: "pas_archive" }), false)
  const archive = ajv.compile(methods.recurrencePassageRead.input)
  assert.equal(archive({ scheduleID: "rec_schedule", passageID: "pas_archive" }), true)
  assert.equal(archive({ scheduleID: "rec_schedule", passageID: "pas_archive", missionID: "forged" }), false)
  const current = ajv.compile(methods.recurrenceCurrent.input)
  assert.equal(current({ scheduleID: "rec_schedule" }), true)
  assert.equal(current({ scheduleID: "rec_schedule", sessionID: "forged" }), false)
  const validate = ajv.compile(methods.recurrenceSnapshot.output)
  const schedule = { id: "rec_schedule", revision: 0, scheduleRevision: 0, state: "paused", clock: { time: "07:00", zone: "UTC" },
    pendingPassageID: null, pendingStatus: null, pendingAdmission: null, settledCount: 0, latestResult: null, history: [] }
  const snapshot = { version: 1, projectID: "project", projectCanonical: "/project", location: { directory: "/project" }, schedules: [schedule] }
  assert.equal(validate(snapshot), true, JSON.stringify(validate.errors))
  assert.equal(validate({ ...snapshot, schedules: [{ ...schedule, epoch: 2, state: "interrupted", controlCapability: { version: 1, actions: ["play", "stop"] } }] }), true)
  const requestID = recurrenceHumanRequestID(schedule.id, 3, "pause"), operationID = controlOperationID("msn_passage", requestID)
  const nativeControl = { id: operationID, missionID: "msn_passage", requestID, expectedRevision: 1, action: "pause",
    targets: [{ sessionID: "ses_root", location: { directory: "/project" } }, { sessionID: "ses_worker", location: { directory: "/project" } }],
    pending: ["ses_worker"], receipts: [{ receiptID: controlReceiptID(operationID, "ses_root"), sessionID: "ses_root", acknowledgementState: "known",
      nativeAcknowledgement: { missionID: "msn_passage", operationID, sessionID: "ses_root", action: "pause", disposition: "interrupt-observed",
        interrupt: { interrupted: true }, cancellations: [] } }] }
  lifecycleOperationReadSchema.parse(nativeControl)
  const partial = { ...schedule, revision: 5, epoch: 3, state: "paused", controlsComplete: false, nativeControl,
    controlRetry: { scheduleID: schedule.id, requestID, action: "pause", expectedRevision: 4, expectedEpoch: 2 },
    controlCapability: { version: 1, actions: ["pause", "stop"] } }
  assert.equal(validate({ ...snapshot, schedules: [partial] }), true, JSON.stringify(validate.errors))
  assert.equal(validate({ ...snapshot, schedules: [{ ...partial, nativeControl: { ...nativeControl, backendApproved: true } }] }), false)
  assert.equal(validate({ ...snapshot, schedules: [{ ...partial, nativeControl: { ...nativeControl, action: "start" } }] }), false, "a denial-control snapshot never exposes a start prompt")
  assert.equal(validate({ ...snapshot, schedules: [{ ...partial, controlRetry: { ...partial.controlRetry, action: "play" } }] }), false)
  assert.equal(lifecycleOperationReadSchema.safeParse({ ...nativeControl, pending: ["ses_foreign"] }).success, false)
  for (const invalid of [
    { ...schedule, prompt: "private" }, { ...schedule, controlCapability: { version: 1, actions: ["play"], qualified: true } },
    { ...schedule, controlCapability: { version: 1, actions: ["play", "play"] } }, { ...schedule, epoch: -1 },
    { ...schedule, history: Array(31).fill({}) },
  ]) assert.equal(validate({ ...snapshot, schedules: [invalid] }), false)
  const event = ajv.compile(CODENOMAD_MISSIONS_RPC.events.scheduleChanged.schema)
  assert.equal(event({ scheduleID: "rec_schedule", revision: 1 }), true)
  assert.equal(event({ scheduleID: "rec_schedule", revision: 1, consigne: "private" }), false)
})

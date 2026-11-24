import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { Effect } from "effect"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { withNativeRecurrenceRpc } from "../opencode/missions/managed-owner-plugin"
import { recurrenceSnapshotSchema } from "./recurrence-control-contract"

test("native registration replaces control placeholders and exposes manual start/status only through RPC", async () => {
  let captured: Record<string, unknown> = {}
  const placeholder = () => Effect.die("placeholder")
  const rpc = { register: (_definition: unknown, handlers: Record<string, unknown>) => Effect.sync(() => { captured = handlers }) }
  const entry = withNativeRecurrenceRpc({ rpc } as never)
  await Effect.runPromise(Effect.scoped(entry.register(CODENOMAD_MISSIONS_RPC, { recurrenceControl: placeholder } as never)))
  assert.notEqual(captured.recurrenceControl, placeholder)
  for (const method of ["recurrenceControl", "recurrenceControlStatus", "recurrenceRunNow", "recurrenceRunNowStatus",
    "recurrenceRead", "recurrenceCreate", "recurrencePassageRead", "recurrenceCurrent", "recurrenceCurrentContent"]) assert.equal(typeof captured[method], "function")
})
test("strict simple snapshot omits epochs, grants, budgets and signed retry tuples", () => {
  const ajv = new Ajv({ allErrors: true }), methods = CODENOMAD_MISSIONS_RPC.methods
  const validate = ajv.compile(methods.recurrenceSnapshot.output)
  const schedule = { id: "schedule_one", title: "Daily review", revision: 0, state: "paused", clock: { time: "07:00", zone: "UTC" },
    nextDueAt: null, pending: null, latestResult: null, history: [], controls: [], actions: ["play", "run-now", "stop"] }
  const snapshot = { version: 1, projectID: "project", projectCanonical: "/project", location: { directory: "/project" }, schedules: [schedule] }
  assert.equal(validate(snapshot), true, JSON.stringify(validate.errors)); recurrenceSnapshotSchema.parse(snapshot)
  for (const extra of [{ epoch: 1 }, { budgets: {} }, { grant: {} }, { controlRetry: {} }, { prompt: "private" }]) {
    assert.equal(validate({ ...snapshot, schedules: [{ ...schedule, ...extra }] }), false)
  }
  assert.equal(validate({ ...snapshot, schedules: [{ ...schedule, history: Array(31).fill({}) }] }), false)
  const control = ajv.compile(methods.recurrenceControlStatus.input)
  const input = { scheduleID: "schedule_one", requestID: "request_one", action: "resume", expectedRevision: 0 }
  assert.equal(control(input), true); assert.equal(control({ ...input, expectedEpoch: 0 }), false)
  const archive = ajv.compile(methods.recurrencePassageRead.input)
  assert.equal(archive({ scheduleID: "schedule_one", passageID: "passage_one" }), true)
  assert.equal(archive({ scheduleID: "schedule_one", passageID: "passage_one", sessionID: "foreign" }), false)
})

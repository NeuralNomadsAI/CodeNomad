import assert from "node:assert/strict"
import test from "node:test"
import { nativeFailedExecution } from "./native-recurrence-failed-execution"

const sessionID = "ses_root", inputID = "msg_input", id = "msg_assistant", model = { providerID: "fixture", id: "model" }
const error = { type: "provider.auth", message: "https://private.example/?token=do-not-copy", status: 401 }
type Row = { type: string; data: Record<string, unknown> }
const base: Row[] = [
  { type: "session.created.1", data: { sessionID } },
  { type: "session.inbox.enqueued.1", data: { sessionID, inboxID: inputID } },
  { type: "session.execution.started.1", data: { sessionID } },
  { type: "session.inbox.delivered.1", data: { sessionID, inboxID: inputID } },
]
const start = (started = 11, assistantMessageID = id): Row => ({ type: "session.step.started.1",
  data: { sessionID, assistantMessageID, agent: "build", model, started } })
const stepFailed = (assistantMessageID = id): Row => ({ type: "session.step.failed.1", data: { sessionID, assistantMessageID, error, files: [] } })
const assistant = (content: unknown[] = [], assistantMessageID = id, fields: Record<string, unknown> = {}) => ({ id: assistantMessageID,
  type: "assistant", data: JSON.stringify({ agent: "build", model, content, error, finish: "error", snapshot: { files: [] },
    time: { created: 11, completed: 15 }, ...fields }) })
const run = (rows: Row[], messages: { id: string; type: string; data: string }[] = [], failure = error) => {
  const events = [...base, ...rows, { type: "session.execution.failed.1", data: { sessionID, error: failure } }]
    .map((event, seq) => ({ ...event, seq, id: `evt_${seq}` }))
  return nativeFailedExecution(events, [{ id: inputID, type: "synthetic", data: "{}" }, ...messages,
    { id: `msg_${events.length - 1}`, type: "idle", data: JSON.stringify({ outcome: "failed", time: { created: 20 } }) }],
  inputID, 3, events.at(-1)!)
}

test("native coded provider terminals use the published bounded error shape, not prose or zero HTTP inference", () => {
  for (const type of ["provider.rate-limit", "provider.auth", "provider.quota", "provider.content-filter", "provider.transport",
    "provider.internal", "provider.invalid-output", "provider.invalid-request", "provider.unsupported-operation", "provider.no-route",
    "provider.unknown", "provider.timeout"]) assert.equal(run([], [], { ...error, type }), type)
  for (const type of ["unknown", "tool.execution", "aborted", "provider.future-code"]) assert.throws(() => run([], [], { ...error, type }), /observation-unavailable/)
  assert.throws(() => run([], [], { ...error, status: 999 }), /observation-unavailable/)
})

test("failed native Steps permit bounded text/reasoning, but need their matching ended fragments and assistant projection", () => {
  const rows = [start(), { type: "session.text.started.1", data: { sessionID, assistantMessageID: id, ordinal: 0 } },
    { type: "session.text.ended.1", data: { sessionID, assistantMessageID: id, ordinal: 0, text: "Partial provider text" } },
    { type: "session.step.streamed.1", data: { sessionID, assistantMessageID: id } }, stepFailed()]
  const message = assistant([{ type: "text", text: "Partial provider text" }])
  assert.equal(run(rows, [message]), "provider.auth")
  assert.throws(() => run(rows.slice(0, -1), [message]), /observation-unavailable/, "open Step cannot borrow execution failure")
  assert.throws(() => run(rows.filter(row => row.type !== "session.text.ended.1"), [message]), /observation-unavailable/)
  assert.throws(() => run(rows, []), /observation-unavailable/, "missing assistant projection")
  assert.throws(() => run(rows, [assistant([{ type: "text", text: "Changed projection" }])]), /observation-unavailable/)
  assert.throws(() => run(rows, [assistant([], id, { time: { created: 11 } })]), /observation-unavailable/)
})

test("native output-free retries can reuse the same assistant ID; terminal failure also ends native retry wait without workflow replay", () => {
  const retry: Row = { type: "session.retry.scheduled.1", data: { sessionID, assistantMessageID: id, attempt: 2, at: 12, error } }
  assert.equal(run([start(), retry, start(13), stepFailed()], [assistant([], id, { time: { created: 13, completed: 15 } })]), "provider.auth")
  assert.equal(run([start(), retry], [assistant([], id, { error: undefined, finish: undefined, time: { created: 11 } })],
    { type: "provider.no-route", message: "native preparation failure", status: 401 }), "provider.no-route")
  assert.throws(() => run([start(), start(13), stepFailed()], [assistant([], id, { time: { created: 13, completed: 15 } })]), /observation-unavailable/)
  assert.throws(() => run([start(), retry], [assistant([], id, { error: undefined, finish: undefined, retry: { attempt: 2, at: 12, error }, time: { created: 11 } })]), /observation-unavailable/)
})

test("native-internal continuation and prior ended Steps retain causal message identity without admitting another operation", () => {
  const continuation = "The previous response was interrupted. Continue from where you left off without repeating completed content."
  const rows: Row[] = [start(), stepFailed(), { type: "session.retry.scheduled.1", data: { sessionID, assistantMessageID: id, attempt: 2, at: 12, error } },
    { type: "session.synthetic.1", data: { sessionID, text: continuation } }, start(14, "msg_next"), stepFailed("msg_next")]
  const messages = [assistant(), { id: "msg_7", type: "synthetic", data: JSON.stringify({ text: continuation, time: { created: 13 } }) },
    assistant([], "msg_next", { time: { created: 14, completed: 15 } })]
  assert.equal(run(rows, messages), "provider.auth")
  assert.throws(() => run(rows.map(row => row.type === "session.synthetic.1" ? { ...row, data: { ...row.data, text: "Uncorrelated input" } } : row), messages), /observation-unavailable/)
  const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
  const ended: Row = { type: "session.step.ended.1", data: { sessionID, assistantMessageID: id, finish: "stop", cost: 0, tokens, files: [] } }
  assert.equal(run([start(), ended, start(14, "msg_next"), stepFailed("msg_next")],
    [assistant([], id, { error: undefined, finish: "stop", cost: 0, tokens }), assistant([], "msg_next", { time: { created: 14, completed: 15 } })]), "provider.auth")
})

test("any native tool evidence, mutation, unfamiliar lifecycle or changed project files remains pending", () => {
  const closed = [start(), stepFailed()]
  for (const type of ["session.tool.called.1", "session.tool.input.started.1", "session.tool.success.2", "session.tool.failed.2",
    "session.shell.started.1", "session.compaction.started.1", "session.message.content.updated.1", "session.step.future.1"])
    assert.throws(() => run([start(), { type, data: { sessionID, assistantMessageID: id, id: "call", executed: false } }, stepFailed()], [assistant()]), /observation-unavailable/)
  assert.throws(() => run(closed, [assistant([{ type: "tool", id: "call", name: "shell", executed: false,
    state: { status: "running", input: { command: "work" }, time: { created: 11, started: 11 } } }])]), /observation-unavailable/)
  assert.throws(() => run([start(), { ...stepFailed(), data: { ...stepFailed().data, files: ["changed.txt"] } }], [assistant()]), /observation-unavailable/)
})

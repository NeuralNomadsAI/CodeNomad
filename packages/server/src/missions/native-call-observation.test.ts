import assert from "node:assert/strict"
import test from "node:test"
import type { SessionToolCalled, SessionToolSuccess, SessionToolFailed, SessionExecutionStarted, SessionExecutionSucceeded,
  SessionExecutionFailed, SessionExecutionInterrupted, SessionLogOutput, SessionMessageGetOutput } from "@opencode/client"
import { hasUnsettledNativeExecution, parseNativeCallObservation, projectNativeCallObservation, readNativeCallObservation,
  type NativeCallReadClient, type NativeCallReadTarget } from "./native-call-observation"

function fixture(background = false, error = false) {
  const target: NativeCallReadTarget = { binding: { generation: 1, parentSessionID: "ses_parent", parentMessageID: "msg_parent", toolCallID: "call_child" },
    childSessionID: "ses_child", toolName: "subagent" }
  const metadata = { sessionID: target.childSessionID, ...(background ? { status: "running" } : {}) }
  const called: SessionToolCalled = { id: "native_called", created: 10, type: "session.tool.called", durable: { aggregateID: "agg_parent", seq: 1, version: 1 },
    data: { sessionID: "ses_parent", assistantMessageID: "msg_parent", id: "call_child", input: { background }, executed: true } }
  const success: SessionToolSuccess = { id: "native_success", created: 11, type: "session.tool.success", durable: { aggregateID: "agg_parent", seq: 2, version: 2 },
    data: { sessionID: "ses_parent", assistantMessageID: "msg_parent", id: "call_child", executed: true, metadata, content: [{ type: "text", text: "Native result" }] } }
  const failed: SessionToolFailed = { id: "native_failure", created: 11, type: "session.tool.failed", durable: { aggregateID: "agg_parent", seq: 2, version: 2 },
    data: { sessionID: "ses_parent", assistantMessageID: "msg_parent", id: "call_child", executed: true, metadata, error: { type: "Failure", message: "Actual failure" } } }
  const started: SessionExecutionStarted = { id: "native_start", created: 12, type: "session.execution.started", durable: { aggregateID: "agg_child", seq: 1, version: 1 }, data: { sessionID: "ses_child" } }
  const succeeded: SessionExecutionSucceeded = { id: "native_done", created: 13, type: "session.execution.succeeded", durable: { aggregateID: "agg_child", seq: 2, version: 1 }, data: { sessionID: "ses_child" } }
  const childFailed: SessionExecutionFailed = { ...succeeded, type: "session.execution.failed", data: { sessionID: "ses_child", error: { type: "Failure", message: "Failed" } } }
  const interrupted: SessionExecutionInterrupted = { ...succeeded, type: "session.execution.interrupted", data: { sessionID: "ses_child", reason: "user" } }
  const message: SessionMessageGetOutput = { id: "msg_parent", type: "assistant", agent: "parent-agent", model: { providerID: "provider", id: "parent-model", variant: "parent-only" },
    time: { created: 9 }, content: [{ type: "tool", id: "call_child", name: "subagent", executed: true, time: { created: 9, completed: 11 },
      state: error ? { status: "error", input: { background }, metadata, error: { type: "Failure", message: "Actual failure" } }
        : { status: "completed", input: { background }, metadata, content: [{ type: "text", text: "Native result" }] } }] }
  const logs = new Map<string, SessionLogOutput[]>([["ses_parent", [called, error ? failed : success]], ["ses_child", [started, succeeded]]])
  const requests: unknown[] = []
  let checks = 0, yielded = 0, broken = false
  const client: NativeCallReadClient = {
    message: { async get(input) { requests.push(input); return structuredClone(message) } },
    async *log(input) {
      requests.push(input)
      for (const event of logs.get(input.sessionID) ?? []) {
        if (event.type !== "log.synced" && event.durable.seq <= (input.after ?? 0)) continue
        yielded++; yield structuredClone(event)
      }
      if (broken) throw new Error("Disconnected")
      const source = logs.get(input.sessionID) ?? []
      const last = source.at(-1)
      yield { type: "log.synced", aggregateID: input.sessionID === "ses_parent" ? "agg_parent" : "agg_child",
        seq: last && last.type !== "log.synced" ? last.durable.seq : 0 }
    },
  }
  const options = () => ({ check: async () => { checks++ }, signal: AbortSignal.timeout(5_000) })
  return { target, called, success, failed, started, succeeded, childFailed, interrupted, message, logs, client, requests, options,
    counts: () => ({ checks, yielded }), breakRead: () => { broken = true } }
}

test("official 2.0.22 foreground durable events identify the exact tool and terminate without profile inference", async () => {
  const f = fixture(), result = await readNativeCallObservation(f.client, f.target, f.options())
  assert.equal(result.complete, true)
  assert.equal(result.profileObservation, "unknown", "parent assistant identity is not the child's resolved identity")
  assert.deepEqual(result.parentCursor, { aggregateID: "agg_parent", after: 2 })
  assert.deepEqual(result.childCursor, { aggregateID: "agg_child", after: 2 })
  let execution = { binding: f.target.binding }
  for (const observation of result.observations) execution = projectNativeCallObservation(execution, observation)
  assert.equal(hasUnsettledNativeExecution({ nativeBinding: f.target.binding, nativeExecution: execution }), false)
  assert.deepEqual((execution as any).launch, { mode: "foreground", state: "returned" })
  assert.equal((execution as any).ended, "returned")
  assert.equal(result.childCorrelation, "unknown")
  assert.ok(f.requests.every(request => !(request as any).follow))
})

test("actual failed metadata can identify a partial child; error text/progress cannot supply missing identity", async () => {
  const f = fixture(false, true), result = await readNativeCallObservation(f.client, f.target, f.options())
  assert.equal(result.observations.find(item => item.kind === "tool-ended")?.kind, "tool-ended")
  const end = result.observations.find(item => item.kind === "tool-ended")!
  assert.equal(end.kind === "tool-ended" && end.outcome, "error")
  delete f.failed.data.metadata
  f.failed.data.error.message = "Child session_id: ses_child"
  const unknown = await readNativeCallObservation(f.client, f.target, f.options())
  assert.deepEqual(unknown.observations, [])
  assert.equal(unknown.complete, false)
})

test("the ABI's executed flag is not guessed to mean child identity or completion", async () => {
  const f = fixture()
  f.called.data.executed = false; f.success.data.executed = false
  if (f.message.type === "assistant" && f.message.content[0].type === "tool") f.message.content[0].executed = false
  const result = await readNativeCallObservation(f.client, f.target, f.options())
  assert.equal(result.complete, true)
  assert.equal(result.observations.find(item => item.kind === "tool-ended")?.kind, "tool-ended")
})

test("durable running launch metadata can refine unknown mode but cannot prove background child completion", async () => {
  const f = fixture(true)
  if (f.message.type !== "assistant" || f.message.content[0].type !== "tool" || f.message.content[0].state.status === "streaming") throw new Error("fixture")
  delete f.message.content[0].state.input.background; delete f.called.data.input.background
  f.message.content[0].state.metadata = { sessionID: "ses_child" }
  const result = await readNativeCallObservation(f.client, f.target, f.options())
  let execution = { binding: f.target.binding }
  for (const observation of result.observations) execution = projectNativeCallObservation(execution, observation)
  assert.equal((execution as any).launch.mode, "background")
  assert.equal((execution as any).ended, undefined)
  assert.equal((execution as any).observationConflict, undefined)
})

for (const childOutcome of ["succeeded", "failed", "interrupted"] as const) {
  test(`background launch return plus child ${childOutcome} remains uncorrelated/unsettled, never guessed terminal`, async () => {
    const f = fixture(true)
    const terminal = childOutcome === "succeeded" ? f.succeeded : childOutcome === "failed" ? f.childFailed : f.interrupted
    terminal.metadata = { inboxID: "untyped-not-proof", executionID: "untyped-not-proof" }
    f.logs.set("ses_child", [f.started, terminal])
    const result = await readNativeCallObservation(f.client, f.target, f.options())
    let execution = { binding: f.target.binding }
    for (const observation of result.observations) execution = projectNativeCallObservation(execution, observation)
    assert.equal((execution as any).ended, undefined)
    assert.deepEqual((execution as any).launch, { mode: "background", state: "returned" })
    assert.deepEqual((execution as any).childExecution, { state: "unknown", observedOutcome: childOutcome })
    assert.equal(hasUnsettledNativeExecution({ nativeBinding: f.target.binding, nativeExecution: execution }), true)
    assert.ok(result.reasons.includes("child-invocation-correlation-unavailable"))
  })
}

test("bounded log slices use only native aggregate/seq cursors; duplicate entries count toward the read bound", async () => {
  const f = fixture()
  const first = await readNativeCallObservation(f.client, f.target, { ...f.options(), maxEvents: 1 })
  assert.equal(first.complete, false)
  assert.deepEqual(first.parentCursor, { aggregateID: "agg_parent", after: 1 })
  assert.deepEqual(first.childCursor, { aggregateID: "agg_child", after: 1 })
  const second = await readNativeCallObservation(f.client, f.target, { ...f.options(), maxEvents: 1,
    parentCursor: first.parentCursor, childCursor: first.childCursor })
  assert.deepEqual(second.parentCursor, { aggregateID: "agg_parent", after: 2 })
  const third = await readNativeCallObservation(f.client, f.target, { ...f.options(), maxEvents: 1,
    parentCursor: second.parentCursor, childCursor: second.childCursor })
  assert.equal(third.complete, true)
  f.logs.set("ses_parent", [f.called, ...Array.from({ length: 100 }, () => f.called)])
  const before = f.counts().yielded
  const duplicates = await readNativeCallObservation(f.client, f.target, { ...f.options(), maxEvents: 3 })
  assert.equal(duplicates.complete, false)
  assert.ok(f.counts().yielded - before <= 6)
  assert.equal(duplicates.observations.filter(item => item.kind === "tool-called").length, 1)
})

test("foreign durable IDs, conflicting duplicate sequences, stale cursors and partial failures clear facts/checkpoints", async () => {
  const damages: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.called.data.sessionID = "ses_foreign" },
    f => { f.success.durable.aggregateID = "agg_foreign" },
    f => { f.success.durable.seq = f.called.durable.seq },
    f => { f.success.durable.seq = 3 },
    f => { f.success.id = f.called.id },
    f => { f.success.data.metadata = { sessionID: "ses_foreign" } },
    f => { f.message.id = "msg_foreign" },
    f => { f.breakRead() },
    f => { f.logs.set("ses_child", [{ type: "session.tool.progress", data: {} } as any]) },
  ]
  for (const damage of damages) {
    const f = fixture(); damage(f)
    const result = await readNativeCallObservation(f.client, f.target, f.options())
    assert.equal(result.complete, false)
    assert.deepEqual(result.observations, [])
    assert.equal(result.parentCursor, undefined)
    assert.equal(result.childCursor, undefined)
  }
  const f = fixture()
  const stale = await readNativeCallObservation(f.client, f.target, { ...f.options(), parentCursor: { aggregateID: "agg_foreign", after: 0 } })
  assert.equal(stale.complete, false)
})

test("missing actual launch mode is UNKNOWN, not an implicit foreground default", async () => {
  const f = fixture()
  if (f.message.type !== "assistant" || f.message.content[0].type !== "tool" || f.message.content[0].state.status === "streaming") throw new Error("fixture")
  delete f.message.content[0].state.input.background; delete f.called.data.input.background
  const result = await readNativeCallObservation(f.client, f.target, f.options())
  assert.ok(result.reasons.includes("launch-mode-unqualified"))
  let execution = { binding: f.target.binding }
  for (const observation of result.observations) execution = projectNativeCallObservation(execution, observation)
  assert.equal((execution as any).ended, undefined)
  assert.equal(hasUnsettledNativeExecution({ nativeBinding: f.target.binding, nativeExecution: execution }), true)
})

test("observation codec is strict; conflicting durable facts cannot overwrite termination into apparent success", () => {
  const source = { id: "native_event", sessionID: "ses_parent", aggregateID: "agg_parent", seq: 1, created: 1 }
  for (const bad of [{ kind: "tool-ended", mode: "background", outcome: "succeeded", source },
    { kind: "child-uncorrelated", outcome: "succeeded", source, correlated: true },
    { kind: "tool-called", mode: "foreground", source: { ...source, seq: 0 } },
    { kind: "tool-called", mode: ["foreground"], source },
    { kind: "child-uncorrelated", outcome: ["succeeded"], source },
    { kind: "tool-called", mode: "foreground", source: { ...source, inboxID: "forged" } }]) assert.equal(parseNativeCallObservation(bad), undefined)
  const f = fixture(), failed = parseNativeCallObservation({ kind: "tool-ended", mode: "foreground", outcome: "error", source })!
  const execution = projectNativeCallObservation({ binding: f.target.binding }, failed)
  assert.equal(projectNativeCallObservation(execution, failed), execution)
  const conflict = projectNativeCallObservation(execution, { ...failed, kind: "tool-ended", mode: "foreground", outcome: "returned" })
  assert.equal(conflict.observationConflict, true)
  assert.equal(conflict.ended, "error")
  assert.equal(hasUnsettledNativeExecution({ nativeBinding: f.target.binding, nativeExecution: conflict }), true)
})

test("cross-page aggregate/sequence conflicts remain unsettled and never overwrite prior durable facts", () => {
  const f = fixture(), source = { id: "native_called", sessionID: "ses_parent", aggregateID: "agg_parent", seq: 1, created: 1 }
  const called = projectNativeCallObservation({ binding: f.target.binding }, { kind: "tool-called", mode: "foreground", source })
  for (const changed of [{ ...source, id: "native_different" }, { ...source, id: "native_different", seq: 2, aggregateID: "agg_foreign" }]) {
    const execution = projectNativeCallObservation(called, { kind: "tool-ended", mode: "foreground", outcome: "returned", source: changed })
    assert.equal(execution.observationConflict, true)
    assert.equal(execution.ended, undefined)
    assert.equal(hasUnsettledNativeExecution({ nativeBinding: f.target.binding, nativeExecution: execution }), true)
  }
  const returned = projectNativeCallObservation({ binding: f.target.binding }, { kind: "tool-ended", mode: "background", outcome: "returned", source })
  const failed = projectNativeCallObservation(returned, { kind: "tool-ended", mode: "background", outcome: "error", source: { ...source, id: "native_other_end", seq: 2 } })
  assert.equal(failed.observationConflict, true)
  assert.equal(failed.ended, undefined)
})

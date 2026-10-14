import assert from "node:assert/strict"
import test from "node:test"
import { verifyNativeDecisionEvidence, type NativeDecisionEvidenceRequest,
  type NativeDecisionReadClient } from "./native-human-evidence"
import type { HumanDecisionMark } from "./human-answer"

function fixture() {
  const request: NativeDecisionEvidenceRequest = { kind: "native-form-answer",
    contract: { missionID: "mission_test", taskKey: "decision", generation: 2 },
    nativeCall: { generation: 2, parentSessionID: "ses_parent", parentMessageID: "msg_delegate", toolCallID: "call_delegate" },
    sessionID: "ses_child", formID: "form_actual", messageID: "msg_question", toolCallID: "call_question", fieldKey: "q0",
    projectID: "project_test", directory: "D:/owned", delegationToolName: "task", question: "Choose the seam?", answer: "Module" }
  const question = { question: request.question, header: "Seam", options: [{ label: "Module", description: "Own the boundary" }] }
  const input = { questions: [question] }
  const content = [{ type: "text", text: "User has answered your questions" }]
  const metadata = { answers: [["Module"]] }
  const questionPart = { type: "tool", id: request.toolCallID, name: "question", executed: false, state: {
    status: "completed", input, metadata, content } }
  const delegationPart = { type: "tool", id: request.nativeCall.toolCallID, name: "task", executed: false,
    state: { status: "running", input: {}, metadata: { sessionID: request.sessionID } } }
  const message = { type: "assistant", id: request.messageID, content: [questionPart] }
  const delegationMessage = { type: "assistant", id: request.nativeCall.parentMessageID, content: [delegationPart] }
  const parent = { id: request.nativeCall.parentSessionID, projectID: request.projectID, location: { directory: request.directory } }
  const child = { ...parent, id: request.sessionID, parentID: parent.id }
  const form = { id: request.formID, sessionID: request.sessionID, title: "Questions",
    metadata: { kind: "question", tool: { messageID: request.messageID, id: request.toolCallID } },
    fields: [{ key: "q0", type: "string", title: question.header, description: question.question, custom: true,
      options: question.options.map(option => ({ value: option.label, ...option })) }],
    state: { status: "answered", answer: { q0: "Module" } } }
  const base = { created: 100, data: { sessionID: child.id, assistantMessageID: request.messageID, id: request.toolCallID, executed: false } }
  const called = { ...base, id: "event_called", type: "session.tool.called",
    durable: { aggregateID: "aggregate_child", seq: 1, version: 1 }, data: { ...base.data, input } }
  const success = { ...base, id: "event_success", type: "session.tool.success",
    durable: { aggregateID: "aggregate_child", seq: 2, version: 2 }, data: { ...base.data, metadata, content } }
  const synced = { type: "log.synced", aggregateID: "aggregate_child", seq: 2 }
  const events: unknown[] = [called, success, synced]
  let operations = 0, checks = 0, closed = 0
  let failAfter = Infinity
  let beforeRead: ((name: string, count: number) => void) | undefined
  const operation = (name: string) => { operations++; beforeRead?.(name, operations) }
  const client = {
    get: async ({ sessionID }: { sessionID: string }) => { operation("get"); return structuredClone(sessionID === parent.id ? parent : child) },
    message: { get: async ({ sessionID }: { sessionID: string }) => { operation("message"); return structuredClone(sessionID === parent.id ? delegationMessage : message) } },
    form: { get: async () => { operation("form"); return structuredClone(form) } },
    log: () => ({ [Symbol.asyncIterator]() {
      let index = 0
      return { next: async () => { operation("log.next"); return index < events.length
        ? { done: false, value: structuredClone(events[index++]) } : { done: true, value: undefined } },
      return: async () => { operation("log.return"); closed++; return { done: true, value: undefined } } }
    } }),
  } as unknown as NativeDecisionReadClient
  const controller = new AbortController()
  const deps = { client, signal: controller.signal, maxEvents: 128, assertCurrent() {
    checks++
    if (operations >= failAfter) throw new Error("generation/family/lifecycle revoked")
  } }
  return { request, deps, controller, parent, child, form, message, delegationMessage, questionPart, delegationPart,
    question, called, success, synced, events, counts: () => ({ operations, checks, closed }),
    revokeAfter: (count: number) => { failAfter = count }, onRead: (callback: typeof beforeRead) => { beforeRead = callback } }
}

test("exact actual Form/session/message/tool plus durable call/answer is observation, never human proof", async () => {
  const f = fixture()
  const result = await verifyNativeDecisionEvidence(f.request, f.deps)
  assert.equal(result.status, "unqualified")
  assert.equal(result.evidence?.kind, "native-form-answer")
  assert.equal(result.evidence?.formID, "form_actual")
  assert.equal(result.evidence?.contract.generation, 2)
  assert.equal(result.evidence?.durability, "unqualified")
  assert.equal(result.evidence?.humanPrincipal, "unknown")
  assert.deepEqual(result.evidence?.answer, "Module")
  assert.deepEqual(result.requiredChannel, ["answered-native-form", "authenticated-backend-ui-mark"])
  assert.equal(f.counts().closed, 1)
  assert.ok(f.counts().checks >= f.counts().operations * 2)
})

const failures: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ["hosted question is not local proof", f => { f.questionPart.executed = true }],
  ["hosted delegation is not local proof", f => { f.delegationPart.executed = true }],
  ["hosted called event is not local proof", f => { f.called.data.executed = true }],
  ["hosted result event is not local proof", f => { f.success.data.executed = true }],
  ["foreign Form", f => { f.form.id = "form_foreign" }],
  ["foreign Form session", f => { f.form.sessionID = "ses_foreign" }],
  ["foreign Form message", f => { f.form.metadata.tool.messageID = "msg_other" }],
  ["foreign Form call", f => { f.form.metadata.tool.id = "call_other" }],
  ["non-question Form", f => { f.form.metadata.kind = "provider-consent" }],
  ["pending Form is not answered evidence", f => { f.form.state.status = "pending" }],
  ["cancelled Form", f => { f.form.state.status = "cancelled" }],
  ["wrong selected answer", f => { f.request.answer = "Other" }],
  ["wrong exact question", f => { f.request.question = "Another question?" }],
  ["missing exact field", f => { f.request.fieldKey = "q1" }],
  ["duplicate Form fields", f => { f.form.fields.push(structuredClone(f.form.fields[0])) }],
  ["duplicate exact tool", f => { f.message.content.push(structuredClone(f.questionPart)) }],
  ["running question", f => { f.questionPart.state.status = "running" }],
  ["question name is not text inference", f => { f.questionPart.name = "execute" }],
  ["provider-hosted question is not a native local Form", f => { f.questionPart.executed = true }],
  ["provider-hosted delegation is not the original native child call", f => { f.delegationPart.executed = true }],
  ["provider-hosted durable call is not local question evidence", f => { f.called.data.executed = true }],
  ["provider-hosted durable result is not local question evidence", f => { f.success.data.executed = true }],
  ["ordinary descendant is not task child", f => { f.child.parentID = "ses_ordinary_descendant" }],
  ["foreign project", f => { f.child.projectID = "project_foreign" }],
  ["moved session", f => { f.child.location = { directory: "D:/foreign" } }],
  ["wrong actual delegation child", f => { f.delegationPart.state.metadata.sessionID = "ses_other" }],
  ["wrong delegation message", f => { f.delegationMessage.id = "msg_other" }],
  ["generation mismatch", f => { f.request.contract.generation++ }],
  ["question metadata answer mismatch", f => { f.questionPart.state.metadata = { answers: [["Other"]] } }],
  ["durable answer mismatch", f => { f.success.data.metadata = { answers: [["Other"]] } }],
  ["durable input mismatch", f => { f.called.data.input = { questions: [] } }],
  ["foreign durable event", f => { f.called.data.sessionID = "ses_other" }],
  ["missing durable call", f => { f.events.splice(0, 1) }],
  ["missing durable answer", f => { f.events.splice(1, 1); f.synced.seq = 1 }],
  ["missing synced boundary", f => { f.events.pop() }],
  ["duplicate durable event", f => { f.events.splice(1, 0, structuredClone(f.called)) }],
  ["duplicate exact question invocation", f => { f.success.type = "session.tool.called" }],
  ["partial read bound", f => { f.deps.maxEvents = 1 }],
  ["invalid bound", f => { f.deps.maxEvents = 257 }],
  ["missing lifecycle fence", f => { f.deps.assertCurrent = undefined as unknown as () => void }],
  ["fake boolean fence", f => { f.deps.assertCurrent = () => true }],
  ["unawaited async fence", f => { f.deps.assertCurrent = async () => undefined }],
  ["rejecting async fence", f => { f.deps.assertCurrent = async () => { throw new Error("not synchronous") } }],
  ["abort", f => { f.controller.abort() }],
  ["oversized message", f => { f.questionPart.state.content[0].text = "x".repeat(128_000) }],
  ["moved during log read", f => { f.onRead(name => { if (name === "log.next") f.child.location = { directory: "D:/moved" } }) }],
  ["Form cache expires", f => { f.onRead((name, count) => { if (name === "form" && count > 5) throw new Error("FormNotFoundError") }) }],
  ["Form settlement changes", f => { f.onRead(name => { if (name === "log.next") f.form.state.answer.q0 = "Other" }) }],
  ["no fake human principal", f => { f.form.state.status = "pending"; Object.assign(f.form.metadata, { humanAnswer: true }) }],
]
for (const [name, mutate] of failures) test(`unknown without usable evidence: ${name}`, async () => {
  const f = fixture(); mutate(f)
  const result = await verifyNativeDecisionEvidence(f.request, f.deps)
  assert.equal(result.status, "unknown")
  assert.equal(result.evidence, undefined)
})

test("rechecks revocation after every read, including iterator next and return", async () => {
  const total = fixture()
  await verifyNativeDecisionEvidence(total.request, total.deps)
  for (let index = 1; index <= total.counts().operations; index++) {
    const f = fixture(); f.revokeAfter(index)
    const result = await verifyNativeDecisionEvidence(f.request, f.deps)
    assert.equal(result.status, "unknown", `revocation at read ${index}`)
    assert.equal(result.evidence, undefined)
  }
})

test("no temporal/title/tool-text fallback when durable proof or actual Form ID is missing", async () => {
  const f = fixture()
  f.form.id = "same-title-different-form"
  f.form.title = f.request.question
  Object.assign(f.questionPart.state.metadata, { humanAnswer: true, formID: f.request.formID })
  const result = await verifyNativeDecisionEvidence(f.request, f.deps)
  assert.equal(result.status, "unknown")
  assert.equal(result.evidence, undefined)
})

test("authenticated client reply still has no human principal; fake boolean cannot qualify it", async () => {
  const f = fixture()
  Object.assign(f.form.metadata, { humanAnswer: true })
  const result = await verifyNativeDecisionEvidence(f.request, f.deps)
  assert.equal(result.status, "unqualified")
  assert.equal(result.evidence?.humanPrincipal, "unknown")
})

test("duplicate question text uses exact indexed Form field, never text/title lookup", async () => {
  const f = fixture()
  f.questionPart.state.input.questions.push(structuredClone(f.question))
  f.form.fields.push({ ...structuredClone(f.form.fields[0]), key: "q1" })
  Object.assign(f.form.state.answer, { q1: "Other" })
  f.questionPart.state.metadata.answers.push(["Other"])
  f.request.fieldKey = "q1"; f.request.answer = "Other"
  const result = await verifyNativeDecisionEvidence(f.request, f.deps)
  assert.equal(result.status, "unqualified")
  assert.equal(result.evidence?.fieldKey, "q1")
  assert.equal(result.evidence?.answer, "Other")
  f.request.answer = "Module"
  assert.equal((await verifyNativeDecisionEvidence(f.request, f.deps)).status, "unknown")
})

test("native multiselect answer retains exact array representation", async () => {
  const f = fixture()
  Object.assign(f.question, { multiple: true })
  f.form.fields[0].type = "multiselect"
  Object.assign(f.form.state.answer, { q0: ["Module"] })
  f.request.answer = ["Module"]
  const result = await verifyNativeDecisionEvidence(f.request, f.deps)
  assert.equal(result.status, "unqualified")
  assert.deepEqual(result.evidence?.answer, ["Module"])
  f.request.answer = "Module"
  assert.equal((await verifyNativeDecisionEvidence(f.request, f.deps)).status, "unknown")
})

test("owned UI mark qualifies the exact answer after native Form cache expiry", async () => {
  const f = fixture(), { state, ...form } = structuredClone(f.form)
  const mark = { formID: form.id, sessionID: form.sessionID, answeredAt: 100, via: "ui", form, answer: state.answer } as unknown as HumanDecisionMark
  f.deps.client.form.get = async () => { throw new Error("Form cache expired") }
  let calls = 0
  const result = await verifyNativeDecisionEvidence(f.request, { ...f.deps, humanGate: async () => { calls++; return structuredClone(mark) } })
  assert.equal(calls, 2); assert.equal(result.status, "qualified")
  assert.equal(result.evidence?.durability, "native-ui-mark")
  assert.equal(result.evidence?.humanPrincipal, "codenomad-human")
})

test("UI mark gate refusal and changing mark snapshots fail closed", async () => {
  const f = fixture(), { state, ...form } = structuredClone(f.form)
  const mark = { formID: form.id, sessionID: form.sessionID, answeredAt: 100, via: "ui", form, answer: state.answer } as unknown as HumanDecisionMark
  assert.equal((await verifyNativeDecisionEvidence(f.request, { ...f.deps, humanGate: async () => { throw new Error("No mark") } })).status, "unknown")
  let calls = 0
  assert.equal((await verifyNativeDecisionEvidence(f.request, { ...f.deps, humanGate: async () => ({ ...mark, answeredAt: ++calls }) })).status, "unknown")
})

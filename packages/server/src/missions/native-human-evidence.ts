import type { FormDetail, OpenCode, SessionLogOutput, SessionMessageGetOutput } from "@opencode/client"
import { validateNativeDecisionArtifact, type NativeDecisionProvenance } from "./contracts"
import { isLocalNativeTool, type NativeObservationSource } from "./native-call-observation"
import type { HumanDecisionMark } from "./human-answer"

type SessionClient = ReturnType<typeof OpenCode.make>["session"]
export type NativeDecisionReadClient = Pick<SessionClient, "get" | "log"> & {
  message: Pick<SessionClient["message"], "get">
  form: Pick<SessionClient["form"], "get">
}
export type NativeDecisionEvidenceRequest = NativeDecisionProvenance & {
  question: string
  answer: string | string[]
  projectID: string
  directory: string
  delegationToolName: string
  /** Without a published binding, the exact declared assignment the delegation call must carry. */
  assignmentPrompt?: string
}
export type NativeFormAnswerObservation = NativeDecisionProvenance & {
  kind: "native-form-answer"
  question: string
  answer: string | string[]
  /** UI mark plus answered native call, or an unqualified cached Form. */
  durability: "unqualified" | "native-ui-mark"
  humanPrincipal: "unknown" | "codenomad-human"
  toolCalled: NativeObservationSource
  toolAnswered: NativeObservationSource
}
export type NativeDecisionEvidenceResult = {
  status: "qualified" | "unqualified" | "unknown"
  evidence?: NativeFormAnswerObservation
  reasons: string[]
  requiredChannel: readonly ["answered-native-form", "authenticated-backend-ui-mark"]
}
export type NativeDecisionEvidenceDependencies = {
  /** Already authenticated, ownership-checked native read client, not model input. */
  client: NativeDecisionReadClient
  signal: AbortSignal
  /** REQUIRED synchronous authority-owned fence before/after EVERY await.
   * Must independently select the exact accepted invocation and decision-role task privilege,
   * generation, family/location, connection and lifecycle. Mere descendant
   * membership grants no decision-task authority. No caller JSON/boolean proof.
   * This read module does not mint authority even when this check succeeds. */
  assertCurrent(request: Readonly<NativeDecisionEvidenceRequest>): void
  maxEvents?: number
  /** Construction-owned native gate; reads exact UI mark storage
   * and positively matches its actual answer/call. Never model JSON provenance. */
  humanGate?(request: Readonly<NativeDecisionEvidenceRequest>): Promise<HumanDecisionMark>
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\s\x00-\x1f\x7f]/.test(value)
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const bounded = (value: unknown, limit: number) => {
  if (JSON.stringify(value).length > limit) throw new Error("native-byte-bound")
}
const source = (event: Exclude<SessionLogOutput, { type: "log.synced" }>): NativeObservationSource => ({
  id: event.id, sessionID: event.data.sessionID, aggregateID: event.durable.aggregateID,
  seq: event.durable.seq, created: event.created,
})

function questionTool(message: SessionMessageGetOutput, messageID: string, toolID: string, name: string) {
  bounded(message, 128_000)
  if (message.id !== messageID || message.type !== "assistant" || !Array.isArray(message.content)
    || message.content.length > 128) throw new Error("native-message-mismatch")
  const tools = message.content.filter(part => part.type === "tool" && part.id === toolID)
  if (tools.length !== 1 || tools[0].type !== "tool" || tools[0].name !== name
    || tools[0].state.status === "streaming" || !isLocalNativeTool(tools[0])) throw new Error("native-tool-mismatch")
  return tools[0]
}

function observeAnswer(form: FormDetail, tool: ReturnType<typeof questionTool>, request: NativeDecisionEvidenceRequest): string[][] {
  bounded(form, 128_000)
  if (form.id !== request.formID || form.sessionID !== request.sessionID || form.metadata?.kind !== "question"
    || !record(form.metadata.tool) || form.metadata.tool.messageID !== request.messageID
    || form.metadata.tool.id !== request.toolCallID) throw new Error("native-form-binding-mismatch")
  if (form.state?.status !== "answered") throw new Error("native-form-not-answered")
  if (tool.state.status !== "completed") throw new Error("native-question-not-completed")
  const questions = tool.state.input.questions
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 32
    || !Array.isArray(form.fields) || form.fields.length !== questions.length
    || !record(form.state.answer) || Object.keys(form.state.answer).some(key => !form.fields.some(field => field.key === key))) {
    throw new Error("native-question-schema-mismatch")
  }
  const answers: string[][] = []
  for (let index = 0; index < questions.length; index++) {
    const question: unknown = questions[index], field = form.fields[index], value = form.state.answer[`q${index}`]
    if (!record(question) || typeof question.question !== "string" || typeof question.header !== "string"
      || !Array.isArray(question.options) || question.options.length > 32
      || (question.multiple !== undefined && typeof question.multiple !== "boolean")
      || field.key !== `q${index}` || field.title !== question.header || field.description !== question.question
      || field.type !== (question.multiple === true ? "multiselect" : "string") || field.custom !== true) {
      throw new Error("native-question-field-mismatch")
    }
    const options = question.options.map((option: unknown) => {
      if (!record(option) || typeof option.label !== "string" || typeof option.description !== "string") {
        throw new Error("native-question-option-mismatch")
      }
      return { value: option.label, label: option.label, description: option.description }
    })
    if (!equal(field.options, options) || (value !== undefined && (question.multiple === true
      ? !Array.isArray(value) || value.length > 32 || value.some(answer => typeof answer !== "string")
      : typeof value !== "string"))) throw new Error("native-question-answer-mismatch")
    answers.push(value === undefined ? [] : Array.isArray(value) ? value as string[] : [value as string])
    if (field.key === request.fieldKey && (question.question !== request.question || !equal(value, request.answer))) {
      throw new Error("native-decision-answer-mismatch")
    }
  }
  if (!form.fields.some(field => field.key === request.fieldKey) || !equal(tool.state.metadata?.answers, answers)) {
    throw new Error("native-question-answer-mismatch")
  }
  return answers
}

/** Native Forms have a ten-minute settlement cache and no answerer identity.
 * A construction-owned gate supplies the UI mark and exact Form snapshot after
 * cache expiry. Native question call/success bindings still have to match.
 * No reply/create, synthetic prompt, mutation, automatic ask or replay here. */
export async function verifyNativeDecisionEvidence(request: NativeDecisionEvidenceRequest,
  deps: NativeDecisionEvidenceDependencies): Promise<NativeDecisionEvidenceResult> {
  const result: NativeDecisionEvidenceResult = { status: "unknown", reasons: [],
    requiredChannel: ["answered-native-form", "authenticated-backend-ui-mark"] }
  const cancellation = new AbortController()
  const signal = AbortSignal.any([deps.signal, cancellation.signal, AbortSignal.timeout(10_000)])
  const check = () => {
    signal.throwIfAborted()
    // A Promise or true is not a synchronous authority fence.
    const assertion: unknown = deps.assertCurrent(request)
    if (assertion !== undefined) {
      if (assertion instanceof Promise) void assertion.catch(() => undefined)
      throw new Error("native-authority-fence-invalid")
    }
    signal.throwIfAborted()
  }
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    check()
    try { return await operation() } finally { check() }
  }
  try {
    bounded(request, 160_000)
    request = { ...request, contract: { ...request.contract }, nativeCall: { ...request.nativeCall },
      answer: Array.isArray(request.answer) ? [...request.answer] : request.answer }
    const limit = deps.maxEvents ?? 128
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 || !id(request.projectID)
      || !id(request.delegationToolName) || typeof request.directory !== "string" || !request.directory
      || request.directory.length > 4096) throw new Error("native-request-invalid")
    const provenance = validateNativeDecisionArtifact({ contract: request.contract, call: request.nativeCall, sessionID: request.sessionID,
      artifact: { kind: "decision", question: request.question, answer: request.answer,
        provenance: { kind: request.kind, contract: request.contract, nativeCall: request.nativeCall, sessionID: request.sessionID,
          formID: request.formID, messageID: request.messageID, toolCallID: request.toolCallID, fieldKey: request.fieldKey } } })
    const assertSession = (session: Awaited<ReturnType<SessionClient["get"]>>, sessionID: string) => {
      if (session.id !== sessionID || session.projectID !== request.projectID || session.location.directory !== request.directory
        || Object.keys(session.location).some(key => key !== "directory")) throw new Error("native-session-moved-or-foreign")
    }
    const parent = await read(() => deps.client.get({ sessionID: request.nativeCall.parentSessionID }, { signal }))
    const child = await read(() => deps.client.get({ sessionID: request.sessionID }, { signal }))
    assertSession(parent, request.nativeCall.parentSessionID); assertSession(child, request.sessionID)
    if (child.parentID !== parent.id) throw new Error("native-session-family-mismatch")
    const delegation = questionTool(await read(() => deps.client.message.get({ sessionID: parent.id,
      messageID: request.nativeCall.parentMessageID }, { signal })), request.nativeCall.parentMessageID,
    request.nativeCall.toolCallID, request.delegationToolName)
    if (delegation.state.status === "streaming" || delegation.state.metadata?.sessionID !== child.id) throw new Error("native-invocation-child-mismatch")
    const message = await read(() => deps.client.message.get({ sessionID: child.id, messageID: request.messageID }, { signal }))
    const tool = questionTool(message, request.messageID, request.toolCallID, "question")
    const mark = deps.humanGate && await read(() => deps.humanGate!(request))
    const form = mark ? JSON.parse(JSON.stringify({ ...mark.form, state: { status: "answered", answer: mark.answer } })) as FormDetail
      : await read(() => deps.client.form.get({ sessionID: child.id, formID: request.formID }, { signal }))
    const answers = observeAnswer(form, tool, request)
    let called: NativeObservationSource | undefined, answered: NativeObservationSource | undefined
    let aggregateID: string | undefined, seq = 0, bytes = 0, count = 0, synced = false
    const seenIDs = new Set<string>()
    check()
    const iterator = deps.client.log({ sessionID: child.id, after: 0, follow: false }, { signal })[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await read(() => iterator.next())
        if (next.done) break
        const event = next.value
        bytes += JSON.stringify(event).length
        if (bytes > 1_000_000) throw new Error("native-log-byte-bound")
        if (event.type === "log.synced") {
          if (!id(event.aggregateID) || (aggregateID && aggregateID !== event.aggregateID)
            || !Number.isSafeInteger(event.seq) || event.seq !== seq) throw new Error("native-log-boundary-mismatch")
          synced = true; break
        }
        if (++count > limit) throw new Error("native-log-event-bound")
        if (!id(event.id) || seenIDs.has(event.id) || !id(event.durable?.aggregateID)
          || (aggregateID && aggregateID !== event.durable.aggregateID)
          || !Number.isSafeInteger(event.durable.seq) || event.durable.seq !== seq + 1
          || !Number.isSafeInteger(event.created) || event.created < 1 || !record(event.data)
          || event.data.sessionID !== child.id || (event.location && (event.location.directory !== request.directory
            || Object.keys(event.location).some(key => key !== "directory")))) throw new Error("native-log-foreign-or-incomplete")
        aggregateID = event.durable.aggregateID; seq = event.durable.seq; seenIDs.add(event.id)
        if (event.type !== "session.tool.called" && event.type !== "session.tool.success" && event.type !== "session.tool.failed") continue
        if (event.data.assistantMessageID !== request.messageID || event.data.id !== request.toolCallID) continue
        // `executed` means provider-hosted execution, not local completion.
        if (!isLocalNativeTool(event.data)) throw new Error("native-question-origin-mismatch")
        if (event.type === "session.tool.called") {
          if (called || answered || event.durable.version !== 1 || !equal(event.data.input, tool.state.input)) {
            throw new Error("native-question-call-conflict")
          }
          called = source(event)
        } else if (event.type === "session.tool.success") {
          if (!called || answered || event.durable.version !== 2 || !equal(event.data.metadata?.answers, answers)
            || tool.state.status !== "completed" || !equal(event.data.content, tool.state.content)) {
            throw new Error("native-question-success-conflict")
          }
          answered = source(event)
        } else throw new Error("native-question-failed")
      }
    } finally {
      if (iterator.return) await read(() => iterator.return!())
    }
    if (!synced || !called || !answered) throw new Error("native-question-log-missing-or-partial")
    // Re-read identity and Form after draining: native moves/settlement races are
    // not repaired using temporal/title/string matching or descendant authority.
    assertSession(await read(() => deps.client.get({ sessionID: parent.id }, { signal })), parent.id)
    const currentChild = await read(() => deps.client.get({ sessionID: child.id }, { signal }))
    assertSession(currentChild, child.id)
    if (currentChild.parentID !== parent.id) throw new Error("native-session-family-mismatch")
    if (mark) {
      const currentMark = await read(() => deps.humanGate!(request))
      if (!equal(mark, currentMark) || mark.via !== "ui" || mark.formID !== request.formID
        || mark.sessionID !== request.sessionID) throw new Error("native-human-mark-changed")
    } else {
      const currentForm = await read(() => deps.client.form.get({ sessionID: child.id, formID: request.formID }, { signal }))
      if (!equal(form, currentForm)) throw new Error("native-form-changed")
    }
    check()
    result.status = mark ? "qualified" : "unqualified"
    result.evidence = { ...provenance, durability: mark ? "native-ui-mark" : "unqualified",
      humanPrincipal: mark ? "codenomad-human" : "unknown",
      toolCalled: called, toolAnswered: answered }
    if (!mark) result.reasons.push("native-ui-human-mark-unavailable")
  } catch {
    // Dispose this read's transport even if a revoked fence prevents iterator
    // cleanup. Local cancellation is not a native Form/session mutation.
    cancellation.abort()
    delete result.evidence
    result.status = "unknown"
    result.reasons.push("native-read-or-current-authority-unknown")
  }
  return result
}

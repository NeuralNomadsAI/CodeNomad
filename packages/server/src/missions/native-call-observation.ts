import type { OpenCode, SessionLogOutput, SessionMessageGetOutput } from "@opencode/client"
import type { MissionNativeBinding, MissionTask } from "./model"
import { parseNativeBinding } from "./native-report-provenance"

export type NativeObservationSource = { id: string; sessionID: string; aggregateID: string; seq: number; created: number }
export type NativeLaunchMode = "foreground" | "background" | "unknown"
export type NativeChildOutcome = "started" | "succeeded" | "failed" | "interrupted"
export type NativeCallObservation =
  | { kind: "tool-called"; mode: NativeLaunchMode; source: NativeObservationSource }
  | { kind: "tool-ended"; mode: NativeLaunchMode; outcome: "returned" | "error"; source: NativeObservationSource }
  // 2.0.22 execution events identify a session, not an invocation/job/inbox.
  | { kind: "child-uncorrelated"; outcome: NativeChildOutcome; source: NativeObservationSource }
export type MissionNativeExecution = {
  binding: MissionNativeBinding
  ended?: "returned" | "error"
  launch?: { mode: NativeLaunchMode; state: "called" | "returned" | "error" }
  childExecution?: { state: "unknown"; observedOutcome?: NativeChildOutcome }
  observations?: NativeCallObservation[]
  observationConflict?: true
}
export type NativeLogCursor = { aggregateID: string; after: number }
export type NativeCallReadTarget = { binding: MissionNativeBinding; childSessionID: string; toolName: string }
type SessionClient = ReturnType<typeof OpenCode.make>["session"]
export type NativeCallReadClient = { log: SessionClient["log"]; message: Pick<SessionClient["message"], "get"> }
export type NativeCallReadResult = {
  observations: NativeCallObservation[]
  parentCursor?: NativeLogCursor
  childCursor?: NativeLogCursor
  complete: boolean
  reasons: string[]
  childCorrelation: "unknown"
  profileObservation: "unknown"
}

/** V2 publish-llm-event.ts: `executed` means provider-hosted, NOT success.
 * Local question/subagent calls and their durable results carry false. */
export function isLocalNativeTool(value: { executed?: unknown }): boolean { return value.executed === false }

const record = (input: unknown): input is Record<string, unknown> => Boolean(input) && typeof input === "object" && !Array.isArray(input)
const id = (input: unknown): input is string => typeof input === "string" && input.length > 0 && input.length <= 240 && !/[\s\x00-\x1f\x7f]/.test(input)
const only = (input: Record<string, unknown>, keys: string[]) => Object.keys(input).every(key => keys.includes(key))

export function parseNativeCallObservation(input: unknown): NativeCallObservation | undefined {
  if (!record(input) || !record(input.source)) return undefined
  const source = input.source
  if (!only(source, ["id", "sessionID", "aggregateID", "seq", "created"])
    || !id(source.id) || !id(source.sessionID) || !id(source.aggregateID)
    || !Number.isSafeInteger(source.seq) || Number(source.seq) < 1
    || !Number.isSafeInteger(source.created) || Number(source.created) < 1) return undefined
  const parsed = { id: source.id, sessionID: source.sessionID, aggregateID: source.aggregateID, seq: Number(source.seq), created: Number(source.created) }
  if (input.kind === "child-uncorrelated" && only(input, ["kind", "outcome", "source"])
    && typeof input.outcome === "string" && ["started", "succeeded", "failed", "interrupted"].includes(input.outcome)) {
    return { kind: input.kind, outcome: input.outcome as NativeChildOutcome, source: parsed }
  }
  if (typeof input.mode !== "string" || !["foreground", "background", "unknown"].includes(input.mode)) return undefined
  const mode = input.mode as NativeLaunchMode
  if (input.kind === "tool-called" && only(input, ["kind", "mode", "source"])) return { kind: input.kind, mode, source: parsed }
  if (input.kind === "tool-ended" && only(input, ["kind", "mode", "outcome", "source"])
    && (input.outcome === "returned" || input.outcome === "error")) return { kind: input.kind, mode, outcome: input.outcome, source: parsed }
  return undefined
}

/** No business report, idle state or background launch ACK establishes termination. */
export function hasUnsettledNativeExecution(task: Pick<MissionTask, "nativeBinding" | "nativeExecution">): boolean {
  if (!task.nativeBinding) return false
  const execution = task.nativeExecution
  return !execution || Boolean(execution.observationConflict)
    || (execution.launch !== undefined && execution.launch.mode !== "foreground") || !execution.ended
}

export function projectNativeCallObservation(execution: MissionNativeExecution, observation: NativeCallObservation): MissionNativeExecution {
  const history = execution.observations ?? []
  const existing = history.find(item => item.source.sessionID === observation.source.sessionID && item.source.id === observation.source.id)
  if (existing) return JSON.stringify(existing) === JSON.stringify(observation) ? execution : { ...execution, observationConflict: true }
  const next: MissionNativeExecution = { ...execution, observations: [...history, observation] }
  if (history.some(item => item.source.sessionID === observation.source.sessionID
    && (item.source.aggregateID !== observation.source.aggregateID || item.source.seq === observation.source.seq))) {
    return { ...next, observationConflict: true }
  }
  if (observation.kind === "child-uncorrelated") {
    next.childExecution = { state: "unknown", observedOutcome: observation.outcome }
    return next
  }
  if (execution.launch && execution.launch.mode !== "unknown" && observation.mode !== "unknown"
    && execution.launch.mode !== observation.mode) next.observationConflict = true
  const mode = observation.mode === "unknown" ? execution.launch?.mode ?? "unknown" : observation.mode
  if (observation.kind === "tool-ended" && execution.launch && execution.launch.state !== "called"
    && execution.launch.state !== observation.outcome) next.observationConflict = true
  const state = observation.kind === "tool-ended" ? observation.outcome : execution.launch?.state ?? "called"
  next.launch = { mode, state }
  if (mode !== "foreground") {
    next.childExecution = { state: "unknown", ...next.childExecution }
    if (execution.ended && mode === "background") next.observationConflict = true
  } else if (observation.kind === "tool-ended") {
    if (execution.ended && execution.ended !== observation.outcome) next.observationConflict = true
    else next.ended = observation.outcome
  }
  return next
}

async function readLog(client: NativeCallReadClient, sessionID: string, cursor: NativeLogCursor | undefined,
  limit: number, signal: AbortSignal, check: () => Promise<void>) {
  let after = cursor?.after ?? 0, aggregateID = cursor?.aggregateID
  const events: Exclude<SessionLogOutput, { type: "log.synced" }>[] = [], seen = new Map<number, string>(), identities = new Map<string, string>()
  let scanned = 0, bytesRead = 0
  let complete = false, reason = "missing-log-synced"
  await check()
  for await (const event of client.log({ sessionID, after, follow: false }, { signal })) {
    signal.throwIfAborted()
    if (++scanned > limit) { reason = "event-bound"; break }
    if (event.type === "log.synced") {
      if (!id(event.aggregateID) || (aggregateID && aggregateID !== event.aggregateID)
        || !Number.isSafeInteger(event.seq) || event.seq !== after) throw new Error("Native log boundary mismatch")
      aggregateID = event.aggregateID; complete = true; reason = ""; break
    }
    if (!id(event.id) || !id(event.durable?.aggregateID) || (aggregateID && event.durable.aggregateID !== aggregateID)
      || !Number.isSafeInteger(event.durable?.seq) || event.durable.seq < 1 || !Number.isSafeInteger(event.created) || event.created < 1
      || !record(event.data) || event.data.sessionID !== sessionID) throw new Error("Foreign or malformed native log event")
    aggregateID = event.durable.aggregateID
    const bytes = JSON.stringify(event), previous = seen.get(event.durable.seq)
    if (identities.has(event.id) && identities.get(event.id) !== bytes) throw new Error("Conflicting native event identity")
    identities.set(event.id, bytes)
    bytesRead += bytes.length
    if (bytesRead > 1_000_000) throw new Error("Native log byte bound")
    if (previous !== undefined) {
      if (previous !== bytes) throw new Error("Conflicting native log sequence")
      if (scanned === limit) { reason = "event-bound"; break }
      continue
    }
    if (event.durable.seq !== after + 1) throw new Error("Native log cursor gap or regression")
    seen.set(event.durable.seq, bytes); after = event.durable.seq; events.push(event)
    if (scanned === limit) { reason = "event-bound"; break }
  }
  await check()
  return { events, complete, reason, cursor: aggregateID ? { aggregateID, after } : undefined }
}

/** Bounded durable log slices, not global SSE replay. Supplied client/check own authentication and authority. */
export async function readNativeCallObservation(client: NativeCallReadClient, target: NativeCallReadTarget, options: {
  check: () => Promise<void>; signal: AbortSignal; maxEvents?: number; parentCursor?: NativeLogCursor; childCursor?: NativeLogCursor
}): Promise<NativeCallReadResult> {
  target = structuredClone(target)
  options = { ...options, parentCursor: structuredClone(options.parentCursor), childCursor: structuredClone(options.childCursor) }
  const limit = options.maxEvents ?? 128
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid native observation bound")
  for (const cursor of [options.parentCursor, options.childCursor]) {
    if (cursor && (!id(cursor.aggregateID) || !Number.isSafeInteger(cursor.after) || cursor.after < 0)) throw new Error("Invalid native log cursor")
  }
  const observations: NativeCallObservation[] = [], reasons: string[] = []
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
  const result: NativeCallReadResult = { observations, reasons, complete: false, childCorrelation: "unknown", profileObservation: "unknown" }
  try {
    if (!parseNativeBinding(target.binding) || !id(target.childSessionID) || !id(target.toolName)
      || target.childSessionID === target.binding.parentSessionID) throw new Error("Invalid native observation target")
    await options.check(); signal.throwIfAborted()
    const message: SessionMessageGetOutput = await client.message.get({ sessionID: target.binding.parentSessionID,
      messageID: target.binding.parentMessageID }, { signal })
    await options.check()
    if (message.id !== target.binding.parentMessageID || message.type !== "assistant" || message.content.length > 512
      || JSON.stringify(message).length > 1_000_000) throw new Error("Native parent message mismatch/bound")
    const tools = message.content.filter(part => part.type === "tool" && part.id === target.binding.toolCallID)
    if (tools.length !== 1) throw new Error("Native tool identity ambiguous/missing")
    const tool = tools[0]
    if (tool.type !== "tool" || tool.name !== target.toolName || tool.state.status === "streaming"
      || !isLocalNativeTool(tool) || tool.state.metadata?.sessionID !== target.childSessionID) throw new Error("Native child correlation unavailable")
    const input = tool.state.input
    if (input.background === false && tool.state.metadata?.status === "running") throw new Error("Native launch mode conflict")
    // No missing-input/default profile or background-mode inference.
    const mode: NativeLaunchMode = input.background === true || tool.state.metadata?.status === "running" ? "background"
      : input.background === false ? "foreground" : "unknown"
    const parent = await readLog(client, target.binding.parentSessionID, options.parentCursor, limit, signal, options.check)
    result.parentCursor = parent.cursor
    if (!parent.complete) reasons.push(parent.reason)
    for (const event of parent.events) {
      if (event.type !== "session.tool.called" && event.type !== "session.tool.success" && event.type !== "session.tool.failed") continue
      if (event.data.assistantMessageID !== target.binding.parentMessageID || event.data.id !== target.binding.toolCallID) continue
      if (!isLocalNativeTool(event.data) || event.durable.version !== (event.type === "session.tool.called" ? 1 : 2)) throw new Error("Native tool schema mismatch")
      if (event.type === "session.tool.called" && !record(event.data.input)) throw new Error("Native tool input missing")
      if (event.type === "session.tool.called" && event.data.input.background !== input.background) throw new Error("Native tool input conflict")
      const source = { id: event.id, sessionID: event.data.sessionID, aggregateID: event.durable.aggregateID, seq: event.durable.seq, created: event.created }
      if (event.type === "session.tool.called") observations.push({ kind: "tool-called", mode, source })
      else {
        if (event.type === "session.tool.success" && (!Array.isArray(event.data.content) || !event.data.content.length)) throw new Error("Native success content missing")
        if (event.type === "session.tool.failed" && (!record(event.data.error) || typeof event.data.error.type !== "string"
          || typeof event.data.error.message !== "string")) throw new Error("Native failure error missing")
        if (event.data.metadata?.sessionID !== target.childSessionID) throw new Error("Native terminal child correlation unavailable")
        if ((event.type === "session.tool.success" && tool.state.status !== "completed")
          || (event.type === "session.tool.failed" && tool.state.status !== "error")) throw new Error("Native tool state/log conflict")
        if (input.background === false && event.data.metadata?.status === "running") throw new Error("Native terminal launch mode conflict")
        const terminalMode = event.data.metadata?.status === "running" ? "background" : mode
        observations.push({ kind: "tool-ended", mode: terminalMode, outcome: event.type === "session.tool.success" ? "returned" : "error", source })
      }
    }
    const child = await readLog(client, target.childSessionID, options.childCursor, limit, signal, options.check)
    result.childCursor = child.cursor
    if (!child.complete) reasons.push(child.reason)
    for (const event of child.events) {
      if (!event.type.startsWith("session.execution.")) continue
      const outcome = event.type.slice("session.execution.".length) as NativeChildOutcome
      if (!["started", "succeeded", "failed", "interrupted"].includes(outcome)) continue
      if (event.durable.version !== 1) throw new Error("Native execution schema mismatch")
      if (event.type === "session.execution.failed" && (!record(event.data.error) || typeof event.data.error.type !== "string"
        || typeof event.data.error.message !== "string")) throw new Error("Native execution error missing")
      if (event.type === "session.execution.interrupted" && !["user", "shutdown", "superseded", "inactivity"].includes(event.data.reason)) throw new Error("Native interruption reason missing")
      observations.push({ kind: "child-uncorrelated", outcome, source: { id: event.id, sessionID: target.childSessionID,
        aggregateID: event.durable.aggregateID, seq: event.durable.seq, created: event.created } })
    }
    if (mode === "unknown") reasons.push("launch-mode-unqualified")
    if (mode === "background" || observations.some(item => item.kind === "tool-ended" && item.mode === "background")) reasons.push("child-invocation-correlation-unavailable")
    result.complete = parent.complete && child.complete
    await options.check()
  } catch {
    // Partial/error reads cannot authorize publication or advance checkpoints.
    observations.length = 0; delete result.parentCursor; delete result.childCursor
    result.complete = false; reasons.push("native-read-or-authority-unknown")
  }
  return result
}

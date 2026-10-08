import { DateTime, Schema } from "effect"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionError } from "@opencode/schema/session-error"
import { canonicalAuthority, rejectAuthority } from "../../missions/authority-protocol"

// Native to-session-error.ts at 757e565c (the inspected 2.0.24 contract), not
// diagnostic prose or a daemon-version allowlist. Unrecognised codes stay pending.
const providerCodes = new Set(["provider.rate-limit", "provider.auth", "provider.quota", "provider.content-filter",
  "provider.transport", "provider.internal", "provider.invalid-output", "provider.invalid-request",
  "provider.unsupported-operation", "provider.no-route", "provider.unknown", "provider.timeout"])
const continuation = "The previous response was interrupted. Continue from where you left off without repeating completed content."
type Event = { id: string; seq: number; type: string; data: Record<string, unknown> }
type Message = Readonly<Record<string, unknown>>
type Part = { type: "text" | "reasoning"; ordinal: number; text?: string }
type Step = { id: string; started: number; agent: string; model: unknown; phase: "active" | "retry" | "ended" | "failed";
  retry: boolean; streamed: boolean; parts: Part[]; error?: SessionError.Error; finish?: string }
const codecs = {
  "session.step.started.1": SessionEvent.Step.Started.fields.data,
  "session.step.streamed.1": SessionEvent.Step.Streamed.fields.data,
  "session.step.ended.1": SessionEvent.Step.Ended.fields.data,
  "session.step.failed.1": SessionEvent.Step.Failed.fields.data,
  "session.retry.scheduled.1": SessionEvent.RetryScheduled.fields.data,
  "session.text.started.1": SessionEvent.Text.Started.fields.data,
  "session.text.ended.1": SessionEvent.Text.Ended.fields.data,
  "session.reasoning.started.1": SessionEvent.Reasoning.Started.fields.data,
  "session.reasoning.ended.1": SessionEvent.Reasoning.Ended.fields.data,
}
const same = (a: unknown, b: unknown) => canonicalAuthority(JSON.parse(JSON.stringify(a ?? null))) === canonicalAuthority(JSON.parse(JSON.stringify(b ?? null)))
function failed(): never { return rejectAuthority("observation-unavailable") }
const providerError = (value: unknown) => {
  const error = Schema.decodeUnknownSync(SessionError.Error)(value)
  if (!providerCodes.has(error.type)) failed()
  return error
}

/** Complete bounded native lifecycle inside one admitted execution. Tool Called
 * precedes local execution; scoped tool fibers join before the execution terminal.
 * RetryScheduled can end an output-free attempt without Step.Failed and reuse its
 * assistant ID. A final execution failure can also end that native retry wait.
 * This proves terminal native work, never zero HTTP requests or remote billing. */
export function nativeFailedExecution(events: readonly Event[], messages: readonly Message[], inputID: string,
  deliveredSeq: number, terminal: Event): string {
  try {
    const error = providerError(terminal.data.error), steps = new Map<string, Step>()
    const artifacts = new Map<string, { type: string; text?: unknown }>()
    const idleID = terminal.id.replace(/^evt_/, "msg_")
    let active: Step | undefined
    for (const event of events) {
      const codec = codecs[event.type as keyof typeof codecs]
      if (!codec) {
        if (["session.created.1", "session.inbox.enqueued.1", "session.inbox.delivered.1",
          "session.execution.started.1", "session.execution.failed.1"].includes(event.type)) continue
        if (event.type === "session.synthetic.1") {
          if (!active?.retry || active.phase !== "failed" || event.data.text !== continuation
            || event.data.description !== undefined || event.data.metadata !== undefined) failed()
          artifacts.set(event.id.replace(/^evt_/, "msg_"), { type: "synthetic", text: continuation })
          continue
        }
        if (["session.agent.selected.1", "session.model.selected.1", "session.instructions.updated.2"].includes(event.type)) {
          const type = event.type === "session.instructions.updated.2" ? "system" : event.type.split(".")[1] + "-switched"
          if (type !== "system" || typeof event.data.text === "string" && event.data.text.length)
            artifacts.set(event.id.replace(/^evt_/, "msg_"), { type, ...(type === "system" ? { text: event.data.text } : {}) })
          continue
        }
        // No tool/input/result, Shell, compaction, mutation, usage-only partial
        // projection or unfamiliar event can borrow this finite failure proof.
        failed()
      }
      Schema.decodeUnknownSync(codec as Schema.Codec<unknown>)(event.data)
      if (event.seq <= deliveredSeq || event.seq >= terminal.seq) failed()
      const id = String(event.data.assistantMessageID)
      if (event.type === "session.step.started.1") {
        if (active?.phase === "active" || active?.phase === "retry" && active.id !== id
          || steps.has(id) && (active?.id !== id || active.phase !== "retry" || active.parts.length)) failed()
        active = { id, started: Number(event.data.started), agent: String(event.data.agent), model: event.data.model,
          phase: "active", retry: false, streamed: false, parts: [] }
        steps.set(id, active)
        continue
      }
      if (!active || active.id !== id) failed()
      if (event.type === "session.retry.scheduled.1") {
        if (active.retry || !["active", "failed"].includes(active.phase)
          || active.parts.some(part => part.text === undefined)) failed()
        providerError(event.data.error)
        active.retry = true
        if (active.phase === "active") active.phase = "retry"
        continue
      }
      if (active.phase !== "active") failed()
      if (event.type === "session.step.streamed.1") {
        if (active.streamed) failed()
        active.streamed = true
      } else if (event.type === "session.step.failed.1" || event.type === "session.step.ended.1") {
        if (active.parts.some(part => part.text === undefined)
          || event.data.files !== undefined && (!Array.isArray(event.data.files) || event.data.files.length)) failed()
        active.phase = event.type === "session.step.failed.1" ? "failed" : "ended"
        active.finish = String(event.data.finish ?? "error")
        if (active.phase === "failed") active.error = providerError(event.data.error)
      } else {
        const type = event.type.startsWith("session.text.") ? "text" : "reasoning"
        const ordinal = Number(event.data.ordinal)
        const part = active.parts.find(part => part.type === type && part.ordinal === ordinal)
        if (event.type.endsWith("started.1")) {
          if (part || active.parts.length >= 512) failed()
          active.parts.push({ type, ordinal })
        } else {
          if (!part || part.text !== undefined) failed()
          part.text = String(event.data.text)
        }
      }
    }
    if (active?.phase === "active") failed()
    const seen = new Set<string>()
    for (const row of messages) {
      if (typeof row.id !== "string" || seen.has(row.id) || typeof row.data !== "string") failed()
      seen.add(row.id)
      if (row.id === inputID) { if (row.type !== "synthetic") failed(); continue }
      const data = JSON.parse(row.data)
      const message = Schema.decodeUnknownSync(SessionMessage.Info)({ ...data, id: row.id, type: row.type })
      if (row.id === idleID && message.type === "idle" && message.outcome === "failed") continue
      const artifact = artifacts.get(row.id)
      if (artifact && message.type === artifact.type
        && (artifact.text === undefined || "text" in message && message.text === artifact.text)) continue
      const step = steps.get(row.id)
      if (!step || message.type !== "assistant") failed()
      if (message.content.some(part => part.type === "tool") || message.retry
        || message.content.length !== step.parts.length || message.agent !== step.agent || !same(message.model, step.model)
        || DateTime.toEpochMillis(message.time.created) !== step.started
        || message.snapshot?.files?.length || !same(message.error, step.error) || message.finish !== step.finish
        || (step.phase === "retry" ? message.time.completed !== undefined : message.time.completed === undefined)) failed()
      if (message.content.some((part, index) => part.type !== step.parts[index].type || part.text !== step.parts[index].text)) failed()
    }
    if (!seen.has(inputID) || [...steps.keys(), ...artifacts.keys()].some(id => !seen.has(id))) failed()
    // Retain only a bounded native code in the Mission journal. Provider messages
    // can contain URLs/tokens; original diagnostics remain in native storage.
    return error.type
  } catch { return failed() }
}

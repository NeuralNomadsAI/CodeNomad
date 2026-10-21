import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client"
import { MESSAGE_WINDOW_PAGE_SIZE } from "./message-v2/message-window"

/** Bounded live rows a transcript reducer keeps resident. */
export const MAX_ACTIVE_TRANSCRIPT_MESSAGES = 32
export const MAX_TRANSCRIPT_MESSAGES = MESSAGE_WINDOW_PAGE_SIZE

/** Messages that can still grow or settle: kept resident regardless of the
 * completed-message bound so active work never falls out of the window. */
export function isActiveTranscriptMessage(message: SessionMessageInfo): boolean {
  return (message.type === "assistant" && !message.time?.completed)
    || (message.type === "shell" && message.status === "running")
    || (message.type === "compaction" && message.status === "running")
}

export function boundedTranscript(messages: SessionMessageInfo[], limit = MAX_TRANSCRIPT_MESSAGES): SessionMessageInfo[] {
  const active = messages.filter(isActiveTranscriptMessage).slice(-MAX_ACTIVE_TRANSCRIPT_MESSAGES)
  const completedLimit = Math.max(0, limit - active.length)
  const completed = messages
    .filter((message) => !isActiveTranscriptMessage(message))
    .slice(-completedLimit)
  const retained = new Set([...completed, ...active].map((message) => message.id))
  return messages
    .filter((message) => retained.has(message.id))
    .map((message) => JSON.parse(JSON.stringify(message)) as SessionMessageInfo)
}

/** Events that can add a message row to the reducer's window. */
export function eventMayAppendMessage(event: OpenCodeEvent, runningCompactions = 0): boolean {
  switch (event.type) {
    case "session.agent.selected":
    case "session.model.selected":
    case "session.moved":
    case "session.synthetic":
    case "session.shell.started":
    case "session.step.started":
    case "session.compaction.started":
      return true
    case "session.compaction.ended":
    case "session.compaction.failed":
      return runningCompactions === 0
    case "session.instructions.updated":
      return event.data.text !== undefined
    case "session.inbox.enqueued":
      return event.data.item.type === "user" || event.data.item.type === "synthetic"
    default:
      return false
  }
}

/** Events whose admission changes projected message content. */
export function eventAffectsMessages(event: OpenCodeEvent): boolean {
  switch (event.type) {
    case "session.agent.selected":
    case "session.model.selected":
    case "session.moved":
    case "session.inbox.delivered":
    case "session.inbox.cancelled":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.synthetic":
    case "session.step.started":
    case "session.step.ended":
    case "session.step.failed":
    case "session.text.started":
    case "session.text.delta":
    case "session.text.ended":
    case "session.reasoning.started":
    case "session.reasoning.delta":
    case "session.reasoning.ended":
    case "session.tool.input.started":
    case "session.tool.input.delta":
    case "session.tool.input.ended":
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed":
    case "session.retry.scheduled":
    case "session.revert.committed":
    case "session.compaction.started":
    case "session.compaction.delta":
    case "session.compaction.ended":
    case "session.compaction.failed":
    case "session.shell.started":
    case "session.shell.ended":
    case "session.skill.activated":
      return true
    case "session.instructions.updated":
      return event.data.text !== undefined
    case "session.inbox.enqueued":
      return event.data.item.type === "user" || event.data.item.type === "synthetic"
    case "session.created":
    case "session.renamed":
    case "session.viewed":
    case "session.inbox.delivery.changed":
    case "session.execution.started":
    case "session.revert.staged":
    case "session.revert.cleared":
    case "session.usage.updated":
    case "session.forked":
      return false
    default:
      return event.type.startsWith("session.")
  }
}

/** The session a native event belongs to, if any. */
export function eventSessionId(event: OpenCodeEvent): string | undefined {
  const sessionId = (event as { data?: { sessionID?: unknown } }).data?.sessionID
  if (typeof sessionId === "string") return sessionId
  if (event.type === "form.created") return event.data.form.sessionID
}

import { createSignal } from "solid-js"
import type { AssistantStreamChunkEvent } from "../lib/event-transport-contract"

const [streamTexts, setStreamTexts] = createSignal(new Map<string, string>())

function makeKey(instanceId: string, sessionId: string, messageId: string, partId: string) {
  return `${instanceId}:${sessionId}:${messageId}:${partId}`
}

export function appendAssistantStreamChunk(instanceId: string, event: AssistantStreamChunkEvent) {
  const props = event.properties
  if (!props?.sessionID || !props?.messageID || !props.partID || typeof props.delta !== "string") {
    return
  }

  const key = makeKey(instanceId, props.sessionID, props.messageID, props.partID)
  setStreamTexts((prev) => {
    const next = new Map(prev)
    next.set(key, `${next.get(key) ?? ""}${props.delta}`)
    return next
  })
}

export function getAssistantStreamPreviewText(
  instanceId: string,
  sessionId: string | undefined,
  messageId: string | undefined,
  partId: string | undefined,
) {
  if (!sessionId || !messageId || !partId) return undefined
  return streamTexts().get(makeKey(instanceId, sessionId, messageId, partId))
}

export function clearAssistantStreamMessage(
  instanceId: string,
  sessionId: string | undefined,
  messageId: string | undefined,
) {
  if (!sessionId || !messageId) return
  const prefix = `${instanceId}:${sessionId}:${messageId}:`
  setStreamTexts((prev) => {
    let changed = false
    const next = new Map(prev)
    for (const key of next.keys()) {
      if (key.startsWith(prefix)) {
        next.delete(key)
        changed = true
      }
    }
    return changed ? next : prev
  })
}

export function clearAssistantStreamPart(
  instanceId: string,
  sessionId: string | undefined,
  messageId: string | undefined,
  partId: string | undefined,
) {
  if (!sessionId || !messageId || !partId) return
  const key = makeKey(instanceId, sessionId, messageId, partId)
  setStreamTexts((prev) => {
    if (!prev.has(key)) return prev
    const next = new Map(prev)
    next.delete(key)
    return next
  })
}

export function clearAssistantStreamAll() {
  setStreamTexts((prev) => {
    if (prev.size === 0) return prev
    return new Map()
  })
}

export function clearAssistantStreamInstance(instanceId: string) {
  const prefix = `${instanceId}:`
  setStreamTexts((prev) => {
    let changed = false
    const next = new Map(prev)
    for (const key of next.keys()) {
      if (key.startsWith(prefix)) {
        next.delete(key)
        changed = true
      }
    }
    return changed ? next : prev
  })
}

export function clearAssistantStreamSession(instanceId: string, sessionId: string | undefined) {
  if (!sessionId) return
  const prefix = `${instanceId}:${sessionId}:`
  setStreamTexts((prev) => {
    let changed = false
    const next = new Map(prev)
    for (const key of next.keys()) {
      if (key.startsWith(prefix)) {
        next.delete(key)
        changed = true
      }
    }
    return changed ? next : prev
  })
}

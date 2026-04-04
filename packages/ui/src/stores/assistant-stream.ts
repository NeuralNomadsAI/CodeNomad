import { createSignal } from "solid-js"
import type { AssistantStreamChunkEvent } from "../lib/event-transport-contract"

interface StreamEntry {
  text: string
  get: () => string
  set: (value: string) => void
}

const streamEntries = new Map<string, StreamEntry>()

function makeKey(instanceId: string, sessionId: string, messageId: string, partId: string) {
  return `${instanceId}:${sessionId}:${messageId}:${partId}`
}

function getOrCreateEntry(key: string): StreamEntry {
  let entry = streamEntries.get(key)
  if (!entry) {
    const [get, set] = createSignal("")
    entry = { text: "", get, set: (v: string) => set(v) }
    streamEntries.set(key, entry)
  }
  return entry
}

export function appendAssistantStreamChunk(instanceId: string, event: AssistantStreamChunkEvent) {
  const props = event.properties
  if (!props?.sessionID || !props?.messageID || !props.partID || typeof props.delta !== "string") {
    return
  }
  if (props.delta.length === 0) return

  const key = makeKey(instanceId, props.sessionID, props.messageID, props.partID)
  const entry = getOrCreateEntry(key)
  entry.text += props.delta
  entry.set(entry.text)
}

export function getAssistantStreamPreviewText(
  instanceId: string,
  sessionId: string | undefined,
  messageId: string | undefined,
  partId: string | undefined,
) {
  if (!sessionId || !messageId || !partId) return undefined
  const key = makeKey(instanceId, sessionId, messageId, partId)
  const entry = streamEntries.get(key)
  if (!entry) return undefined
  // Subscribe to this specific key's signal
  return entry.get() || undefined
}

export function clearAssistantStreamMessage(
  instanceId: string,
  sessionId: string | undefined,
  messageId: string | undefined,
) {
  if (!sessionId || !messageId) return
  const prefix = `${instanceId}:${sessionId}:${messageId}:`
  for (const [key, entry] of streamEntries) {
    if (key.startsWith(prefix)) {
      entry.set("")
      streamEntries.delete(key)
    }
  }
}

export function clearAssistantStreamPart(
  instanceId: string,
  sessionId: string | undefined,
  messageId: string | undefined,
  partId: string | undefined,
) {
  if (!sessionId || !messageId || !partId) return
  const key = makeKey(instanceId, sessionId, messageId, partId)
  const entry = streamEntries.get(key)
  if (!entry) return
  entry.set("")
  streamEntries.delete(key)
}

export function clearAssistantStreamAll() {
  for (const entry of streamEntries.values()) {
    entry.set("")
  }
  streamEntries.clear()
}

export function clearAssistantStreamInstance(instanceId: string) {
  const prefix = `${instanceId}:`
  for (const [key, entry] of streamEntries) {
    if (key.startsWith(prefix)) {
      entry.set("")
      streamEntries.delete(key)
    }
  }
}

export function clearAssistantStreamSession(instanceId: string, sessionId: string | undefined) {
  if (!sessionId) return
  const prefix = `${instanceId}:${sessionId}:`
  for (const [key, entry] of streamEntries) {
    if (key.startsWith(prefix)) {
      entry.set("")
      streamEntries.delete(key)
    }
  }
}

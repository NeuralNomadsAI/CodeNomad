import type { SessionReasoningDelta, SessionTextDelta } from "@opencode-ai/client"
import type { ClientPart, MessageInfo } from "../types/message"
import { messageStoreBus } from "./message-v2/bus"

type NativeContentDelta = SessionTextDelta | SessionReasoningDelta
type TrackedPart = {
  messageId: string
  partId: string
  type: "text" | "reasoning"
  ordinal: number
  order: number
  text: string
  createdAt: number
}
type SessionStreamingState = {
  seenEventIds: Set<string>
  eventOrder: string[]
  parts: Map<string, TrackedPart>
  renderTimers: Map<string, ReturnType<typeof setTimeout>>
  settledMessageIds: Set<string>
  settledMessageOrder: string[]
}

const MAX_TRACKED_EVENT_IDS = 20_000
const MAX_SETTLED_MESSAGE_IDS = 100
const RENDER_INTERVAL_MS = 16
const streamingState = new Map<string, Map<string, SessionStreamingState>>()

function getSessionState(instanceId: string, sessionId: string): SessionStreamingState {
  let instance = streamingState.get(instanceId)
  if (!instance) {
    instance = new Map()
    streamingState.set(instanceId, instance)
  }
  let session = instance.get(sessionId)
  if (!session) {
    session = {
      seenEventIds: new Set(), eventOrder: [], parts: new Map(), renderTimers: new Map(),
      settledMessageIds: new Set(), settledMessageOrder: [],
    }
    instance.set(sessionId, session)
  }
  return session
}

function markEventSeen(state: SessionStreamingState, eventId: string): boolean {
  if (state.seenEventIds.has(eventId)) return false
  state.seenEventIds.add(eventId)
  state.eventOrder.push(eventId)
  while (state.eventOrder.length > MAX_TRACKED_EVENT_IDS) {
    const expired = state.eventOrder.shift()
    if (expired) state.seenEventIds.delete(expired)
  }
  return true
}

function displayText(tracked: string, existing: string | undefined): string {
  if (!existing) return tracked
  if (existing.startsWith(tracked) && existing.length >= tracked.length) return existing
  if (!tracked.startsWith(existing)) return existing
  return tracked
}

function renderTrackedMessage(
  instanceId: string,
  sessionId: string,
  state: SessionStreamingState,
  messageId: string,
): void {
  const trackedParts = [...state.parts.values()]
    .filter((part) => part.messageId === messageId)
    .sort((left, right) => left.order - right.order)
  if (trackedParts.length === 0) return

  const store = messageStoreBus.getOrCreate(instanceId)
  const current = store.getMessage(messageId)
  const currentParts = (current?.partIds ?? [])
    .map((partId) => current?.parts[partId]?.data)
    .filter((part): part is ClientPart => Boolean(part))
  const nextParts = currentParts.filter((part) => {
    const id = typeof part.id === "string" ? part.id : ""
    return !id.startsWith(`${messageId}-`) || !id.includes("-native-")
  })

  for (const tracked of trackedParts) {
    const sameTypeIndexes = nextParts
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => part.type === tracked.type)
    const existingIndex = sameTypeIndexes[tracked.ordinal]?.index ?? -1
    const existing = existingIndex >= 0 ? nextParts[existingIndex] : undefined
    const existingText = existing && "text" in existing && typeof existing.text === "string" ? existing.text : undefined
    const part: ClientPart = {
      ...(existing ?? {}),
      id: existing?.id ?? tracked.partId,
      type: tracked.type,
      text: displayText(tracked.text, existingText),
      sessionID: sessionId,
      messageID: messageId,
    } as ClientPart
    if (existingIndex >= 0) nextParts[existingIndex] = part
    else nextParts.push(part)
  }

  const createdAt = current?.createdAt ?? trackedParts[0]?.createdAt ?? Date.now()
  store.addOrUpdateSession({ id: sessionId })
  store.upsertMessage({
    id: messageId,
    sessionId,
    role: "assistant",
    status: current?.status === "error"
      ? "error"
      : state.settledMessageIds.has(messageId) ? "complete" : "streaming",
    createdAt,
    updatedAt: Date.now(),
    parts: nextParts,
  })
  if (!store.getMessageInfo(messageId)) {
    const info: MessageInfo = {
      id: messageId,
      sessionID: sessionId,
      role: "assistant",
      time: { created: createdAt },
    }
    store.setMessageInfo(messageId, info)
  }
}

function flushMessage(instanceId: string, sessionId: string, state: SessionStreamingState, messageId: string): void {
  const timer = state.renderTimers.get(messageId)
  if (timer) clearTimeout(timer)
  state.renderTimers.delete(messageId)
  renderTrackedMessage(instanceId, sessionId, state, messageId)
}

function scheduleMessageRender(instanceId: string, sessionId: string, state: SessionStreamingState, messageId: string): void {
  if (state.renderTimers.has(messageId)) return
  state.renderTimers.set(messageId, setTimeout(() => {
    state.renderTimers.delete(messageId)
    renderTrackedMessage(instanceId, sessionId, state, messageId)
  }, RENDER_INTERVAL_MS))
}

export function applyNativeContentDelta(instanceId: string, event: NativeContentDelta): boolean {
  const { sessionID, assistantMessageID, ordinal, delta } = event.data
  if (!instanceId || !event.id || !sessionID || !assistantMessageID || !Number.isInteger(ordinal) || ordinal < 0 || typeof delta !== "string") {
    return false
  }

  const state = getSessionState(instanceId, sessionID)
  if (state.settledMessageIds.has(assistantMessageID) || !markEventSeen(state, event.id)) return false
  const partType = event.type === "session.text.delta" ? "text" : "reasoning"
  const partId = `${assistantMessageID}-${partType}-native-${ordinal}`
  const tracked = state.parts.get(partId) ?? {
    messageId: assistantMessageID,
    partId,
    type: partType,
    ordinal,
    order: typeof event.created === "number" ? event.created : Date.now(),
    text: "",
    createdAt: typeof event.created === "number" ? event.created : Date.now(),
  }
  tracked.text += delta
  state.parts.set(partId, tracked)

  const store = messageStoreBus.getOrCreate(instanceId)
  if (!store.getMessage(assistantMessageID)) renderTrackedMessage(instanceId, sessionID, state, assistantMessageID)
  else scheduleMessageRender(instanceId, sessionID, state, assistantMessageID)
  return true
}

export function reapplyNativeContentDeltas(instanceId: string, sessionId: string): void {
  const state = streamingState.get(instanceId)?.get(sessionId)
  if (!state) return
  const messageIds = new Set([...state.parts.values()].map((part) => part.messageId))
  for (const messageId of messageIds) flushMessage(instanceId, sessionId, state, messageId)
}

function markMessageComplete(instanceId: string, sessionId: string, messageId: string): void {
  const store = messageStoreBus.getOrCreate(instanceId)
  const message = store.getMessage(messageId)
  if (!message || message.status === "complete" || message.status === "error") return
  store.upsertMessage({
    id: message.id,
    sessionId,
    role: "assistant",
    status: "complete",
    createdAt: message.createdAt,
    updatedAt: Date.now(),
  })
}

export function settleNativeContentDeltas(instanceId: string, sessionId: string): void {
  const state = streamingState.get(instanceId)?.get(sessionId)
  if (!state) return
  reapplyNativeContentDeltas(instanceId, sessionId)
  for (const tracked of state.parts.values()) {
    if (!state.settledMessageIds.has(tracked.messageId)) {
      state.settledMessageIds.add(tracked.messageId)
      state.settledMessageOrder.push(tracked.messageId)
    }
    markMessageComplete(instanceId, sessionId, tracked.messageId)
  }
  while (state.settledMessageOrder.length > MAX_SETTLED_MESSAGE_IDS) {
    const expired = state.settledMessageOrder.shift()
    if (!expired) continue
    state.settledMessageIds.delete(expired)
    for (const [partId, tracked] of state.parts) {
      if (tracked.messageId === expired) state.parts.delete(partId)
    }
  }
}

export function reconcileNativeContentAfterSnapshot(instanceId: string, sessionId: string): void {
  const state = streamingState.get(instanceId)?.get(sessionId)
  if (!state) return
  reapplyNativeContentDeltas(instanceId, sessionId)
  for (const messageId of state.settledMessageIds) markMessageComplete(instanceId, sessionId, messageId)
}

export function clearNativeContentDeltaState(instanceId: string, sessionId?: string): void {
  if (!sessionId) {
    const instance = streamingState.get(instanceId)
    for (const state of instance?.values() ?? []) {
      for (const timer of state.renderTimers.values()) clearTimeout(timer)
    }
    streamingState.delete(instanceId)
    return
  }
  const instance = streamingState.get(instanceId)
  const state = instance?.get(sessionId)
  for (const timer of state?.renderTimers.values() ?? []) clearTimeout(timer)
  instance?.delete(sessionId)
  if (instance?.size === 0) streamingState.delete(instanceId)
}

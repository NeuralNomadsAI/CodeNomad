import type { SessionReasoningDelta, SessionTextDelta } from "@opencode-ai/client"
import type { ClientPart, MessageInfo } from "../types/message"
import { messageStoreBus } from "./message-v2/bus"

type NativeContentDelta = SessionTextDelta | SessionReasoningDelta
type TrackedPart = {
  messageId: string
  partId: string
  type: "text" | "reasoning"
  ordinal: number
  text: string
  createdAt: number
}
type SessionStreamingState = {
  seenEventIds: Set<string>
  eventOrder: string[]
  parts: Map<string, TrackedPart>
  settledMessageIds: Set<string>
  settledMessageOrder: string[]
}

const MAX_TRACKED_EVENT_IDS = 20_000
const MAX_SETTLED_MESSAGE_IDS = 100
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
      seenEventIds: new Set(), eventOrder: [], parts: new Map(),
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

function renderTrackedPart(instanceId: string, sessionId: string, tracked: TrackedPart): void {
  const store = messageStoreBus.getOrCreate(instanceId)
  const current = store.getMessage(tracked.messageId)
  const existingPart = current?.parts[tracked.partId]?.data as ClientPart | undefined
  const existingText = existingPart && "text" in existingPart ? existingPart.text : undefined
  if (typeof existingText === "string") {
    const terminalSnapshot = current?.status === "complete" || current?.status === "error"
    if (terminalSnapshot) {
      if (!tracked.text.startsWith(existingText) || existingText.length >= tracked.text.length) tracked.text = existingText
    } else if (existingText.length > tracked.text.length && existingText.startsWith(tracked.text)) {
      tracked.text = existingText
    }
  }

  const part: ClientPart = {
    ...(existingPart ?? {}),
    id: tracked.partId,
    type: tracked.type,
    text: tracked.text,
    sessionID: sessionId,
    messageID: tracked.messageId,
  } as ClientPart
  const parts = (current?.partIds ?? [])
    .filter((partId) => partId !== tracked.partId)
    .map((partId) => current?.parts[partId]?.data)
    .filter((candidate): candidate is ClientPart => Boolean(candidate))
  parts.splice(Math.min(tracked.ordinal, parts.length), 0, part)

  store.addOrUpdateSession({ id: sessionId })
  store.upsertMessage({
    id: tracked.messageId,
    sessionId,
    role: "assistant",
    status: "streaming",
    createdAt: current?.createdAt ?? tracked.createdAt,
    updatedAt: Date.now(),
    parts,
  })
  if (!store.getMessageInfo(tracked.messageId)) {
    const info: MessageInfo = {
      id: tracked.messageId,
      sessionID: sessionId,
      role: "assistant",
      time: { created: tracked.createdAt },
    }
    store.setMessageInfo(tracked.messageId, info)
  }
}

export function applyNativeContentDelta(instanceId: string, event: NativeContentDelta): boolean {
  const { sessionID, assistantMessageID, ordinal, delta } = event.data
  if (!instanceId || !event.id || !sessionID || !assistantMessageID || !Number.isInteger(ordinal) || ordinal < 0 || typeof delta !== "string") {
    return false
  }

  const state = getSessionState(instanceId, sessionID)
  if (!markEventSeen(state, event.id) || state.settledMessageIds.has(assistantMessageID)) return true
  const createdAt = typeof event.created === "number" ? event.created : Date.now()
  const partType = event.type === "session.text.delta" ? "text" : "reasoning"
  const partId = `${assistantMessageID}-${partType}-${ordinal}`
  const tracked = state.parts.get(partId) ?? {
    messageId: assistantMessageID,
    partId,
    type: partType,
    ordinal,
    text: "",
    createdAt,
  }
  tracked.text += delta
  state.parts.set(partId, tracked)
  renderTrackedPart(instanceId, sessionID, tracked)
  return true
}

export function reapplyNativeContentDeltas(instanceId: string, sessionId: string): void {
  const state = streamingState.get(instanceId)?.get(sessionId)
  if (!state) return
  for (const tracked of [...state.parts.values()].sort((a, b) => a.ordinal - b.ordinal)) {
    renderTrackedPart(instanceId, sessionId, tracked)
  }
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
    streamingState.delete(instanceId)
    return
  }
  const instance = streamingState.get(instanceId)
  instance?.delete(sessionId)
  if (instance?.size === 0) streamingState.delete(instanceId)
}

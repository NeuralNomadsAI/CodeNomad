import { createSignal } from "solid-js"
import type { Attachment } from "../types/attachment"

interface SessionAttachmentState {
  values: Attachment[]
  authoritative: boolean
}

const [attachments, setAttachments] = createSignal<Map<string, SessionAttachmentState>>(new Map())

const getSessionKey = (instanceId: string, sessionId: string) => `${instanceId}:${sessionId}`

function setSession(instanceId: string, sessionId: string, state?: SessionAttachmentState) {
  const key = getSessionKey(instanceId, sessionId)
  setAttachments((previous) => {
    const next = new Map(previous)
    if (state) next.set(key, state)
    else next.delete(key)
    return next
  })
}

function getAttachments(instanceId: string, sessionId: string): Attachment[] {
  return attachments().get(getSessionKey(instanceId, sessionId))?.values ?? []
}

function getInstanceEntries(instanceId: string) {
  const prefix = `${instanceId}:`
  return [...attachments()].filter(([key]) => key.startsWith(prefix))
    .map(([key, state]) => [key.slice(prefix.length), state] as const)
}

function getSessionAttachmentsForInstance(instanceId: string): Record<string, Attachment[]> {
  if (!instanceId) return {}
  return Object.fromEntries(
    getInstanceEntries(instanceId)
      .filter(([, state]) => state.values.length > 0)
      .map(([sessionId, state]) => [sessionId, [...state.values]]),
  )
}

function getAuthoritativeAttachmentSessionIdsForInstance(instanceId: string): ReadonlySet<string> {
  if (!instanceId) return new Set()
  return new Set(
    getInstanceEntries(instanceId)
      .filter(([, state]) => state.authoritative)
      .map(([sessionId]) => sessionId),
  )
}

function addAttachment(instanceId: string, sessionId: string, attachment: Attachment) {
  setSession(instanceId, sessionId, {
    values: [...getAttachments(instanceId, sessionId), attachment],
    authoritative: true,
  })
}

function removeAttachment(instanceId: string, sessionId: string, attachmentId: string) {
  setSession(instanceId, sessionId, {
    values: getAttachments(instanceId, sessionId).filter((attachment) => attachment.id !== attachmentId),
    authoritative: true,
  })
}

function clearAttachments(instanceId: string, sessionId: string) {
  setSession(instanceId, sessionId, { values: [], authoritative: true })
}

function deleteSessionAttachments(instanceId: string, sessionId: string) {
  setSession(instanceId, sessionId)
}

function hydrateSessionAttachments(instanceId: string, sessionId: string, values: Attachment[]) {
  setSession(instanceId, sessionId, {
    values: [...values],
    authoritative: attachments().get(getSessionKey(instanceId, sessionId))?.authoritative ?? false,
  })
}

function clearInstanceAttachments(instanceId: string, valuesOnly = false) {
  if (!instanceId) return
  const prefix = `${instanceId}:`
  setAttachments((previous) => {
    const next = new Map(previous)
    for (const [key, state] of next) {
      if (!key.startsWith(prefix)) continue
      if (valuesOnly && state.authoritative) next.set(key, { ...state, values: [] })
      else next.delete(key)
    }
    return next
  })
}

function clearInstanceAttachmentValues(instanceId: string) {
  clearInstanceAttachments(instanceId, true)
}

export {
  getAttachments,
  getSessionAttachmentsForInstance,
  getAuthoritativeAttachmentSessionIdsForInstance,
  addAttachment,
  removeAttachment,
  clearAttachments,
  deleteSessionAttachments,
  hydrateSessionAttachments,
  clearInstanceAttachmentValues,
  clearInstanceAttachments,
}

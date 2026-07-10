import { createSignal } from "solid-js"
import type { Attachment } from "../types/attachment"

const [attachments, setAttachments] = createSignal<Map<string, Attachment[]>>(new Map())
const [authoritativeAttachmentKeys, setAuthoritativeAttachmentKeys] = createSignal<Set<string>>(new Set())

function getSessionKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

function getAttachments(instanceId: string, sessionId: string): Attachment[] {
  const key = getSessionKey(instanceId, sessionId)
  return attachments().get(key) || []
}

function getSessionAttachmentsForInstance(instanceId: string): Record<string, Attachment[]> {
  if (!instanceId) return {}
  const prefix = `${instanceId}:`
  const result: Record<string, Attachment[]> = {}
  for (const [key, value] of attachments()) {
    if (!key.startsWith(prefix) || value.length === 0) continue
    result[key.slice(prefix.length)] = [...value]
  }
  return result
}

function getAuthoritativeAttachmentSessionIdsForInstance(instanceId: string): ReadonlySet<string> {
  if (!instanceId) return new Set()
  const prefix = `${instanceId}:`
  return new Set(
    [...authoritativeAttachmentKeys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  )
}

function markAttachmentsAuthoritative(key: string) {
  setAuthoritativeAttachmentKeys((prev) => {
    if (prev.has(key)) return prev
    const next = new Set(prev)
    next.add(key)
    return next
  })
}

function addAttachment(instanceId: string, sessionId: string, attachment: Attachment) {
  const key = getSessionKey(instanceId, sessionId)
  markAttachmentsAuthoritative(key)
  setAttachments((prev) => {
    const next = new Map(prev)
    const existing = next.get(key) || []
    next.set(key, [...existing, attachment])
    return next
  })
}

function removeAttachment(instanceId: string, sessionId: string, attachmentId: string) {
  const key = getSessionKey(instanceId, sessionId)
  markAttachmentsAuthoritative(key)
  setAttachments((prev) => {
    const next = new Map(prev)
    const existing = next.get(key) || []
    next.set(
      key,
      existing.filter((a) => a.id !== attachmentId),
    )
    return next
  })
}

function clearAttachments(instanceId: string, sessionId: string) {
  const key = getSessionKey(instanceId, sessionId)
  markAttachmentsAuthoritative(key)
  setAttachments((prev) => {
    const next = new Map(prev)
    next.delete(key)
    return next
  })
}

function deleteSessionAttachments(instanceId: string, sessionId: string) {
  const key = getSessionKey(instanceId, sessionId)
  setAttachments((prev) => {
    if (!prev.has(key)) return prev
    const next = new Map(prev)
    next.delete(key)
    return next
  })
  setAuthoritativeAttachmentKeys((prev) => {
    if (!prev.has(key)) return prev
    const next = new Set(prev)
    next.delete(key)
    return next
  })
}

function hydrateSessionAttachments(instanceId: string, sessionId: string, value: Attachment[]) {
  const key = getSessionKey(instanceId, sessionId)
  setAttachments((prev) => {
    const next = new Map(prev)
    if (value.length === 0) {
      next.delete(key)
    } else {
      next.set(key, [...value])
    }
    return next
  })
}

function clearInstanceAttachmentValues(instanceId: string) {
  if (!instanceId) return
  const prefix = `${instanceId}:`
  setAttachments((prev) => {
    const next = new Map(prev)
    let changed = false
    for (const key of next.keys()) {
      if (!key.startsWith(prefix)) continue
      next.delete(key)
      changed = true
    }
    return changed ? next : prev
  })
}

function clearInstanceAttachmentAuthority(instanceId: string) {
  if (!instanceId) return
  const prefix = `${instanceId}:`
  setAuthoritativeAttachmentKeys((prev) => {
    const next = new Set([...prev].filter((key) => !key.startsWith(prefix)))
    return next.size === prev.size ? prev : next
  })
}

function clearInstanceAttachments(instanceId: string) {
  clearInstanceAttachmentValues(instanceId)
  clearInstanceAttachmentAuthority(instanceId)
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

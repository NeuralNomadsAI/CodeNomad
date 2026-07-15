import { createSignal } from "solid-js"
import type { Attachment } from "../types/attachment"

const [attachments, setAttachments] = createSignal<Map<string, Attachment[]>>(new Map())

function getSessionKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

function getAttachments(instanceId: string, sessionId: string): Attachment[] {
  const key = getSessionKey(instanceId, sessionId)
  return attachments().get(key) || []
}

function addAttachment(instanceId: string, sessionId: string, attachment: Attachment) {
  const key = getSessionKey(instanceId, sessionId)
  setAttachments((prev) => {
    const next = new Map(prev)
    const existing = next.get(key) || []
    next.set(key, [...existing, attachment])
    return next
  })
}

function removeAttachment(instanceId: string, sessionId: string, attachmentId: string) {
  const key = getSessionKey(instanceId, sessionId)
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
  setAttachments((prev) => {
    const next = new Map(prev)
    next.delete(key)
    return next
  })
}

export { getAttachments, addAttachment, removeAttachment, clearAttachments }

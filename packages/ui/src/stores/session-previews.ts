import { createSignal } from "solid-js"
import { serverApi } from "../lib/api-client"
import type { PreviewSession } from "../../../server/src/api-types"

interface SessionPreviewRecord extends PreviewSession {
  mode: "preview" | "chat"
}

const [sessionPreviews, setSessionPreviews] = createSignal<Map<string, SessionPreviewRecord>>(new Map())

function getSessionPreview(sessionId: string): SessionPreviewRecord | null {
  return sessionPreviews().get(sessionId) ?? null
}

async function openSessionPreview(sessionId: string, url: string): Promise<SessionPreviewRecord> {
  const existing = sessionPreviews().get(sessionId)
  if (existing) {
    void serverApi.deletePreview(existing.token).catch(() => undefined)
  }

  const preview = await serverApi.createPreview({ sessionId, url })
  const record: SessionPreviewRecord = { ...preview, mode: "preview" }
  setSessionPreviews((prev) => {
    const next = new Map(prev)
    next.set(sessionId, record)
    return next
  })
  return record
}

function showSessionPreview(sessionId: string) {
  setSessionPreviews((prev) => {
    const current = prev.get(sessionId)
    if (!current) return prev
    const next = new Map(prev)
    next.set(sessionId, { ...current, mode: "preview" })
    return next
  })
}

function showSessionChat(sessionId: string) {
  setSessionPreviews((prev) => {
    const current = prev.get(sessionId)
    if (!current) return prev
    const next = new Map(prev)
    next.set(sessionId, { ...current, mode: "chat" })
    return next
  })
}

async function closeSessionPreview(sessionId: string) {
  const current = sessionPreviews().get(sessionId)
  if (!current) return
  setSessionPreviews((prev) => {
    const next = new Map(prev)
    next.delete(sessionId)
    return next
  })
  await serverApi.deletePreview(current.token).catch(() => undefined)
}

export {
  sessionPreviews,
  getSessionPreview,
  openSessionPreview,
  showSessionPreview,
  showSessionChat,
  closeSessionPreview,
}
export type { SessionPreviewRecord }

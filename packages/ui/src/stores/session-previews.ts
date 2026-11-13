import { createSignal } from "solid-js"
import { serverApi } from "../lib/api-client"
import type { PreviewSession } from "../../../server/src/api-types"
import { BrowserHistoryJournal, historyUrl, parseBrowserHistory, type BrowserHistory } from "../lib/browser-history"
import { updateMissionProjectView } from "./mission-view-state"
import { getTabViewState, updateTabViewState, type RestorableTabPreview } from "./tab-view-state"
import { parseLegacySessionPreviews } from "./tab-view-state-codec"
import { onInstanceLifecycleAuthority } from "./instance-lifecycle-authority"

interface SessionPreviewRecord extends PreviewSession {
  mode: "preview" | "chat"
  storageKey: string
  instanceId: string
  history: BrowserHistory
  viewport?: RestorableTabPreview["viewport"]
}
type StoredSessionPreview = RestorableTabPreview
const DEFAULT_PREVIEW_URL = "http://localhost:3000"
const [sessionPreviews, setSessionPreviews] = createSignal<Map<string, SessionPreviewRecord>>(new Map())
const restorePromises = new Map<string, Promise<SessionPreviewRecord | null>>()
const operationVersions = new Map<string, number>()
const closedOccurrences = new Set<string>()

function beginOperation(storageKey: string): number {
  const version = (operationVersions.get(storageKey) ?? 0) + 1
  operationVersions.set(storageKey, version)
  restorePromises.delete(storageKey)
  return version
}

export const parseStoredSessionPreviews = parseLegacySessionPreviews
const previewKey = (sessionId: string, instanceId: string) => JSON.stringify([instanceId, sessionId])
const savedPreview = (sessionId: string, instanceId: string) => getTabViewState(instanceId).previews?.[sessionId]

function storePreview(sessionId: string, instanceId: string, preview: StoredSessionPreview | null) {
  const previews = { ...getTabViewState(instanceId).previews }
  delete previews[sessionId]
  if (preview) previews[sessionId] = { targetUrl: preview.targetUrl, mode: preview.mode,
    ...(preview.history ? { history: preview.history } : {}),
    ...(preview.viewport ? { viewport: preview.viewport } : {}) }
  updateTabViewState(instanceId, { previews })
}

export function getPreviewSessionIds(instanceId: string): string[] {
  return [...sessionPreviews().values()].filter(preview => preview.instanceId === instanceId).map(preview => preview.sessionId)
}

function getSessionPreview(sessionId: string, instanceId: string): SessionPreviewRecord | null {
  return sessionPreviews().get(previewKey(sessionId, instanceId)) ?? null
}

async function openSessionPreview(sessionId: string, url: string, instanceId: string, canPublish?: () => Promise<boolean>): Promise<SessionPreviewRecord> {
  if (closedOccurrences.has(instanceId)) throw new DOMException("Preview occurrence is closed", "AbortError")
  const storageKey = previewKey(sessionId, instanceId)
  const operationVersion = beginOperation(storageKey)
  const existing = sessionPreviews().get(storageKey)
  const saved = savedPreview(sessionId, instanceId)
  const preview = await serverApi.createPreview({ sessionId, url })
  if (canPublish && !await canPublish().catch(() => false)) {
    void serverApi.deletePreview(preview.token).catch(() => undefined)
    throw new Error("Preview open request is no longer current")
  }
  if (operationVersions.get(storageKey) !== operationVersion || closedOccurrences.has(instanceId)) {
    void serverApi.deletePreview(preview.token).catch(() => undefined)
    throw new DOMException("Preview navigation was superseded", "AbortError")
  }
  const record: SessionPreviewRecord = { ...preview, mode: "preview", storageKey, instanceId,
    viewport: existing?.viewport ?? saved?.viewport,
    history: new BrowserHistoryJournal(existing?.history ?? parseBrowserHistory(saved?.history, saved?.targetUrl ?? preview.targetUrl)).visitUrl(preview.targetUrl) }
  setSessionPreviews(previous => new Map(previous).set(storageKey, record))
  storePreview(sessionId, instanceId, record)
  updateMissionProjectView(instanceId, { reader: undefined })
  if (existing) void serverApi.deletePreview(existing.token).catch(() => undefined)
  return record
}

function restoreSessionPreview(sessionId: string, instanceId: string): Promise<SessionPreviewRecord | null> {
  if (closedOccurrences.has(instanceId)) return Promise.reject(new DOMException("Preview occurrence is closed", "AbortError"))
  const storageKey = previewKey(sessionId, instanceId)
  const current = sessionPreviews().get(storageKey)
  if (current) return Promise.resolve(current)
  const stored = savedPreview(sessionId, instanceId)
  if (!stored) return Promise.resolve(null)
  const pending = restorePromises.get(storageKey)
  if (pending) return pending
  const operationVersion = beginOperation(storageKey)
  const restore = serverApi.createPreview({ sessionId, url: stored.targetUrl }).then(preview => {
    if (operationVersions.get(storageKey) !== operationVersion || closedOccurrences.has(instanceId)) {
      void serverApi.deletePreview(preview.token).catch(() => undefined)
      throw new DOMException("Preview navigation was superseded", "AbortError")
    }
    const record: SessionPreviewRecord = { ...preview, mode: stored.mode, storageKey, instanceId,
      viewport: stored.viewport, history: parseBrowserHistory(stored.history, preview.targetUrl) }
    setSessionPreviews(previous => new Map(previous).set(storageKey, record))
    return record
  }).finally(() => {
    if (restorePromises.get(storageKey) === restore) restorePromises.delete(storageKey)
  })
  restorePromises.set(storageKey, restore)
  return restore
}

function showSessionPreview(storageKey: string) {
  const current = sessionPreviews().get(storageKey)
  if (!current) return
  beginOperation(storageKey)
  updateMissionProjectView(current.instanceId, { reader: undefined })
  const next = { ...current, mode: "preview" as const }
  setSessionPreviews(previous => new Map(previous).set(storageKey, next))
  storePreview(current.sessionId, current.instanceId, next)
}

function showSessionChat(storageKey: string) {
  // A reader/chat gesture wins over an earlier browser open or restore.
  beginOperation(storageKey)
  const current = sessionPreviews().get(storageKey)
  if (!current) {
    const [instanceId, sessionId] = JSON.parse(storageKey) as [string, string]
    const stored = savedPreview(sessionId, instanceId)
    if (stored) storePreview(sessionId, instanceId, { ...stored, mode: "chat" })
    return
  }
  const next = { ...current, mode: "chat" as const }
  setSessionPreviews(previous => new Map(previous).set(storageKey, next))
  storePreview(current.sessionId, current.instanceId, next)
}

function showSessionChatFor(sessionId: string, instanceId: string) {
  showSessionChat(previewKey(sessionId, instanceId))
}

function updateSessionPreviewLocation(storageKey: string, targetUrl: string) {
  const current = sessionPreviews().get(storageKey)
  const target = historyUrl(targetUrl)
  if (!current || !target) return
  setSessionPreviews(previous => new Map(previous).set(storageKey, { ...current, targetUrl: target }))
  // History capture persists the committed URL and cursor together.
}

export function updateSessionPreviewHistory(storageKey: string, history: BrowserHistory) {
  const current = sessionPreviews().get(storageKey)
  const targetUrl = historyUrl(history.urls[history.index])
  if (!current || !targetUrl) return
  const next = { ...current, targetUrl, history: parseBrowserHistory(history, targetUrl) }
  setSessionPreviews(previous => new Map(previous).set(storageKey, next))
  storePreview(current.sessionId, current.instanceId, next)
}

export function updateSessionPreviewViewport(storageKey: string, viewport: NonNullable<StoredSessionPreview["viewport"]>) {
  const current = sessionPreviews().get(storageKey)
  if (!current) return
  const next = { ...current, viewport }
  setSessionPreviews(previous => new Map(previous).set(storageKey, next))
  storePreview(current.sessionId, current.instanceId, next)
}

export function cancelSessionPreviewNavigation(storageKey: string) { beginOperation(storageKey) }

async function closeSessionPreview(storageKey: string) {
  beginOperation(storageKey)
  const [instanceId, sessionId] = JSON.parse(storageKey) as [string, string]
  const current = sessionPreviews().get(storageKey)
  storePreview(sessionId, instanceId, null)
  setSessionPreviews(previous => { const next = new Map(previous); next.delete(storageKey); return next })
  if (current) await serverApi.deletePreview(current.token).catch(() => undefined)
}

onInstanceLifecycleAuthority(event => {
  if (event.type === "opened") closedOccurrences.delete(event.instanceId)
  if (event.type !== "removed") return
  closedOccurrences.add(event.instanceId)
  for (const key of operationVersions.keys()) {
    if ((JSON.parse(key) as [string, string])[0] !== event.instanceId) continue
    beginOperation(key)
  }
  const next = new Map(sessionPreviews())
  for (const [key, preview] of next) {
    if (preview.instanceId !== event.instanceId) continue
    next.delete(key)
    void serverApi.deletePreview(preview.token).catch(() => undefined)
  }
  setSessionPreviews(next)
})

export { sessionPreviews, getSessionPreview, openSessionPreview, restoreSessionPreview, updateSessionPreviewLocation,
  showSessionPreview, showSessionChat, showSessionChatFor, closeSessionPreview, DEFAULT_PREVIEW_URL }
export type { SessionPreviewRecord, StoredSessionPreview }

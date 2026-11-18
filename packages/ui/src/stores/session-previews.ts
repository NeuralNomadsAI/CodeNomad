import { createSignal } from "solid-js"
import { serverApi } from "../lib/api-client"
import type { PreviewSession } from "../../../server/src/api-types"
import { BrowserHistoryJournal, historyUrl, parseBrowserHistory, type BrowserHistory } from "../lib/browser-history"
import { applySurface, beginGesture, type SurfaceGesture } from "./session-surface"
import { adoptLegacyTabPreview, getTabViewState, updateTabViewState } from "./tab-view-state"
import type { RestorableBrowserPreview } from "./tab-view-state-codec"
import { savedSessionBrowser, saveSessionBrowser } from "./session-browser-persistence"
import { isInstanceOccurrenceOpen, onInstanceLifecycleAuthority } from "./instance-lifecycle-authority"

interface SessionPreviewRecord extends PreviewSession {
  history: BrowserHistory
  viewport?: RestorableBrowserPreview["viewport"]
}
const DEFAULT_PREVIEW_URL = "http://localhost:3000"
const [sessionPreviews, setSessionPreviews] = createSignal<Map<string, SessionPreviewRecord>>(new Map())
const owners = new Map<string, ReadonlyMap<string, unknown>>()
const restorePromises = new Map<string, Promise<SessionPreviewRecord | null>>()
const operations = new Map<string, SurfaceGesture & { instanceId: string }>()
export const getPendingPreviewOperationCount = () => operations.size

function cancelOperation(sessionId: string) {
  operations.delete(sessionId)
  restorePromises.delete(sessionId)
}
function beginOperation(sessionId: string, instanceId: string, gesture?: SurfaceGesture) {
  const operation = { instanceId, current: () => operations.get(sessionId) === operation
    && isInstanceOccurrenceOpen(instanceId) && (gesture?.current() ?? true) }
  cancelOperation(sessionId)
  operations.set(sessionId, operation)
  return operation
}
function finishOperation(sessionId: string, operation: SurfaceGesture) {
  if (operations.get(sessionId) === operation) operations.delete(sessionId)
}
function storePreview(record: SessionPreviewRecord) {
  saveSessionBrowser(record.sessionId, { targetUrl: record.targetUrl, history: record.history, viewport: record.viewport, mode: "chat" })
}
function getSessionPreview(sessionId: string): SessionPreviewRecord | null {
  return sessionPreviews().get(sessionId) ?? null
}
function savedPreview(sessionId: string, instanceId: string) {
  adoptLegacyTabPreview(instanceId, sessionId)
  const legacy = getTabViewState(instanceId).previews?.[sessionId]
  return savedSessionBrowser(sessionId) ?? (legacy?.targetUrl ? legacy as RestorableBrowserPreview : undefined)
}

async function openSessionPreview(sessionId: string, url: string, instanceId: string, canPublish?: () => Promise<boolean>, intent = beginGesture({ sessionId, instanceId })): Promise<SessionPreviewRecord> {
  if (!isInstanceOccurrenceOpen(instanceId)) throw new DOMException("Preview occurrence is closed", "AbortError")
  const operation = beginOperation(sessionId, instanceId, intent)
  const existing = getSessionPreview(sessionId)
  const saved = savedPreview(sessionId, instanceId)
  try {
    if (!operation.current()) throw new DOMException("Preview navigation was superseded", "AbortError")
    // Showing the same destination reuses its live guest, native history and token.
    const preview = existing?.targetUrl === url ? existing : await serverApi.createPreview({ sessionId, url })
    if (canPublish && !await canPublish().catch(() => false)) {
      if (preview !== existing) void serverApi.deletePreview(preview.token).catch(() => undefined)
      throw new Error("Preview open request is no longer current")
    }
    if (!operation.current()) {
      if (preview !== existing) void serverApi.deletePreview(preview.token).catch(() => undefined)
      throw new DOMException("Preview navigation was superseded", "AbortError")
    }
    const record: SessionPreviewRecord = preview === existing ? existing : { ...preview,
      viewport: existing?.viewport ?? saved?.viewport,
      history: new BrowserHistoryJournal(existing?.history ?? parseBrowserHistory(saved?.history, saved?.targetUrl ?? preview.targetUrl)).visitUrl(preview.targetUrl) }
    setSessionPreviews(previous => new Map(previous).set(sessionId, record))
    storePreview(record)
    showSessionPreview(sessionId, instanceId, operation)
    if (existing && preview !== existing) void serverApi.deletePreview(existing.token).catch(() => undefined)
    return record
  } catch (error) {
    if (!operation.current()) throw new DOMException("Preview navigation was superseded", "AbortError")
    throw error
  } finally { finishOperation(sessionId, operation) }
}

function restoreSessionPreview(sessionId: string, instanceId: string): Promise<SessionPreviewRecord | null> {
  if (!isInstanceOccurrenceOpen(instanceId)) return Promise.reject(new DOMException("Preview occurrence is closed", "AbortError"))
  const current = getSessionPreview(sessionId)
  if (current) return Promise.resolve(current)
  const stored = savedPreview(sessionId, instanceId)
  if (!stored) return Promise.resolve(null)
  const operationInProgress = operations.get(sessionId)
  const ownOperation = operationInProgress?.instanceId === instanceId && operationInProgress.current()
  const pending = ownOperation ? restorePromises.get(sessionId) : undefined
  if (pending) return pending
  if (ownOperation) return Promise.resolve(null)
  const operation = beginOperation(sessionId, instanceId)
  const restore = serverApi.createPreview({ sessionId, url: stored.targetUrl }).then(preview => {
    if (!operation.current()) {
      void serverApi.deletePreview(preview.token).catch(() => undefined)
      throw new DOMException("Preview navigation was superseded", "AbortError")
    }
    const record: SessionPreviewRecord = { ...preview,
      viewport: stored.viewport, history: parseBrowserHistory(stored.history, preview.targetUrl) }
    setSessionPreviews(previous => new Map(previous).set(sessionId, record))
    return record
  }).catch(error => {
    if (!operation.current()) throw new DOMException("Preview navigation was superseded", "AbortError")
    throw error
  }).finally(() => {
    finishOperation(sessionId, operation)
    if (restorePromises.get(sessionId) === restore) restorePromises.delete(sessionId)
  })
  restorePromises.set(sessionId, restore)
  return restore
}

function showSessionPreview(sessionId: string, instanceId: string, intent?: SurfaceGesture) {
  if (intent && !intent.current() || !getSessionPreview(sessionId)) return
  const previews = getTabViewState(instanceId).previews
  if (!previews?.[sessionId]) updateTabViewState(instanceId, { previews: { ...previews, [sessionId]: { mode: "chat" } } })
  applySurface({ instanceId, sessionId }, { kind: "web", sessionId }, intent)
}
function showSessionChatFor(sessionId: string, instanceId: string) {
  if (operations.get(sessionId)?.instanceId === instanceId) cancelOperation(sessionId)
  applySurface({ instanceId, sessionId }, { kind: "conversation" })
}
function updateSessionPreviewLocation(sessionId: string, targetUrl: string) {
  const current = getSessionPreview(sessionId), target = historyUrl(targetUrl)
  if (current && target) setSessionPreviews(previous => new Map(previous).set(sessionId, { ...current, targetUrl: target }))
}
export function updateSessionPreviewHistory(sessionId: string, history: BrowserHistory) {
  const current = getSessionPreview(sessionId), targetUrl = historyUrl(history.urls[history.index])
  if (!current || !targetUrl) return
  const next = { ...current, targetUrl, history: parseBrowserHistory(history, targetUrl) }
  setSessionPreviews(previous => new Map(previous).set(sessionId, next))
  storePreview(next)
}
export function updateSessionPreviewViewport(sessionId: string, viewport: NonNullable<RestorableBrowserPreview["viewport"]>) {
  const current = getSessionPreview(sessionId)
  if (!current) return
  const next = { ...current, viewport }
  setSessionPreviews(previous => new Map(previous).set(sessionId, next))
  storePreview(next)
}
export function cancelSessionPreviewNavigation(sessionId: string) { cancelOperation(sessionId) }
async function closeSessionPreview(sessionId: string) {
  cancelOperation(sessionId)
  const current = getSessionPreview(sessionId)
  setSessionPreviews(previous => { const next = new Map(previous); next.delete(sessionId); return next })
  if (current) await serverApi.deletePreview(current.token).catch(() => undefined)
}

export function setPreviewSessionOwners(instanceId: string, sessions: ReadonlyMap<string, unknown>) {
  owners.set(instanceId, sessions)
}
onInstanceLifecycleAuthority(event => {
  if (event.type === "opened") return
  for (const [id, operation] of operations) if (operation.instanceId === event.instanceId) cancelOperation(id)
  if (event.type !== "removed") return
  owners.delete(event.instanceId)
  for (const id of sessionPreviews().keys()) if (![...owners.values()].some(ids => ids.has(id))) void closeSessionPreview(id)
})

export { sessionPreviews, getSessionPreview, openSessionPreview, restoreSessionPreview, updateSessionPreviewLocation,
  showSessionPreview, showSessionChatFor, closeSessionPreview, DEFAULT_PREVIEW_URL }
export type { SessionPreviewRecord }

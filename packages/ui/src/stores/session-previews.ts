import { createSignal } from "solid-js"
import { serverApi } from "../lib/api-client"
import type { PreviewSession } from "../../../server/src/api-types"
import { BrowserHistoryJournal, historyUrl, parseBrowserHistory, type BrowserHistory } from "../lib/browser-history"
import { activateSessionSurface, captureSessionSurfaceIntent, getSessionSurface, invalidateSessionSurfaceIntent } from "./session-surface"
import { activeSessionId } from "./session-selection-state"
import { adoptLegacyTabPreview, getTabViewState, updateTabViewState, type RestorableTabPreview } from "./tab-view-state"
import { parseLegacySessionPreviews } from "./tab-view-state-codec"
import { isInstanceOccurrenceOpen, onInstanceLifecycleAuthority } from "./instance-lifecycle-authority"

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
// Only pending requests need a fence. Object identity prevents ABA after cleanup.
type PreviewOperation = ReturnType<typeof captureSessionSurfaceIntent>
const operations = new Map<string, PreviewOperation>()

function cancelOperation(storageKey: string) {
  operations.get(storageKey)?.release()
  operations.delete(storageKey)
  restorePromises.delete(storageKey)
}
function beginOperation(storageKey: string, sessionId: string, instanceId: string, intent?: PreviewOperation): PreviewOperation {
  cancelOperation(storageKey)
  const operation = intent ?? captureSessionSurfaceIntent({ sessionId, instanceId })
  operations.set(storageKey, operation)
  return operation
}
function finishOperation(storageKey: string, operation: PreviewOperation) {
  operation.release()
  if (operations.get(storageKey) === operation) operations.delete(storageKey)
}
export const getPendingPreviewOperationCount = () => operations.size

export const parseStoredSessionPreviews = parseLegacySessionPreviews
const previewKey = (sessionId: string, instanceId: string) => JSON.stringify([instanceId, sessionId])
const savedPreview = (sessionId: string, instanceId: string) => getTabViewState(instanceId).previews?.[sessionId]

function withLiveMode(record: SessionPreviewRecord): SessionPreviewRecord {
  return Object.defineProperty(record, "mode", { enumerable: true, configurable: true,
    get: () => savedPreview(record.sessionId, record.instanceId)?.mode ?? "chat" })
}

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

async function createPreview(sessionId: string, url: string, instanceId: string, storageKey: string, version: PreviewOperation) {
  try { return await serverApi.createPreview({ sessionId, url }) }
  catch (error) {
    if (!version.current() || operations.get(storageKey) !== version) {
      throw new DOMException("Preview navigation was superseded", "AbortError")
    }
    throw error
  }
}

async function openSessionPreview(sessionId: string, url: string, instanceId: string, canPublish?: () => Promise<boolean>, intent?: PreviewOperation): Promise<SessionPreviewRecord> {
  if (!isInstanceOccurrenceOpen(instanceId)) throw new DOMException("Preview occurrence is closed", "AbortError")
  const storageKey = previewKey(sessionId, instanceId)
  const operationVersion = beginOperation(storageKey, sessionId, instanceId, intent)
  const existing = sessionPreviews().get(storageKey)
  const saved = savedPreview(sessionId, instanceId)
  try {
    if (!operationVersion.current()) throw new DOMException("Preview navigation was superseded", "AbortError")
    const preview = await createPreview(sessionId, url, instanceId, storageKey, operationVersion)
    if (canPublish && !await canPublish().catch(() => false)) {
      void serverApi.deletePreview(preview.token).catch(() => undefined)
      throw new Error("Preview open request is no longer current")
    }
    if (operations.get(storageKey) !== operationVersion || !operationVersion.current()) {
      void serverApi.deletePreview(preview.token).catch(() => undefined)
      throw new DOMException("Preview navigation was superseded", "AbortError")
    }
    const record: SessionPreviewRecord = { ...preview, mode: "preview", storageKey, instanceId,
      viewport: existing?.viewport ?? saved?.viewport,
      history: new BrowserHistoryJournal(existing?.history ?? parseBrowserHistory(saved?.history, saved?.targetUrl ?? preview.targetUrl)).visitUrl(preview.targetUrl) }
    setSessionPreviews(previous => new Map(previous).set(storageKey, withLiveMode(record)))
    storePreview(sessionId, instanceId, { ...record, mode: "preview" })
    activateSessionSurface({ sessionId, instanceId }, { kind: "web", sessionId })
    if (existing) void serverApi.deletePreview(existing.token).catch(() => undefined)
    return record
  } finally { finishOperation(storageKey, operationVersion) }
}

function restoreSessionPreview(sessionId: string, instanceId: string): Promise<SessionPreviewRecord | null> {
  if (!isInstanceOccurrenceOpen(instanceId)) return Promise.reject(new DOMException("Preview occurrence is closed", "AbortError"))
  const storageKey = previewKey(sessionId, instanceId)
  const current = sessionPreviews().get(storageKey)
  if (current) return Promise.resolve(current)
  adoptLegacyTabPreview(instanceId, sessionId)
  const stored = savedPreview(sessionId, instanceId)
  if (!stored) return Promise.resolve(null)
  const pending = operations.get(storageKey)?.current() ? restorePromises.get(storageKey) : undefined
  if (pending) return pending
  const operationVersion = beginOperation(storageKey, sessionId, instanceId)
  const restore = createPreview(sessionId, stored.targetUrl, instanceId, storageKey, operationVersion).then(preview => {
    if (operations.get(storageKey) !== operationVersion || !operationVersion.current()) {
      void serverApi.deletePreview(preview.token).catch(() => undefined)
      throw new DOMException("Preview navigation was superseded", "AbortError")
    }
    const record: SessionPreviewRecord = { ...preview, mode: stored.mode, storageKey, instanceId,
      viewport: stored.viewport, history: parseBrowserHistory(stored.history, preview.targetUrl) }
    setSessionPreviews(previous => new Map(previous).set(storageKey, withLiveMode(record)))
    return record
  }).finally(() => {
    finishOperation(storageKey, operationVersion)
    if (restorePromises.get(storageKey) === restore) restorePromises.delete(storageKey)
  })
  restorePromises.set(storageKey, restore)
  return restore
}

function showSessionPreview(storageKey: string) {
  const current = sessionPreviews().get(storageKey)
  if (!current) return
  cancelOperation(storageKey)
  activateSessionSurface(current, { kind: "web", sessionId: current.sessionId })
}

function showSessionChat(storageKey: string) {
  // A reader/chat gesture wins over an earlier browser open or restore.
  cancelOperation(storageKey)
  const [instanceId, sessionId] = JSON.parse(storageKey) as [string, string]
  activateSessionSurface({ instanceId, sessionId }, { kind: "conversation" })
}

function showSessionChatFor(sessionId: string, instanceId: string) {
  showSessionChat(previewKey(sessionId, instanceId))
}

function updateSessionPreviewLocation(storageKey: string, targetUrl: string) {
  const current = sessionPreviews().get(storageKey)
  const target = historyUrl(targetUrl)
  if (!current || !target) return
  if (isForegroundPreview(current) && target !== current.targetUrl) invalidateSessionSurfaceIntent(current.instanceId)
  setSessionPreviews(previous => new Map(previous).set(storageKey, withLiveMode({ ...current, targetUrl: target })))
  // History capture persists the committed URL and cursor together.
}

function isForegroundPreview(preview: SessionPreviewRecord): boolean {
  const surface = getSessionSurface({ instanceId: preview.instanceId, sessionId: activeSessionId().get(preview.instanceId) ?? null })
  return surface.kind === "web" && surface.sessionId === preview.sessionId
}

export function updateSessionPreviewHistory(storageKey: string, history: BrowserHistory) {
  const current = sessionPreviews().get(storageKey)
  const targetUrl = historyUrl(history.urls[history.index])
  if (!current || !targetUrl) return
  if (isForegroundPreview(current) && (current.history.index !== history.index || current.history.urls.length !== history.urls.length
    || current.history.urls.some((url, index) => url !== history.urls[index]))) invalidateSessionSurfaceIntent(current.instanceId)
  const next = withLiveMode({ ...current, targetUrl, history: parseBrowserHistory(history, targetUrl) })
  setSessionPreviews(previous => new Map(previous).set(storageKey, next))
  storePreview(current.sessionId, current.instanceId, next)
}

export function updateSessionPreviewViewport(storageKey: string, viewport: NonNullable<StoredSessionPreview["viewport"]>) {
  const current = sessionPreviews().get(storageKey)
  if (!current) return
  const next = withLiveMode({ ...current, viewport })
  setSessionPreviews(previous => new Map(previous).set(storageKey, next))
  storePreview(current.sessionId, current.instanceId, next)
}

export function cancelSessionPreviewNavigation(storageKey: string) { cancelOperation(storageKey) }

async function closeSessionPreview(storageKey: string) {
  cancelOperation(storageKey)
  const [instanceId, sessionId] = JSON.parse(storageKey) as [string, string]
  const current = sessionPreviews().get(storageKey)
  storePreview(sessionId, instanceId, null)
  setSessionPreviews(previous => { const next = new Map(previous); next.delete(storageKey); return next })
  if (current) await serverApi.deletePreview(current.token).catch(() => undefined)
}

onInstanceLifecycleAuthority(event => {
  if (event.type === "opened") return
  for (const key of operations.keys()) {
    if ((JSON.parse(key) as [string, string])[0] !== event.instanceId) continue
    cancelOperation(key)
  }
  if (event.type !== "removed") return
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

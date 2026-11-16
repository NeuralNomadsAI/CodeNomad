import { createSignal } from "solid-js"
import { backendOf, type BackendClient } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { tGlobal } from "../lib/i18n"
import type { PreviewSession } from "../../../server/src/api-types"
import { BrowserHistoryJournal, historyUrl, parseBrowserHistory, type BrowserHistory } from "../lib/browser-history"
import { remotePreviewContent, remotePreviewSource } from "../lib/remote-preview-address"
import { applySurface, beginGesture, type SurfaceGesture } from "./session-surface"
import { adoptLegacyTabPreview, getTabViewState, updateTabViewState, type RestorableTabPreview } from "./tab-view-state"
import { parseLegacySessionPreviews } from "./tab-view-state-codec"
import { isInstanceOccurrenceOpen, onInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { onInstanceTabDetached } from "./app-tab-membership"

interface SessionPreviewRecord extends PreviewSession {
  capability?: string
  contentUrl?: string
  mode: "preview" | "chat"
  storageKey: string
  instanceId: string
  owner: { client: BackendClient; signal: AbortSignal }
  history: BrowserHistory
  viewport?: RestorableTabPreview["viewport"]
}
type StoredSessionPreview = RestorableTabPreview
const DEFAULT_PREVIEW_URL = "http://localhost:3000"
const [sessionPreviews, setSessionPreviews] = createSignal<Map<string, SessionPreviewRecord>>(new Map())
const restorePromises = new Map<string, Promise<SessionPreviewRecord | null>>()
type PreviewOperation = SurfaceGesture & { client: BackendClient; signal: AbortSignal }
const operations = new Map<string, PreviewOperation>()
const previewRevocations = new Map<string, () => void>()

function cancelOperation(storageKey: string) {
  operations.delete(storageKey)
  restorePromises.delete(storageKey)
}
function beginOperation(storageKey: string, sessionId: string, instanceId: string, intent?: SurfaceGesture, passive = false): PreviewOperation {
  const owner = captureBackendOperation(instanceId)
  const client = backendOf(instanceId)
  const gesture = passive ? undefined : intent ?? beginGesture({ sessionId, instanceId })
  const operation: PreviewOperation = {
    client, signal: owner.signal,
    current: () => operations.get(storageKey) === operation && owner.current()
      && isInstanceOccurrenceOpen(instanceId) && (gesture?.current() ?? true),
  }
  cancelOperation(storageKey)
  operations.set(storageKey, operation)
  return operation
}
function finishOperation(storageKey: string, operation: PreviewOperation) {
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

function releasePreview(client: BackendClient, preview: PreviewSession & { capability?: string }, keepalive = false) {
  return (preview.capability ? client.api.deletePreviewCapability(preview.capability, keepalive) : client.api.deletePreview(preview.token))
    .catch(() => undefined)
}

function removeLivePreview(storageKey: string, keepalive = false) {
  previewRevocations.get(storageKey)?.()
  previewRevocations.delete(storageKey)
  const record = sessionPreviews().get(storageKey)
  setSessionPreviews(previous => { const next = new Map(previous); next.delete(storageKey); return next })
  if (record) return releasePreview(record.owner.client, record, keepalive)
}

/** Retain saved logical history while releasing a remote guest's live authority. */
export function dismissSessionPreview(storageKey: string, keepalive = false) {
  const record = sessionPreviews().get(storageKey)
  if (!record?.capability) { showSessionChat(storageKey); return }
  showSessionChat(storageKey)
  void removeLivePreview(storageKey, keepalive)
}

function publishPreview(record: SessionPreviewRecord) {
  previewRevocations.get(record.storageKey)?.()
  const revoke = () => {
    cancelOperation(record.storageKey)
    void removeLivePreview(record.storageKey)
  }
  record.owner.signal.addEventListener("abort", revoke, { once: true })
  previewRevocations.set(record.storageKey, () => record.owner.signal.removeEventListener("abort", revoke))
  setSessionPreviews(previous => new Map(previous).set(record.storageKey, withLiveMode(record)))
}

export function getPreviewSessionIds(instanceId: string): string[] {
  return [...sessionPreviews().values()].filter(preview => preview.instanceId === instanceId && !preview.owner.signal.aborted).map(preview => preview.sessionId)
}

function getSessionPreview(sessionId: string, instanceId: string): SessionPreviewRecord | null {
  const preview = sessionPreviews().get(previewKey(sessionId, instanceId))
  return preview && !preview.owner.signal.aborted ? preview : null
}

async function createPreview(sessionId: string, url: string, version: PreviewOperation) {
  try {
    if (version.client.id === "local") return await version.client.api.createPreview({ sessionId, url })
    if (new URL(url).hostname.endsWith(".preview.localhost")) throw new TypeError(tGlobal("sessionPreview.open.invalidUrl"))
    const preview = await version.client.api.createPreviewCapability({ sessionId, url })
    try {
      if (!remotePreviewContent(preview) || preview.sessionId !== sessionId || !remotePreviewSource(preview, preview.targetUrl)) throw new TypeError()
      return preview
    } catch {
      await releasePreview(version.client, preview)
      throw new TypeError(tGlobal("sessionPreview.open.invalidUrl"))
    }
  } catch (error) {
    if (!version.current()) throw new DOMException("Preview navigation was superseded", "AbortError")
    throw error
  }
}

async function openSessionPreview(sessionId: string, url: string, instanceId: string, canPublish?: () => Promise<boolean>, intent?: SurfaceGesture): Promise<SessionPreviewRecord> {
  if (!isInstanceOccurrenceOpen(instanceId)) throw new DOMException("Preview occurrence is closed", "AbortError")
  if (!historyUrl(url)) throw new TypeError(tGlobal("sessionPreview.open.invalidUrl"))
  const storageKey = previewKey(sessionId, instanceId)
  const operation = beginOperation(storageKey, sessionId, instanceId, intent)
  const existing = sessionPreviews().get(storageKey)
  const saved = savedPreview(sessionId, instanceId)
  try {
    if (!operation.current()) throw new DOMException("Preview navigation was superseded", "AbortError")
    const preview = await createPreview(sessionId, url, operation)
    if (canPublish && !await canPublish().catch(() => false)) {
      void releasePreview(operation.client, preview)
      throw new Error("Preview open request is no longer current")
    }
    if (!operation.current()) {
      void releasePreview(operation.client, preview)
      throw new DOMException("Preview navigation was superseded", "AbortError")
    }
    const record: SessionPreviewRecord = { ...preview, sessionId, mode: "preview", storageKey, instanceId,
      owner: { client: operation.client, signal: operation.signal }, viewport: existing?.viewport ?? saved?.viewport,
      history: new BrowserHistoryJournal(existing?.history ?? parseBrowserHistory(saved?.history, saved?.targetUrl ?? preview.targetUrl)).visitUrl(preview.targetUrl) }
    publishPreview(record)
    storePreview(sessionId, instanceId, { ...record, mode: "preview" })
    applySurface({ sessionId, instanceId }, { kind: "web", sessionId }, operation)
    if (existing) void releasePreview(existing.owner.client, existing)
    return record
  } finally { finishOperation(storageKey, operation) }
}

function restoreSessionPreview(sessionId: string, instanceId: string): Promise<SessionPreviewRecord | null> {
  if (!isInstanceOccurrenceOpen(instanceId)) return Promise.reject(new DOMException("Preview occurrence is closed", "AbortError"))
  const storageKey = previewKey(sessionId, instanceId)
  const current = getSessionPreview(sessionId, instanceId)
  if (current) return Promise.resolve(current)
  adoptLegacyTabPreview(instanceId, sessionId)
  const stored = savedPreview(sessionId, instanceId)
  if (!stored) return Promise.resolve(null)
  const pending = operations.get(storageKey)?.current() ? restorePromises.get(storageKey) : undefined
  if (pending) return pending
  if (operations.get(storageKey)?.current()) return Promise.resolve(null)
  const operation = beginOperation(storageKey, sessionId, instanceId, undefined, true)
  const restore = createPreview(sessionId, stored.targetUrl, operation).then(preview => {
    if (!operation.current()) {
      void releasePreview(operation.client, preview)
      throw new DOMException("Preview navigation was superseded", "AbortError")
    }
    const record: SessionPreviewRecord = { ...preview, sessionId, mode: stored.mode, storageKey, instanceId,
      owner: { client: operation.client, signal: operation.signal },
      viewport: stored.viewport, history: parseBrowserHistory(stored.history, preview.targetUrl) }
    publishPreview(record)
    return record
  }).finally(() => {
    finishOperation(storageKey, operation)
    if (restorePromises.get(storageKey) === restore) restorePromises.delete(storageKey)
  })
  restorePromises.set(storageKey, restore)
  return restore
}

function showSessionPreview(storageKey: string, intent?: SurfaceGesture) {
  if (intent && !intent.current()) return
  const current = sessionPreviews().get(storageKey)
  if (!current || current.owner.signal.aborted) return
  cancelOperation(storageKey)
  applySurface(current, { kind: "web", sessionId: current.sessionId }, intent)
}

function showSessionChat(storageKey: string) {
  const [instanceId, sessionId] = JSON.parse(storageKey) as [string, string]
  cancelOperation(storageKey)
  applySurface({ instanceId, sessionId }, { kind: "conversation" })
}

function showSessionChatFor(sessionId: string, instanceId: string) {
  showSessionChat(previewKey(sessionId, instanceId))
}

function updateSessionPreviewLocation(storageKey: string, targetUrl: string) {
  const current = sessionPreviews().get(storageKey)
  const target = historyUrl(targetUrl)
  if (!current || current.owner.signal.aborted || !target) return
  if (current.capability && new URL(target).hostname.endsWith(".preview.localhost")) return
  setSessionPreviews(previous => new Map(previous).set(storageKey, withLiveMode({ ...current, targetUrl: target })))
  // History capture persists the committed URL and cursor together.
}

export function updateSessionPreviewHistory(storageKey: string, history: BrowserHistory) {
  const current = sessionPreviews().get(storageKey)
  const targetUrl = historyUrl(history.urls[history.index])
  if (!current || current.owner.signal.aborted || !targetUrl) return
  if (current.capability && history.urls.some(url => !historyUrl(url) || new URL(url).hostname.endsWith(".preview.localhost"))) return
  const next = withLiveMode({ ...current, targetUrl, history: parseBrowserHistory(history, targetUrl) })
  setSessionPreviews(previous => new Map(previous).set(storageKey, next))
  storePreview(current.sessionId, current.instanceId, next)
}

export function updateSessionPreviewViewport(storageKey: string, viewport: NonNullable<StoredSessionPreview["viewport"]>) {
  const current = sessionPreviews().get(storageKey)
  if (!current || current.owner.signal.aborted) return
  const next = withLiveMode({ ...current, viewport })
  setSessionPreviews(previous => new Map(previous).set(storageKey, next))
  storePreview(current.sessionId, current.instanceId, next)
}

export function cancelSessionPreviewNavigation(storageKey: string) { cancelOperation(storageKey) }

async function closeSessionPreview(storageKey: string) {
  cancelOperation(storageKey)
  const [instanceId, sessionId] = JSON.parse(storageKey) as [string, string]
  storePreview(sessionId, instanceId, null)
  await removeLivePreview(storageKey)
}

onInstanceLifecycleAuthority(event => {
  if (event.type === "opened") return
  for (const key of operations.keys()) {
    if ((JSON.parse(key) as [string, string])[0] === event.instanceId) cancelOperation(key)
  }
  for (const preview of sessionPreviews().values()) {
    if (preview.instanceId === event.instanceId && (event.type === "removed" || preview.capability))
      void removeLivePreview(preview.storageKey)
  }
})

onInstanceTabDetached(instanceId => {
  for (const key of operations.keys()) {
    const operation = operations.get(key)!
    if ((JSON.parse(key) as [string, string])[0] === instanceId && operation.client.id !== "local") cancelOperation(key)
  }
  for (const record of sessionPreviews().values())
    if (record.instanceId === instanceId && record.capability) dismissSessionPreview(record.storageKey)
})
if (typeof window !== "undefined") window.addEventListener("pagehide", () => {
  for (const [key, operation] of operations) if (operation.client.id !== "local") cancelOperation(key)
  for (const record of sessionPreviews().values()) if (record.capability) dismissSessionPreview(record.storageKey, true)
})

export { sessionPreviews, getSessionPreview, openSessionPreview, restoreSessionPreview, updateSessionPreviewLocation,
  showSessionPreview, showSessionChat, showSessionChatFor, closeSessionPreview, DEFAULT_PREVIEW_URL }
export type { SessionPreviewRecord, StoredSessionPreview }

import { createSignal, untrack } from "solid-js"
import { backendOf, type BackendClient } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { tGlobal } from "../lib/i18n"
import type { PreviewSession } from "../../../server/src/api-types"
import { BrowserHistoryJournal, browserAddress, historyUrl, parseBrowserHistory, type BrowserHistory } from "../lib/browser-history"
import { remotePreviewContent, remotePreviewSource } from "../lib/remote-preview-address"
import { applySurface, beginGesture, getSessionSurface, onSurfaceGesture, type SurfaceGesture } from "./session-surface"
import { releaseNativeBrowserOpen } from "../lib/native/browser"
import { adoptLegacyTabPreview, getTabViewState, updateTabViewState } from "./tab-view-state"
import type { RestorableTabPreview } from "./tab-view-state-codec"
import { isInstanceOccurrenceOpen, onInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { onInstanceTabDetached } from "./app-tab-membership"
import { parseInstanceKey } from "../lib/backend-identity"
import { savedSessionBrowser, saveSessionBrowser } from "./session-browser-persistence"

interface SessionPreviewRecord extends PreviewSession {
  capability?: string
  contentUrl?: string
  mode: "preview" | "chat"
  storageKey: string
  instanceId: string
  owner: { client: BackendClient; signal: AbortSignal }
  history: BrowserHistory
  viewport?: RestorableTabPreview["viewport"]
  nativeOpen?: { requestID: string; instanceId: string; current: () => boolean; created?: boolean; observedAddress?: string }
}
type StoredSessionPreview = RestorableTabPreview
const DEFAULT_PREVIEW_URL = "http://localhost:3000"
const [sessionPreviews, setSessionPreviews] = createSignal<Map<string, SessionPreviewRecord>>(new Map())
const restorePromises = new Map<string, Promise<SessionPreviewRecord | null>>()
type PreviewOperation = SurfaceGesture & { client: BackendClient; signal: AbortSignal; instanceId: string }
const operations = new Map<string, PreviewOperation>()
const previewRevocations = new Map<string, () => void>()
const localOwners = new Map<string, ReadonlyMap<string, unknown>>()

function cancelOperation(storageKey: string) {
  operations.delete(storageKey)
  restorePromises.delete(storageKey)
}
function beginOperation(storageKey: string, sessionId: string, instanceId: string, intent?: SurfaceGesture, passive = false): PreviewOperation {
  const owner = captureBackendOperation(instanceId)
  const client = backendOf(instanceId)
  const gesture = passive ? undefined : intent ?? beginGesture({ sessionId, instanceId })
  const operation: PreviewOperation = {
    client, signal: owner.signal, instanceId,
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

const local = (instanceId: string) => parseInstanceKey(instanceId).backendId === "local"
export const previewKey = (sessionId: string, instanceId: string) => local(instanceId) ? sessionId : JSON.stringify([instanceId, sessionId])
const tabPreview = (sessionId: string, instanceId: string) => getTabViewState(instanceId).previews?.[sessionId]
const savedPreview = (sessionId: string, instanceId: string) =>
  (local(instanceId) ? savedSessionBrowser(sessionId) : undefined) ?? tabPreview(sessionId, instanceId)

function withLiveMode(record: SessionPreviewRecord): SessionPreviewRecord {
  return Object.defineProperty(record, "mode", { enumerable: true, configurable: true,
    get: () => tabPreview(record.sessionId, record.instanceId)?.mode ?? "chat" })
}

function storePreview(sessionId: string, instanceId: string, preview: StoredSessionPreview | null) {
  const previews = { ...getTabViewState(instanceId).previews }
  if (preview?.targetUrl && local(instanceId)) {
    const url = historyUrl(preview.targetUrl) ?? historyUrl(preview.history?.urls[preview.history.index])
    if (url) saveSessionBrowser(sessionId, { ...preview, targetUrl: url, mode: "chat" })
    if (previews[sessionId]) return
  }
  delete previews[sessionId]
  if (preview) previews[sessionId] = local(instanceId) ? { mode: preview.mode } : { targetUrl: preview.targetUrl, mode: preview.mode,
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

export function settleSessionPreviewOpen(sessionId: string, instanceId: string, requestID: string, committedUrl?: string | null,
  keepGuest?: boolean, successorUrl?: string | null) {
  const record = getSessionPreview(sessionId, instanceId)
  const request = record?.nativeOpen
  if (!record || request?.requestID !== requestID || request.instanceId !== instanceId) return
  const confirmed = request.current() ? browserAddress(committedUrl) : undefined
  if (!confirmed && request.created && !keepGuest) {
    applySurface({ sessionId, instanceId }, { kind: "conversation" }, request)
    void removeLivePreview(record.storageKey)
    return
  }
  const next = { ...record, nativeOpen: undefined }
  const successor = keepGuest ? browserAddress(successorUrl) : undefined
  // A native start alone is not a commit; require the retained guest's location event.
  const committed = confirmed ?? (successor === request.observedAddress ? successor : undefined)
  if (committed) {
    next.targetUrl = request.observedAddress ?? committed
    const savedUrl = historyUrl(committed)
    if (savedUrl) {
      next.history = { ...new BrowserHistoryJournal(record.history).visitUrl(savedUrl) }
      storePreview(sessionId, instanceId, { ...next, targetUrl: savedUrl })
    }
  }
  publishPreview(next)
}

const openRetirements = new WeakMap<NonNullable<SessionPreviewRecord["nativeOpen"]>, Promise<boolean>>()
export function retireSessionPreviewOpen(request: NonNullable<SessionPreviewRecord["nativeOpen"]>, keepGuest?: boolean) {
  const existing = openRetirements.get(request)
  if (existing) return existing
  const retirement = releaseNativeBrowserOpen(request.requestID, keepGuest)
  openRetirements.set(request, retirement)
  return retirement
}

export function startSessionPreviewNavigation(sessionId: string, instanceId: string): Promise<boolean> | undefined {
  const request = getSessionPreview(sessionId, instanceId)?.nativeOpen
  const retirement = request?.instanceId === instanceId && retireSessionPreviewOpen(request, true).then(released => {
    if (released) settleSessionPreviewOpen(sessionId, instanceId, request.requestID, undefined, true)
    return released
  })
  beginGesture({ sessionId, instanceId })
  return retirement || undefined
}

onSurfaceGesture(instanceId => {
  for (const record of untrack(sessionPreviews).values()) {
    const request = record.nativeOpen
    if (request?.instanceId === instanceId && !request.current()) {
      void retireSessionPreviewOpen(request).catch(() => {})
    }
  }
})

/** Retain saved logical history while releasing a remote guest's live authority. */
export function dismissSessionPreview(storageKey: string, keepalive = false) {
  const record = sessionPreviews().get(storageKey)
  if (!record) return
  showSessionChatFor(record.sessionId, record.instanceId)
  if (record.capability) void removeLivePreview(storageKey, keepalive)
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

function getSessionPreview(sessionId: string, instanceId = ""): SessionPreviewRecord | null {
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

async function openSessionPreview(sessionId: string, url: string, instanceId: string, canPublish?: () => Promise<boolean>, intent?: SurfaceGesture,
  nativeOpen?: NonNullable<SessionPreviewRecord["nativeOpen"]>): Promise<SessionPreviewRecord> {
  if (!isInstanceOccurrenceOpen(instanceId)) throw new DOMException("Preview occurrence is closed", "AbortError")
  if (!(local(instanceId) ? browserAddress(url) : historyUrl(url))) throw new TypeError(tGlobal("sessionPreview.open.invalidUrl"))
  const surfaceAvailable = () => {
    if (!nativeOpen) return true
    const surface = getSessionSurface({ instanceId, sessionId: null })
    return surface.kind !== "file" && surface.kind !== "mission"
  }
  if (!surfaceAvailable()) throw new DOMException("Close the file or Mission reader before opening a preview", "AbortError")
  const storageKey = previewKey(sessionId, instanceId)
  const operation = beginOperation(storageKey, sessionId, instanceId, intent)
  const existing = sessionPreviews().get(storageKey)
  const saved = savedPreview(sessionId, instanceId)
  try {
    if (!operation.current()) throw new DOMException("Preview navigation was superseded", "AbortError")
    const preview = existing && (nativeOpen || (!existing.nativeOpen && existing.targetUrl === url)) && existing.owner.signal === operation.signal
      ? existing : await createPreview(sessionId, url, operation)
    if (canPublish && !await canPublish().catch(() => false)) {
      if (preview !== existing) void releasePreview(operation.client, preview)
      throw new Error("Preview open request is no longer current")
    }
    if (!operation.current() || !surfaceAvailable()) {
      if (preview !== existing) void releasePreview(operation.client, preview)
      throw new DOMException("Preview navigation was superseded", "AbortError")
    }
    const baseHistory = existing?.history ?? (saved?.targetUrl ? parseBrowserHistory(saved.history, saved.targetUrl) : { urls: [], index: 0 })
    let record: SessionPreviewRecord = preview === existing ? existing : { ...preview, sessionId, mode: "preview", storageKey, instanceId,
      owner: { client: operation.client, signal: operation.signal }, viewport: existing?.viewport ?? saved?.viewport,
      history: nativeOpen ? baseHistory : new BrowserHistoryJournal(baseHistory).visitUrl(preview.targetUrl) }
    if (nativeOpen || record.nativeOpen) record = { ...record, nativeOpen: nativeOpen && { ...nativeOpen, created: preview !== existing } }
    if (record !== existing) publishPreview(record)
    if (!nativeOpen && existing?.nativeOpen) void retireSessionPreviewOpen(existing.nativeOpen).catch(() => {})
    if (nativeOpen) showSessionPreview(sessionId, instanceId, operation)
    else {
      storePreview(sessionId, instanceId, { ...record, mode: "preview" })
      applySurface({ sessionId, instanceId }, { kind: "web", sessionId }, operation)
    }
    if (existing && preview !== existing) void releasePreview(existing.owner.client, existing)
    return record
  } finally { finishOperation(storageKey, operation) }
}

function restoreSessionPreview(sessionId: string, instanceId: string): Promise<SessionPreviewRecord | null> {
  if (!isInstanceOccurrenceOpen(instanceId)) return Promise.reject(new DOMException("Preview occurrence is closed", "AbortError"))
  const storageKey = previewKey(sessionId, instanceId)
  const current = getSessionPreview(sessionId, instanceId)
  if (current && !current.nativeOpen?.created) return Promise.resolve(current)
  adoptLegacyTabPreview(instanceId, sessionId)
  const stored = savedPreview(sessionId, instanceId)
  if (!stored?.targetUrl) return Promise.resolve(null)
  const running = operations.get(storageKey)
  const ownOperation = running?.instanceId === instanceId && running.current()
  const pending = ownOperation ? restorePromises.get(storageKey) : undefined
  if (pending) return pending
  if (ownOperation) return Promise.resolve(null)
  const operation = beginOperation(storageKey, sessionId, instanceId, undefined, true)
  const restore = createPreview(sessionId, stored.targetUrl, operation).then(preview => {
    if (!operation.current()) {
      void releasePreview(operation.client, preview)
      throw new DOMException("Preview navigation was superseded", "AbortError")
    }
    const record: SessionPreviewRecord = { ...preview, sessionId, mode: tabPreview(sessionId, instanceId)?.mode ?? "chat", storageKey, instanceId,
      owner: { client: operation.client, signal: operation.signal },
      viewport: stored.viewport, history: parseBrowserHistory(stored.history, preview.targetUrl) }
    const superseded = getSessionPreview(sessionId, instanceId)
    if (superseded && !superseded.nativeOpen?.created) {
      void releasePreview(operation.client, preview)
      return superseded
    }
    publishPreview(record)
    if (superseded?.nativeOpen) void retireSessionPreviewOpen(superseded.nativeOpen).catch(() => {})
    if (superseded) void releasePreview(superseded.owner.client, superseded)
    return record
  }).finally(() => {
    finishOperation(storageKey, operation)
    if (restorePromises.get(storageKey) === restore) restorePromises.delete(storageKey)
  })
  restorePromises.set(storageKey, restore)
  return restore
}

function showSessionPreview(sessionId: string, instanceId: string, intent?: SurfaceGesture) {
  if (intent && !intent.current()) return
  if (!getSessionPreview(sessionId, instanceId)) return
  const previews = getTabViewState(instanceId).previews
  if (!previews?.[sessionId]) updateTabViewState(instanceId, { previews: { ...previews, [sessionId]: { mode: "chat" } } })
  applySurface({ instanceId, sessionId }, { kind: "web", sessionId }, intent)
}

function showSessionChatFor(sessionId: string, instanceId: string) {
  const key = previewKey(sessionId, instanceId)
  if (operations.get(key)?.instanceId === instanceId) cancelOperation(key)
  applySurface({ instanceId, sessionId }, { kind: "conversation" })
}

function updateSessionPreviewLocation(storageKey: string, targetUrl: string) {
  const current = sessionPreviews().get(storageKey)
  if (!current || current.owner.signal.aborted) return
  const target = local(current.instanceId) ? browserAddress(targetUrl) : historyUrl(targetUrl)
  if (!target) return
  if (current.nativeOpen) {
    current.nativeOpen.observedAddress = target
    return
  }
  if (current.capability && new URL(target).hostname.endsWith(".preview.localhost")) return
  setSessionPreviews(previous => new Map(previous).set(storageKey, withLiveMode({ ...current, targetUrl: target })))
  // History capture persists the committed URL and cursor together.
}

export function updateSessionPreviewHistory(storageKey: string, history: BrowserHistory) {
  const current = sessionPreviews().get(storageKey)
  const targetUrl = historyUrl(history.urls[history.index])
  if (!current || current.owner.signal.aborted || current.nativeOpen || !targetUrl) return
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
  const savedUrl = next.history.urls[next.history.index]
  if (!current.nativeOpen?.created && savedUrl) storePreview(current.sessionId, current.instanceId, { ...next, targetUrl: savedUrl })
}

export function cancelSessionPreviewNavigation(storageKey: string) { cancelOperation(storageKey) }

async function closeSessionPreview(storageKey: string) {
  cancelOperation(storageKey)
  await removeLivePreview(storageKey)
}

export function setPreviewSessionOwners(instanceId: string, sessions: ReadonlyMap<string, unknown>) {
  if (local(instanceId)) localOwners.set(instanceId, sessions)
}

onInstanceLifecycleAuthority(event => {
  if (event.type === "opened") return
  for (const [key, operation] of operations) if (operation.instanceId === event.instanceId) cancelOperation(key)
  if (event.type === "removed") localOwners.delete(event.instanceId)
  for (const preview of sessionPreviews().values()) {
    if (preview.capability ? preview.instanceId === event.instanceId
      : event.type === "removed" && ![...localOwners.values()].some(sessions => sessions.has(preview.sessionId)))
      void removeLivePreview(preview.storageKey)
  }
})

onInstanceTabDetached(instanceId => {
  for (const key of operations.keys()) {
    const operation = operations.get(key)!
    if (operation.instanceId === instanceId && operation.client.id !== "local") cancelOperation(key)
  }
  for (const record of sessionPreviews().values())
    if (record.instanceId === instanceId && record.capability) dismissSessionPreview(record.storageKey)
})
if (typeof window !== "undefined") window.addEventListener("pagehide", () => {
  for (const [key, operation] of operations) if (operation.client.id !== "local") cancelOperation(key)
  for (const record of sessionPreviews().values()) if (record.capability) dismissSessionPreview(record.storageKey, true)
})

export { sessionPreviews, getSessionPreview, openSessionPreview, restoreSessionPreview, updateSessionPreviewLocation,
  showSessionPreview, showSessionChatFor, closeSessionPreview, DEFAULT_PREVIEW_URL }
export type { SessionPreviewRecord, StoredSessionPreview }

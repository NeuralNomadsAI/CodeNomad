import { createSignal } from "solid-js"
import { backendOf, type BackendClient } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { tGlobal } from "../lib/i18n"
import type { PreviewSession } from "../../../server/src/api-types"
import { readClientLayoutValue, writeClientLayoutValue } from "./client-state"
import { BrowserHistoryJournal, historyUrl, parseBrowserHistory, type BrowserHistory } from "../lib/browser-history"
import { updateMissionProjectView } from "./mission-view-state"

interface SessionPreviewRecord extends PreviewSession {
  mode: "preview" | "chat"
  storageKey: string
  instanceFolder: string
  history: BrowserHistory
  instanceId: string
  owner: { client: BackendClient; signal: AbortSignal }
}

interface StoredSessionPreview {
  targetUrl: string
  mode: SessionPreviewRecord["mode"]
  history?: BrowserHistory
}

const STORAGE_KEY = "opencode-session-previews-v1"
const MAX_STORAGE_LENGTH = 4_000
const MAX_STORED_PREVIEWS = 32
const DEFAULT_PREVIEW_URL = "http://localhost:3000"

const [sessionPreviews, setSessionPreviews] = createSignal<Map<string, SessionPreviewRecord>>(new Map())
const storedPreviews = new Map<string, StoredSessionPreview>()
const restorePromises = new Map<string, { signal: AbortSignal; version: number; promise: Promise<SessionPreviewRecord | null> }>()
const operationVersions = new Map<string, number>()
const previewRevocations = new Map<string, () => void>()
let storageInitialized = false

function publishPreview(record: SessionPreviewRecord) {
  previewRevocations.get(record.storageKey)?.()
  const revoke = () => {
    previewRevocations.delete(record.storageKey)
    setSessionPreviews(previous => {
      const next = new Map(previous)
      next.delete(record.storageKey)
      return next
    })
    void record.owner.client.api.deletePreview(record.token).catch(() => undefined)
  }
  record.owner.signal.addEventListener("abort", revoke, { once: true })
  previewRevocations.set(record.storageKey, () => record.owner.signal.removeEventListener("abort", revoke))
  setSessionPreviews(previous => new Map(previous).set(record.storageKey, record))
}

function beginOperation(storageKey: string): number {
  const version = (operationVersions.get(storageKey) ?? 0) + 1
  operationVersions.set(storageKey, version)
  return version
}

export function parseStoredSessionPreviews(value: string | null): Array<[string, StoredSessionPreview]> {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
    const result: Array<[string, StoredSessionPreview]> = []
    for (const [sessionId, preview] of Object.entries(parsed).slice(0, MAX_STORED_PREVIEWS)) {
      if (!sessionId || sessionId.length > 4_096 || !preview || typeof preview !== "object" || Array.isArray(preview)) continue
      const targetUrl = (preview as Record<string, unknown>).targetUrl
      const mode = (preview as Record<string, unknown>).mode
      if (typeof targetUrl !== "string" || targetUrl.length > 2_048 || (mode !== "preview" && mode !== "chat")) continue
      let target: URL
      try {
        target = new URL(targetUrl)
      } catch {
        continue
      }
      if (!historyUrl(target.href)) continue
      const history = (preview as StoredSessionPreview).history
      result.push([sessionId, { targetUrl: target.href, mode, ...(history ? { history: parseBrowserHistory(history, target.href) } : {}) }])
    }
    return result
  } catch {
    return []
  }
}

function initializeStorage() {
  if (storageInitialized) return
  storageInitialized = true
  for (const [sessionId, preview] of parseStoredSessionPreviews(readClientLayoutValue(STORAGE_KEY))) {
    storedPreviews.set(sessionId, preview)
  }
}

function persistStorage() {
  const entries = [...storedPreviews.entries()].slice(-MAX_STORED_PREVIEWS)
  let value = JSON.stringify(Object.fromEntries(entries))
  // Keep the existing layout-value budget: trim history before evicting an URL.
  while (value.length > MAX_STORAGE_LENGTH) {
    const entry = entries.find(([, preview]) => (preview.history?.urls.length ?? 0) > 1)
    if (!entry) break
    const history = entry[1].history!
    if (history.index > 0) { history.urls.shift(); history.index-- }
    else history.urls.pop()
    value = JSON.stringify(Object.fromEntries(entries))
  }
  while (value.length > MAX_STORAGE_LENGTH && entries.length > 0) {
    storedPreviews.delete(entries.shift()![0])
    value = JSON.stringify(Object.fromEntries(entries))
  }
  writeClientLayoutValue(STORAGE_KEY, value)
}

function storePreview(storageKey: string, preview: StoredSessionPreview | null) {
  initializeStorage()
  storedPreviews.delete(storageKey)
  if (preview) storedPreviews.set(storageKey, { targetUrl: preview.targetUrl, mode: preview.mode,
    ...(preview.history ? { history: parseBrowserHistory(preview.history, preview.targetUrl) } : {}) })
  persistStorage()
}

function previewKey(sessionId: string, instanceFolder: string): string {
  return JSON.stringify([instanceFolder, sessionId])
}

export function getPreviewSessionIds(instanceFolder: string): string[] {
  return [...sessionPreviews().values()].filter((preview) => preview.instanceFolder === instanceFolder && !preview.owner.signal.aborted).map((preview) => preview.sessionId)
}

function getSessionPreview(sessionId: string, instanceFolder = ""): SessionPreviewRecord | null {
  initializeStorage()
  const storageKey = previewKey(sessionId, instanceFolder)
  const preview = sessionPreviews().get(storageKey)
  return preview && !preview.owner.signal.aborted ? preview : null
}

async function createPreview(client: BackendClient, sessionId: string, url: string) {
  const preview = await client.api.createPreview({ sessionId, url })
  if (client.id === "local") return preview
  try {
    const source = new URL(client.url(preview.proxyUrl))
    if (!historyUrl(source.href) || !historyUrl(preview.targetUrl) || source.origin !== new URL(client.url("/")).origin) throw new TypeError()
    return { ...preview, proxyUrl: source.href }
  } catch {
    void client.api.deletePreview(preview.token).catch(() => undefined)
    throw new TypeError(tGlobal("sessionPreview.open.invalidUrl"))
  }
}

async function openSessionPreview(sessionId: string, url: string, instanceFolder = "", instanceId = ""): Promise<SessionPreviewRecord> {
  if (!historyUrl(url)) throw new TypeError(tGlobal("sessionPreview.open.invalidUrl"))
  const client = backendOf(instanceId)
  const operation = captureBackendOperation(instanceId)
  operation.signal.throwIfAborted()
  initializeStorage()
  const storageKey = previewKey(sessionId, instanceFolder)
  const operationVersion = beginOperation(storageKey)
  const existing = sessionPreviews().get(storageKey)
  const saved = storedPreviews.get(storageKey)
  const preview = await createPreview(client, sessionId, url)
  if (!operation.current() || operationVersions.get(storageKey) !== operationVersion) {
    void client.api.deletePreview(preview.token).catch(() => undefined)
    const current = sessionPreviews().get(storageKey)
    if (operation.current() && current && !current.owner.signal.aborted) return { ...current, sessionId }
    throw new Error("Preview navigation was superseded")
  }
  const record: SessionPreviewRecord = { ...preview, sessionId, instanceId, owner: { client, signal: operation.signal },
    mode: "preview", storageKey, instanceFolder,
    history: new BrowserHistoryJournal(existing?.history ?? parseBrowserHistory(saved?.history, saved?.targetUrl ?? preview.targetUrl)).visitUrl(preview.targetUrl) }
  publishPreview(record)
  storePreview(record.storageKey, record)
  // Mission readers are project-scoped; an explicit browser open owns the central surface.
  updateMissionProjectView(instanceFolder, { reader: undefined })
  if (existing) void existing.owner.client.api.deletePreview(existing.token).catch(() => undefined)
  return record
}

function restoreSessionPreview(sessionId: string, instanceFolder = "", instanceId = ""): Promise<SessionPreviewRecord | null> {
  const client = backendOf(instanceId)
  const operation = captureBackendOperation(instanceId)
  if (!operation.current()) return Promise.resolve(null)
  initializeStorage()
  const storageKey = previewKey(sessionId, instanceFolder)
  const current = sessionPreviews().get(storageKey)
  if (current && current.owner.signal === operation.signal) return Promise.resolve({ ...current, sessionId })
  // Adopt the old project-wide URL once, for the first session that restores it.
  // Other sessions then start independently rather than inheriting its page.
  if (!storedPreviews.has(storageKey) && instanceFolder && storedPreviews.has(instanceFolder)) {
    const legacy = storedPreviews.get(instanceFolder)!
    storedPreviews.delete(instanceFolder)
    storePreview(storageKey, legacy)
  }
  const stored = storedPreviews.get(storageKey)
  if (!stored) return Promise.resolve(null)
  const pending = restorePromises.get(storageKey)
  if (pending?.signal === operation.signal && pending.version === operationVersions.get(storageKey)) return pending.promise

  const operationVersion = beginOperation(storageKey)
  const restore = createPreview(client, sessionId, stored.targetUrl).then((preview) => {
    if (!operation.current() || operationVersions.get(storageKey) !== operationVersion) {
      void client.api.deletePreview(preview.token).catch(() => undefined)
      // A later reader/chat gesture must not look like a missing saved URL:
      // the shell would then create its default page and steal that surface.
      if (operation.current()) throw new DOMException("Preview navigation was superseded", "AbortError")
      return null
    }
    const record: SessionPreviewRecord = { ...preview, sessionId, instanceId, owner: { client, signal: operation.signal },
      mode: stored.mode, storageKey, instanceFolder,
      history: parseBrowserHistory(stored.history, preview.targetUrl) }
    publishPreview(record)
    return record
  }).finally(() => { if (restorePromises.get(storageKey)?.promise === restore) restorePromises.delete(storageKey) })
  restorePromises.set(storageKey, { signal: operation.signal, version: operationVersion, promise: restore })
  return restore
}

function showSessionPreview(storageKey: string) {
  const current = sessionPreviews().get(storageKey)
  if (!current || current.owner.signal.aborted) return
  updateMissionProjectView(current.instanceFolder, { reader: undefined })
  setSessionPreviews((prev) => {
    const next = new Map(prev)
    next.set(storageKey, { ...current, mode: "preview" })
    return next
  })
  storePreview(current.storageKey, { ...current, mode: "preview" })
}

function showSessionChat(storageKey: string) {
  // A reader/chat gesture wins over an earlier in-flight browser open or restore.
  beginOperation(storageKey)
  const current = sessionPreviews().get(storageKey)
  if (!current) {
    initializeStorage()
    const stored = storedPreviews.get(storageKey)
    if (stored) storePreview(storageKey, { ...stored, mode: "chat" })
    return
  }
  setSessionPreviews((prev) => {
    const next = new Map(prev)
    next.set(storageKey, { ...current, mode: "chat" })
    return next
  })
  storePreview(current.storageKey, { ...current, mode: "chat" })
}

/** Return one session's central surface to chat, including a preview still being opened or restored. */
function showSessionChatFor(sessionId: string, instanceFolder = "") {
  showSessionChat(previewKey(sessionId, instanceFolder))
}

function updateSessionPreviewLocation(storageKey: string, targetUrl: string) {
  const current = sessionPreviews().get(storageKey)
  if (!current || current.owner.signal.aborted) return
  const normalized = historyUrl(targetUrl)
  if (!normalized) return
  setSessionPreviews((prev) => new Map(prev).set(storageKey, { ...current, targetUrl: normalized }))
  // History capture publishes the committed URL and cursor together. Avoid
  // replacing a valid saved history with an interim location-only snapshot.
}

export function updateSessionPreviewHistory(storageKey: string, history: BrowserHistory) {
  const current = sessionPreviews().get(storageKey)
  const targetUrl = historyUrl(history.urls[history.index])
  if (!current || current.owner.signal.aborted || !targetUrl) return
  const next = { ...current, targetUrl, history: parseBrowserHistory(history, targetUrl) }
  setSessionPreviews(previous => new Map(previous).set(storageKey, next))
  storePreview(storageKey, next)
}

export function cancelSessionPreviewNavigation(storageKey: string) {
  beginOperation(storageKey)
}

async function closeSessionPreview(storageKey: string) {
  beginOperation(storageKey)
  previewRevocations.get(storageKey)?.()
  previewRevocations.delete(storageKey)
  const current = sessionPreviews().get(storageKey)
  // Clear persistence before notifying the active-session restore effect.
  storePreview(storageKey, null)
  if (!current) {
    return
  }
  setSessionPreviews((prev) => {
    const next = new Map(prev)
    next.delete(storageKey)
    return next
  })
  await current.owner.client.api.deletePreview(current.token).catch(() => undefined)
}

export {
  sessionPreviews,
  getSessionPreview,
  openSessionPreview,
  restoreSessionPreview,
  updateSessionPreviewLocation,
  showSessionPreview,
  showSessionChat,
  showSessionChatFor,
  closeSessionPreview,
}
export { DEFAULT_PREVIEW_URL }
export type { SessionPreviewRecord, StoredSessionPreview }

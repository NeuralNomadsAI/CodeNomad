import { createSignal } from "solid-js"
import { serverApi } from "../lib/api-client"
import type { PreviewSession } from "../../../server/src/api-types"
import { readClientLayoutValue, writeClientLayoutValue } from "./client-state"
import { BrowserHistoryJournal, historyUrl, parseBrowserHistory, type BrowserHistory } from "../lib/browser-history"

interface SessionPreviewRecord extends PreviewSession {
  mode: "preview" | "chat"
  storageKey: string
  instanceFolder: string
  history: BrowserHistory
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
const restorePromises = new Map<string, Promise<SessionPreviewRecord | null>>()
const operationVersions = new Map<string, number>()
let storageInitialized = false

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
  return [...sessionPreviews().values()].filter((preview) => preview.instanceFolder === instanceFolder).map((preview) => preview.sessionId)
}

function getSessionPreview(sessionId: string, instanceFolder = ""): SessionPreviewRecord | null {
  initializeStorage()
  const storageKey = previewKey(sessionId, instanceFolder)
  const preview = sessionPreviews().get(storageKey)
  return preview ?? null
}

async function openSessionPreview(sessionId: string, url: string, instanceFolder = ""): Promise<SessionPreviewRecord> {
  initializeStorage()
  const storageKey = previewKey(sessionId, instanceFolder)
  const operationVersion = beginOperation(storageKey)
  const existing = sessionPreviews().get(storageKey)
  const saved = storedPreviews.get(storageKey)
  const preview = await serverApi.createPreview({ sessionId, url })
  if (operationVersions.get(storageKey) !== operationVersion) {
    void serverApi.deletePreview(preview.token).catch(() => undefined)
    const current = sessionPreviews().get(storageKey)
    if (current) return { ...current, sessionId }
    throw new Error("Preview navigation was superseded")
  }
  const record: SessionPreviewRecord = { ...preview, mode: "preview", storageKey, instanceFolder,
    history: new BrowserHistoryJournal(existing?.history ?? parseBrowserHistory(saved?.history, saved?.targetUrl ?? preview.targetUrl)).visitUrl(preview.targetUrl) }
  setSessionPreviews((prev) => {
    const next = new Map(prev)
    next.set(storageKey, record)
    return next
  })
  storePreview(record.storageKey, record)
  if (existing) void serverApi.deletePreview(existing.token).catch(() => undefined)
  return record
}

function restoreSessionPreview(sessionId: string, instanceFolder = ""): Promise<SessionPreviewRecord | null> {
  initializeStorage()
  const storageKey = previewKey(sessionId, instanceFolder)
  const current = sessionPreviews().get(storageKey)
  if (current) return Promise.resolve({ ...current, sessionId })
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
  if (pending) return pending

  const operationVersion = beginOperation(storageKey)
  const restore = serverApi.createPreview({ sessionId, url: stored.targetUrl }).then((preview) => {
    if (operationVersions.get(storageKey) !== operationVersion) {
      void serverApi.deletePreview(preview.token).catch(() => undefined)
      const currentPreview = sessionPreviews().get(storageKey)
      return currentPreview ? { ...currentPreview, sessionId } : null
    }
    const record: SessionPreviewRecord = { ...preview, mode: stored.mode, storageKey, instanceFolder,
      history: parseBrowserHistory(stored.history, preview.targetUrl) }
    setSessionPreviews((prev) => new Map(prev).set(storageKey, record))
    return record
  }).finally(() => restorePromises.delete(storageKey))
  restorePromises.set(storageKey, restore)
  return restore
}

function showSessionPreview(storageKey: string) {
  const current = sessionPreviews().get(storageKey)
  if (!current) return
  setSessionPreviews((prev) => {
    const next = new Map(prev)
    next.set(storageKey, { ...current, mode: "preview" })
    return next
  })
  storePreview(current.storageKey, { ...current, mode: "preview" })
}

function showSessionChat(storageKey: string) {
  const current = sessionPreviews().get(storageKey)
  if (!current) return
  setSessionPreviews((prev) => {
    const next = new Map(prev)
    next.set(storageKey, { ...current, mode: "chat" })
    return next
  })
  storePreview(current.storageKey, { ...current, mode: "chat" })
}

function updateSessionPreviewLocation(storageKey: string, targetUrl: string) {
  const current = sessionPreviews().get(storageKey)
  if (!current) return
  const target = new URL(targetUrl)
  if (target.protocol !== "http:" && target.protocol !== "https:") return
  const normalized = target.href
  setSessionPreviews((prev) => new Map(prev).set(storageKey, { ...current, targetUrl: normalized }))
  // History capture publishes the committed URL and cursor together. Avoid
  // replacing a valid saved history with an interim location-only snapshot.
}

export function updateSessionPreviewHistory(storageKey: string, history: BrowserHistory) {
  const current = sessionPreviews().get(storageKey)
  const targetUrl = historyUrl(history.urls[history.index])
  if (!current || !targetUrl) return
  const next = { ...current, targetUrl, history: parseBrowserHistory(history, targetUrl) }
  setSessionPreviews(previous => new Map(previous).set(storageKey, next))
  storePreview(storageKey, next)
}

export function cancelSessionPreviewNavigation(storageKey: string) {
  beginOperation(storageKey)
}

async function closeSessionPreview(storageKey: string) {
  beginOperation(storageKey)
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
  await serverApi.deletePreview(current.token).catch(() => undefined)
}

export {
  sessionPreviews,
  getSessionPreview,
  openSessionPreview,
  restoreSessionPreview,
  updateSessionPreviewLocation,
  showSessionPreview,
  showSessionChat,
  closeSessionPreview,
}
export { DEFAULT_PREVIEW_URL }
export type { SessionPreviewRecord, StoredSessionPreview }

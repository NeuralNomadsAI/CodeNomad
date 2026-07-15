import { createSignal } from "solid-js"
import {
  clearNativeClientState,
  loadNativeClientState,
  saveNativeClientState,
  setNativeRestoreEnabled,
} from "../lib/native/client-state"
import {
  decodeClientSnapshot,
  isFutureClientSnapshot,
  normalizeRestorableSession,
  type ClientSnapshotV1,
  type RestorableSessionState,
  type RestorableSidecarTabState,
  type RestorableTabState,
  type RestorableWorkspaceTabState,
} from "./client-state-codec"

export type {
  ClientSnapshotV1,
  RestorableSessionState,
  RestorableSidecarTabState,
  RestorableTabState,
  RestorableWorkspaceTabState,
}

const SAVE_DEBOUNCE_MS = 250
const FLUSH_MAX_ATTEMPTS = 3
const MAX_LAYOUT_ENTRIES = 64
const MAX_LAYOUT_KEY_LENGTH = 256
const MAX_LAYOUT_VALUE_LENGTH = 4096
const LEGACY_LAYOUT_KEY_PREFIX = "opencode-session-"

const [clientStateIsPrimary, setClientStateIsPrimary] = createSignal(true)
const [restorePreviousStateEnabled, setRestorePreviousStateEnabledSignal] = createSignal(true)
const [loadedClientSnapshotExists, setLoadedClientSnapshotExists] = createSignal(false)
const [loadedRestorableSession, setLoadedRestorableSession] = createSignal<RestorableSessionState | null>(null)

let initialized = false
let initialization: Promise<void> | null = null
let layout: Record<string, string> = Object.create(null)
let revision = 0
let dirty = false
let snapshotWriteBlocked = false
let transactionWriteBlocked = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let writeQueue: Promise<void> = Promise.resolve()
let lastSaveError: unknown
const knownLegacyLayoutKeys = new Set<string>()
const NO_PENDING_SESSION = Symbol("no-pending-session")
let pendingSessionWrite: RestorableSessionState | null | typeof NO_PENDING_SESSION = NO_PENDING_SESSION
const pendingLayoutWrites = new Map<string, string>()

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function isValidLayoutKey(key: string): boolean {
  return key.length > 0
    && key.length <= MAX_LAYOUT_KEY_LENGTH
    && key !== "__proto__"
    && key !== "constructor"
    && key !== "prototype"
}

function isValidLayoutValue(value: string): boolean {
  return value.length <= MAX_LAYOUT_VALUE_LENGTH
}

function rememberLegacyLayoutKey(key: string) {
  if (isValidLayoutKey(key)) knownLegacyLayoutKeys.add(key)
}

function readLegacyLayoutValue(key: string): string | null {
  const storage = getLocalStorage()
  if (!storage) return null
  try {
    const value = storage.getItem(key)
    if (value === null || !isValidLayoutValue(value)) return null
    rememberLegacyLayoutKey(key)
    return value
  } catch {
    return null
  }
}

function writeLegacyLayoutValue(key: string, value: string) {
  const storage = getLocalStorage()
  if (!storage) return
  try {
    storage.setItem(key, value)
    rememberLegacyLayoutKey(key)
  } catch {
    // The native snapshot remains the source of truth when web storage is unavailable.
  }
}

function collectLegacyLayoutKeys(): string[] {
  const keys = new Set(knownLegacyLayoutKeys)
  const storage = getLocalStorage()
  if (!storage) return [...keys]

  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(LEGACY_LAYOUT_KEY_PREFIX)) keys.add(key)
    }
  } catch {
    // Keep keys already observed by the layout facade.
  }
  return [...keys]
}

function clearLegacyLayoutValues() {
  const storage = getLocalStorage()
  if (!storage) return
  try {
    for (const key of collectLegacyLayoutKeys()) storage.removeItem(key)
  } catch {
    // Native clearing still prevents these values from being restored by the primary process.
  }
  knownLegacyLayoutKeys.clear()
}

function migrateLegacyLayoutValues(): boolean {
  const storage = getLocalStorage()
  if (!storage) return false

  let changed = false
  for (const key of collectLegacyLayoutKeys()) {
    if (Object.prototype.hasOwnProperty.call(layout, key)) continue
    if (Object.keys(layout).length >= MAX_LAYOUT_ENTRIES) break
    const value = readLegacyLayoutValue(key)
    if (value === null) continue
    layout[key] = value
    changed = true
  }
  return changed
}

function canWriteSnapshot(): boolean {
  return initialized
    && clientStateIsPrimary()
    && restorePreviousStateEnabled()
    && !snapshotWriteBlocked
    && !transactionWriteBlocked
}

function cancelSaveTimer() {
  if (saveTimer === null) return
  clearTimeout(saveTimer)
  saveTimer = null
}

function currentSnapshot(): ClientSnapshotV1 {
  revision += 1
  return {
    version: 1,
    revision,
    savedAt: Date.now(),
    layout: { ...layout },
    session: loadedRestorableSession(),
  }
}

function enqueuePendingSave(): Promise<void> {
  cancelSaveTimer()
  if (!dirty || !canWriteSnapshot()) return writeQueue

  dirty = false
  const snapshot = currentSnapshot()
  const saveAttempt = writeQueue
    .then(async () => {
      try {
        const saved = await saveNativeClientState(snapshot)
        if (!saved) {
          setClientStateIsPrimary(false)
          throw new Error("Native client state save was rejected")
        }
        lastSaveError = undefined
      } catch (error) {
        dirty = true
        lastSaveError = error
        throw error
      }
    })
  writeQueue = saveAttempt.catch(() => undefined)
  return saveAttempt
}

function scheduleSave() {
  dirty = true
  if (!canWriteSnapshot()) return
  cancelSaveTimer()
  saveTimer = setTimeout(() => {
    saveTimer = null
    void enqueuePendingSave().catch((error) => {
      console.warn("[client-state] failed to save client snapshot", error)
    })
  }, SAVE_DEBOUNCE_MS)
}

function resetPendingWrites() {
  pendingSessionWrite = NO_PENDING_SESSION
  pendingLayoutWrites.clear()
}

function applyPendingWrites(): boolean {
  let changed = false
  if (pendingSessionWrite !== NO_PENDING_SESSION) {
    setLoadedRestorableSession(pendingSessionWrite)
    changed = true
  }
  for (const [key, value] of pendingLayoutWrites) {
    writeLegacyLayoutValue(key, value)
    if (layout[key] === value) continue
    layout[key] = value
    changed = true
  }
  resetPendingWrites()
  return changed
}

function rollbackWriteTransaction(wasWriteBlocked: boolean, retryDirty: boolean) {
  transactionWriteBlocked = false
  snapshotWriteBlocked = wasWriteBlocked
  dirty = retryDirty
  if (applyPendingWrites()) dirty = true
  if (dirty) scheduleSave()
}

export function updateRestorableSession(state: RestorableSessionState | null): void {
  const normalized = state === null ? null : normalizeRestorableSession(state)
  if (state !== null && normalized === null) return
  if (transactionWriteBlocked) {
    pendingSessionWrite = normalized
    return
  }
  if (snapshotWriteBlocked || !clientStateIsPrimary() || !restorePreviousStateEnabled()) return

  setLoadedRestorableSession(normalized)
  scheduleSave()
}

export function readClientLayoutValue(key: string): string | null {
  if (!isValidLayoutKey(key)) return null

  if (!clientStateIsPrimary()) return readLegacyLayoutValue(key)
  if (!restorePreviousStateEnabled()) return null
  if (snapshotWriteBlocked || transactionWriteBlocked) return null

  if (Object.prototype.hasOwnProperty.call(layout, key)) return layout[key] ?? null
  const legacyValue = readLegacyLayoutValue(key)
  if (legacyValue === null || Object.keys(layout).length >= MAX_LAYOUT_ENTRIES) return legacyValue

  layout[key] = legacyValue
  scheduleSave()
  return legacyValue
}

export function writeClientLayoutValue(key: string, value: string): void {
  if (!isValidLayoutKey(key) || !isValidLayoutValue(value)) return

  if (!clientStateIsPrimary()) {
    writeLegacyLayoutValue(key, value)
    return
  }
  if (transactionWriteBlocked) {
    const isNewKey = !Object.prototype.hasOwnProperty.call(layout, key) && !pendingLayoutWrites.has(key)
    const pendingNewKeyCount = [...pendingLayoutWrites.keys()]
      .filter((pendingKey) => !Object.prototype.hasOwnProperty.call(layout, pendingKey))
      .length
    if (isNewKey && Object.keys(layout).length + pendingNewKeyCount >= MAX_LAYOUT_ENTRIES) return
    pendingLayoutWrites.set(key, value)
    return
  }
  if (!restorePreviousStateEnabled()) return
  if (snapshotWriteBlocked) return

  if (!Object.prototype.hasOwnProperty.call(layout, key) && Object.keys(layout).length >= MAX_LAYOUT_ENTRIES) return
  writeLegacyLayoutValue(key, value)
  if (layout[key] === value) return

  layout[key] = value
  scheduleSave()
}

export async function flushClientState(): Promise<void> {
  cancelSaveTimer()
  let lastError = lastSaveError
  let attempts = 0

  while (attempts < FLUSH_MAX_ATTEMPTS) {
    const pendingQueue = writeQueue
    await pendingQueue
    if (pendingQueue !== writeQueue) continue
    if (!dirty) {
      if (lastError !== undefined) throw lastError
      return
    }
    if (!canWriteSnapshot()) {
      const writeError = lastSaveError ?? lastError
      if (writeError !== undefined) throw writeError
      return
    }
    attempts += 1
    try {
      await enqueuePendingSave()
      lastError = undefined
    } catch (error) {
      lastError = error
    }
  }

  while (true) {
    const pendingQueue = writeQueue
    await pendingQueue
    if (pendingQueue !== writeQueue) continue
    if (!dirty) return
    break
  }
  if (lastError !== undefined) throw lastError
  throw new Error("Client state remained dirty after the final flush attempt")
}

export async function clearRestoredClientState(): Promise<void> {
  if (!clientStateIsPrimary()) throw new Error("Client state is not owned by this window")

  const wasWriteBlocked = snapshotWriteBlocked
  const wasDirty = dirty
  let retryDirty = wasDirty
  transactionWriteBlocked = true
  resetPendingWrites()
  cancelSaveTimer()
  dirty = false
  try {
    await writeQueue
    retryDirty ||= dirty
    dirty = false

    const cleared = await clearNativeClientState()
    if (!cleared) {
      setClientStateIsPrimary(false)
      throw new Error("Native client state clear was rejected")
    }

    layout = Object.create(null)
    setLoadedClientSnapshotExists(false)
    setLoadedRestorableSession(null)
    clearLegacyLayoutValues()
    resetPendingWrites()
    transactionWriteBlocked = false
    snapshotWriteBlocked = true
  } catch (error) {
    retryDirty ||= dirty
    rollbackWriteTransaction(wasWriteBlocked, retryDirty)
    throw error
  }
}

export async function setRestorePreviousStateEnabled(enabled: boolean): Promise<void> {
  if (enabled === restorePreviousStateEnabled()) return
  if (!clientStateIsPrimary()) throw new Error("Client state is not owned by this window")

  if (!enabled) {
    const wasWriteBlocked = snapshotWriteBlocked
    const wasDirty = dirty
    let retryDirty = wasDirty
    transactionWriteBlocked = true
    resetPendingWrites()
    setRestorePreviousStateEnabledSignal(false)
    cancelSaveTimer()
    dirty = false
    await writeQueue
    retryDirty ||= dirty
    dirty = false

    try {
      const preferenceSaved = await setNativeRestoreEnabled(false)
      if (!preferenceSaved) {
        throw new Error("Native restore preference update was rejected")
      }

      layout = Object.create(null)
      setLoadedClientSnapshotExists(false)
      setLoadedRestorableSession(null)
      clearLegacyLayoutValues()
      resetPendingWrites()
      transactionWriteBlocked = false
      snapshotWriteBlocked = true
      return
    } catch (error) {
      retryDirty ||= dirty
      setRestorePreviousStateEnabledSignal(true)
      rollbackWriteTransaction(wasWriteBlocked, retryDirty)
      throw error
    }
  }

  const preferenceSaved = await setNativeRestoreEnabled(true)
  if (!preferenceSaved) {
    throw new Error("Native restore preference update was rejected")
  }
  snapshotWriteBlocked = false
  setRestorePreviousStateEnabledSignal(true)
}

export function initializeClientState(): Promise<void> {
  if (initialization) return initialization

  initialization = (async () => {
    try {
      const loaded = await loadNativeClientState()
      setClientStateIsPrimary(loaded.isPrimary)
      setRestorePreviousStateEnabledSignal(loaded.restoreEnabled)
      setLoadedClientSnapshotExists(false)
      setLoadedRestorableSession(null)
      layout = Object.create(null)
      revision = 0
      dirty = false
      lastSaveError = undefined
      snapshotWriteBlocked = false
      transactionWriteBlocked = false
      resetPendingWrites()

      if (!loaded.isPrimary || !loaded.restoreEnabled) {
        initialized = true
        return
      }

      snapshotWriteBlocked = isFutureClientSnapshot(loaded.snapshot)
      const snapshot = decodeClientSnapshot(loaded.snapshot)
      if (snapshot) {
        setLoadedClientSnapshotExists(true)
        revision = snapshot.revision
        layout = { ...snapshot.layout }
        setLoadedRestorableSession(snapshot.session)
        for (const key of Object.keys(snapshot.layout)) rememberLegacyLayoutKey(key)
      }

      initialized = true
      if (!snapshotWriteBlocked && migrateLegacyLayoutValues()) scheduleSave()
    } catch (error) {
      initialized = true
      setClientStateIsPrimary(false)
      setLoadedClientSnapshotExists(false)
      setLoadedRestorableSession(null)
      console.warn("[client-state] failed to initialize client state", error)
    }
  })()

  return initialization
}

export { clientStateIsPrimary, loadedClientSnapshotExists, loadedRestorableSession, restorePreviousStateEnabled }

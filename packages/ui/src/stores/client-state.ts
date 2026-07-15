import { createSignal } from "solid-js"
import { clearNativeClientState, loadNativeClientState, saveNativeClientState, setNativeRestoreEnabled } from "../lib/native/client-state"
import { decodeClientSnapshot, isFutureClientSnapshot, normalizeRestorableSession } from "./client-state-codec"
import type { ClientSnapshotV1, RestorableSessionState, RestorableSidecarTabState, RestorableTabState, RestorableWorkspaceTabState } from "./client-state-codec"
export type { ClientSnapshotV1, RestorableSessionState, RestorableSidecarTabState, RestorableTabState, RestorableWorkspaceTabState }
const SAVE_DEBOUNCE_MS = 250
const FLUSH_MAX_ATTEMPTS = 3
const MAX_LAYOUT_ENTRIES = 64
const MAX_LAYOUT_KEY_LENGTH = 256
const MAX_LAYOUT_VALUE_LENGTH = 4096
const LEGACY_LAYOUT_KEY_PREFIX = "opencode-session-"
const UNSAFE_LAYOUT_KEYS = new Set(["__proto__", "constructor", "prototype"])
const [clientStateIsPrimary, setClientStateIsPrimary] = createSignal(true)
const [restorePreviousStateEnabled, setRestorePreviousStateEnabledSignal] = createSignal(true)
const [loadedClientSnapshotExists, setLoadedClientSnapshotExists] = createSignal(false)
const [loadedRestorableSession, setLoadedRestorableSession] = createSignal<RestorableSessionState | null>(null)
let initialized = false
let initialization: Promise<void> | null = null
let layout: Record<string, string> = Object.create(null)
let revision = 0
let dirty = false
let writeBlock: false | "snapshot" | "transaction" = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let writeQueue: Promise<void> = Promise.resolve()
let destructiveQueue: Promise<void> = Promise.resolve()
let lastSaveError: unknown
const transactionLayoutWrites = new Set<string>()
function useLocalStorage<T>(fallback: T, operation: (storage: Storage) => T): T {
  try {
    return operation(window.localStorage)
  } catch {
    return fallback
  }
}

function isValidLayoutKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_LAYOUT_KEY_LENGTH && !UNSAFE_LAYOUT_KEYS.has(key)
}
const readLegacyLayoutValue = (key: string) =>
  useLocalStorage<string | null>(null, (storage) => {
    const value = storage.getItem(key)
    return value !== null && value.length <= MAX_LAYOUT_VALUE_LENGTH ? value : null
  })
const writeLegacyLayoutValue = (key: string, value: string) =>
  useLocalStorage(undefined, (storage) => storage.setItem(key, value))
function legacyLayoutKeys(storage: Storage): string[] {
  const keys = new Set(Object.keys(layout))
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(LEGACY_LAYOUT_KEY_PREFIX)) keys.add(key)
  }
  return [...keys]
}
const hasLayoutKey = (key: string) => Object.prototype.hasOwnProperty.call(layout, key)
const layoutIsFull = () => Object.keys(layout).length >= MAX_LAYOUT_ENTRIES

function migrateLegacyLayoutValues(): boolean {
  return useLocalStorage(false, (storage) => {
    const previousSize = Object.keys(layout).length
    for (const key of legacyLayoutKeys(storage)) {
      if (hasLayoutKey(key)) continue
      if (layoutIsFull()) break
      const value = storage.getItem(key)
      if (value === null || value.length > MAX_LAYOUT_VALUE_LENGTH) continue
      layout[key] = value
    }
    return Object.keys(layout).length !== previousSize
  })
}

function canWriteSnapshot(): boolean {
  return initialized && clientStateIsPrimary() && restorePreviousStateEnabled() && !writeBlock
}
const cancelSaveTimer = () => {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
}

function enqueuePendingSave(): Promise<void> {
  cancelSaveTimer()
  if (!dirty || !canWriteSnapshot()) return writeQueue
  const snapshot: ClientSnapshotV1 = {
    version: 1,
    revision: ++revision,
    savedAt: Date.now(),
    layout: { ...layout },
    session: loadedRestorableSession(),
  }
  dirty = false
  const saveAttempt = writeQueue.then(async () => {
    try {
      if (!await saveNativeClientState(snapshot)) {
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
  saveTimer = setTimeout(() => void enqueuePendingSave()
    .catch((error) => console.warn("[client-state] failed to save client snapshot", error)), SAVE_DEBOUNCE_MS)
}
function resetLoadedState(snapshot: ClientSnapshotV1 | null = null, resetRevision = false) {
  layout = snapshot ? { ...snapshot.layout } : Object.create(null)
  if (resetRevision) revision = snapshot?.revision ?? 0
  setLoadedClientSnapshotExists(snapshot !== null)
  setLoadedRestorableSession(snapshot?.session ?? null)
}
async function executeDestructiveTransaction(operation: () => Promise<boolean>, rejectedMessage: string, loseOwnershipOnRejection = false): Promise<void> {
  const previousWriteBlock = writeBlock
  let retryDirty = dirty
  writeBlock = "transaction"
  transactionLayoutWrites.clear()
  cancelSaveTimer()
  dirty = false
  try {
    await writeQueue
    retryDirty ||= dirty
    dirty = false
    if (!await operation()) {
      if (loseOwnershipOnRejection) setClientStateIsPrimary(false)
      throw new Error(rejectedMessage)
    }
    useLocalStorage(undefined, (storage) => {
      for (const key of legacyLayoutKeys(storage)) storage.removeItem(key)
    })
    resetLoadedState()
    transactionLayoutWrites.clear()
    writeBlock = "snapshot"
  } catch (error) {
    retryDirty ||= dirty
    for (const key of transactionLayoutWrites) writeLegacyLayoutValue(key, layout[key]!)
    transactionLayoutWrites.clear()
    writeBlock = previousWriteBlock
    dirty = retryDirty
    if (dirty) scheduleSave()
    throw error
  }
}
function runDestructiveTransition(operation: () => Promise<void>): Promise<void> {
  const transition = destructiveQueue.then(operation)
  destructiveQueue = transition.catch(() => undefined)
  return transition
}
export function updateRestorableSession(state: RestorableSessionState | null): void {
  const normalized = state === null ? null : normalizeRestorableSession(state)
  if (state !== null && normalized === null) return
  if (writeBlock === "transaction") {
    setLoadedRestorableSession(normalized)
    dirty = true
    return
  }
  if (writeBlock || !clientStateIsPrimary() || !restorePreviousStateEnabled()) return
  setLoadedRestorableSession(normalized)
  scheduleSave()
}

export function readClientLayoutValue(key: string): string | null {
  if (!isValidLayoutKey(key)) return null
  if (!clientStateIsPrimary()) return readLegacyLayoutValue(key)
  if (!restorePreviousStateEnabled() || writeBlock) return null
  if (hasLayoutKey(key)) return layout[key] ?? null
  const legacyValue = readLegacyLayoutValue(key)
  if (legacyValue === null || layoutIsFull()) return legacyValue
  layout[key] = legacyValue
  scheduleSave()
  return legacyValue
}

export function writeClientLayoutValue(key: string, value: string): void {
  if (!isValidLayoutKey(key) || value.length > MAX_LAYOUT_VALUE_LENGTH) return
  if (!clientStateIsPrimary()) return writeLegacyLayoutValue(key, value)
  if (writeBlock === "transaction") {
    if (!hasLayoutKey(key) && layoutIsFull()) return
    dirty ||= layout[key] !== value
    layout[key] = value
    transactionLayoutWrites.add(key)
    return
  }
  if (!restorePreviousStateEnabled() || writeBlock) return
  if (!hasLayoutKey(key) && layoutIsFull()) return
  writeLegacyLayoutValue(key, value)
  if (layout[key] === value) return
  layout[key] = value
  scheduleSave()
}

export async function flushClientState(): Promise<void> {
  cancelSaveTimer()
  let lastError = lastSaveError
  for (let attempts = 0; attempts < FLUSH_MAX_ATTEMPTS; attempts += 1) {
    while (true) {
      const pending = writeQueue
      await pending
      if (pending === writeQueue) break
    }
    if (!dirty) {
      if (lastError !== undefined) throw lastError
      return
    }
    if (!canWriteSnapshot()) {
      const writeError = lastSaveError ?? lastError
      if (writeError !== undefined) throw writeError
      return
    }
    try {
      await enqueuePendingSave()
      lastError = undefined
    } catch (error) {
      lastError = error
    }
  }
  await writeQueue
  if (!dirty) return
  throw lastError ?? new Error("Client state remained dirty after the final flush attempt")
}

export async function clearRestoredClientState(): Promise<void> {
  await runDestructiveTransition(async () => {
    if (!clientStateIsPrimary()) throw new Error("Client state is not owned by this window")
    await executeDestructiveTransaction(clearNativeClientState, "Native client state clear was rejected", true)
  })
}

export async function setRestorePreviousStateEnabled(enabled: boolean): Promise<void> {
  await runDestructiveTransition(async () => {
    if (enabled === restorePreviousStateEnabled() && (!enabled || writeBlock === false)) return
    if (!clientStateIsPrimary()) throw new Error("Client state is not owned by this window")
    if (enabled) {
      if (!await setNativeRestoreEnabled(true)) throw new Error("Native restore preference update was rejected")
      writeBlock = false
      setRestorePreviousStateEnabledSignal(true)
      return
    }
    setRestorePreviousStateEnabledSignal(false)
    try {
      await executeDestructiveTransaction(() => setNativeRestoreEnabled(false), "Native restore preference update was rejected")
    } catch (error) {
      setRestorePreviousStateEnabledSignal(true)
      throw error
    }
  })
}

export function initializeClientState(): Promise<void> {
  if (initialization) return initialization
  initialization = (async () => {
    try {
      const loaded = await loadNativeClientState()
      setClientStateIsPrimary(loaded.isPrimary)
      setRestorePreviousStateEnabledSignal(loaded.restoreEnabled)
      resetLoadedState(null, true)
      dirty = false
      lastSaveError = undefined
      writeBlock = false
      transactionLayoutWrites.clear()
      initialized = true
      if (!loaded.isPrimary || !loaded.restoreEnabled) return
      writeBlock = isFutureClientSnapshot(loaded.snapshot) ? "snapshot" : false
      const snapshot = decodeClientSnapshot(loaded.snapshot)
      resetLoadedState(snapshot, true)
      if (!writeBlock && migrateLegacyLayoutValues()) scheduleSave()
    } catch (error) {
      initialized = true
      setClientStateIsPrimary(false)
      resetLoadedState()
      console.warn("[client-state] failed to initialize client state", error)
    }
  })()
  return initialization
}

export { clientStateIsPrimary, loadedClientSnapshotExists, loadedRestorableSession, restorePreviousStateEnabled }

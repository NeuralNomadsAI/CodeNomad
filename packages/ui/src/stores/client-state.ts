import { createSignal } from "solid-js"
import { clearNativeClientState, commitNativeClientStatePartitions, loadNativeClientState, loadNativeClientStatePartition,
  loadNativeFileDrafts, saveNativeFileDraft, saveNativeClientState, setNativeRestoreEnabled } from "../lib/native/client-state"
import { decodeClientSnapshot, normalizeRestorableSession } from "./client-state-codec"
import type { ClientSnapshotV1, RestorableSessionState, RestorableSidecarTabState, RestorableTabState, RestorableWorkspaceTabState } from "./client-state-codec"
import { canCommitClientSnapshotV2, createClientSnapshotV2Encoder, decodeClientSnapshotV2, isClientSnapshotV2 } from "./client-state-partitions"
import type { ClientSnapshotV2, EncodedClientSnapshotV2 } from "./client-state-partitions"
import { LEGACY_SESSION_PREVIEWS_KEY, SESSION_BROWSER_STATE_KEY, mergeSessionBrowsers, tabPreviewModes } from "./tab-view-state-codec"
import { migrateLegacyTabPreviews } from "./tab-view-state-migration"
import { changeWorkspaceFileDrafts, MAX_FILE_DRAFT_BYTES, normalizeWorkspaceFileDrafts, type WorkspaceFileDraft } from "./workspace-file-drafts-codec"
export type { ClientSnapshotV1, RestorableSessionState, RestorableSidecarTabState, RestorableTabState, RestorableWorkspaceTabState }
export type { ClientSnapshotV2 }
const SAVE_DEBOUNCE_MS = 250
const SAVE_MAX_WAIT_MS = 500
const FLUSH_MAX_ATTEMPTS = 3
const MAX_V1_SNAPSHOT_BYTES = 1024 * 1024
const MAX_LAYOUT_ENTRIES = 64
const MAX_LAYOUT_KEY_LENGTH = 256
export const MAX_LAYOUT_VALUE_LENGTH = 4096
const LEGACY_LAYOUT_KEY_PREFIX = "opencode-session-"
const UNSAFE_LAYOUT_KEYS = new Set(["__proto__", "constructor", "prototype"])
const [clientStateIsPrimary, setClientStateIsPrimary] = createSignal(true)
const [restorePreviousStateEnabled, setRestorePreviousStateEnabledSignal] = createSignal(false)
const [loadedClientSnapshotExists, setLoadedClientSnapshotExists] = createSignal(false)
const [loadedRestorableSession, setLoadedRestorableSession] = createSignal<RestorableSessionState | null>(null)
let initialized = false
let initialization: Promise<void> | null = null
let layout: Record<string, string> = Object.create(null)
let fileDrafts: WorkspaceFileDraft[] = []
const FILE_DRAFTS_KEY = "codenomad.workspace-file-drafts.v1"
export class WorkspaceDraftFlushError extends Error {}
type DraftValue = Omit<WorkspaceFileDraft, "key"> | null
type DraftWrite = { value: DraftValue; base: { value: DraftValue }; finish: (ok: boolean) => void }
const nativeDraftBase = new Map<string, { value: DraftValue }>()
const nativeDraftReads = new Map<string, Promise<WorkspaceFileDraft | undefined>>()
const pendingFileDrafts = new Map<string, DraftWrite>()
const inflightFileDrafts = new Map<string, DraftWrite>()
const keptFileDrafts = new Map<string, DraftWrite>()
const refusedFileDrafts = new Set<string>()
let draftTimer: ReturnType<typeof setTimeout> | undefined
let draftWrites = Promise.resolve()
let revision = 0
let dirty = false
let writeBlock: false | "snapshot" | "transaction" = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveDeadline: number | undefined
let saveDue = false
let snapshotWritePending = false
let writeQueue: Promise<void> = Promise.resolve()
let destructiveQueue: Promise<void> = Promise.resolve()
let lastSaveError: unknown
let partitionProtocolVersion: 1 | undefined
let encodeSnapshot = createClientSnapshotV2Encoder()
// Only the last root's keys stay confirmed: publication may sweep older keys.
let confirmedPartitionKeys: ReadonlySet<string> | undefined
async function commitSnapshot(snapshot: EncodedClientSnapshotV2): Promise<boolean> {
  const known = confirmedPartitionKeys
  confirmedPartitionKeys = undefined
  const send = (partitions: Record<string, string>) => commitNativeClientStatePartitions({
    protocolVersion: 1, snapshot: snapshot.root, partitions, partitionKeys: snapshot.partitionKeys,
  })
  if (known) {
    const missing = snapshot.partitionKeys.filter(key => !known.has(key))
    if (missing.length < snapshot.partitionKeys.length) {
      try {
        if (await send(Object.fromEntries(missing.map(key => [key, snapshot.partitions[key]!])))) {
          confirmedPartitionKeys = new Set(snapshot.partitionKeys)
          return true
        }
      } catch {
        // The host may have lost or swept a key, or may require full commits.
      }
    }
  }
  const accepted = await send(snapshot.partitions)
  if (accepted) confirmedPartitionKeys = new Set(snapshot.partitionKeys)
  return accepted
}
// Content of the last accepted partitioned commit (root without revision/savedAt):
// status-only captures re-encode to the same graph and need no native write.
let committedContent: string | null = null
// A skipped save leaves the host copy unverified: the next explicit flush republishes it.
let republishOnFlush = false
const layoutMigrations = new Map<string, { source: string; remaining: string | null }>()
// Browser tabs restore their session from sessionStorage while layout values keep
// their shared localStorage entries, written and read immediately.
let snapshotOwnsLayout = true
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
  useLocalStorage(false, (storage) => { storage.setItem(key, value); return true })
const removeLegacyLayoutValue = (key: string) =>
  useLocalStorage(undefined, (storage) => storage.removeItem(key))
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
  saveDeadline = undefined
  saveDue = false
}

// Explicit flushes (navigation, close, host requests) verify even unchanged
// graphs on the host; debounced saves can skip them.
function enqueuePendingSave(republish = false): Promise<void> {
  cancelSaveTimer()
  if (!dirty || !canWriteSnapshot()) return writeQueue
  const snapshot: ClientSnapshotV1 = {
    version: 1,
    revision: ++revision,
    savedAt: Date.now(),
    layout: { ...layout },
    session: partitionProtocolVersion === 1 ? loadedRestorableSession() : withoutPartitionCaches(loadedRestorableSession()),
  }
  const normalizedSnapshot = decodeClientSnapshot(snapshot)
  if (!normalizedSnapshot) {
    lastSaveError = new Error("Client snapshot normalization failed")
    return Promise.reject(lastSaveError)
  }
  layout = { ...normalizedSnapshot.layout }
  dirty = false
  const save = async () => {
    try {
      const partitioned = partitionProtocolVersion === 1 ? await encodeSnapshot(normalizedSnapshot) : null
      const content = partitioned && JSON.stringify({ ...partitioned.root, revision: 0, savedAt: 0 })
      if (!republish && content && content === committedContent) {
        lastSaveError = undefined
        republishOnFlush = true
        return
      }
      if (partitioned && !canCommitClientSnapshotV2(partitioned)) {
        throw new Error("Client snapshot exceeds the native partition count or size limits")
      }
      if (!partitioned && new TextEncoder().encode(JSON.stringify(normalizedSnapshot)).byteLength > MAX_V1_SNAPSHOT_BYTES) {
        throw new Error("Client snapshot exceeds the V1 1 MiB limit and partition persistence is unavailable")
      }
      committedContent = null
      const accepted = partitioned
        ? await commitSnapshot(partitioned)
        : await saveNativeClientState(normalizedSnapshot)
      if (!accepted) {
        setClientStateIsPrimary(false)
        throw new Error("Native client state save was rejected")
      }
      committedContent = content || null
      republishOnFlush = false
      lastSaveError = undefined
      // Retire the legacy entries only after a snapshot carrying descriptor views
      // is durably accepted. Changed concurrent legacy writes retain their authority.
      if (layoutMigrations.size && normalizedSnapshot.session?.tabs.some(tab => tab.kind === "workspace" && tab.viewState)) {
        const migrations = [...layoutMigrations]
        layoutMigrations.clear()
        for (const [key, migration] of migrations) if ((snapshotOwnsLayout ? layout[key] : readLegacyLayoutValue(key)) === migration.source) {
          const concurrent = readLegacyLayoutValue(key)
          const remaining = concurrent !== null && concurrent !== migration.source ? concurrent : migration.remaining
          if (remaining === null) removeClientLayoutValue(key)
          else writeClientLayoutValue(key, remaining)
        }
      }
    } catch (error) {
      dirty = true
      lastSaveError = error
      throw error
    } finally {
      snapshotWritePending = false
      if (saveDue) {
        saveDue = false
        if (dirty) scheduleSave()
      }
    }
  }
  // Web saves write sessionStorage before the first await, including during pagehide.
  if (snapshotOwnsLayout) snapshotWritePending = true
  const saveAttempt = snapshotOwnsLayout ? Promise.resolve().then(save) : save()
  writeQueue = saveAttempt.catch(() => undefined)
  return saveAttempt
}

function withoutPartitionCaches(state: RestorableSessionState | null): RestorableSessionState | null {
  return state && { ...state, tabs: state.tabs.map(tab => {
    if (tab.kind !== "workspace") return tab
    const { outlineIndexes: _, sessionCatalog: _catalog, ...rest } = tab
    return rest
  }) }
}

function scheduleSave() {
  dirty = true
  if (!canWriteSnapshot() || saveDue) return
  const now = performance.now()
  saveDeadline ??= now + SAVE_MAX_WAIT_MS
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    // Keep the deadline, but capture only the latest state once the write settles.
    if (snapshotWritePending) {
      saveDue = true
      return
    }
    void enqueuePendingSave().catch((error) => console.warn("[client-state] failed to save client snapshot", error))
  }, Math.min(SAVE_DEBOUNCE_MS, saveDeadline - now))
}
function resetLoadedState(snapshot: ClientSnapshotV1 | null = null, resetRevision = false) {
  confirmedPartitionKeys = undefined
  encodeSnapshot = createClientSnapshotV2Encoder()
  committedContent = null
  republishOnFlush = false
  layout = snapshot ? { ...snapshot.layout } : Object.create(null)
  if (resetRevision) revision = snapshot?.revision ?? 0
  setLoadedClientSnapshotExists(snapshot !== null)
  setLoadedRestorableSession(snapshot?.session ?? null)
}
async function executeDestructiveTransaction(operation: () => Promise<boolean>, rejectedMessage: string, loseOwnershipOnRejection = false): Promise<void> {
  const previousWriteBlock = writeBlock
  let retryDirty = dirty
  writeBlock = "transaction"
  committedContent = null
  republishOnFlush = false
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
    if (snapshotOwnsLayout) useLocalStorage(undefined, (storage) => {
      for (const key of legacyLayoutKeys(storage)) storage.removeItem(key)
    })
    resetLoadedState()
    transactionLayoutWrites.clear()
    writeBlock = "snapshot"
  } catch (error) {
    retryDirty ||= dirty
    for (const key of transactionLayoutWrites) {
      if (hasLayoutKey(key)) writeLegacyLayoutValue(key, layout[key]!)
      else removeLegacyLayoutValue(key)
    }
    transactionLayoutWrites.clear()
    writeBlock = previousWriteBlock
    dirty = retryDirty
    // The host copy is unknown after a failed operation, even if a save that was in
    // flight recorded a commit meanwhile: the next save or flush rewrites it.
    committedContent = null
    confirmedPartitionKeys = undefined
    republishOnFlush = true
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

export function restoredWorkspaceFileDraft(key: string) {
  if (!restorePreviousStateEnabled()) return
  const queued = pendingFileDrafts.get(key) ?? inflightFileDrafts.get(key)
  if (queued) return queued.value ? { key, ...queued.value } : undefined
  if (!snapshotOwnsLayout) return fileDrafts.find(draft => draft.key === key)
}

export async function refreshWorkspaceFileDraft(key: string) {
  if (!snapshotOwnsLayout || !clientStateIsPrimary() || !restorePreviousStateEnabled()) return restoredWorkspaceFileDraft(key)
  const existing = nativeDraftReads.get(key)
  if (existing) return existing
  const base = nativeDraftBase.get(key)
  const expected = base?.value
  const reading = (async () => {
    const fresh = await loadNativeFileDrafts(key)?.catch(() => undefined)
    const pending = pendingFileDrafts.has(key) || inflightFileDrafts.has(key)
    if (fresh && !pending && !refusedFileDrafts.has(key) && nativeDraftBase.get(key) === base && base?.value === expected) {
      const next = normalizeWorkspaceFileDrafts(fresh).find(entry => entry.key === key)
      if (next) nativeDraftBase.set(key, { value: { fingerprint: next.fingerprint, text: next.text } })
      else nativeDraftBase.delete(key)
      return next
    }
    return restoredWorkspaceFileDraft(key)
  })().finally(() => nativeDraftReads.delete(key))
  nativeDraftReads.set(key, reading)
  return reading
}

export function keepRecoveredWorkspaceFileDraft({ key, fingerprint, text }: WorkspaceFileDraft) {
  const base = nativeDraftBase.get(key)
  if (!base || keptFileDrafts.has(key) || pendingFileDrafts.has(key) || inflightFileDrafts.has(key)
    || base.value?.fingerprint !== fingerprint || base.value.text !== text) return
  keptFileDrafts.set(key, { base, value: { fingerprint, text }, finish: () => {} })
}

/** Keep admitted drafts intact if a new or larger draft exceeds the storage budget. */
export function updateWorkspaceFileDraft(key: string, value: DraftValue, finish: (ok: boolean) => void): boolean {
  if (!initialized || !clientStateIsPrimary()) return false
  if (value && !changeWorkspaceFileDrafts([], key, value)) {
    keptFileDrafts.delete(key)
    pendingFileDrafts.delete(key)
    inflightFileDrafts.delete(key)
    refusedFileDrafts.add(key)
    return false
  }
  const base = nativeDraftBase.get(key) ?? { value: null }
  if (!restorePreviousStateEnabled() && value) {
    if (pendingFileDrafts.size >= 32 && !pendingFileDrafts.has(key)) {
      inflightFileDrafts.delete(key)
      refusedFileDrafts.add(key)
      return false
    }
    refusedFileDrafts.delete(key)
    keptFileDrafts.delete(key)
    pendingFileDrafts.set(key, { value, base, finish })
    return true
  }
  const queued = pendingFileDrafts.get(key) ?? inflightFileDrafts.get(key)
  const previous = queued ? queued.value : base.value
  if (!snapshotOwnsLayout) {
    pendingFileDrafts.delete(key)
    const next = changeWorkspaceFileDrafts(fileDrafts, key, value)
    try {
      if (!next) throw new Error("Draft budget exceeded")
      window.sessionStorage.setItem(FILE_DRAFTS_KEY, JSON.stringify(next))
      fileDrafts = next
      refusedFileDrafts.delete(key)
      return true
    } catch { refusedFileDrafts.add(key); return false }
  }
  // The host decides the shared profile limit under its ownership lock.
  if (!refusedFileDrafts.has(key)
    && previous?.text === value?.text && previous?.fingerprint === value?.fingerprint) return true
  keptFileDrafts.delete(key)
  nativeDraftBase.set(key, base)
  pendingFileDrafts.set(key, { value, base, finish })
  clearTimeout(draftTimer)
  draftTimer = setTimeout(flushWorkspaceFileDrafts, SAVE_DEBOUNCE_MS)
  return true
}

function flushWorkspaceFileDrafts() {
  clearTimeout(draftTimer)
  const changes = [...pendingFileDrafts].filter(([, change]) => restorePreviousStateEnabled() || !change.value)
  if (!snapshotOwnsLayout) {
    pendingFileDrafts.clear()
    for (const [key, { value, finish }] of changes) finish(updateWorkspaceFileDraft(key, value, finish))
    return draftWrites
  }
  for (const [key] of changes) pendingFileDrafts.delete(key)
  if (!changes.length) return draftWrites
  for (const [key, change] of changes) {
    inflightFileDrafts.set(key, change)
    nativeDraftBase.set(key, change.base)
  }
  draftWrites = draftWrites.then(async () => {
    for (const [key, change] of changes) {
      const { value, base, finish } = change
      const accepted = await (saveNativeFileDraft({ key, draft: value, expected: base.value })?.catch(() => false) ?? false)
      if (accepted) base.value = value
      if (inflightFileDrafts.get(key) === change) {
        inflightFileDrafts.delete(key)
        if (!pendingFileDrafts.has(key)) {
          if (accepted) {
            refusedFileDrafts.delete(key)
            if (value) keptFileDrafts.set(key, change)
            if (!value && nativeDraftBase.get(key) === base) nativeDraftBase.delete(key)
          } else if (value && !restorePreviousStateEnabled()) {
            pendingFileDrafts.set(key, change)
            continue
          } else {
            refusedFileDrafts.add(key)
            if (!value) pendingFileDrafts.set(key, change)
          }
          finish(accepted)
        }
      }
    }
  })
  return draftWrites
}

async function loadWorkspaceFileDrafts() {
  if (snapshotOwnsLayout) return
  try {
    const raw = window.sessionStorage.getItem(FILE_DRAFTS_KEY)
    fileDrafts = raw && raw.length <= MAX_FILE_DRAFT_BYTES ? normalizeWorkspaceFileDrafts(JSON.parse(raw)) : []
  } catch { fileDrafts = [] }
}

export function readClientLayoutValue(key: string): string | null {
  if (!isValidLayoutKey(key)) return null
  if (!clientStateIsPrimary() || !snapshotOwnsLayout) return readLegacyLayoutValue(key)
  if (!restorePreviousStateEnabled() || writeBlock) return null
  if (hasLayoutKey(key)) return layout[key] ?? null
  const legacyValue = readLegacyLayoutValue(key)
  if (legacyValue === null || layoutIsFull()) return legacyValue
  layout[key] = legacyValue
  scheduleSave()
  return legacyValue
}

export function writeClientLayoutValue(key: string, value: string): boolean {
  if (!isValidLayoutKey(key) || value.length > MAX_LAYOUT_VALUE_LENGTH) return false
  if (!clientStateIsPrimary() || !snapshotOwnsLayout) return writeLegacyLayoutValue(key, value)
  if (writeBlock === "transaction") {
    if (!hasLayoutKey(key) && layoutIsFull()) return false
    dirty ||= layout[key] !== value
    layout[key] = value
    transactionLayoutWrites.add(key)
    return true
  }
  if (!restorePreviousStateEnabled() || writeBlock) return false
  if (!hasLayoutKey(key) && layoutIsFull()) return false
  writeLegacyLayoutValue(key, value)
  if (layout[key] === value) return true
  layout[key] = value
  scheduleSave()
  return true
}

export function removeClientLayoutValue(key: string): void {
  if (!isValidLayoutKey(key)) return
  if (!clientStateIsPrimary() || !snapshotOwnsLayout) return removeLegacyLayoutValue(key)
  if (writeBlock === "transaction") {
    dirty ||= hasLayoutKey(key)
    delete layout[key]
    transactionLayoutWrites.add(key)
    return
  }
  if (!restorePreviousStateEnabled() || writeBlock) return
  removeLegacyLayoutValue(key)
  if (!hasLayoutKey(key)) return
  delete layout[key]
  scheduleSave()
}

export async function flushWorkspaceFileDraftsForClose(): Promise<void> {
  if (!snapshotOwnsLayout) return
  await flushWorkspaceFileDrafts()
  if (!restorePreviousStateEnabled()) return
  if (refusedFileDrafts.size) throw new WorkspaceDraftFlushError("Workspace file drafts could not be retained")
  if (!keptFileDrafts.size && !pendingFileDrafts.size && !inflightFileDrafts.size) return
  const fresh = await loadNativeFileDrafts()?.catch(() => undefined)
  if (!fresh) throw new WorkspaceDraftFlushError("Workspace file drafts could not be checked")
  const latest = new Map(normalizeWorkspaceFileDrafts(fresh).map(draft => [draft.key, draft]))
  for (const [key, change] of keptFileDrafts) {
    const stored = latest.get(key)
    const { value } = change
    if (stored?.fingerprint === value?.fingerprint && stored?.text === value?.text) continue
    if (!stored && keptFileDrafts.get(key) === change
      && await saveNativeFileDraft({ key, draft: value, expected: null })?.catch(() => false)) continue
    change.finish(false)
    throw new WorkspaceDraftFlushError("A workspace file draft changed in another window")
  }
  if (refusedFileDrafts.size || pendingFileDrafts.size || inflightFileDrafts.size) {
    throw new WorkspaceDraftFlushError("A newer workspace file draft is not confirmed")
  }
}

export async function flushClientState(): Promise<void> {
  cancelSaveTimer()
  if (!snapshotOwnsLayout) return enqueuePendingSave(true)
  for (let attempts = 0; ; attempts += 1) {
    while (true) {
      const pending = writeQueue
      await pending
      if (pending === writeQueue) break
    }
    if (republishOnFlush && canWriteSnapshot()) dirty = true
    if (!dirty || !canWriteSnapshot()) {
      if (lastSaveError !== undefined) throw lastSaveError
      return
    }
    if (attempts === FLUSH_MAX_ATTEMPTS) {
      throw lastSaveError ?? new Error("Client state remained dirty after the final flush attempt")
    }
    try {
      await enqueuePendingSave(true)
    } catch {
      // Re-read the outcome after the queue settles: a newer write can supersede this attempt.
    }
  }
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
      await flushWorkspaceFileDrafts()
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
      partitionProtocolVersion = loaded.partitionProtocolVersion
      snapshotOwnsLayout = loaded.webSession !== true
      setClientStateIsPrimary(loaded.isPrimary)
      setRestorePreviousStateEnabledSignal(loaded.restoreEnabled)
      resetLoadedState(null, true)
      dirty = false
      lastSaveError = undefined
      writeBlock = false
      transactionLayoutWrites.clear()
      layoutMigrations.clear()
      initialized = true
      if (loaded.isPrimary) await loadWorkspaceFileDrafts()
      if (!loaded.isPrimary || !loaded.restoreEnabled) return
      let snapshot: ClientSnapshotV1 | null
      const verified = new Set<string>()
      if (isClientSnapshotV2(loaded.snapshot)) {
        writeBlock = "snapshot"
        try {
          snapshot = await decodeClientSnapshotV2(
            loaded.snapshot,
            loaded.partitionProtocolVersion,
            loadNativeClientStatePartition,
            key => verified.add(key),
          )
        } catch (error) {
          snapshot = null
          console.warn("[client-state] failed to load client snapshot partition", error)
        }
        if (snapshot) writeBlock = false
      } else {
        snapshot = decodeClientSnapshot(loaded.snapshot)
        writeBlock = loaded.snapshot !== null && snapshot === null ? "snapshot" : false
      }
      if (loaded.recreateWebRecords) {
        for (const tab of snapshot?.session?.tabs ?? []) if (tab.kind === "workspace") delete tab.workspaceId
      }
      resetLoadedState(snapshot && !snapshotOwnsLayout ? { ...snapshot, layout: {} } : snapshot, true)
      if (snapshot && verified.size) confirmedPartitionKeys = verified
      if (!writeBlock) {
        const migratedLayout = snapshotOwnsLayout && migrateLegacyLayoutValues()
        const source = readClientLayoutValue(LEGACY_SESSION_PREVIEWS_KEY)
        const migration = migrateLegacyTabPreviews(loadedRestorableSession(), source ?? null, readClientLayoutValue)
        if (migration) {
          if (source !== null) layoutMigrations.set(LEGACY_SESSION_PREVIEWS_KEY, { source, remaining: migration.remaining })
          for (const { key, source } of migration.missions) layoutMigrations.set(key, { source, remaining: null })
          setLoadedRestorableSession(migration.state)
        }
        const session = loadedRestorableSession()
        if (session) {
          const tabs = session.tabs
          const ordered = [tabs[session.activeTabIndex], ...tabs.filter((_, index) => index !== session.activeTabIndex)]
          const views = ordered.flatMap(tab => tab?.kind === "workspace" && (!tab.backendId || tab.backendId === "local") ? [tab.viewState] : [])
          if (views.some(view => Object.values(view?.previews ?? {}).some(p => p.targetUrl))) {
            const value = mergeSessionBrowsers(views, readClientLayoutValue(SESSION_BROWSER_STATE_KEY))
            if (writeClientLayoutValue(SESSION_BROWSER_STATE_KEY, value)) {
              setLoadedRestorableSession({ ...session, tabs: tabs.map(tab => tab.kind === "workspace" && (!tab.backendId || tab.backendId === "local") && tab.viewState
                ? { ...tab, viewState: tabPreviewModes(tab.viewState) } : tab) })
              scheduleSave()
            }
          }
        }
        if (migratedLayout || migration) scheduleSave()
      }
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

// Client state of a plain browser tab, kept in its sessionStorage: it survives
// reloads and mobile page discards of that tab, and ends when the tab closes.
// Each tab owns its own state, so every tab is primary.

const SNAPSHOT_KEY = "codenomad.client-state.v1"
const RESTORE_DISABLED_KEY = "codenomad.client-state.restore-disabled"
const RELEASED_KEY = "codenomad.client-state.records-released"

type WebSessionClientState = { restoreEnabled: boolean; snapshot: unknown | null; recreateWebRecords?: true }

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

let departing = false
let restored = false

/** Null when this tab has no usable sessionStorage. */
export function loadWebSessionClientState(): WebSessionClientState | null {
  const storage = sessionStore()
  if (!storage) return null
  try {
    const raw = storage.getItem(SNAPSHOT_KEY)
    let snapshot: unknown = null
    try { snapshot = raw ? JSON.parse(raw) : null } catch { /* An unreadable snapshot restores nothing. */ }
    const released = storage.getItem(RELEASED_KEY) !== null
    const recreate = (document as Document & { wasDiscarded?: boolean }).wasDiscarded !== true || released
    // If a fresh restore is itself discarded before it saves, its inherited IDs stay ineligible.
    if (recreate && snapshot && !released) write(storage => storage.setItem(RELEASED_KEY, "1"))
    return { restoreEnabled: storage.getItem(RESTORE_DISABLED_KEY) !== "true", snapshot,
      ...(recreate ? { recreateWebRecords: true } : {}) }
  } catch {
    return null
  }
}

function write(operation: (storage: Storage) => void): boolean {
  const storage = sessionStore()
  if (!storage) return false
  try {
    operation(storage)
    return true
  } catch {
    return false
  }
}

/** False when the browser refuses the write (quota, storage disabled). */
export const saveWebSessionClientState = (snapshot: unknown): boolean =>
  write(storage => {
    storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
    if (restored && !departing) storage.removeItem(RELEASED_KEY)
  })

export function markWebSessionRecordsReleased(): boolean {
  departing = true
  if (!sessionStore()) return true
  return write(storage => storage.setItem(RELEASED_KEY, "1"))
}

export function completeWebSessionRestore(): void {
  restored = true
}

export const clearWebSessionClientState = (): boolean =>
  write(storage => storage.removeItem(SNAPSHOT_KEY))

export const setWebSessionRestoreEnabled = (enabled: boolean): boolean =>
  write(storage => {
    if (enabled) return storage.removeItem(RESTORE_DISABLED_KEY)
    storage.setItem(RESTORE_DISABLED_KEY, "true")
    storage.removeItem(SNAPSHOT_KEY)
  })

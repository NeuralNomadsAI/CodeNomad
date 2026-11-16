// Client state of a plain browser tab, kept in its sessionStorage: it survives
// reloads and mobile page discards of that tab, and ends when the tab closes.
// Each tab owns its own state, so every tab is primary.

const SNAPSHOT_KEY = "codenomad.client-state.v1"
const RESTORE_DISABLED_KEY = "codenomad.client-state.restore-disabled"

export type WebSessionClientState = { restoreEnabled: boolean; snapshot: unknown | null }

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Null when this tab has no usable sessionStorage. */
export function loadWebSessionClientState(): WebSessionClientState | null {
  const storage = sessionStore()
  if (!storage) return null
  try {
    const raw = storage.getItem(SNAPSHOT_KEY)
    let snapshot: unknown = null
    try { snapshot = raw ? JSON.parse(raw) : null } catch { /* An unreadable snapshot restores nothing. */ }
    return { restoreEnabled: storage.getItem(RESTORE_DISABLED_KEY) !== "true", snapshot }
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
  write(storage => storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot)))

export const clearWebSessionClientState = (): boolean =>
  write(storage => storage.removeItem(SNAPSHOT_KEY))

export const setWebSessionRestoreEnabled = (enabled: boolean): boolean =>
  write(storage => {
    if (enabled) return storage.removeItem(RESTORE_DISABLED_KEY)
    storage.setItem(RESTORE_DISABLED_KEY, "true")
    storage.removeItem(SNAPSHOT_KEY)
  })

import { generateUUID } from "./client-identity"

// Client state of a plain browser tab, kept in its sessionStorage: it survives
// reloads and mobile page discards of that tab, and ends when the tab closes.
// Each tab owns its own state, so every tab is primary.

const SNAPSHOT_KEY = "codenomad.client-state.v1"
const RESTORE_DISABLED_KEY = "codenomad.client-state.restore-disabled"
const PAGE_KEY = "codenomad.client-state.page"

export type WebSessionClientState = { restoreEnabled: boolean; snapshot: unknown | null }

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

let recordClaim: Promise<boolean> | undefined
let copiedPageId: string | undefined

/** Web Locks require a secure context; on LAN HTTP, ask the live same-origin page. */
function claimBroadcastPage(id: string): Promise<boolean> {
  return new Promise(resolve => {
    const channel = new BroadcastChannel(`${PAGE_KEY}:${id}`)
    const contender = generateUUID()
    let owns = false
    const finish = (claimed: boolean) => {
      clearTimeout(timer)
      owns = claimed
      if (!claimed) channel.close()
      resolve(claimed)
    }
    const timer = setTimeout(() => finish(true), 100)
    channel.onmessage = ({ data }: MessageEvent<{ claim?: string; occupied?: string }>) => {
      if (data.claim) {
        if (owns || contender < data.claim) channel.postMessage({ occupied: data.claim })
        else finish(false)
      } else if (!owns && data.occupied === contender) finish(false)
    }
    window.addEventListener("pagehide", function close(event) {
      if (event.persisted) return
      window.removeEventListener("pagehide", close)
      channel.close()
    })
    channel.postMessage({ claim: contender })
  })
}

/** A duplicated tab inherits both the snapshot and its owner's lock name. */
export function claimWebSessionRecords(): Promise<boolean> {
  return recordClaim ??= (async () => {
    const storage = sessionStore()
    if (!storage) return false
    const acquire = (id: string) => !navigator.locks ? claimBroadcastPage(id) : new Promise<boolean>((resolve, reject) => {
      void navigator.locks.request(`${PAGE_KEY}:${id}`, { ifAvailable: true }, lock => {
        resolve(Boolean(lock))
        if (lock) return new Promise<void>(release => {
          const onHide = (event: PageTransitionEvent) => {
            if (event.persisted) return
            window.removeEventListener("pagehide", onHide)
            release()
          }
          window.addEventListener("pagehide", onHide)
        })
      }).catch(reject)
    })
    const existing = storage.getItem(PAGE_KEY)
    if (existing && await acquire(existing)) return true
    const id = generateUUID()
    if (!existing) storage.setItem(PAGE_KEY, id)
    if (!await acquire(id)) return false
    // A duplicate keeps the inherited name until its own snapshot replaces
    // the copied IDs, so reloading during restoration still detects the copy.
    if (existing) copiedPageId = id
    return !existing
  })().catch(() => false)
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
  write(storage => {
    storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
    if (copiedPageId) {
      storage.setItem(PAGE_KEY, copiedPageId)
      copiedPageId = undefined
    }
  })

export const clearWebSessionClientState = (): boolean =>
  write(storage => storage.removeItem(SNAPSHOT_KEY))

export const setWebSessionRestoreEnabled = (enabled: boolean): boolean =>
  write(storage => {
    if (enabled) return storage.removeItem(RESTORE_DISABLED_KEY)
    storage.setItem(RESTORE_DISABLED_KEY, "true")
    storage.removeItem(SNAPSHOT_KEY)
  })

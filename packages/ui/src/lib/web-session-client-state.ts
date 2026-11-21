import { generateUUID } from "./client-identity"

// Client state of a plain browser tab, kept in its sessionStorage: it survives
// reloads and mobile page discards of that tab, and ends when the tab closes.
// Each tab owns its own state, so every tab is primary.

const SNAPSHOT_KEY = "codenomad.client-state.v1"
const RESTORE_DISABLED_KEY = "codenomad.client-state.restore-disabled"
const PAGE_KEY = "codenomad.client-state.page"
const RELEASED_KEY = "codenomad.client-state.records-released"

export type WebSessionClientState = { restoreEnabled: boolean; snapshot: unknown | null; recordsReleased: boolean }

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

let recordClaim: Promise<boolean> | undefined
let copiedPageId: string | undefined
let departing = false
let restored = false

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
    // A copied snapshot must still create fresh records if this page is discarded during restore.
    if (existing) storage.setItem(RELEASED_KEY, "1")
    if (!await acquire(id)) return false
    copiedPageId = id
    return false
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
    return { restoreEnabled: storage.getItem(RESTORE_DISABLED_KEY) !== "true", snapshot,
      recordsReleased: storage.getItem(RELEASED_KEY) !== null }
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
    if (restored && !departing) storage.removeItem(RELEASED_KEY)
  })

export function markWebSessionRecordsReleased(): boolean {
  departing = true
  if (!sessionStore()) return true
  return write(storage => storage.setItem(RELEASED_KEY, "1"))
    || write(storage => storage.removeItem(PAGE_KEY)) // Quota can prevent a new key.
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

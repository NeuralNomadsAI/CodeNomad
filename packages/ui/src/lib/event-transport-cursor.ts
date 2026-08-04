let cursor: string | undefined
let owner = 0
let scope: string | undefined
let persistence: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined

const STORAGE_KEY_PREFIX = "codenomad:event-cursor:"

export interface EventTransportCursorAuthority {
  read: () => string | undefined
  commit: (next?: string) => boolean
}

function getCursorStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  try {
    if (globalThis.sessionStorage) return globalThis.sessionStorage
  } catch {}
  try {
    if (globalThis.localStorage) return globalThis.localStorage
  } catch {}
  return undefined
}

function readPersistedCursor(storage: typeof persistence, key: string): string | undefined {
  try {
    return storage?.getItem(key) || undefined
  } catch {
    return undefined
  }
}

export function acquireEventTransportCursorAuthority(
  nextScope = "default",
  storage = getCursorStorage(),
): EventTransportCursorAuthority {
  if (scope !== nextScope || persistence !== storage) {
    scope = nextScope
    persistence = storage
    cursor = readPersistedCursor(storage, `${STORAGE_KEY_PREFIX}${nextScope}`)
  }
  const token = ++owner
  return {
    read: () => cursor,
    commit(next) {
      if (token !== owner) return false
      cursor = next || undefined
      try {
        if (cursor) persistence?.setItem(`${STORAGE_KEY_PREFIX}${nextScope}`, cursor)
        else persistence?.removeItem(`${STORAGE_KEY_PREFIX}${nextScope}`)
      } catch {}
      return true
    },
  }
}

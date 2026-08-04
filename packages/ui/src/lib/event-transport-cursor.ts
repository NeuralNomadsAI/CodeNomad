let cursor: string | undefined
let owner = 0

export interface EventTransportCursorAuthority {
  read: () => string | undefined
  commit: (next: string) => boolean
}

export function acquireEventTransportCursorAuthority(): EventTransportCursorAuthority {
  const token = ++owner
  return {
    read: () => cursor,
    commit(next) {
      if (!next || token !== owner) return false
      cursor = next
      return true
    },
  }
}

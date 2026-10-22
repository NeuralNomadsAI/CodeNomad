import type { ToastHandle } from "../lib/notifications"

/** Enough recent compactions to cover replays; older identities are forgotten first. */
const REMEMBERED_COMPACTIONS = 256

interface CompactionEndIdentity {
  id: string
  durable?: { aggregateID: string; seq: number }
  data: { sessionID: string }
}

/**
 * A compaction's end reaches a window once per project tab open on its folder,
 * and again when the event stream replays it. Its durable position (or event
 * ID) identifies it: only the first delivery may notify.
 */
export function createCompactionNoticeClaims(limit = REMEMBERED_COMPACTIONS) {
  const claimed = new Set<string>()
  return (event: CompactionEndIdentity): boolean => {
    const key = event.durable
      ? `${event.durable.aggregateID}\0${event.durable.seq}`
      : `${event.data.sessionID}\0${event.id}`
    if (claimed.has(key)) return false
    claimed.add(key)
    if (claimed.size > limit) claimed.delete(claimed.values().next().value!)
    return true
  }
}

/**
 * One bubble per session: a later notice replaces the one still shown. Each is
 * forgotten when it expires, unless a newer one replaced it; a notice routed
 * away from the screen leaves nothing to replace.
 */
export function createSessionBubbles(schedule: (expire: () => void, ms: number) => void = (expire, ms) => { setTimeout(expire, ms) }) {
  const shown = new Map<string, ToastHandle>()
  return {
    show(sessionID: string, durationMs: number, notify: () => ToastHandle) {
      shown.get(sessionID)?.dismiss()
      shown.delete(sessionID)
      const handle = notify()
      if (!handle.id) return
      shown.set(sessionID, handle)
      schedule(() => { if (shown.get(sessionID) === handle) shown.delete(sessionID) }, durationMs)
    },
    get size() { return shown.size },
  }
}

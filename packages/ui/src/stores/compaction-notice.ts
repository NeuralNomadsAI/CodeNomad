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

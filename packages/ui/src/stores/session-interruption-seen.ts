import { createSignal } from "solid-js"
import type { Session } from "../types/session"

// Seen native interruptions, keyed by the native idle boundary they ended at. Seeing one
// only hides its badge: the native outcome and the recovery marker stay untouched, a
// later boundary shows the badge again, and refreshes, which keep the boundary, do not.
type Seen = Map<string, Map<string, number | null>>
type Interruptible = Pick<Session, "id" | "generationRecovery" | "time" | "status" | "pendingPermission" | "pendingForm" | "retry">

const [seenInterruptions, setSeenInterruptions] = createSignal<Seen>(new Map())
const eventBoundaries = new Map<string, Map<string, number>>()

/** Tracks every change, for persistence. */
export const seenInterruptionsRevision = seenInterruptions

const boundary = (instanceId: string, session: Interruptible) => Math.max(
  session.time?.idle ?? 0, eventBoundaries.get(instanceId)?.get(session.id) ?? 0,
)

function update(instanceId: string, change: (entries: Map<string, number | null>) => boolean): void {
  setSeenInterruptions((prev) => {
    const entries = new Map(prev.get(instanceId))
    if (!change(entries)) return prev
    const next = new Map(prev)
    if (entries.size) next.set(instanceId, entries)
    else next.delete(instanceId)
    return next
  })
}

export function isSessionInterruptionUnseen(instanceId: string, session: Interruptible): boolean {
  if (session.generationRecovery !== "interrupted" || session.status !== "idle"
    || session.pendingPermission || session.pendingForm || session.retry) return false
  const seen = seenInterruptions().get(instanceId)?.get(session.id)
  return seen == null || boundary(instanceId, session) > seen
}

export function markSessionInterruptionSeen(instanceId: string, session: Interruptible): void {
  if (!isSessionInterruptionUnseen(instanceId, session)) return
  update(instanceId, (entries) => {
    entries.set(session.id, boundary(instanceId, session))
    return true
  })
}

/** Native terminal boundaries advance monotonically, including within one millisecond.
 * Keep the event's boundary until SessionInfo catches up, so that read preserves a clear. */
export function observeSessionInterruption(instanceId: string, session: Interruptible, created: number): void {
  const boundaries = eventBoundaries.get(instanceId) ?? new Map<string, number>()
  boundaries.set(session.id, Math.max(created, boundary(instanceId, session) + 1))
  eventBoundaries.set(instanceId, boundaries)
  // A tombstone fences late snapshot hydration of this new event.
  update(instanceId, (entries) => { entries.set(session.id, null); return true })
}

/** Saved with the window's session markers, including while recovery is being revalidated. */
export function captureSeenInterruptions(instanceId: string, sessions: readonly Interruptible[]): Record<string, number> {
  const entries = seenInterruptions().get(instanceId)
  const result: Record<string, number> = {}
  if (!entries) return result
  for (const session of sessions) {
    const seen = entries.get(session.id)
    if (seen != null) result[session.id] = seen
  }
  return result
}

export function hydrateSeenInterruptions(instanceId: string, markers: Readonly<Record<string, number>> | undefined): void {
  if (!markers) return
  update(instanceId, (entries) => {
    let changed = false
    for (const [sessionId, seen] of Object.entries(markers)) {
      if (entries.has(sessionId)) continue
      entries.set(sessionId, seen)
      changed = true
    }
    return changed
  })
}

export function clearInstanceSeenInterruptions(instanceId: string): void {
  eventBoundaries.delete(instanceId)
  update(instanceId, (entries) => {
    const changed = entries.size > 0
    entries.clear()
    return changed
  })
}

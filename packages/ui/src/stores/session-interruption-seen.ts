import { createSignal } from "solid-js"
import type { Session } from "../types/session"

// Seen native interruptions, keyed by the native idle boundary they ended at. Seeing one
// only hides its badge: the native outcome and the recovery marker stay untouched, a
// later boundary shows the badge again, and refreshes, which keep the boundary, do not.
type Seen = Map<string, Map<string, number | null>>
type Interruptible = Pick<Session, "id" | "generationRecovery" | "time" | "status" | "pendingPermission" | "pendingForm" | "retry" | "outcome" | "runtimeStatusKnown">

const [seenInterruptions, setSeenInterruptions] = createSignal<Seen>(new Map())
const eventBoundaries = new Map<string, Map<string, { baseline: number; provisional: number }>>()

/** Tracks every change, for persistence. */
export const seenInterruptionsRevision = seenInterruptions

const boundary = (instanceId: string, session: Interruptible) => Math.max(
  session.time?.idle ?? 0, eventBoundaries.get(instanceId)?.get(session.id)?.provisional ?? 0,
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

/** Event authority precedes asynchronous reads. A provisional boundary covers metadata lag. */
export function observeSessionInterruption(instanceId: string, session: Interruptible, created: number): void {
  const boundaries = eventBoundaries.get(instanceId) ?? new Map()
  const baseline = session.time?.idle ?? 0
  if (baseline < created) boundaries.set(session.id, { baseline, provisional: created })
  else boundaries.delete(session.id)
  if (boundaries.size) eventBoundaries.set(instanceId, boundaries)
  else eventBoundaries.delete(instanceId)
  // A tombstone fences late snapshot hydration of this new event.
  update(instanceId, (entries) => { entries.set(session.id, null); return true })
}

const settledPast = (session: Interruptible, seen: number) => session.runtimeStatusKnown
  && session.generationRecovery !== "interrupted" && (session.outcome === "succeeded" || session.outcome === "failed")
  && (session.time?.idle ?? 0) > seen

/** Called only after the runtime merge admits native metadata for publication. */
export function reconcileSessionInterruptionBoundary(instanceId: string, session: Interruptible): void {
  const event = eventBoundaries.get(instanceId)?.get(session.id)
  const idle = session.time?.idle ?? 0
  const seen = seenInterruptions().get(instanceId)?.get(session.id)
  if ((seen != null || event) && settledPast(session, seen ?? event!.baseline)) {
    clearSessionSeenInterruption(instanceId, session.id)
    return
  }
  if (!event || idle <= event.baseline || session.outcome !== "interrupted") return
  eventBoundaries.get(instanceId)!.delete(session.id)
  if (!eventBoundaries.get(instanceId)!.size) eventBoundaries.delete(instanceId)
  // Rebind a clear made in the metadata gap to the proven boundary, even when
  // the event timestamp was later. A subsequent native boundary must show again.
  update(instanceId, entries => {
    if (entries.get(session.id) !== event.provisional) return false
    entries.set(session.id, idle)
    return true
  })
}

/** Saved with the window's session markers, including while recovery is being revalidated. */
export function captureSeenInterruptions(instanceId: string, sessions: readonly Interruptible[]): Record<string, number> {
  const entries = seenInterruptions().get(instanceId)
  const result: Record<string, number> = {}
  if (!entries) return result
  for (const session of sessions) {
    const seen = entries.get(session.id)
    if (seen != null && !settledPast(session, seen)) result[session.id] = seen
  }
  return result
}

export function clearSessionSeenInterruption(instanceId: string, sessionId: string): void {
  const boundaries = eventBoundaries.get(instanceId)
  boundaries?.delete(sessionId)
  if (!boundaries?.size) eventBoundaries.delete(instanceId)
  update(instanceId, entries => entries.delete(sessionId))
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

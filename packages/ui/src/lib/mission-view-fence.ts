import { createComputed, createMemo, onCleanup } from "solid-js"

/** Counts changes of a value a view learns from a read, for its fence identity. Within one scope
 * (instance and Location), the first report is the view already shown when it matches the value
 * the view knew from elsewhere, or when it knew none; one that contradicts it is another view.
 * An unknown value (an unavailable or cleared read) keeps the last one; a later different report
 * is another view. */
export function createReportedChanges(scope: () => string, value: () => string | undefined, known: () => string | undefined): () => number {
  const reported = createMemo<{ scope?: string; value?: string; changes: number }>(previous => {
    const where = scope(), next = value(), last = previous.scope === where ? previous.value : undefined
    if (next === undefined || next === last) return previous.scope === where ? previous : { scope: where, changes: previous.changes }
    const expected = last ?? known()
    return { scope: where, value: next, changes: previous.changes + (expected === undefined || expected === next ? 0 : 1) }
  }, { changes: 0 })
  return () => reported().changes
}

// A transition away and back is still a different view lifetime (including ABA).
// Capture before mutation/preparation, not when its response happens to arrive.
export function createMissionViewFence(identity: () => string, active: () => boolean) {
  let generation = 0, alive = true
  let previousIdentity: string | undefined, previousActive: boolean | undefined
  createComputed(() => {
    const scope = identity(), visible = active()
    // Reactive snapshot replacement/loading is not a view transition.
    if (scope !== previousIdentity || visible !== previousActive) {
      previousIdentity = scope; previousActive = visible; generation++
    }
  })
  onCleanup(() => { alive = false; generation++ })
  return () => {
    const origin = generation, scope = identity()
    return () => alive && generation === origin && identity() === scope && active()
  }
}

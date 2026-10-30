import { createComputed, createMemo, onCleanup } from "solid-js"

/** Counts replacements of a value a view learns from a read, for its fence identity. The first
 * report reveals what the view already showed, and an unknown value (an unavailable or cleared
 * read) keeps the last one: only a different reported value is another view. */
export function createReportedChanges(value: () => string | undefined): () => number {
  const reported = createMemo<{ value?: string; changes: number }>(previous => {
    const next = value()
    return next === undefined || next === previous.value ? previous
      : { value: next, changes: previous.changes + (previous.value === undefined ? 0 : 1) }
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

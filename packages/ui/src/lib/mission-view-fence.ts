import { createComputed, onCleanup } from "solid-js"

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

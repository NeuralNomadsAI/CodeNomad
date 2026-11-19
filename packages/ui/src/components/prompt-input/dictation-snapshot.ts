import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { TrailingResyncCoordinator } from "../../lib/trailing-resync"

/** A renderer has one device choice even when multiple composers stay mounted. */
export function createDictationSnapshot<T>(read: () => Promise<T | undefined>) {
  const [snapshot, setSnapshot] = createSignal<T>()
  const refresh = new TrailingResyncCoordinator(async () => {
    const value = await read()
    if (value !== undefined) setSnapshot(() => value)
  }, () => {})
  return {
    snapshot,
    readFresh: read,
    use(active: Accessor<boolean>) {
      createEffect(() => {
        if (!active()) return
        const update = () => { void refresh.request("device") }
        update()
        window.addEventListener("focus", update)
        onCleanup(() => window.removeEventListener("focus", update))
      })
    },
    refresh: () => { void refresh.request("device") },
  }
}

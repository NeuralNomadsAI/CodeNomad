import { batch, createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { TrailingResyncCoordinator } from "../../lib/trailing-resync"

/** A renderer has one device choice even when multiple composers stay mounted. */
export function createDictationSnapshot<T>(read: () => Promise<T | undefined>) {
  const [snapshot, setSnapshot] = createSignal<T>()
  const [readFailed, setReadFailed] = createSignal(false)
  const refresh = new TrailingResyncCoordinator(async () => {
    const value = await read()
    batch(() => {
      setReadFailed(value === undefined)
      if (value !== undefined) setSnapshot(() => value)
    })
  }, () => setReadFailed(true))
  return {
    snapshot,
    readFailed,
    async readFresh() {
      await refresh.request("device")
      return readFailed() ? undefined : snapshot()
    },
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

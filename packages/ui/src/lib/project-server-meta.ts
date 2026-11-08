import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { ServerMeta } from "../../../server/src/api-types"
import { backendOf } from "./backend-client"
import { backendEvents } from "./backend-events"

/** Project presentation follows one revocable backend attachment; host update metadata stays local. */
export function createProjectServerMeta(instanceId: Accessor<string | undefined>) {
  const [meta, setMeta] = createSignal<ServerMeta | null>(null)
  const [available, setAvailable] = createSignal(false)
  createEffect(() => {
    const id = instanceId()
    const signal = id ? backendEvents.signalForInstance(id) : undefined
    setMeta(null)
    setAvailable(false)
    if (!id || !signal || signal.aborted) return
    const revoke = () => { setMeta(null); setAvailable(false) }
    signal.addEventListener("abort", revoke, { once: true })
    onCleanup(() => { signal.removeEventListener("abort", revoke) })
    try {
      const client = backendOf(id)
      setAvailable(true)
      createEffect(() => { setMeta(signal.aborted ? null : client.meta.meta(signal)) })
      void client.meta.getServerMeta(false, signal).catch(() => undefined)
    } catch { /* An unavailable owner leaves project controls inactive. */ }
  })
  return { meta, previewsUnavailable: () => !available() || meta()?.previewsUnavailable === true,
    previewsAvailabilityResolved: () => meta() !== null }
}

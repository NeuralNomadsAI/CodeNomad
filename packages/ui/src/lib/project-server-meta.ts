import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { ServerMeta } from "../../../server/src/api-types"
import { backendOf, localBackend, type BackendClient } from "./backend-client"
import { backendEvents } from "./backend-events"
import { localServerMeta, previewsAvailabilityResolved as hostPreviewsResolved, previewsUnavailable as hostPreviewsUnavailable } from "./server-meta"

/** Project presentation follows one revocable backend attachment; host update metadata stays local. */
export function createProjectServerMeta(instanceId: Accessor<string | undefined>) {
  const [meta, setMeta] = createSignal<ServerMeta | null>(null)
  const [owner, setOwner] = createSignal<BackendClient>()
  createEffect(() => {
    const id = instanceId()
    const signal = id ? backendEvents.signalForInstance(id) : undefined
    setMeta(null)
    setOwner(undefined)
    if (!id || !signal || signal.aborted) return
    const revoke = () => { setMeta(null); setOwner(undefined) }
    signal.addEventListener("abort", revoke, { once: true })
    onCleanup(() => { signal.removeEventListener("abort", revoke) })
    try {
      const client = backendOf(id)
      if (client !== localBackend) {
        let mounted = true
        const stillNeeded = () => mounted && !signal.aborted
        void localServerMeta.getServerMeta().catch(() => undefined)
        const off = backendEvents.onOpen(backendId => {
          if (backendId === localBackend.id && stillNeeded() && !hostPreviewsResolved()) {
            void localServerMeta.recoverInitialServerMeta(stillNeeded).catch(() => undefined)
          }
        })
        onCleanup(() => { mounted = false; off() })
      }
      setOwner(client)
      createEffect(() => { setMeta(signal.aborted ? null : client.meta.meta(signal)) })
      void client.meta.getServerMeta(false, signal).catch(() => undefined)
    } catch { /* An unavailable owner leaves project controls inactive. */ }
  })
  // Every remote project's preview content also passes through this host, under its Web previews switch.
  const previewsAvailabilityResolved = () => meta() !== null && (owner() === localBackend || hostPreviewsResolved())
  return {
    meta,
    previewsAvailabilityResolved,
    previewsUnavailable: () => !owner() || (owner() !== localBackend && !previewsAvailabilityResolved())
      || meta()?.previewsUnavailable === true || hostPreviewsUnavailable(),
  }
}

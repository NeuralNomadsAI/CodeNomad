import { createEffect, createSignal, onCleanup } from "solid-js"
import type { LocationRef } from "@opencode/client"
import type { ImageGenerationSelection, ImageSettingsSnapshot } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { serverEvents } from "../../lib/server-events"
import { getActiveCatalogLocation } from "../../stores/sessions"

/** Reads while mounted; config, model-catalog and connection events coalesce into one trailing reread. */
export function useImageSettings(props: { instanceId: string; location?: LocationRef }) {
  const [snapshot, setSnapshot] = createSignal<ImageSettingsSnapshot>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal(false)
  const location = () => props.location ?? getActiveCatalogLocation(props.instanceId)
  let mutate: (change: { generation: ImageGenerationSelection } | { mediaStorage: boolean }) => Promise<void> = async () => {}

  createEffect(() => {
    const instanceId = props.instanceId, directory = location().directory
    let disposed = false, reading = false, writing = false, trailing = false, revision = 0
    setSnapshot(undefined); setError(false); setBusy(false)
    mutate = async () => {}
    if (!instanceId || !directory) return
    const load = async () => {
      if (disposed) return
      if (reading || writing) { trailing = true; return }
      reading = true; setBusy(true)
      do {
        trailing = false
        const captured = revision
        try {
          const next = await serverApi.getImageSettings(instanceId, directory)
          if (!disposed && captured === revision && !trailing) { setSnapshot(next); setError(false) }
        } catch { if (!disposed && captured === revision && !trailing) setError(true) }
      } while (!disposed && !writing && trailing)
      reading = false
      if (!disposed && !writing) setBusy(false)
    }
    mutate = async change => {
      if (disposed || writing || reading) return
      writing = true; revision++; setBusy(true); setError(false)
      let failed = false
      try { await serverApi.setImageSettings(instanceId, { location: { directory }, ...change }) } catch { failed = true }
      finally { writing = false; if (!disposed) setBusy(false) }
      if (!disposed) await load()
      if (!disposed && failed) setError(true)
    }
    const events = serverEvents.on("instance.event", payload => {
      if (payload.type === "instance.event" && payload.instanceId === instanceId
        && ["config.updated", "model.updated", "integration.updated", "credential.updated"].includes(payload.event.type)) void load()
    })
    const status = serverEvents.on("instance.eventStatus", payload => {
      if (payload.type === "instance.eventStatus" && payload.instanceId === instanceId && payload.status === "connected") void load()
    })
    const reconnect = serverEvents.onOpen(() => void load())
    onCleanup(() => { disposed = true; events(); status(); reconnect() })
    void load()
  })

  return { snapshot, busy, error, save: (change: Parameters<typeof mutate>[0]) => mutate(change) }
}

import { createEffect, createSignal, onCleanup } from "solid-js"
import type { LocationRef } from "@opencode/client"
import type { ImageGenerationSelection, ImageSettingsSnapshot } from "../../../../server/src/api-types"
import { backendOf } from "../../lib/backend-client"
import { parseInstanceKey } from "../../lib/backend-identity"
import { captureBackendOperation } from "../../lib/backend-operation"
import { backendEvents as serverEvents } from "../../lib/server-events"
import { getActiveCatalogLocation } from "../../stores/sessions"

/** Reads while mounted; config, model-catalog and connection events coalesce into one trailing reread. */
export function useImageSettings(props: { instanceId: string; location?: LocationRef }) {
  const [snapshot, setSnapshot] = createSignal<ImageSettingsSnapshot>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal(false)
  const location = () => props.location ?? getActiveCatalogLocation(props.instanceId)
  let mutate: (change: { generation: ImageGenerationSelection } | { mediaStorage: boolean }) => Promise<void> = async () => {}
  let scope: string | undefined

  createEffect(() => {
    const instanceId = props.instanceId, directory = location().directory
    let disposed = false, reading = false, writing = false, trailing = false, revision = 0
    const controller = new AbortController()
    const operation = captureBackendOperation(instanceId, controller.signal, () => !disposed)
    const current = operation.current
    const identity = JSON.stringify([instanceId, directory])
    if (scope !== identity) { scope = identity; setSnapshot(undefined) }
    setError(false); setBusy(false)
    mutate = async () => {}
    if (!instanceId || !directory || !current()) return
    const api = backendOf(instanceId).api, workspaceId = parseInstanceKey(instanceId).workspaceId
    const load = async () => {
      if (!current()) return
      if (reading || writing) { trailing = true; return }
      reading = true; setBusy(true)
      do {
        trailing = false
        const captured = revision
        try {
          const next = await api.getImageSettings(workspaceId, directory, operation.signal)
          if (current() && captured === revision && !trailing) { setSnapshot(next); setError(false) }
        } catch { if (current() && captured === revision && !trailing) setError(true) }
      } while (current() && !writing && trailing)
      reading = false
      if (current() && !writing) setBusy(false)
    }
    mutate = async change => {
      if (!current() || writing || reading) return
      writing = true; revision++; setBusy(true); setError(false)
      let failed = false
      try { await api.setImageSettings(workspaceId, { location: { directory }, ...change }, operation.signal) } catch { failed = true }
      finally { writing = false; if (current()) setBusy(false) }
      if (current()) await load()
      if (current() && failed) setError(true)
    }
    const events = serverEvents.on("instance.event", payload => {
      if (payload.type === "instance.event" && payload.instanceId === instanceId
        && ["config.updated", "model.updated", "integration.updated", "credential.updated"].includes(payload.event.type)) void load()
    })
    const status = serverEvents.on("instance.eventStatus", payload => {
      if (payload.type === "instance.eventStatus" && payload.instanceId === instanceId && payload.status === "connected") void load()
    })
    const reconnect = serverEvents.forInstance(() => instanceId).onOpen(() => void load())
    onCleanup(() => { disposed = true; controller.abort(); events(); status(); reconnect() })
    void load()
  })

  return { snapshot, busy, error, save: (change: Parameters<typeof mutate>[0]) => mutate(change) }
}

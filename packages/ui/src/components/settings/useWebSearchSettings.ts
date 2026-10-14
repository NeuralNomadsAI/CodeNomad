import { createEffect, createSignal, onCleanup } from "solid-js"
import type { IntegrationInfo, LocationRef, WebSearchProvider } from "@opencode/client"
import type { PluginControlScope, WebSearchSelection, WebSearchSettingsSnapshot } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { serverEvents } from "../../lib/server-events"
import { getRootClient } from "../../stores/opencode-client"
import { getActiveCatalogLocation } from "../../stores/sessions"
import { requestLocationOptions, toRequestLocation } from "../../stores/request-locations"

export function useWebSearchSettings(props: { instanceId: string; location?: LocationRef }) {
  const [snapshot, setSnapshot] = createSignal<WebSearchSettingsSnapshot>()
  const [providers, setProviders] = createSignal<WebSearchProvider[]>([])
  const [integrations, setIntegrations] = createSignal<IntegrationInfo[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal(false)
  const location = () => props.location ?? getActiveCatalogLocation(props.instanceId)
  let refresh = () => {}
  let mutate: (operation: () => Promise<unknown>) => Promise<boolean> = async () => false

  createEffect(() => {
    const instanceId = props.instanceId, catalogLocation = { ...location() }, directory = catalogLocation.directory
    let disposed = false, reading = false, writing = false, trailing = false, revision = 0
    setSnapshot(undefined); setProviders([]); setIntegrations([]); setError(false); setBusy(false)
    refresh = () => {}
    mutate = async () => false
    if (!instanceId || !directory) return
    const load = async () => {
      if (disposed) return
      if (reading || writing) { trailing = true; return }
      reading = true; setBusy(true)
      do {
        trailing = false
        const captured = revision
        try {
          const client = getRootClient(instanceId)
          const request = { location: toRequestLocation(catalogLocation) }
          const [next, catalog, access] = await Promise.all([
            serverApi.getWebSearchSettings(instanceId, directory),
            client.websearch.providers(request, requestLocationOptions(catalogLocation)),
            client.integration.list(request, requestLocationOptions(catalogLocation)),
          ])
          if (!disposed && captured === revision && !trailing) {
            setSnapshot(next); setProviders(catalog.data); setIntegrations(access.data); setError(false)
          }
        } catch { if (!disposed && captured === revision && !trailing) setError(true) }
      } while (!disposed && !writing && trailing)
      reading = false
      if (!disposed && !writing) setBusy(false)
    }
    refresh = () => { void load() }
    mutate = async operation => {
      if (disposed || writing || reading) return false
      writing = true; revision++; setBusy(true); setError(false)
      let failed = false
      try { await operation() } catch { failed = true }
      finally { writing = false; if (!disposed) setBusy(false) }
      if (!disposed) await load()
      if (!disposed && failed) setError(true)
      return !disposed && !failed
    }
    const events = serverEvents.on("instance.event", payload => {
      if (payload.type === "instance.event" && payload.instanceId === instanceId
        && ["config.updated", "websearch.updated", "integration.updated", "credential.updated"].includes(payload.event.type)) refresh()
    })
    const status = serverEvents.on("instance.eventStatus", payload => {
      if (payload.type === "instance.eventStatus" && payload.instanceId === instanceId && payload.status === "connected") refresh()
    })
    const reconnect = serverEvents.onOpen(() => refresh())
    onCleanup(() => { disposed = true; events(); status(); reconnect() })
    void load()
  })

  return {
    snapshot, providers, integrations, busy, error, location,
    refresh: () => refresh(),
    save: (scope: PluginControlScope, provider: WebSearchSelection) => {
      const instanceId = props.instanceId, directory = location().directory
      return directory ? mutate(() => serverApi.setWebSearchSettings(instanceId, { location: { directory }, scope, provider })) : Promise.resolve(false)
    },
    connect: (integrationID: string, key: string) => {
      const client = getRootClient(props.instanceId), catalogLocation = { ...location() }
      return mutate(() => client.integration.connect.key({ integrationID, key, location: toRequestLocation(catalogLocation) }, requestLocationOptions(catalogLocation)))
    },
    remove: (credentialID: string) => {
      const client = getRootClient(props.instanceId), catalogLocation = { ...location() }
      return mutate(() => client.credential.remove({ credentialID }, requestLocationOptions(catalogLocation, { includeDirectory: true })))
    },
  }
}

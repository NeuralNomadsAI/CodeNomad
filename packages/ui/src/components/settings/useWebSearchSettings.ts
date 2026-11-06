import { createEffect, createSignal, onCleanup } from "solid-js"
import type { IntegrationInfo, LocationRef, WebSearchProvider } from "@opencode/client"
import type { PluginControlScope, WebSearchSelection, WebSearchSettingsSnapshot } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { captureBackendOperation } from "../../lib/backend-operation"
import { backendEvents as serverEvents } from "../../lib/server-events"
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
  let mutate: (action: (signal: AbortSignal) => Promise<unknown>) => Promise<boolean> = async () => false
  let scope: string | undefined

  createEffect(() => {
    const instanceId = props.instanceId, catalogLocation = { ...location() }, directory = catalogLocation.directory
    let disposed = false, reading = false, writing = false, trailing = false, revision = 0
    const controller = new AbortController()
    const operation = captureBackendOperation(instanceId, controller.signal, () => !disposed)
    const current = operation.current
    const identity = JSON.stringify([instanceId, directory])
    if (scope !== identity) { scope = identity; setSnapshot(undefined); setProviders([]); setIntegrations([]) }
    setError(false); setBusy(false)
    refresh = () => {}
    mutate = async () => false
    if (!instanceId || !directory) return
    const load = async () => {
      if (!current()) return
      if (reading || writing) { trailing = true; return }
      reading = true; setBusy(true)
      do {
        trailing = false
        const captured = revision
        try {
          const client = getRootClient(instanceId)
          const request = { location: toRequestLocation(catalogLocation) }
          const [next, catalog, access] = await Promise.all([
            serverApi.getWebSearchSettings(instanceId, directory, operation.signal),
            client.websearch.providers(request, { ...requestLocationOptions(catalogLocation), signal: operation.signal }),
            client.integration.list(request, { ...requestLocationOptions(catalogLocation), signal: operation.signal }),
          ])
          if (current() && captured === revision && !trailing) {
            setSnapshot(next); setProviders(catalog.data); setIntegrations(access.data); setError(false)
          }
        } catch { if (current() && captured === revision && !trailing) setError(true) }
      } while (current() && !writing && trailing)
      reading = false
      if (current() && !writing) setBusy(false)
    }
    refresh = () => { void load() }
    mutate = async action => {
      if (!current() || writing || reading) return false
      writing = true; revision++; setBusy(true); setError(false)
      let failed = false
      try { await action(operation.signal) } catch { failed = true }
      finally { writing = false; if (current()) setBusy(false) }
      if (current()) await load()
      if (current() && failed) setError(true)
      return current() && !failed
    }
    const events = serverEvents.on("instance.event", payload => {
      if (payload.type === "instance.event" && payload.instanceId === instanceId
        && ["config.updated", "websearch.updated", "integration.updated", "credential.updated"].includes(payload.event.type)) refresh()
    })
    const status = serverEvents.on("instance.eventStatus", payload => {
      if (payload.type === "instance.eventStatus" && payload.instanceId === instanceId && payload.status === "connected") refresh()
    })
    const reconnect = serverEvents.forInstance(() => instanceId).onOpen(() => refresh())
    onCleanup(() => { disposed = true; controller.abort(); events(); status(); reconnect() })
    void load()
  })

  return {
    snapshot, providers, integrations, busy, error, location,
    refresh: () => refresh(),
    save: (scope: PluginControlScope, provider: WebSearchSelection) => {
      const instanceId = props.instanceId, directory = location().directory
      return directory ? mutate(signal => serverApi.setWebSearchSettings(instanceId, { location: { directory }, scope, provider }, signal)) : Promise.resolve(false)
    },
    connect: (integrationID: string, key: string) => {
      const client = getRootClient(props.instanceId), catalogLocation = { ...location() }
      return mutate(signal => client.integration.connect.key({ integrationID, key, location: toRequestLocation(catalogLocation) }, { ...requestLocationOptions(catalogLocation), signal }))
    },
    remove: (credentialID: string) => {
      const client = getRootClient(props.instanceId), catalogLocation = { ...location() }
      return mutate(signal => client.credential.remove({ credentialID }, { ...requestLocationOptions(catalogLocation, { includeDirectory: true }), signal }))
    },
  }
}

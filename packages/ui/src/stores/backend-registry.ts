import { createComputed, createRoot, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { RemoteServerProfile, ServerMeta } from "../../../server/src/api-types"
import { createRemoteBackendClient, registerBackendClient, type BackendClient } from "../lib/backend-client"
import { backendCompatibility } from "../lib/backend-compatibility"
import { backendEvents, type BackendEvents } from "../lib/backend-events"
import { isBackendId, LOCAL_BACKEND_ID } from "../lib/backend-identity"
import { RELAY_AUTHORITY_HEADER } from "../../../server/src/codenomad-servers/relay-authority"

export type BackendAdmissionState = "idle" | "admitting" | "compatible" | "refused" | "unauthorized" | "unreachable"
type Entry = {
  profile: RemoteServerProfile
  client: BackendClient
  controller: AbortController
  pending: Promise<BackendClient | undefined>
  serverId?: string
  detach?: () => void
  remove?: () => void
  revoked: boolean
}

export interface BackendRegistryOptions {
  enabled(): unknown
  profiles(): readonly RemoteServerProfile[]
  createClient?: (id: string) => BackendClient
  register?: (client: BackendClient) => () => void
  events?: BackendEvents
  loadWorkspaces(client: BackendClient, signal: AbortSignal): Promise<void>
}

/** Owns candidates, attachment authority and disposal; observing profiles never probes them. */
export function createBackendRegistry(options: BackendRegistryOptions) {
  const events = options.events ?? backendEvents
  const entries = new Map<string, Entry>()
  const [states, setState] = createStore<Record<string, BackendAdmissionState | undefined>>(Object.create(null))
  let disposed = false
  const profileFor = (id: string) => options.enabled() === true ? options.profiles().find(p => p.id === id) : undefined
  const sameTarget = (a: RemoteServerProfile, b?: RemoteServerProfile) =>
    b !== undefined && a.baseUrl === b.baseUrl && a.skipTlsVerify === b.skipTlsVerify && a.ssh?.host === b.ssh?.host
  const current = (id: string, entry: Entry) => !disposed && !entry.revoked && entries.get(id) === entry
    && !entry.controller.signal.aborted && sameTarget(entry.profile, profileFor(id))

  function detach(id: string, state: BackendAdmissionState = "idle") {
    const entry = entries.get(id)
    if (entry && !entry.revoked) {
      entry.revoked = true
      // Revoke domain authority before closing owned streams and removing the client.
      entry.detach?.()
      entry.controller.abort()
      entry.client.events.dispose()
      entry.remove?.()
      if (entries.get(id) === entry) entries.delete(id)
    }
    setState(id, state)
  }

  const stopWatching = createRoot(dispose => {
    createComputed(() => {
      const enabled = options.enabled() === true
      const profiles = options.profiles()
      untrack(() => {
        for (const [id, entry] of entries) {
          if (!enabled || !sameTarget(entry.profile, profiles.find(p => p.id === id))) detach(id)
        }
        for (const id of Object.keys(states)) {
          if (!enabled || !profiles.some(p => p.id === id)) setState(id, undefined)
        }
      })
    })
    return dispose
  })

  async function validate(id: string, entry: Entry, attempt?: AbortSignal): Promise<boolean> {
    const active = () => !attempt?.aborted && current(id, entry)
    if (!active()) return false
    const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(8000), ...attempt ? [attempt] : []])
    try {
      // Admission never joins the display metadata cache or a previous attachment's read.
      const response = await entry.client.fetch(entry.client.url("/api/meta"), {
        credentials: "include", cache: "no-store", signal,
      })
      if (!active()) return false
      signal.throwIfAborted()
      if (response.status === 404) { detach(id, "refused"); return false }
      if (!response.ok) throw response.status === 401 ? "unauthorized" : "unreachable"
      const meta: ServerMeta | null = await response.json()
      if (!active()) return false
      signal.throwIfAborted()
      if (backendCompatibility(meta) !== "compatible" || entry.serverId && entry.serverId !== meta?.serverId) {
        detach(id, "refused")
        return false
      }
      entry.serverId = meta!.serverId
      if (entry.client.admitRelayAuthority && !entry.client.admitRelayAuthority(response.headers.get(RELAY_AUTHORITY_HEADER))) {
        detach(id, "refused")
        return false
      }
      if (entry.detach) setState(id, "compatible")
      return active()
    } catch (error) {
      if (active()) {
        if (error instanceof SyntaxError) { detach(id, "refused"); return false }
        // Temporary connection failure preserves the attachment and its ordinary retry path.
        setState(id, error === "unauthorized" ? "unauthorized" : "unreachable")
        if (!entry.detach) detach(id, error === "unauthorized" ? "unauthorized" : "unreachable")
      }
      throw error
    }
  }

  function ensure(id: string): Promise<BackendClient | undefined> {
    if (disposed || id === LOCAL_BACKEND_ID || !isBackendId(id)) return Promise.resolve(undefined)
    const profile = profileFor(id)
    const existing = entries.get(id)
    if (existing && !current(id, existing)) detach(id)
    if (!profile) return Promise.resolve(undefined)
    const active = entries.get(id)
    if (active) return active.revoked ? Promise.resolve(undefined) : active.pending
    const client = options.createClient ? options.createClient(id) : createRemoteBackendClient(id, { bindRelayAuthority: true })
    const entry: Entry = { profile: { ...profile }, client, controller: new AbortController(),
      pending: Promise.resolve(undefined), revoked: false }
    entries.set(id, entry)
    setState(id, "admitting")
    entry.pending = (async () => {
      try {
        if (!await validate(id, entry) || !current(id, entry)) return undefined
        entry.remove = (options.register ?? registerBackendClient)(client)
        entry.detach = events.attach(id, client.events)
        if (!current(id, entry)) { detach(id); return undefined }
        client.events.setConnectionValidator(async signal => {
          if (!current(id, entry)) return false
          return validate(id, entry, signal)
        })
        setState(id, "compatible")
        await client.events.start()
        if (!current(id, entry)) return undefined
        if (states[id] !== "compatible") return client
        // Start the stream first; domain reads always retain this exact attachment.
        const signal = events.signal(id)!
        await options.loadWorkspaces(client, signal)
        return current(id, entry) ? client : undefined
      } catch {
        if (current(id, entry) && !entry.detach) detach(id, "unreachable")
        if (current(id, entry)) { setState(id, "unreachable"); return client }
        return undefined
      }
    })()
    return entry.pending
  }

  return {
    ensure, detach,
    state: (id: string): BackendAdmissionState => states[id] ?? "idle",
    dispose() {
      if (disposed) return
      disposed = true
      stopWatching()
      for (const id of [...entries.keys()]) detach(id)
    },
  }
}

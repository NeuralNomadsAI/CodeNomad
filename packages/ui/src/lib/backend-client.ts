import { createServerApi, serverApi, type ServerApi } from "./api-client"
import { authenticatedFetch, authRecovery, createAuthenticatedFetch, createAuthRecovery, localHttp, type AuthRecovery } from "./auth-recovery"
import { createBackendTransport, type BackendId, type BackendTransportOptions } from "./backend-transport"
import { SDKManager, sdkManager } from "./sdk-manager"
import { createServerMetaCache, localServerMeta, type ServerMetaCache } from "./server-meta"
import { ServerEvents, serverEvents } from "./server-events"
import { ServerStorage, storage } from "./storage"
import { parseInstanceKey } from "./backend-identity"
import { bindBackendRelayAuthority } from "./backend-relay-authority"

export type { BackendId }

/** Everything the UI needs to talk to one CodeNomad backend. */
export interface BackendClient {
  readonly id: BackendId
  readonly baseUrl: string | undefined
  readonly eventsUrl: string
  url(path: string): string
  readonly fetch: typeof fetch
  readonly auth: AuthRecovery
  readonly api: ServerApi
  readonly events: ServerEvents
  readonly storage: ServerStorage
  readonly meta: ServerMetaCache
  readonly sdk: SDKManager
  readonly admitRelayAuthority?: (proof: string | null) => boolean
}

export interface BackendClientOptions extends BackendTransportOptions {
  /** Absolute http(s) URL of the other backend. */
  baseUrl: string
  /** Replaces the global fetch, resolved per request when omitted. */
  fetcher?: typeof fetch
  /** Registry-owned candidates require a locally issued, immutable relay generation. */
  bindRelayAuthority?: boolean
}

function assertAbsoluteHttpUrl(baseUrl: string) {
  let protocol: string | undefined
  try { protocol = new URL(baseUrl).protocol } catch { /* relative or malformed */ }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new TypeError(`A backend client needs an absolute http(s) base URL, not ${JSON.stringify(baseUrl)}`)
  }
}

/** A client of another backend. Its events stream connects only when `events.start()` is called. */
export function createBackendClient(options: BackendClientOptions): BackendClient {
  assertAbsoluteHttpUrl(options.baseUrl)
  const rawTransport = createBackendTransport(options)
  if (options.bindRelayAuthority && options.relayProfileId === undefined) throw new TypeError("Relay profile required")
  const authority = options.bindRelayAuthority ? bindBackendRelayAuthority(rawTransport, options.fetcher) : undefined
  const transport = authority?.transport ?? rawTransport
  const fetcher = authority?.fetch ?? options.fetcher
  const auth = createAuthRecovery(transport, fetcher)
  const fetch = createAuthenticatedFetch(auth, fetcher)
  const api = createServerApi({ ...transport, fetch })
  const events = new ServerEvents({ api, auth })
  return Object.freeze({
    id: transport.id, baseUrl: transport.baseUrl, eventsUrl: transport.eventsUrl, url: transport.url, fetch, auth, api, events,
    storage: new ServerStorage({ api, events }),
    meta: createServerMetaCache(api),
    sdk: new SDKManager({ url: rawTransport.url, fetch }),
    ...(authority ? { admitRelayAuthority: authority.admitRelayAuthority } : {}),
  })
}

/** An unregistered remote client; the local backend owns its relay credentials. */
export function createRemoteBackendClient(profileId: string, options: Pick<BackendClientOptions, "fetcher" | "eventSource" | "bindRelayAuthority"> = {}): BackendClient {
  const baseUrl = new URL(localHttp.url("/"), window.location.origin).origin
  return createBackendClient({ ...options, id: profileId, baseUrl, relayProfileId: profileId })
}

/** The backend that served this page, made of the module singletons its importers already use. */
export const localBackend: BackendClient = Object.freeze({
  id: localHttp.id, baseUrl: localHttp.baseUrl, eventsUrl: localHttp.eventsUrl, url: localHttp.url,
  fetch: authenticatedFetch, auth: authRecovery, api: serverApi, events: serverEvents,
  storage, meta: localServerMeta, sdk: sdkManager,
})

const clients = new Map<BackendId, BackendClient>([[localBackend.id, localBackend]])
export const backends: ReadonlyMap<BackendId, BackendClient> = clients

/** Registry-owned publication; stale cleanup cannot remove a replacement client. */
export function registerBackendClient(client: BackendClient): () => void {
  if (client.id === localBackend.id || clients.has(client.id)) throw new Error(`Backend already registered: ${client.id}`)
  clients.set(client.id, client)
  return () => { if (clients.get(client.id) === client) clients.delete(client.id) }
}

/** Native machine access and backend administration belong to the page's host. */
export function isLocalBackend(backend: BackendClient): boolean {
  return backend === localBackend
}

/** Resolve the owner from the opaque UI key; a missing backend never falls back to local. */
export function backendOf(instanceId: string): BackendClient {
  const { backendId } = parseInstanceKey(instanceId)
  const backend = backends.get(backendId)
  if (!backend) throw new Error(`Backend unavailable: ${backendId}`)
  return backend
}

import { createSignal } from "solid-js"
import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi, type ServerApi } from "./api-client"
import { setHostServerMeta } from "./host-server-meta"
export { secretEntryAllowed } from "./host-server-meta"

/** One backend's cached `/api/meta`, with its previews availability signals. */
export function createServerMetaCache(api: Pick<ServerApi, "fetchServerMeta">) {
  function createSnapshot() {
    const [meta, setMeta] = createSignal<ServerMeta | null>(null)
    return { cached: null as ServerMeta | null, pending: null as Promise<ServerMeta> | null, meta, setMeta }
  }
  type Snapshot = ReturnType<typeof createSnapshot>
  const local = createSnapshot()
  const attachments = new WeakMap<AbortSignal, Snapshot>()

  function snapshotFor(signal?: AbortSignal): Snapshot {
    let snapshot = signal ? attachments.get(signal) : local
    if (!snapshot) { snapshot = createSnapshot(); attachments.set(signal!, snapshot) }
    return snapshot
  }

  async function getServerMeta(forceRefresh = false, signal?: AbortSignal): Promise<ServerMeta> {
    signal?.throwIfAborted()
    const snapshot = snapshotFor(signal)
    if (snapshot.cached && !forceRefresh) {
      return snapshot.cached
    }
    if (snapshot.pending) {
      return snapshot.pending
    }
    const request = api.fetchServerMeta().then((meta) => {
      signal?.throwIfAborted()
      snapshot.cached = meta
      snapshot.setMeta(meta)
      if (api === serverApi && !signal) setHostServerMeta(meta)
      return meta
    })
    snapshot.pending = request
    try {
      return await request
    } finally {
      if (snapshot.pending === request) snapshot.pending = null
    }
  }

  // An open that joins the initial read still owns one recovery read if that flight fails.
  async function recoverInitialServerMeta(stillNeeded: () => boolean): Promise<void> {
    await local.pending?.catch(() => undefined)
    if (!local.cached && stillNeeded()) await getServerMeta()
  }

  return { getServerMeta, recoverInitialServerMeta, meta: (signal?: AbortSignal) => snapshotFor(signal).meta(),
    previewsUnavailable: () => local.meta()?.previewsUnavailable === true,
    previewsAvailabilityResolved: () => local.meta() !== null }
}

export type ServerMetaCache = ReturnType<typeof createServerMetaCache>

export const localServerMeta = createServerMetaCache(serverApi)
/** Host authority is derived exclusively from the local transport's metadata. */
export const localRequest = () => localServerMeta.meta()?.localRequest === true
export const serversUsable = () => (localServerMeta.meta()?.serversUsable ?? localRequest()) === true
export const serversManageable = () => (localServerMeta.meta()?.serversManageable ?? localRequest()) === true
/** Whether this client may open SideCars: a host-local client, or one the host allows over direct HTTPS. */
export const sidecarsAllowed = () => localRequest() || localServerMeta.meta()?.sidecarsAllowed === true

/** Whether this client reaches the server through Remote Control while its host keeps web previews off. */
export const previewsUnavailable = localServerMeta.previewsUnavailable
/** Whether the server meta has answered at least once, so `previewsUnavailable` carries a real value. */
export const previewsAvailabilityResolved = localServerMeta.previewsAvailabilityResolved

export const getServerMeta = localServerMeta.getServerMeta

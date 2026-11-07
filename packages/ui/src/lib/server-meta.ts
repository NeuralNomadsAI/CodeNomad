import { createSignal } from "solid-js"
import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi, type ServerApi } from "./api-client"

/** One backend's cached `/api/meta`, with its previews availability signals. */
export function createServerMetaCache(api: Pick<ServerApi, "fetchServerMeta">) {
  interface Snapshot { cached: ServerMeta | null; pending: Promise<ServerMeta> | null }
  const local: Snapshot = { cached: null, pending: null }
  const attachments = new WeakMap<AbortSignal, Snapshot>()
  const [previewsUnavailable, setPreviewsUnavailable] = createSignal(false)
  const [previewsAvailabilityResolved, setPreviewsAvailabilityResolved] = createSignal(false)

  async function getServerMeta(forceRefresh = false, signal?: AbortSignal): Promise<ServerMeta> {
    signal?.throwIfAborted()
    let snapshot = signal ? attachments.get(signal) : local
    if (!snapshot) { snapshot = { cached: null, pending: null }; attachments.set(signal!, snapshot) }
    if (snapshot.cached && !forceRefresh) {
      return snapshot.cached
    }
    if (snapshot.pending) {
      return snapshot.pending
    }
    const request = api.fetchServerMeta().then((meta) => {
      signal?.throwIfAborted()
      snapshot.cached = meta
      setPreviewsUnavailable(meta.previewsUnavailable === true)
      setPreviewsAvailabilityResolved(true)
      return meta
    })
    snapshot.pending = request
    try {
      return await request
    } finally {
      if (snapshot.pending === request) snapshot.pending = null
    }
  }

  return { getServerMeta, previewsUnavailable, previewsAvailabilityResolved }
}

export type ServerMetaCache = ReturnType<typeof createServerMetaCache>

export const localServerMeta = createServerMetaCache(serverApi)

/** Whether this client reaches the server through Remote Control while its host keeps web previews off. */
export const previewsUnavailable = localServerMeta.previewsUnavailable
/** Whether the server meta has answered at least once, so `previewsUnavailable` carries a real value. */
export const previewsAvailabilityResolved = localServerMeta.previewsAvailabilityResolved

export const getServerMeta = localServerMeta.getServerMeta

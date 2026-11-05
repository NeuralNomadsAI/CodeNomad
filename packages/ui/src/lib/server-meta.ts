import { createSignal } from "solid-js"
import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi, type ServerApi } from "./api-client"

/** One backend's cached `/api/meta`, with its previews availability signals. */
export function createServerMetaCache(api: Pick<ServerApi, "fetchServerMeta">) {
  let cachedMeta: ServerMeta | null = null
  let pendingMeta: Promise<ServerMeta> | null = null
  const [previewsUnavailable, setPreviewsUnavailable] = createSignal(false)
  const [previewsAvailabilityResolved, setPreviewsAvailabilityResolved] = createSignal(false)

  async function getServerMeta(forceRefresh = false): Promise<ServerMeta> {
    if (cachedMeta && !forceRefresh) {
      return cachedMeta
    }
    if (pendingMeta) {
      return pendingMeta
    }
    const request = api.fetchServerMeta().then((meta) => {
      cachedMeta = meta
      setPreviewsUnavailable(meta.previewsUnavailable === true)
      setPreviewsAvailabilityResolved(true)
      return meta
    })
    pendingMeta = request
    try {
      return await request
    } finally {
      if (pendingMeta === request) pendingMeta = null
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

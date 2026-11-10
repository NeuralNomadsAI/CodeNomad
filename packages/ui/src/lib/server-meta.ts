import { createSignal } from "solid-js"
import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi } from "./api-client"

let cachedMeta: ServerMeta | null = null
let pendingMeta: Promise<ServerMeta> | null = null
const [previewsUnavailable, setPreviewsUnavailable] = createSignal(false)
const [previewsAvailabilityResolved, setPreviewsAvailabilityResolved] = createSignal(false)
const [localRequest, setLocalRequest] = createSignal(false)
export { localRequest }

/** Whether this client reaches the server through Remote Control while its host keeps web previews off. */
export { previewsUnavailable }
/** Whether the server meta has answered at least once, so `previewsUnavailable` carries a real value. */
export { previewsAvailabilityResolved }

export async function getServerMeta(forceRefresh = false): Promise<ServerMeta> {
  if (cachedMeta && !forceRefresh) {
    return cachedMeta
  }
  if (pendingMeta) {
    return pendingMeta
  }
  const request = serverApi.fetchServerMeta().then((meta) => {
    cachedMeta = meta
    setLocalRequest(meta.localRequest === true)
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

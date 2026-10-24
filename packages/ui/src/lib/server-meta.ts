import { createSignal } from "solid-js"
import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi } from "./api-client"

let cachedMeta: ServerMeta | null = null
let pendingMeta: Promise<ServerMeta> | null = null
const [previewsUnavailable, setPreviewsUnavailable] = createSignal(false)

/** Whether this client reaches the server through Remote Control while its host keeps web previews off. */
export { previewsUnavailable }

export async function getServerMeta(forceRefresh = false): Promise<ServerMeta> {
  if (cachedMeta && !forceRefresh) {
    return cachedMeta
  }
  if (pendingMeta) {
    return pendingMeta
  }
  const request = serverApi.fetchServerMeta().then((meta) => {
    cachedMeta = meta
    setPreviewsUnavailable(meta.previewsUnavailable === true)
    return meta
  })
  pendingMeta = request
  try {
    return await request
  } finally {
    if (pendingMeta === request) pendingMeta = null
  }
}

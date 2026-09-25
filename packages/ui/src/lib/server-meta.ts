import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi } from "./api-client"

let cachedMeta: ServerMeta | null = null
let pendingMeta: Promise<ServerMeta> | null = null

export async function getServerMeta(forceRefresh = false): Promise<ServerMeta> {
  if (cachedMeta && !forceRefresh) {
    return cachedMeta
  }
  if (pendingMeta) {
    return pendingMeta
  }
  const request = serverApi.fetchServerMeta().then((meta) => {
    cachedMeta = meta
    return meta
  })
  pendingMeta = request
  try {
    return await request
  } finally {
    if (pendingMeta === request) pendingMeta = null
  }
}

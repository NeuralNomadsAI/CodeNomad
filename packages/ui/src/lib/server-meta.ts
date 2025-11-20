import type { ServerMeta } from "../../../server/src/api-types"
import { cliApi } from "./api-client"

let cachedMeta: ServerMeta | null = null
let pendingMeta: Promise<ServerMeta> | null = null

export async function getServerMeta(): Promise<ServerMeta> {
  if (cachedMeta) {
    return cachedMeta
  }
  if (pendingMeta) {
    return pendingMeta
  }
  pendingMeta = cliApi.fetchServerMeta().then((meta) => {
    cachedMeta = meta
    pendingMeta = null
    return meta
  })
  return pendingMeta
}

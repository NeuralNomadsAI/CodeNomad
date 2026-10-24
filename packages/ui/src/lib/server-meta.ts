import { createSignal } from "solid-js"
import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi } from "./api-client"

let cachedMeta: ServerMeta | null = null
let pendingMeta: Promise<ServerMeta> | null = null
const [remoteControlClient, setRemoteControlClient] = createSignal(false)

/** Whether this client reaches the server through Remote Control, which serves no previews. */
export { remoteControlClient }

export async function getServerMeta(forceRefresh = false): Promise<ServerMeta> {
  if (cachedMeta && !forceRefresh) {
    return cachedMeta
  }
  if (pendingMeta) {
    return pendingMeta
  }
  const request = serverApi.fetchServerMeta().then((meta) => {
    cachedMeta = meta
    setRemoteControlClient(meta.remoteControl === true)
    return meta
  })
  pendingMeta = request
  try {
    return await request
  } finally {
    if (pendingMeta === request) pendingMeta = null
  }
}

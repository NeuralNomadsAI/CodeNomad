import type { ServerMeta } from "../../../server/src/api-types"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"

/** Admission requires the exact contract and a stable backend identity. */
export function backendCompatibility(meta: Pick<ServerMeta, "apiContract" | "serverId"> | null | undefined): "compatible" | "refused" {
  return meta?.apiContract === CODENOMAD_API_CONTRACT && typeof meta.serverId === "string" && meta.serverId.trim().length > 0
    ? "compatible" : "refused"
}

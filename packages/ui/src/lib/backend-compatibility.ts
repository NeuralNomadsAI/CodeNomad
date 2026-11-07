import type { ServerMeta } from "../../../server/src/api-types"
import { CODENOMAD_API_CONTRACT } from "../../../server/src/meta-contract"

/** Opening policy for a future backend picker; callers opt in explicitly. */
export function backendCompatibility(meta: Pick<ServerMeta, "apiContract">): "native" | "fallback" {
  return meta.apiContract === CODENOMAD_API_CONTRACT ? "native" : "fallback"
}

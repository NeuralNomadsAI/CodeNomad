import type { ServerMeta } from "../../../server/src/api-types"
import type { CodeNomadCapability } from "../../../server/src/meta-contract"
import { hostServerMeta } from "./host-server-meta"

/** Metadata that is unknown or lists no capabilities predates the contract: every family is served. */
export function declaresCapability(meta: Pick<ServerMeta, "capabilities"> | null | undefined, capability: CodeNomadCapability): boolean {
  return !Array.isArray(meta?.capabilities) || meta.capabilities.includes(capability)
}

/** Whether the local host serves a route family, from its latest metadata (reactive). */
export const hostSupports = (capability: CodeNomadCapability) => declaresCapability(hostServerMeta(), capability)

import type { CodeNomadCapability } from "../../../server/src/meta-contract"
import { hostSupports } from "../lib/backend-capabilities"
import { LOCAL_BACKEND_ID, parseInstanceKey } from "../lib/backend-identity"
import { backendRegistry } from "./remote-backends"

/** Whether the backend owning this project serves a route family (reactive). */
export function supportsWorkspaceCapability(instanceId: string, capability: CodeNomadCapability): boolean {
  const { backendId } = parseInstanceKey(instanceId)
  return backendId === LOCAL_BACKEND_ID ? hostSupports(capability) : backendRegistry.supports(backendId, capability)
}

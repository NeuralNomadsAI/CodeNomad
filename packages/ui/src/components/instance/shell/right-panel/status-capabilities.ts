import type { CodeNomadCapability } from "../../../../../../server/src/meta-contract"
import { supportsWorkspaceCapability } from "../../../../stores/workspace-capabilities"

/** Status sections backed by an optional route family; the others only need the native relay. */
const capabilitiesBySection: Record<string, readonly CodeNomadCapability[]> = {
  "permissions": ["conversation-permissions"],
  "provider-usage": ["provider-usage"],
  "background-processes": ["background-shells"],
  "plugins": ["plugin-controls", "integrations"],
}

export function supportsStatusSection(instanceId: string, section: string): boolean {
  return (capabilitiesBySection[section] ?? []).every(capability => supportsWorkspaceCapability(instanceId, capability))
}

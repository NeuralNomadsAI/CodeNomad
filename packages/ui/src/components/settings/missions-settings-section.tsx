import { type Component } from "solid-js"
import type { LocationRef } from "@opencode/client"
import { activeInstanceId, instances } from "../../stores/instances"
import { activeSettingsSection } from "../../stores/settings-screen"
import { MissionPreferences } from "../mission-preferences"

/** Global Mission defaults plus the Location-scoped parts for the project that
 * opened Settings. Catalog/depth reads follow this section's visibility. */
export const MissionsSettingsSection: Component<{ instanceId?: string; location?: LocationRef }> = (props) => {
  const instanceId = () => props.instanceId ?? activeInstanceId() ?? ""
  const directory = () => props.location?.directory ?? instances().get(instanceId())?.folder
  return <div class="settings-section-stack">
    <MissionPreferences instanceId={instanceId()} directory={instanceId() ? directory() : undefined}
      active={() => activeSettingsSection() === "missions"} />
  </div>
}

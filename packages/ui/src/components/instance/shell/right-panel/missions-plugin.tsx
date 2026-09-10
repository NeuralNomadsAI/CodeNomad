import MissionControl from "./tabs/MissionControl"
import type { RightPanelManifest } from "./plugin-manifest"

export const missionsRightPanelManifest: RightPanelManifest = {
  id: "mission-control",
  displayNameKey: "instanceShell.rightPanel.modules.missions",
  descriptionKey: "instanceShell.rightPanel.modules.missions.description",
  origin: "first-party",
  create: (host) => ({
    id: "mission-control",
    displayNameKey: "instanceShell.rightPanel.modules.missions",
    descriptionKey: "instanceShell.rightPanel.modules.missions.description",
    origin: "first-party",
    tabs: [{
      id: "missions",
      labelKey: "instanceShell.rightPanel.tabs.missions",
      order: 25,
      render: () => <MissionControl instanceId={host.instanceId} activeSessionId={host.activeSessionId} t={host.t} />,
    }],
  }),
}

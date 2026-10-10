import type { Accessor } from "solid-js"
import MissionControl from "./tabs/MissionControl"
import type { RightPanelModule } from "./registry"

interface MissionsRightPanelOptions {
  instanceId: string
  t: (key: string, vars?: Record<string, any>) => string
  activeSessionId: Accessor<string | null>
  /** True only while the panel is visible with the Missions tab selected. */
  isActive: () => boolean
  revealConversation: (restoreChat?: boolean) => void
}

/** Built-in Missions tab, constructed directly like the core tabs. */
export function createMissionsRightPanelModule(options: MissionsRightPanelOptions): RightPanelModule {
  return {
    id: "mission-control",
    displayNameKey: "instanceShell.rightPanel.modules.missions",
    descriptionKey: "instanceShell.rightPanel.modules.missions.description",
    origin: "first-party",
    tabs: [{
      id: "missions",
      labelKey: "instanceShell.rightPanel.tabs.missions",
      order: 25,
      render: () => <MissionControl instanceId={options.instanceId} activeSessionId={options.activeSessionId}
        isActive={options.isActive} t={options.t} onRevealConversation={options.revealConversation} />,
    }],
  }
}

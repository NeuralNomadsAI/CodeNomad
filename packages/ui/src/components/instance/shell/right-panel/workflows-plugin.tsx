import { lazy } from "solid-js"

import type { RightPanelManifest } from "./plugin-manifest"

const LazyWorkflowsTab = lazy(() => import("./tabs/WorkflowsTab"))

export const WORKFLOWS_PLUGIN_MANIFEST: RightPanelManifest = {
  id: "workflows",
  displayNameKey: "instanceShell.rightPanel.modules.workflows",
  descriptionKey: "instanceShell.rightPanel.modules.workflows.description",
  origin: "first-party",
  create: (host) => ({
    id: "workflows",
    displayNameKey: "instanceShell.rightPanel.modules.workflows",
    descriptionKey: "instanceShell.rightPanel.modules.workflows.description",
    origin: "first-party",
    tabs: [
      {
        id: "workflows",
        labelKey: "instanceShell.rightPanel.tabs.workflows",
        order: 5,
        render: () => (
          <LazyWorkflowsTab
            t={host.t}
            instanceId={host.instanceId}
            activeSessionId={host.activeSessionId}
            active={() => host.isTabActive("workflows")}
          />
        ),
      },
    ],
  }),
}

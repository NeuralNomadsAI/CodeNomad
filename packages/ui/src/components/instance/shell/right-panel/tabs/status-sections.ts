import type { RightPanelItem } from "../registry"
import type { HelpDestination } from "../../../../../lib/help-url"

export const CORE_STATUS_SECTION_ITEMS: readonly (RightPanelItem & { tooltipKey: string; defaultExpanded?: boolean; help: HelpDestination })[] = [
  {
    id: "tokens",
    labelKey: "instanceShell.rightPanel.sections.tokens",
    tooltipKey: "instanceShell.rightPanel.sections.tokens.tooltip",
    help: { page: "providers", anchor: "usage" },
    order: 0,
  },
  {
    id: "yolo-mode",
    labelKey: "instanceShell.rightPanel.sections.yoloMode",
    tooltipKey: "instanceShell.rightPanel.sections.yoloMode.tooltip",
    help: { page: "permissions", anchor: "yolo-mode" },
    order: 10,
  },
  {
    id: "provider-usage",
    labelKey: "providerUsage.title",
    tooltipKey: "providerUsage.tooltip",
    help: { page: "providers", anchor: "usage" },
    order: 20,
  },
  {
    id: "background-processes",
    labelKey: "instanceShell.rightPanel.sections.backgroundProcesses",
    tooltipKey: "instanceShell.rightPanel.sections.backgroundProcesses.tooltip",
    help: { page: "index", anchor: "monitor-work" },
    order: 40,
  },
  {
    id: "mcp",
    labelKey: "instanceShell.rightPanel.sections.mcp",
    tooltipKey: "instanceShell.rightPanel.sections.mcp.tooltip",
    help: { page: "integrations", anchor: "mcp" },
    order: 50,
  },
  {
    id: "plugins",
    labelKey: "instanceShell.rightPanel.sections.plugins",
    tooltipKey: "instanceShell.rightPanel.sections.plugins.tooltip",
    help: { page: "integrations", anchor: "plugins" },
    order: 60,
  },
]

import type { RightPanelItem } from "../registry"

export const CORE_STATUS_SECTION_ITEMS: readonly (RightPanelItem & { tooltipKey: string; defaultExpanded?: boolean })[] = [
  {
    id: "tokens",
    labelKey: "instanceShell.rightPanel.sections.tokens",
    tooltipKey: "instanceShell.rightPanel.sections.tokens.tooltip",
    order: 0,
  },
  {
    id: "yolo-mode",
    labelKey: "instanceShell.rightPanel.sections.yoloMode",
    tooltipKey: "instanceShell.rightPanel.sections.yoloMode.tooltip",
    order: 10,
  },
  {
    id: "provider-usage",
    labelKey: "providerUsage.title",
    tooltipKey: "providerUsage.tooltip",
    order: 20,
  },
  {
    id: "background-processes",
    labelKey: "instanceShell.rightPanel.sections.backgroundProcesses",
    tooltipKey: "instanceShell.rightPanel.sections.backgroundProcesses.tooltip",
    order: 40,
  },
  {
    id: "mcp",
    labelKey: "instanceShell.rightPanel.sections.mcp",
    tooltipKey: "instanceShell.rightPanel.sections.mcp.tooltip",
    order: 50,
  },
  {
    id: "plugins",
    labelKey: "instanceShell.rightPanel.sections.plugins",
    tooltipKey: "instanceShell.rightPanel.sections.plugins.tooltip",
    order: 60,
  },
  {
    id: "websearch",
    labelKey: "settings.websearch.title",
    tooltipKey: "settings.websearch.defaultHint",
    order: 70,
  },
]

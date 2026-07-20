import type { RightPanelItem } from "../registry"

export const CORE_STATUS_SECTION_ITEMS: readonly (RightPanelItem & { tooltipKey: string; defaultExpanded?: boolean })[] = [
  {
    id: "provider-usage",
    labelKey: "providerUsage.title",
    tooltipKey: "providerUsage.tooltip",
    order: 10,
  },
  {
    id: "yolo-mode",
    labelKey: "instanceShell.rightPanel.sections.yoloMode",
    tooltipKey: "instanceShell.rightPanel.sections.yoloMode.tooltip",
    order: 20,
  },
  {
    id: "plan",
    labelKey: "instanceShell.rightPanel.sections.plan",
    tooltipKey: "instanceShell.rightPanel.sections.plan.tooltip",
    order: 30,
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
    id: "lsp",
    labelKey: "instanceShell.rightPanel.sections.lsp",
    tooltipKey: "instanceShell.rightPanel.sections.lsp.tooltip",
    order: 60,
  },
  {
    id: "plugins",
    labelKey: "instanceShell.rightPanel.sections.plugins",
    tooltipKey: "instanceShell.rightPanel.sections.plugins.tooltip",
    order: 70,
  },
]

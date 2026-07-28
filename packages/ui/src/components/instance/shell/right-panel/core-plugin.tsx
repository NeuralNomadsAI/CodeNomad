import type { JSX } from "solid-js"

import type { RightPanelPluginManifest } from "./plugin-manifest"

interface CoreRightPanelRenderers {
  renderGitChangesTab: () => JSX.Element
  renderFilesTab: () => JSX.Element
  renderStatusTab: () => JSX.Element
}

interface CoreStatusSectionRenderers {
  renderYoloModeSection: () => JSX.Element
  renderProviderUsage: () => JSX.Element
  renderPlanSectionContent: () => JSX.Element
  renderBackgroundProcesses: () => JSX.Element
  renderMcpStatus: () => JSX.Element
  renderLspStatus: () => JSX.Element
  renderPluginStatus: () => JSX.Element
}

export function createCoreRightPanelManifest(renderers: CoreRightPanelRenderers): RightPanelPluginManifest {
  return {
    id: "core-right-panel",
    tabs: [
      {
        id: "git-changes",
        labelKey: "instanceShell.rightPanel.tabs.gitChanges",
        order: 10,
        render: renderers.renderGitChangesTab,
      },
      {
        id: "files",
        labelKey: "instanceShell.rightPanel.tabs.files",
        order: 20,
        render: renderers.renderFilesTab,
      },
      {
        id: "status",
        labelKey: "instanceShell.rightPanel.tabs.status",
        order: 30,
        render: renderers.renderStatusTab,
      },
    ],
  }
}

export function createCoreStatusSectionManifest(renderers: CoreStatusSectionRenderers): RightPanelPluginManifest {
  return {
    id: "core-status-sections",
    statusSections: [
      {
        id: "yolo-mode",
        labelKey: "instanceShell.rightPanel.sections.yoloMode",
        tooltipKey: "instanceShell.rightPanel.sections.yoloMode.tooltip",
        order: 10,
        render: renderers.renderYoloModeSection,
      },
      {
        id: "provider-usage",
        labelKey: "providerUsage.title",
        tooltipKey: "providerUsage.tooltip",
        order: 20,
        render: renderers.renderProviderUsage,
      },
      {
        id: "plan",
        labelKey: "instanceShell.rightPanel.sections.plan",
        tooltipKey: "instanceShell.rightPanel.sections.plan.tooltip",
        order: 30,
        render: renderers.renderPlanSectionContent,
      },
      {
        id: "background-processes",
        labelKey: "instanceShell.rightPanel.sections.backgroundProcesses",
        tooltipKey: "instanceShell.rightPanel.sections.backgroundProcesses.tooltip",
        order: 40,
        render: renderers.renderBackgroundProcesses,
      },
      {
        id: "mcp",
        labelKey: "instanceShell.rightPanel.sections.mcp",
        tooltipKey: "instanceShell.rightPanel.sections.mcp.tooltip",
        order: 50,
        render: renderers.renderMcpStatus,
      },
      {
        id: "lsp",
        labelKey: "instanceShell.rightPanel.sections.lsp",
        tooltipKey: "instanceShell.rightPanel.sections.lsp.tooltip",
        order: 60,
        render: renderers.renderLspStatus,
      },
      {
        id: "plugins",
        labelKey: "instanceShell.rightPanel.sections.plugins",
        tooltipKey: "instanceShell.rightPanel.sections.plugins.tooltip",
        order: 70,
        render: renderers.renderPluginStatus,
      },
    ],
  }
}

import type { JSX } from "solid-js"

import type { RightPanelPluginManifest } from "./plugin-manifest"
import { CORE_STATUS_SECTION_ITEMS } from "./tabs/status-sections"

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
  const sectionRenderers: Record<string, () => JSX.Element> = {
    "yolo-mode": renderers.renderYoloModeSection,
    "provider-usage": renderers.renderProviderUsage,
    plan: renderers.renderPlanSectionContent,
    "background-processes": renderers.renderBackgroundProcesses,
    mcp: renderers.renderMcpStatus,
    lsp: renderers.renderLspStatus,
    plugins: renderers.renderPluginStatus,
  }

  return {
    id: "core-status-sections",
    statusSections: CORE_STATUS_SECTION_ITEMS.map((section) => {
      const render = sectionRenderers[section.id]
      if (!render) throw new Error(`Missing core right panel section renderer: ${section.id}`)
      return { ...section, render }
    }),
  }
}

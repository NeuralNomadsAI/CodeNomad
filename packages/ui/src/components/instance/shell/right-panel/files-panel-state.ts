import type { RightPanelCustomization } from "./registry"

export const FILES_PANEL_MIGRATION_KEY = "opencode-files-panel-migration-v1"
export const FILES_PANEL_MODE_KEY = "opencode-files-panel-mode-v1"
export type FilesPanelMode = "workspace" | "changes" | "history"

// Called once per client layout. Either previously visible entry keeps the
// merged Files surface available; retain the earliest position in the tab strip.
export function mergeFilesPanelCustomization(value: RightPanelCustomization): RightPanelCustomization {
  const hidden = value.hiddenTabIds.filter(id => id !== "git-changes" && id !== "files")
  if (value.hiddenTabIds.includes("files") && value.hiddenTabIds.includes("git-changes")) hidden.push("files")
  return { ...value, hiddenTabIds: hidden,
    tabOrder: [...new Set(value.tabOrder.map(id => id === "git-changes" ? "files" : id))] }
}

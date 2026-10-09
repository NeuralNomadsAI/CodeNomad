import { readClientLayoutValue } from "../../../stores/client-state"

export const DEFAULT_SESSION_SIDEBAR_WIDTH = 340
export const MIN_SESSION_SIDEBAR_WIDTH = 220

export const RIGHT_DRAWER_WIDTH = 260
export const MIN_RIGHT_DRAWER_WIDTH = 200
export const MAX_RIGHT_DRAWER_WIDTH = 1200

export const LEFT_DRAWER_STORAGE_KEY = "opencode-session-sidebar-width-v8"
export const RIGHT_DRAWER_STORAGE_KEY = "opencode-session-right-drawer-width-v1"
export const LEFT_PIN_STORAGE_KEY = "opencode-session-left-drawer-pinned-v1"
export const RIGHT_PIN_STORAGE_KEY = "opencode-session-right-drawer-pinned-v1"
export const LEFT_OPEN_STORAGE_KEY = "opencode-session-left-drawer-open-v1"
export const RIGHT_OPEN_STORAGE_KEY = "opencode-session-right-drawer-open-v1"
export const RIGHT_PANEL_TAB_STORAGE_KEY = "opencode-session-right-panel-tab-v2"
export const LEGACY_RIGHT_PANEL_TAB_STORAGE_KEY = "opencode-session-right-panel-tab-v1"
export const RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY = "opencode-session-right-panel-customization-v1"
export const RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY = "opencode-session-right-panel-changes-diff-view-mode-v1"
export const RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY = "opencode-session-right-panel-changes-diff-context-mode-v1"
export const RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY = "opencode-session-right-panel-changes-diff-word-wrap-v1"
export const RIGHT_PANEL_FILES_WORD_WRAP_KEY = "opencode-session-right-panel-files-word-wrap-v1"

export const clampWidth = (value: number) => Math.max(MIN_SESSION_SIDEBAR_WIDTH, value)

export const clampRightWidth = (value: number) => {
  const windowMax = typeof window !== "undefined" ? Math.floor(window.innerWidth * 0.7) : MAX_RIGHT_DRAWER_WIDTH
  const max = Math.max(MIN_RIGHT_DRAWER_WIDTH, windowMax)
  return Math.min(max, Math.max(MIN_RIGHT_DRAWER_WIDTH, value))
}

export function readStoredRightPanelTab(defaultValue: string): string {
  const stored = readClientLayoutValue(RIGHT_PANEL_TAB_STORAGE_KEY)
  if (stored === "status") return "status"
  if (stored === "changes") return "git-changes"
  if (stored === "git-changes") return "git-changes"
  if (stored === "files") return "files"
  if (stored) return stored

  // Migrate from v1 (where the stored values were the internal tab ids).
  const legacy = readClientLayoutValue(LEGACY_RIGHT_PANEL_TAB_STORAGE_KEY)
  if (legacy === "status") return "status"
  if (legacy === "browser") return "files"
  if (legacy === "files") return "git-changes"

  return defaultValue
}

export function readStoredEnum<T extends string>(key: string, allowed: readonly T[]): T | null {
  const stored = readClientLayoutValue(key)
  if (!stored) return null
  return (allowed as readonly string[]).includes(stored) ? (stored as T) : null
}

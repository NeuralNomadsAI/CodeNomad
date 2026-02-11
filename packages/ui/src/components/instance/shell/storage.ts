export const DEFAULT_SESSION_SIDEBAR_WIDTH = 340
export const MIN_SESSION_SIDEBAR_WIDTH = 220
export const MAX_SESSION_SIDEBAR_WIDTH = 400

export const RIGHT_DRAWER_WIDTH = 260
export const MIN_RIGHT_DRAWER_WIDTH = 200
export const MAX_RIGHT_DRAWER_WIDTH = 1200

export const LEFT_DRAWER_STORAGE_KEY = "opencode-session-sidebar-width-v8"
export const RIGHT_DRAWER_STORAGE_KEY = "opencode-session-right-drawer-width-v1"
export const LEFT_PIN_STORAGE_KEY = "opencode-session-left-drawer-pinned-v1"
export const RIGHT_PIN_STORAGE_KEY = "opencode-session-right-drawer-pinned-v1"
export const RIGHT_PANEL_TAB_STORAGE_KEY = "opencode-session-right-panel-tab-v2"
export const LEGACY_RIGHT_PANEL_TAB_STORAGE_KEY = "opencode-session-right-panel-tab-v1"
export const RIGHT_PANEL_CHANGES_SPLIT_WIDTH_KEY = "opencode-session-right-panel-changes-split-width-v1"
export const RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY = "opencode-session-right-panel-files-split-width-v1"
export const RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY = "opencode-session-right-panel-git-changes-split-width-v1"
export const RIGHT_PANEL_CHANGES_LIST_OPEN_NONPHONE_KEY = "opencode-session-right-panel-changes-list-open-nonphone-v1"
export const RIGHT_PANEL_CHANGES_LIST_OPEN_PHONE_KEY = "opencode-session-right-panel-changes-list-open-phone-v1"
export const RIGHT_PANEL_FILES_LIST_OPEN_NONPHONE_KEY = "opencode-session-right-panel-files-list-open-nonphone-v1"
export const RIGHT_PANEL_FILES_LIST_OPEN_PHONE_KEY = "opencode-session-right-panel-files-list-open-phone-v1"
export const RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_NONPHONE_KEY = "opencode-session-right-panel-git-changes-list-open-nonphone-v1"
export const RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_PHONE_KEY = "opencode-session-right-panel-git-changes-list-open-phone-v1"
export const RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY = "opencode-session-right-panel-changes-diff-view-mode-v1"
export const RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY = "opencode-session-right-panel-changes-diff-context-mode-v1"

export const clampWidth = (value: number) =>
  Math.min(MAX_SESSION_SIDEBAR_WIDTH, Math.max(MIN_SESSION_SIDEBAR_WIDTH, value))

export const clampRightWidth = (value: number) => {
  const windowMax = typeof window !== "undefined" ? Math.floor(window.innerWidth * 0.7) : MAX_RIGHT_DRAWER_WIDTH
  const max = Math.max(MIN_RIGHT_DRAWER_WIDTH, windowMax)
  return Math.min(max, Math.max(MIN_RIGHT_DRAWER_WIDTH, value))
}

const getPinStorageKey = (side: "left" | "right") => (side === "left" ? LEFT_PIN_STORAGE_KEY : RIGHT_PIN_STORAGE_KEY)

export function readStoredPinState(side: "left" | "right", defaultValue: boolean) {
  if (typeof window === "undefined") return defaultValue
  const stored = window.localStorage.getItem(getPinStorageKey(side))
  if (stored === "true") return true
  if (stored === "false") return false
  return defaultValue
}

export function persistPinState(side: "left" | "right", value: boolean) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(getPinStorageKey(side), value ? "true" : "false")
}

export function readStoredRightPanelTab(
  defaultValue: "changes" | "git-changes" | "files" | "status",
): "changes" | "git-changes" | "files" | "status" {
  if (typeof window === "undefined") return defaultValue

  const stored = window.localStorage.getItem(RIGHT_PANEL_TAB_STORAGE_KEY)
  if (stored === "status") return "status"
  if (stored === "changes") return "changes"
  if (stored === "git-changes") return "git-changes"
  if (stored === "files") return "files"

  // Migrate from v1 (where the stored values were the internal tab ids).
  const legacy = window.localStorage.getItem(LEGACY_RIGHT_PANEL_TAB_STORAGE_KEY)
  if (legacy === "status") return "status"
  if (legacy === "browser") return "files"
  if (legacy === "files") return "changes"

  return defaultValue
}

export function readStoredPanelWidth(key: string, fallback: number) {
  if (typeof window === "undefined") return fallback
  const stored = window.localStorage.getItem(key)
  if (!stored) return fallback
  const parsed = Number.parseInt(stored, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function readStoredBool(key: string): boolean | null {
  if (typeof window === "undefined") return null
  const stored = window.localStorage.getItem(key)
  if (stored === "true") return true
  if (stored === "false") return false
  return null
}

export function readStoredEnum<T extends string>(key: string, allowed: readonly T[]): T | null {
  if (typeof window === "undefined") return null
  const stored = window.localStorage.getItem(key)
  if (!stored) return null
  return (allowed as readonly string[]).includes(stored) ? (stored as T) : null
}

import { createSignal } from "solid-js"
import { runtimeEnv } from "../lib/runtime-env"
import { openNativePreferences, type NativePreferencesRequest } from "../lib/native/preferences-window"
import { getLogger } from "../lib/logger"
import { confirmSettingsDiscard } from "./settings-dirty-guard"
import { backendOf, isLocalBackend } from "../lib/backend-client"

export type SettingsSectionId =
  | "general"
  | "chat"
  | "hotkeys"
  | "notifications"
  | "speech"
  | "remote"
  | "servers"
  | "opencode"
  | "providers"
  | "missions"
  | "usage"
  | "sidecars"
  | "config-files"
  | "advanced"
  | "info"

const [settingsOpen, setSettingsOpen] = createSignal(false)
const [activeSettingsSection, setActiveSettingsSection] = createSignal<SettingsSectionId>("general")
const log = getLogger("actions")

/** Every Settings entry point shares this route. Local desktop windows always
 * reuse/focus the single native Preferences window with the active project
 * context; only browser and remote windows use the embedded screen. A native
 * rejection (for example an older host lacking a section) is reported, never
 * answered with a second, embedded Settings surface. */
export async function openSettings(section?: SettingsSectionId, toggle = false) {
  if (toggle && settingsOpen()) {
    if (await confirmSettingsDiscard()) closeSettings()
    return
  }
  if (section) setActiveSettingsSection(section)
  if ((runtimeEnv.host === "electron" || runtimeEnv.host === "tauri") && runtimeEnv.windowContext === "local") {
    try {
      const { activeInstanceId, instances } = await import("./instances")
      const selected = activeInstanceId()
      const instanceId = selected && isLocalBackend(backendOf(selected)) ? selected : undefined
      const request: NativePreferencesRequest = { section: section ?? "general", instanceId }
      if (instanceId) {
        request.workspacePath = instances().get(instanceId)?.folder
        const { getActiveCatalogLocation } = await import("./sessions")
        request.location = getActiveCatalogLocation(instanceId)
      }
      await openNativePreferences(request, toggle, section === undefined)
    } catch (error) {
      log.warn("Native Preferences rejected the request", error)
      const [{ showToastNotification }, { tGlobal }] = await Promise.all([import("../lib/notifications"), import("../lib/i18n")])
      showToastNotification({ category: "settings", message: tGlobal("settings.native.openFailed"), variant: "error" })
    }
    return
  }
  setSettingsOpen(true)
}

export const toggleSettings = (section?: SettingsSectionId) => openSettings(section, true)

/** Stable setting-row anchors (the row's `id`), independent of their labels. */
export type SettingsRowId = "opencode-login-start"
const SETTINGS_ROWS = new Set<SettingsRowId>(["opencode-login-start"])
const ROW_HINT_KEY = "codenomad.settings.rowTarget", ROW_HINT_MS = 15_000
const [settingsRowTarget, setSettingsRowTarget] = createSignal<SettingsRowId>()
const [rowTargetSection, setRowTargetSection] = createSignal<SettingsSectionId>()
const targetRow = (row: SettingsRowId | undefined, section?: SettingsSectionId) => { setRowTargetSection(section); setSettingsRowTarget(row) }
/** True while the shown section holds a row that will focus itself. */
export const settingsRowPending = () => !!settingsRowTarget() && rowTargetSection() === activeSettingsSection()
/** Opens a section and asks the row with that anchor to take focus once shown. The
 * native Preferences window is another same-origin document: hosts carry only the
 * section, so the row travels as a short-lived localStorage hint it consumes. */
export async function openSettingsRow(section: SettingsSectionId, row: SettingsRowId) {
  const native = (runtimeEnv.host === "electron" || runtimeEnv.host === "tauri") && runtimeEnv.windowContext === "local"
  if (!native) {
    if (settingsOpen() && activeSettingsSection() !== section && !(await confirmSettingsDiscard())) return
    targetRow(row, section)
    return openSettings(section)
  }
  try { localStorage.setItem(ROW_HINT_KEY, JSON.stringify({ section, row, at: Date.now() })) } catch { /* the section still opens */ }
  return openSettings(section)
}
/** Preferences windows adopt a fresh hint for their active section, once. */
export function adoptSettingsRowHint(section: SettingsSectionId) {
  let hint: { section?: unknown; row?: unknown; at?: unknown } | undefined
  try { hint = JSON.parse(localStorage.getItem(ROW_HINT_KEY) ?? "null") ?? undefined } catch { hint = undefined }
  if (!hint || hint.section !== section || !SETTINGS_ROWS.has(hint.row as SettingsRowId)
    || typeof hint.at !== "number" || Math.abs(Date.now() - hint.at) > ROW_HINT_MS) return
  try { localStorage.removeItem(ROW_HINT_KEY) } catch { /* consumed by the signal below */ }
  targetRow(hint.row as SettingsRowId, section)
}
export const SETTINGS_ROW_HINT_KEY = ROW_HINT_KEY
/** The row claims its pending target once, then scrolls and focuses itself. */
export function claimSettingsRow(row: SettingsRowId) {
  if (settingsRowTarget() !== row) return false
  targetRow(undefined)
  return true
}
export { settingsRowTarget }

/** Closing drops a target its row never claimed, so later openings keep their own focus. */
export function closeSettings() {
  targetRow(undefined)
  setSettingsOpen(false)
}

export { settingsOpen, activeSettingsSection, setActiveSettingsSection }

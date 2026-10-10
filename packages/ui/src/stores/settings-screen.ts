import { createSignal } from "solid-js"
import { runtimeEnv } from "../lib/runtime-env"
import { openNativePreferences, type NativePreferencesRequest } from "../lib/native/preferences-window"
import { getLogger } from "../lib/logger"
import { confirmSettingsDiscard } from "./settings-dirty-guard"

export type SettingsSectionId =
  | "general"
  | "chat"
  | "notifications"
  | "speech"
  | "remote"
  | "opencode"
  | "providers"
  | "missions"
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
    if (await confirmSettingsDiscard()) setSettingsOpen(false)
    return
  }
  if (section) setActiveSettingsSection(section)
  if ((runtimeEnv.host === "electron" || runtimeEnv.host === "tauri") && runtimeEnv.windowContext === "local") {
    try {
      const { activeInstanceId } = await import("./instances")
      const instanceId = activeInstanceId() ?? undefined
      const request: NativePreferencesRequest = { section: section ?? "general", instanceId }
      if (instanceId) {
        const { getActiveCatalogLocation } = await import("./sessions")
        request.location = getActiveCatalogLocation(instanceId)
      }
      await openNativePreferences(request, toggle, section === undefined)
    } catch (error) {
      log.warn("Native Preferences rejected the request", error)
      const [{ showToastNotification }, { tGlobal }] = await Promise.all([import("../lib/notifications"), import("../lib/i18n")])
      showToastNotification({ message: tGlobal("settings.native.openFailed"), variant: "error" })
    }
    return
  }
  setSettingsOpen(true)
}

export const toggleSettings = (section?: SettingsSectionId) => openSettings(section, true)

export function closeSettings() {
  setSettingsOpen(false)
}

export { settingsOpen, activeSettingsSection, setActiveSettingsSection }

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
  | "usage"
  | "sidecars"
  | "config-files"
  | "advanced"
  | "info"

const [settingsOpen, setSettingsOpen] = createSignal(false)
const [activeSettingsSection, setActiveSettingsSection] = createSignal<SettingsSectionId>("general")
const log = getLogger("actions")

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
      return
    } catch (error) {
      log.warn("Native Preferences failed; opening settings in this window", error)
    }
  }
  setSettingsOpen(true)
}

export const toggleSettings = (section?: SettingsSectionId) => openSettings(section, true)

export function closeSettings() {
  setSettingsOpen(false)
}

export { settingsOpen, activeSettingsSection, setActiveSettingsSection }

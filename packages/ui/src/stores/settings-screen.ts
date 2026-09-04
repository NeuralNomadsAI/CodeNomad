import { createSignal } from "solid-js"
import { runtimeEnv } from "../lib/runtime-env"
import { openNativePreferences, type NativePreferencesRequest } from "../lib/native/preferences-window"
import { getLogger } from "../lib/logger"

export type SettingsSectionId =
  | "general"
  | "chat"
  | "notifications"
  | "speech"
  | "remote"
  | "opencode"
  | "providers"
  | "sidecars"
  | "config-files"
  | "advanced"
  | "info"

const [settingsOpen, setSettingsOpen] = createSignal(false)
const [activeSettingsSection, setActiveSettingsSection] = createSignal<SettingsSectionId>("general")
const log = getLogger("actions")

export async function openSettings(section: SettingsSectionId = "general") {
  setActiveSettingsSection(section)
  if ((runtimeEnv.host === "electron" || runtimeEnv.host === "tauri") && runtimeEnv.windowContext === "local") {
    try {
      const { activeInstanceId } = await import("./instances")
      const instanceId = activeInstanceId() ?? undefined
      const request: NativePreferencesRequest = { section, instanceId }
      if (instanceId) {
        const { getActiveCatalogLocation } = await import("./sessions")
        request.location = getActiveCatalogLocation(instanceId)
      }
      await openNativePreferences(request)
      return
    } catch (error) {
      log.warn("Native Preferences failed; opening settings in this window", error)
    }
  }
  setSettingsOpen(true)
}

export function closeSettings() {
  setSettingsOpen(false)
}

export { settingsOpen, activeSettingsSection, setActiveSettingsSection }

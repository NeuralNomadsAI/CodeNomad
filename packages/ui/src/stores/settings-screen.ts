import { createSignal } from "solid-js"

export type SettingsSectionId =
  | "general"
  | "chat"
  | "notifications"
  | "voice"
  | "connections"
  | "runtime"
  | "advanced"
  | "about"

const [settingsOpen, setSettingsOpen] = createSignal(false)
const [activeSettingsSection, setActiveSettingsSection] = createSignal<SettingsSectionId>("general")

export function openSettings(section: SettingsSectionId = "general") {
  setActiveSettingsSection(section)
  setSettingsOpen(true)
}

export function closeSettings() {
  setSettingsOpen(false)
}

export { settingsOpen, activeSettingsSection, setActiveSettingsSection }

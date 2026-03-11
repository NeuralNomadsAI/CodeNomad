import { createSignal } from "solid-js"

export type SettingsSectionId = "appearance" | "notifications" | "remote" | "opencode"

const [settingsOpen, setSettingsOpen] = createSignal(false)
const [activeSettingsSection, setActiveSettingsSection] = createSignal<SettingsSectionId>("appearance")

export function openSettings(section: SettingsSectionId = "appearance") {
  setActiveSettingsSection(section)
  setSettingsOpen(true)
}

export function closeSettings() {
  setSettingsOpen(false)
}

export { settingsOpen, activeSettingsSection, setActiveSettingsSection }

import { Dialog } from "@kobalte/core/dialog"
import { Select } from "@kobalte/core/select"
import { Settings, Bell, ChevronDown, FileCog, Info, MonitorUp, Paintbrush, Terminal, Volume2, Globe, X } from "lucide-solid"
import { createMemo, For, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import {
  activeSettingsSection,
  closeSettings,
  settingsOpen,
  setActiveSettingsSection,
  type SettingsSectionId,
} from "../stores/settings-screen"
import { AppearanceSettingsSection } from "./settings/appearance-settings-section"
import { InfoSettingsSection } from "./settings/info-settings-section"
import { NotificationsSettingsSection } from "./settings/notifications-settings-section"
import { OpenCodeSettingsSection } from "./settings/opencode-settings-section"
import { ConfigFilesSettingsSection } from "./settings/config-files-settings-section"
import { RemoteAccessSettingsSection } from "./settings/remote-access-settings-section"
import { SpeechSettingsSection } from "./settings/speech-settings-section"
import { SideCarsSettingsSection } from "./settings/sidecars-settings-section"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { confirmSettingsDiscard } from "../stores/settings-dirty-guard"

type SettingsSectionOption = {
  id: SettingsSectionId
  icon: typeof Settings
  label: string
}

export const SettingsScreen: Component = () => {
  const { t } = useI18n()

  const sections = createMemo(() => {
    const items: SettingsSectionOption[] = [
      { id: "appearance", icon: Paintbrush, label: t("settings.nav.appearance") },
      { id: "notifications", icon: Bell, label: t("settings.nav.notifications") },
      { id: "speech", icon: Volume2, label: t("settings.nav.speech") },
      { id: "sidecars", icon: Globe, label: t("settings.nav.sidecars") },
      { id: "opencode", icon: Terminal, label: t("settings.nav.opencode") },
      { id: "config-files", icon: FileCog, label: t("settings.nav.configFiles") },
      { id: "info", icon: Info, label: t("settings.nav.info") },
    ]

    if (canOpenRemoteWindows()) {
      items.splice(2, 0, { id: "remote", icon: MonitorUp, label: t("settings.nav.remote") })
    }

    return items
  })

  const activeSection = createMemo(() => sections().find((section) => section.id === activeSettingsSection()) ?? sections()[0])

  const renderSection = () => {
    switch (activeSettingsSection()) {
      case "notifications":
        return <NotificationsSettingsSection />
      case "remote":
        return canOpenRemoteWindows() ? <RemoteAccessSettingsSection /> : <AppearanceSettingsSection />
      case "speech":
        return <SpeechSettingsSection />
      case "sidecars":
        return <SideCarsSettingsSection />
      case "opencode":
        return <OpenCodeSettingsSection />
      case "config-files":
        return <ConfigFilesSettingsSection />
      case "info":
        return <InfoSettingsSection />
      case "appearance":
      default:
        return <AppearanceSettingsSection />
    }
  }

  const handleSectionChange = async (sectionId: SettingsSectionId) => {
    if (sectionId === activeSettingsSection()) return
    if (!(await confirmSettingsDiscard())) return
    setActiveSettingsSection(sectionId)
  }

  const handleCloseSettings = async () => {
    if (!(await confirmSettingsDiscard())) return
    closeSettings()
  }

  return (
    <Dialog open={settingsOpen()} onOpenChange={(open) => !open && void handleCloseSettings()}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="settings-screen-frame">
          <Dialog.Content class="modal-surface settings-screen-shell">
            <Dialog.Title class="sr-only">{t("settings.title")}</Dialog.Title>

            <aside class="settings-screen-nav">
              <div class="settings-screen-compact-bar">
                <span class="settings-screen-compact-icon-wrap">
                  <Settings class="settings-screen-nav-icon" />
                </span>
                <div class="settings-section-selector-wrap">
                  <Select<SettingsSectionOption>
                    value={activeSection()}
                    onChange={(section) => section && void handleSectionChange(section.id)}
                    options={sections()}
                    optionValue="id"
                    optionTextValue="label"
                    itemComponent={(itemProps) => {
                      const Icon = itemProps.item.rawValue.icon
                      return (
                        <Select.Item item={itemProps.item} class="selector-option settings-section-selector-option">
                          <Icon class="settings-section-selector-option-icon" />
                          <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
                        </Select.Item>
                      )
                    }}
                  >
                    <Select.Trigger class="selector-trigger settings-section-selector-trigger" aria-label={t("settings.navigationAriaLabel")}>
                      <div class="flex-1 min-w-0">
                        <Select.Value<SettingsSectionOption>>
                          {(state) => {
                            const selected = state.selectedOption()
                            const Icon = selected?.icon ?? Settings
                            return (
                              <span class="settings-section-selector-value">
                                <Icon class="settings-section-selector-value-icon" />
                                <span class="selector-trigger-primary selector-trigger-primary--align-left">{selected?.label}</span>
                              </span>
                            )
                          }}
                        </Select.Value>
                      </div>
                      <Select.Icon class="selector-trigger-icon">
                        <ChevronDown class="w-3 h-3" />
                      </Select.Icon>
                    </Select.Trigger>

                    <Select.Portal>
                      <Select.Content class="selector-popover settings-section-selector-popover">
                        <Select.Listbox class="selector-listbox" />
                      </Select.Content>
                    </Select.Portal>
                  </Select>
                </div>
                <button
                  type="button"
                  class="selector-button selector-button-secondary settings-screen-close settings-screen-compact-close"
                  onClick={() => void handleCloseSettings()}
                  aria-label={t("settings.close")}
                  title={t("settings.close")}
                >
                  <X class="w-4 h-4" />
                </button>
              </div>

              <div class="settings-screen-nav-header">
                <div class="settings-screen-nav-title-row">
                  <span class="settings-screen-nav-icon-wrap">
                    <Settings class="settings-screen-nav-icon" />
                  </span>
                  <div>
                    <h2 class="settings-screen-title">{t("settings.title")}</h2>
                  </div>
                </div>
              </div>

              <nav class="settings-screen-nav-list" aria-label={t("settings.navigationAriaLabel")}>
                <For each={sections()}>
                  {(section) => {
                    const Icon = section.icon
                    return (
                      <button
                        type="button"
                        class="settings-nav-button"
                        data-selected={activeSettingsSection() === section.id ? "true" : "false"}
                        onClick={() => void handleSectionChange(section.id)}
                      >
                        <Icon class="settings-nav-button-icon" />
                        <span>{section.label}</span>
                      </button>
                    )
                  }}
                </For>
              </nav>
            </aside>

            <div class="settings-screen-content">
              <header class="settings-screen-content-header">
                <div class="settings-screen-content-header-title-group">
                  <p class="settings-screen-content-eyebrow">{t("settings.content.eyebrow")}</p>
                  <h1 class="settings-screen-content-title">
                    {activeSection()?.label}
                  </h1>
                </div>
                <button
                  type="button"
                  class="selector-button selector-button-secondary settings-screen-close"
                  onClick={() => void handleCloseSettings()}
                  aria-label={t("settings.close")}
                  title={t("settings.close")}
                >
                  <X class="w-4 h-4" />
                </button>
              </header>

              <div class="settings-screen-scroll">{renderSection()}</div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

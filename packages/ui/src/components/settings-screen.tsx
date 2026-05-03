import { Dialog } from "@kobalte/core/dialog"
import { Settings, Bell, MonitorUp, Paintbrush, Terminal, Volume2, Globe, X } from "lucide-solid"
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
import { NotificationsSettingsSection } from "./settings/notifications-settings-section"
import { OpenCodeSettingsSection } from "./settings/opencode-settings-section"
import { RemoteAccessSettingsSection } from "./settings/remote-access-settings-section"
import { SpeechSettingsSection } from "./settings/speech-settings-section"
import { SideCarsSettingsSection } from "./settings/sidecars-settings-section"
import { canOpenRemoteWindows } from "../lib/runtime-env"

export const SettingsScreen: Component = () => {
  const { t } = useI18n()

  const sections = createMemo(() => {
    const items = [
      { id: "appearance" as SettingsSectionId, icon: Paintbrush, label: t("settings.nav.appearance") },
      { id: "notifications" as SettingsSectionId, icon: Bell, label: t("settings.nav.notifications") },
      { id: "speech" as SettingsSectionId, icon: Volume2, label: t("settings.nav.speech") },
      { id: "sidecars" as SettingsSectionId, icon: Globe, label: t("settings.nav.sidecars") },
      { id: "opencode" as SettingsSectionId, icon: Terminal, label: t("settings.nav.opencode") },
    ]

    if (canOpenRemoteWindows()) {
      items.splice(2, 0, { id: "remote" as SettingsSectionId, icon: MonitorUp, label: t("settings.nav.remote") })
    }

    return items
  })

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
      case "appearance":
      default:
        return <AppearanceSettingsSection />
    }
  }

  return (
    <Dialog open={settingsOpen()} onOpenChange={(open) => !open && closeSettings()}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="settings-screen-frame">
          <Dialog.Content class="modal-surface settings-screen-shell">
            <Dialog.Title class="sr-only">{t("settings.title")}</Dialog.Title>

            <aside class="settings-screen-nav">
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
                        onClick={() => setActiveSettingsSection(section.id)}
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
                    {sections().find((section) => section.id === activeSettingsSection())?.label}
                  </h1>
                </div>
                <button
                  type="button"
                  class="selector-button selector-button-secondary settings-screen-close"
                  onClick={closeSettings}
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

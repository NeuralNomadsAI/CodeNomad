import { createMemo, lazy, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getBehaviorSettings } from "../../lib/settings/behavior-registry"
import { useConfig } from "../../stores/preferences"
import { LocaleSelector } from "../locale-selector"
import { BehaviorSettingRows } from "./behavior-setting-rows"
import { ThemeSchemeSettings } from "./theme-scheme-settings"

const StartupStateSettingsCard = lazy(() => import("./startup-state-settings-card").then((module) => ({ default: module.StartupStateSettingsCard })))

interface GeneralSettingsSectionProps {
  showStartupState?: boolean
}

export const GeneralSettingsSection: Component<GeneralSettingsSectionProps> = (props) => {
  const { t } = useI18n()
  const config = useConfig()
  const generalSettings = createMemo(() =>
    getBehaviorSettings(config).filter(
      (setting) =>
        setting.id === "behavior.keyboardShortcutHints" ||
        setting.id === "behavior.messageTimeline" ||
        setting.id === "behavior.timelineToolCalls" ||
        setting.id === "behavior.diffViewMode" ||
        setting.id === "behavior.followUpBehavior" ||
        setting.id === "behavior.promptSubmitOnEnter",
    ),
  )

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("folderSelection.language.ariaLabel")}</h3>
            <p class="settings-card-subtitle">{t("settings.general.language.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>
        <LocaleSelector />
      </div>

      <Show when={props.showStartupState !== false}><StartupStateSettingsCard /></Show>

      <div class="settings-card">
        <div class="settings-stack">
          <BehaviorSettingRows settings={generalSettings} preferences={config.preferences} />
        </div>
      </div>

      <ThemeSchemeSettings />
    </div>
  )
}

import { createMemo, lazy, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getBehaviorSettings, type BehaviorSetting } from "../../lib/settings/behavior-registry"
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
  const { updatePreferences } = config
  const generalSettings = createMemo<BehaviorSetting[]>(() => [
    ...getBehaviorSettings(config).filter(
      (setting) =>
        setting.id === "behavior.keyboardShortcutHints" ||
        setting.id === "behavior.messageTimeline" ||
        setting.id === "behavior.timelineToolCalls" ||
        setting.id === "behavior.diffViewMode" ||
        setting.id === "behavior.followUpBehavior" ||
        setting.id === "behavior.promptSubmitOnEnter",
    ),
    {
      kind: "toggle",
      id: "behavior.holdLongAssistantReplies",
      titleKey: "settings.behavior.holdLongAssistantReplies.title",
      subtitleKey: "settings.behavior.holdLongAssistantReplies.subtitle",
      get: (current) => Boolean(current.holdLongAssistantReplies ?? true),
      set: (next) => updatePreferences({ holdLongAssistantReplies: next }),
    },
  ])

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

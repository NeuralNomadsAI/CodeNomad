import { createMemo, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getBehaviorSettings, type BehaviorSetting } from "../../lib/settings/behavior-registry"
import { isNativeApplicationWindow } from "../../lib/runtime-env"
import { useConfig } from "../../stores/preferences"
import EnvironmentVariablesEditor from "../environment-variables-editor"
import { BehaviorSettingRows } from "./behavior-setting-rows"

export const AdvancedSettingsSection: Component = () => {
  const { t } = useI18n()
  const config = useConfig()
  const advancedSettings = createMemo<BehaviorSetting[]>(() => [
    ...getBehaviorSettings(config).filter(
      (setting) =>
        setting.id === "behavior.autoCleanupBlankSessions" ||
        setting.id === "behavior.keepUnseenSubagentIdleStatus" ||
        (setting.id === "behavior.focusExistingWindowOnSecondLaunch" && isNativeApplicationWindow()) ||
        setting.id === "behavior.providerUsageCreditBalance",
    ),
    {
      kind: "toggle",
      id: "behavior.holdLongAssistantReplies",
      titleKey: "settings.behavior.holdLongAssistantReplies.title",
      subtitleKey: "settings.behavior.holdLongAssistantReplies.subtitle",
      get: (current) => Boolean(current.holdLongAssistantReplies ?? true),
      set: (next) => config.updatePreferences({ holdLongAssistantReplies: next }),
    },
  ])

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("advancedSettings.environmentVariables.title")}</h3>
            <p class="settings-card-subtitle">{t("advancedSettings.environmentVariables.subtitle")}</p>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>
        <EnvironmentVariablesEditor />
      </div>

      <div class="settings-card">
        <div class="settings-stack">
          <BehaviorSettingRows settings={advancedSettings} preferences={config.preferences} />
        </div>
      </div>
    </div>
  )
}

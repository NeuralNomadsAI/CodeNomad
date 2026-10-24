import { createMemo, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getBehaviorSettings, type BehaviorSetting } from "../../lib/settings/behavior-registry"
import { isNativeApplicationWindow } from "../../lib/runtime-env"
import { useConfig } from "../../stores/preferences"
import EnvironmentVariablesEditor from "../environment-variables-editor"
import { BehaviorSettingRows } from "./behavior-setting-rows"
import { SettingsInfoTip } from "./settings-info-tip"

export const AdvancedSettingsSection: Component = () => {
  const { t } = useI18n()
  const config = useConfig()
  const advancedSettings = createMemo<BehaviorSetting[]>(() => [
    ...getBehaviorSettings(config).filter(
      (setting) =>
        setting.id === "behavior.autoCleanupBlankSessions" ||
        setting.id === "behavior.keepUnseenSubagentIdleStatus" ||
        (setting.id === "behavior.focusExistingWindowOnSecondLaunch" && isNativeApplicationWindow()) ||
        setting.id === "behavior.providerUsageCreditBalance" ||
        setting.id === "behavior.hideDiffWhitespaceChanges",
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
  const variableCount = () => Object.keys(config.serverSettings().environmentVariables ?? {}).length

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-stack">
          <BehaviorSettingRows settings={advancedSettings} preferences={config.preferences} />
        </div>
      </div>

      {/* One folded group after the setting list: title, count and an "i" instead of explanatory text. */}
      <div class="settings-card">
        <details class="settings-disclosure settings-env-disclosure">
          <summary>
            {t("advancedSettings.environmentVariables.title")}
            <span class="settings-env-count">{t(variableCount() === 1 ? "envEditor.count.one" : "envEditor.count.other", { count: variableCount() })}</span>
            <SettingsInfoTip text={t("advancedSettings.environmentVariables.subtitle")} />
            <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
          </summary>
          <EnvironmentVariablesEditor bare />
        </details>
      </div>
    </div>
  )
}

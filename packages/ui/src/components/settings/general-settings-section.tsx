import { Check, Laptop, Moon, Sun } from "lucide-solid"
import { createMemo, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getBehaviorSettings, type BehaviorSetting } from "../../lib/settings/behavior-registry"
import { useTheme, type ThemeMode } from "../../lib/theme"
import { useConfig } from "../../stores/preferences"
import { LocaleSelector } from "../locale-selector"
import { BehaviorSettingRows } from "./behavior-setting-rows"
import { StartupStateSettingsCard } from "./startup-state-settings-card"

const themeModeOptions: Array<{ value: ThemeMode; icon: typeof Laptop }> = [
  { value: "system", icon: Laptop },
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
]

export const GeneralSettingsSection: Component = () => {
  const { t } = useI18n()
  const { themeMode, setThemeMode } = useTheme()
  const config = useConfig()
  const { updatePreferences } = config
  const generalSettings = createMemo<BehaviorSetting[]>(() => [
    ...getBehaviorSettings(config).filter(
      (setting) =>
        setting.id === "behavior.keyboardShortcutHints" ||
        setting.id === "behavior.messageTimeline" ||
        setting.id === "behavior.diffViewMode" ||
        setting.id === "behavior.autoCleanupBlankSessions" ||
        setting.id === "behavior.keepUnseenSubagentIdleStatus" ||
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

  const modeLabel = (mode: ThemeMode) => {
    if (mode === "system") return t("theme.mode.system")
    if (mode === "light") return t("theme.mode.light")
    return t("theme.mode.dark")
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.appearance.theme.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.appearance.theme.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>
        <div class="settings-choice-grid">
          {themeModeOptions.map((option) => {
            const Icon = option.icon
            return (
              <button type="button" class="settings-choice" data-selected={themeMode() === option.value ? "true" : "false"} onClick={() => setThemeMode(option.value)}>
                <span class="settings-choice-icon-wrap"><Icon class="settings-choice-icon" /></span>
                <span class="settings-choice-copy">
                  <span class="settings-choice-label">{modeLabel(option.value)}</span>
                  <span class="settings-choice-description">{t(`settings.appearance.theme.option.${option.value}`)}</span>
                </span>
                <span class="settings-choice-check" aria-hidden="true"><Check class="w-4 h-4" /></span>
              </button>
            )
          })}
        </div>
      </div>

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

      <StartupStateSettingsCard />

      <div class="settings-card">
        <div class="settings-stack">
          <BehaviorSettingRows settings={generalSettings} preferences={config.preferences} />
        </div>
      </div>
    </div>
  )
}

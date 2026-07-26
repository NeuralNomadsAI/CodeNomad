import { Select } from "@kobalte/core/select"
import { ChevronDown } from "lucide-solid"
import { createMemo, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getBehaviorSettings } from "../../lib/settings/behavior-registry"
import { isTauriHost } from "../../lib/runtime-env"
import { useConfig, type ServerLogLevel } from "../../stores/preferences"
import EnvironmentVariablesEditor from "../environment-variables-editor"
import { BehaviorSettingRows } from "./behavior-setting-rows"
import { ConfigFilesSettingsSection } from "./config-files-settings-section"

type LogLevelOption = { value: ServerLogLevel; label: string }

export const AdvancedSettingsSection: Component = () => {
  const { t } = useI18n()
  const config = useConfig()
  const { serverSettings, updateLogLevel } = config
  const logLevelOptions = createMemo<LogLevelOption[]>(() => [
    { value: "DEBUG", label: t("settings.opencode.logLevel.option.debug") },
    { value: "INFO", label: t("settings.opencode.logLevel.option.info") },
    { value: "WARN", label: t("settings.opencode.logLevel.option.warn") },
    { value: "ERROR", label: t("settings.opencode.logLevel.option.error") },
  ])
  const selectedLogLevel = createMemo(
    () => logLevelOptions().find((option) => option.value === serverSettings().logLevel) ?? logLevelOptions()[0],
  )
  const transportSettings = createMemo(() =>
    getBehaviorSettings(config).filter((setting) => setting.id === "behavior.tauriNativeEventTransport"),
  )

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.opencode.logLevel.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.opencode.logLevel.subtitle")}</p>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>
        <div class="settings-card-body">
          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.opencode.logLevel.selector.title")}</div>
              <div class="settings-toggle-caption">{t("settings.opencode.logLevel.selector.subtitle")}</div>
            </div>
            <Select<LogLevelOption>
              value={selectedLogLevel()}
              onChange={(option) => option && updateLogLevel(option.value)}
              options={logLevelOptions()}
              optionValue="value"
              optionTextValue="label"
              itemComponent={(itemProps) => (
                <Select.Item item={itemProps.item} class="selector-option">
                  <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
                </Select.Item>
              )}
            >
              <Select.Trigger class="selector-trigger" aria-label={t("settings.opencode.logLevel.title")}>
                <div class="flex-1 min-w-0">
                  <Select.Value<LogLevelOption>>
                    {(state) => <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.label}</span>}
                  </Select.Value>
                </div>
                <Select.Icon class="selector-trigger-icon"><ChevronDown class="w-3 h-3" /></Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content class="selector-popover"><Select.Listbox class="selector-listbox" /></Select.Content>
              </Select.Portal>
            </Select>
          </div>
        </div>
      </div>

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

      <Show when={isTauriHost()}>
        <div class="settings-card">
          <div class="settings-stack">
            <BehaviorSettingRows settings={transportSettings} preferences={config.preferences} />
          </div>
        </div>
      </Show>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.configFiles.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.configFiles.subtitle")}</p>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>
        <div class="advanced-config-files">
          <ConfigFilesSettingsSection />
        </div>
      </div>
    </div>
  )
}

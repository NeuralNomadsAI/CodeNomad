import type { Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { DataProfilesSettings } from "./data-profiles-settings"
import { SettingsSwitch } from "./settings-switch"
import { SettingsInfoTip } from "./settings-info-tip"

interface StartupStateSettingsViewProps {
  restoreEnabled: boolean
  disabled: boolean
  onRestoreChange: (enabled: boolean) => void
  onClear: () => void
}

export const StartupStateSettingsView: Component<StartupStateSettingsViewProps> = (props) => {
  const { t } = useI18n()
  return (
    <div class="settings-card" data-testid="startup-state-settings">
      <div class="settings-card-header">
        <div>
          <h3 class="settings-card-title">{t("settings.appearance.startup.restore.title")}<SettingsInfoTip text={t("settings.appearance.startup.restore.subtitle")} /></h3>
        </div>
        <SettingsSwitch
          checked={props.restoreEnabled}
          label={t("settings.appearance.startup.restore.title")}
          disabled={props.disabled}
          onChange={props.onRestoreChange}
        />
      </div>
      <div class="settings-stack">

        {/* The rows below open with a separator: keep the button off it. */}
        <div class="flex justify-end pb-[var(--space-sm)]">
          <button
            type="button"
            class="selector-button selector-button-secondary w-auto"
            disabled={props.disabled}
            onClick={() => props.onClear()}
          >
            {t("settings.appearance.startup.clear.action")}
          </button>
        </div>

        <DataProfilesSettings />
      </div>
    </div>
  )
}

import type { Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { CurrentProfileSettingsRow } from "./current-profile-settings-row"
import { OtherProfilesSettingsRow } from "./other-profiles-settings-row"
import { SettingsSwitch } from "./settings-switch"

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
          <h3 class="settings-card-title">{t("settings.appearance.startup.restore.title")}</h3>
          <p class="settings-card-subtitle">{t("settings.appearance.startup.restore.subtitle")}</p>
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

        <CurrentProfileSettingsRow />
        <OtherProfilesSettingsRow />
      </div>
    </div>
  )
}

import { Show, type Component, type JSX } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { OtherProfilesSettingsRow } from "./other-profiles-settings-row"
import { SettingsSwitch } from "./settings-switch"

interface StartupStateSettingsViewProps {
  restoreEnabled: boolean
  disabled: boolean
  note?: JSX.Element
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

        <div class="flex justify-end">
          <button
            type="button"
            class="selector-button selector-button-secondary w-auto"
            disabled={props.disabled}
            onClick={() => props.onClear()}
          >
            {t("settings.appearance.startup.clear.action")}
          </button>
        </div>

        <OtherProfilesSettingsRow />
        {/* Only when the opener-owned controls above are unavailable. */}
        <Show when={props.note}><p class="settings-inline-note settings-inline-warning" role="status">{props.note}</p></Show>
      </div>
    </div>
  )
}

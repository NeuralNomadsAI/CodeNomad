import { Show, type Component, type JSX } from "solid-js"
import { useI18n } from "../../lib/i18n"

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
          <h3 class="settings-card-title">{t("settings.appearance.startup.title")}</h3>
          <p class="settings-card-subtitle">{t("settings.appearance.startup.subtitle")}</p>
          <Show when={props.note}><p class="settings-card-subtitle" role="status">{props.note}</p></Show>
        </div>
        <span class="settings-scope-badge">{t("settings.scope.device")}</span>
      </div>

      <div class="settings-stack">
        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-title">{t("settings.appearance.startup.restore.title")}</div>
            <div class="settings-toggle-caption">{t("settings.appearance.startup.restore.subtitle")}</div>
          </div>
          <label class="settings-checkbox-toggle">
            <input
              type="checkbox"
              aria-label={t("settings.appearance.startup.restore.title")}
              checked={props.restoreEnabled}
              disabled={props.disabled}
              onChange={(event) => props.onRestoreChange(event.currentTarget.checked)}
            />
            <span>{props.restoreEnabled ? t("settings.common.enabled") : t("settings.common.disabled")}</span>
          </label>
        </div>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-title">{t("settings.appearance.startup.clear.title")}</div>
            <div class="settings-toggle-caption">{t("settings.appearance.startup.clear.subtitle")}</div>
          </div>
          <button
            type="button"
            class="selector-button selector-button-secondary w-auto whitespace-nowrap"
            disabled={props.disabled}
            onClick={() => props.onClear()}
          >
            {t("settings.appearance.startup.clear.action")}
          </button>
        </div>
      </div>
    </div>
  )
}

import { createSignal, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { showToastNotification } from "../../lib/notifications"
import {
  clearRestoredClientState,
  clientStateIsPrimary,
  restorePreviousStateEnabled,
  setRestorePreviousStateEnabled,
} from "../../stores/client-state"

export const StartupStateSettingsCard: Component = () => {
  const { t } = useI18n()
  const [busy, setBusy] = createSignal(false)

  const updateRestoreSetting = async (enabled: boolean) => {
    setBusy(true)
    try {
      await setRestorePreviousStateEnabled(enabled)
    } catch {
      showToastNotification({ message: t("settings.appearance.startup.updateError"), variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const clearStartupState = async () => {
    setBusy(true)
    try {
      await clearRestoredClientState()
      showToastNotification({ message: t("settings.appearance.startup.clearSuccess"), variant: "success" })
    } catch {
      showToastNotification({ message: t("settings.appearance.startup.clearError"), variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="settings-card">
      <div class="settings-card-header">
        <div>
          <h3 class="settings-card-title">{t("settings.appearance.startup.title")}</h3>
          <p class="settings-card-subtitle">{t("settings.appearance.startup.subtitle")}</p>
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
              checked={restorePreviousStateEnabled()}
              disabled={busy() || !clientStateIsPrimary()}
              onChange={(event) => void updateRestoreSetting(event.currentTarget.checked)}
            />
            <span>{restorePreviousStateEnabled() ? t("settings.common.enabled") : t("settings.common.disabled")}</span>
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
            disabled={busy() || !clientStateIsPrimary()}
            onClick={() => void clearStartupState()}
          >
            {t("settings.appearance.startup.clear.action")}
          </button>
        </div>
      </div>
    </div>
  )
}

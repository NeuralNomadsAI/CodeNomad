import { createSignal, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { showToastNotification } from "../../lib/notifications"
import {
  clearRestoredClientState,
  clientStateIsPrimary,
  restorePreviousStateEnabled,
  setRestorePreviousStateEnabled,
} from "../../stores/client-state"
import { StartupStateSettingsView } from "./startup-state-settings-view"

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
    <StartupStateSettingsView
      restoreEnabled={restorePreviousStateEnabled()}
      disabled={busy() || !clientStateIsPrimary()}
      onRestoreChange={(enabled) => void updateRestoreSetting(enabled)}
      onClear={() => void clearStartupState()}
    />
  )
}

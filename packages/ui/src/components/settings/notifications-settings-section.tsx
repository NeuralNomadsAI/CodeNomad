import { Show, createEffect, createResource, type Component } from "solid-js"
import { showToastNotification } from "../../lib/notifications"
import { getOsNotificationCapability, requestOsNotificationPermission } from "../../lib/os-notifications"
import { useConfig } from "../../stores/preferences"
import { useI18n } from "../../lib/i18n"
import { NotificationRoutingTable } from "./notification-routing-table"
import { SettingsChoiceRow } from "./settings-switch"

export const NotificationsSettingsSection: Component = () => {
  const { t } = useI18n()
  const { preferences, updatePreferences } = useConfig()
  const [capability, { refetch }] = createResource(() => getOsNotificationCapability())

  createEffect(() => {
    void refetch()
  })

  const notify = (message: string, variant: "success" | "warning", duration?: number) =>
    showToastNotification({ category: "settings", title: t("settings.section.notifications.title"), message, variant, duration })

  const supported = () => capability()?.supported ?? false
  const unsupported = () => !supported() && capability.state === "ready"
  const permissionMissing = () => supported() && (capability()?.permission ?? "unsupported") !== "granted"
  const infoMessage = () => capability()?.info

  /** The system column is the consent: asking happens on the gesture that needs it. */
  const requestPermission = async (announceGranted: boolean) => {
    const cap = capability()
    if (cap && !cap.supported) {
      notify(cap.info ?? t("settings.notifications.messages.unsupportedGeneral"), "warning")
      return
    }
    const permission = await requestOsNotificationPermission()
    void refetch()
    if (permission === "granted") {
      if (announceGranted) notify(t("settings.notifications.messages.permissionGranted"), "success", 6000)
      return
    }
    notify(
      permission === "denied"
        ? t("settings.notifications.messages.permissionRequestDenied")
        : t("settings.notifications.messages.permissionNotGranted"),
      "warning",
    )
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <NotificationRoutingTable
          systemUnavailable={unsupported()}
          onSystemChecked={() => { if (permissionMissing()) void requestPermission(false) }}
        />
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <h3 class="settings-card-title">{t("settings.notifications.system.title")}</h3>
        </div>

        <div class="settings-stack">
          <Show when={permissionMissing()}>
            <div class="settings-toggle-row settings-toggle-row-compact">
              <div>
                <div class="settings-toggle-title">{t("settings.notifications.requestPermission.title")}</div>
                <div class="settings-toggle-caption">{t("settings.notifications.requestPermission.subtitle")}</div>
              </div>
              <button
                type="button"
                class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                onClick={() => void requestPermission(true)}
              >
                {t("settings.notifications.requestPermission.action")}
              </button>
            </div>
          </Show>

          <SettingsChoiceRow
            checked={Boolean(preferences().osNotificationsAllowWhenVisible)}
            title={t("settings.notifications.allowVisible.title")}
            info={t("settings.notifications.allowVisible.subtitle")}
            disabled={unsupported()}
            onChange={(enabled) => updatePreferences({ osNotificationsAllowWhenVisible: enabled })}
          />

          <Show when={Boolean(infoMessage())}>
            <div class="settings-inline-note">{infoMessage()}</div>
          </Show>

          <Show when={unsupported()}>
            <div class="settings-inline-note">{t("settings.notifications.unsupportedNote")}</div>
          </Show>
        </div>
      </div>
    </div>
  )
}

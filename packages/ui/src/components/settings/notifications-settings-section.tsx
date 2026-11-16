import { Show, createEffect, createResource, type Component } from "solid-js"
import { showToastNotification } from "../../lib/notifications"
import { getOsNotificationCapability, requestOsNotificationPermission } from "../../lib/os-notifications"
import { useConfig } from "../../stores/preferences"
import { useI18n } from "../../lib/i18n"
import { NotificationRoutingTable } from "./notification-routing-table"
import { SettingsChoiceRow } from "./settings-switch"
import { BackgroundPushRow } from "./background-push-row"

export const NotificationsSettingsSection: Component = () => {
  const { t } = useI18n()
  const { preferences, updatePreferences } = useConfig()
  const [capability, { refetch }] = createResource(() => getOsNotificationCapability())

  createEffect(() => {
    void refetch()
  })

  const notify = (message: string) =>
    showToastNotification({ category: "settings", title: t("settings.section.notifications.title"), message, variant: "warning" })

  const supported = () => capability()?.supported ?? false
  const unsupported = () => !supported() && capability.state === "ready"
  const permissionMissing = () => supported() && (capability()?.permission ?? "unsupported") !== "granted"
  const infoMessage = () => supported() ? capability()?.info : undefined

  /** The system column is the consent: asking happens on the gesture that needs it. */
  const requestPermission = async () => {
    const cap = capability()
    if (cap && !cap.supported) {
      notify(t("settings.notifications.unsupportedNote"))
      return
    }
    const permission = await requestOsNotificationPermission()
    void refetch()
    if (permission === "granted") return
    notify(
      permission === "denied"
        ? t("settings.notifications.messages.permissionRequestDenied")
        : t("settings.notifications.messages.permissionNotGranted"),
    )
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <NotificationRoutingTable
          systemUnavailable={unsupported()}
          onSystemChecked={() => { if (permissionMissing()) void requestPermission() }}
        />
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <h3 class="settings-card-title">{t("settings.notifications.system.title")}</h3>
        </div>

        <div class="settings-stack">
          <BackgroundPushRow />
          <Show when={permissionMissing()}>
            <div class="settings-toggle-row settings-toggle-row-compact">
              <button
                type="button"
                class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                onClick={() => void requestPermission()}
              >
                {t("settings.notifications.requestPermission.action")}
              </button>
            </div>
          </Show>

          <SettingsChoiceRow
            checked={Boolean(preferences().osNotificationsAllowWhenVisible)}
            title={t("settings.notifications.allowVisible.title")}
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

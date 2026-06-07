import { Show, createEffect, createResource, type Component } from "solid-js"
import { Bell } from "lucide-solid"
import { showToastNotification } from "../../lib/notifications"
import {
  getOsNotificationCapability,
  requestOsNotificationPermission,
  type OsNotificationPermission,
} from "../../lib/os-notifications"
import { useConfig } from "../../stores/preferences"
import { useI18n } from "../../lib/i18n"

function formatPermissionLabel(permission: OsNotificationPermission, t: ReturnType<typeof useI18n>["t"]): string {
  switch (permission) {
    case "granted":
      return t("settings.notifications.permission.granted")
    case "denied":
      return t("settings.notifications.permission.denied")
    case "default":
      return t("settings.notifications.permission.default")
    case "unsupported":
      return t("settings.notifications.permission.unsupported")
    default:
      return String(permission)
  }
}

export const NotificationsSettingsSection: Component = () => {
  const { t } = useI18n()
  const { preferences, updatePreferences } = useConfig()
  const [capability, { refetch }] = createResource(() => getOsNotificationCapability())

  createEffect(() => {
    void refetch()
  })

  const handleEnableToggle = async (enabled: boolean) => {
    if (!enabled) {
      updatePreferences({ osNotificationsEnabled: false })
      return
    }

    const cap = capability()
    if (cap && !cap.supported) {
      showToastNotification({
        title: t("settings.section.notifications.title"),
        message: cap.info ?? t("settings.notifications.messages.unsupportedEnvironment"),
        variant: "warning",
      })
      updatePreferences({ osNotificationsEnabled: false })
      return
    }

    const permission = await requestOsNotificationPermission()
    if (permission !== "granted") {
      showToastNotification({
        title: t("settings.section.notifications.title"),
        message:
          permission === "denied"
            ? t("settings.notifications.messages.permissionDenied")
            : t("settings.notifications.messages.permissionNotGranted"),
        variant: "warning",
      })
      updatePreferences({ osNotificationsEnabled: false })
      return
    }

    updatePreferences({ osNotificationsEnabled: true })
    void refetch()
  }

  const handleRequestPermission = async () => {
    const cap = capability()
    if (cap && !cap.supported) {
      showToastNotification({
        title: t("settings.section.notifications.title"),
        message: cap.info ?? t("settings.notifications.messages.unsupportedGeneral"),
        variant: "warning",
      })
      return
    }

    const permission = await requestOsNotificationPermission()
    if (permission === "granted") {
      showToastNotification({
        title: t("settings.section.notifications.title"),
        message: t("settings.notifications.messages.permissionGranted"),
        variant: "success",
        duration: 6000,
      })
      void refetch()
      return
    }

    showToastNotification({
      title: t("settings.section.notifications.title"),
      message:
        permission === "denied"
          ? t("settings.notifications.messages.permissionRequestDenied")
          : t("settings.notifications.messages.permissionNotGranted"),
      variant: "warning",
    })
    void refetch()
  }

  const supported = () => capability()?.supported ?? false
  const permissionLabel = () => formatPermissionLabel(capability()?.permission ?? "unsupported", t)
  const infoMessage = () => capability()?.info

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Bell class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.notifications.sessionStatus.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.notifications.sessionStatus.subtitle")}</p>
            </div>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>

        <div class="settings-stack">
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-title">{t("settings.notifications.enable.title")}</div>
              <div class="settings-toggle-caption">
                {t("settings.notifications.enable.permission", { permission: permissionLabel() })}
              </div>
            </div>
            <label class="settings-checkbox-toggle">
              <input
                type="checkbox"
                checked={Boolean(preferences().osNotificationsEnabled)}
                disabled={!supported() && capability.state === "ready"}
                onChange={(event) => void handleEnableToggle(event.currentTarget.checked)}
              />
              <span>{t("settings.common.enabled")}</span>
            </label>
          </div>

          <Show when={supported() && (capability()?.permission ?? "unsupported") !== "granted"}>
            <div class="settings-toggle-row settings-toggle-row-compact">
              <div>
                <div class="settings-toggle-title">{t("settings.notifications.requestPermission.title")}</div>
                <div class="settings-toggle-caption">{t("settings.notifications.requestPermission.subtitle")}</div>
              </div>
              <button
                type="button"
                class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                onClick={() => void handleRequestPermission()}
              >
                {t("settings.notifications.requestPermission.action")}
              </button>
            </div>
          </Show>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-title">{t("settings.notifications.allowVisible.title")}</div>
              <div class="settings-toggle-caption">{t("settings.notifications.allowVisible.subtitle")}</div>
            </div>
            <label class="settings-checkbox-toggle">
              <input
                type="checkbox"
                checked={Boolean(preferences().osNotificationsAllowWhenVisible)}
                disabled={!preferences().osNotificationsEnabled}
                onChange={(event) => updatePreferences({ osNotificationsAllowWhenVisible: event.currentTarget.checked })}
              />
              <span>{t("settings.common.enabled")}</span>
            </label>
          </div>

          <Show when={Boolean(infoMessage())}>
            <div class="settings-inline-note">{infoMessage()}</div>
          </Show>

          <Show when={!supported() && capability.state === "ready"}>
            <div class="settings-inline-note">{t("settings.notifications.unsupportedNote")}</div>
          </Show>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.notifications.events.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.notifications.events.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>

        <div class="settings-stack">
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-title">{t("settings.notifications.events.needsInput")}</div>
            </div>
            <label class="settings-checkbox-toggle">
              <input
                type="checkbox"
                checked={Boolean(preferences().notifyOnNeedsInput)}
                disabled={!preferences().osNotificationsEnabled}
                onChange={(event) => updatePreferences({ notifyOnNeedsInput: event.currentTarget.checked })}
              />
              <span>{t("settings.common.enabled")}</span>
            </label>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-title">{t("settings.notifications.events.idle")}</div>
            </div>
            <label class="settings-checkbox-toggle">
              <input
                type="checkbox"
                checked={Boolean(preferences().notifyOnIdle)}
                disabled={!preferences().osNotificationsEnabled}
                onChange={(event) => updatePreferences({ notifyOnIdle: event.currentTarget.checked })}
              />
              <span>{t("settings.common.enabled")}</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}

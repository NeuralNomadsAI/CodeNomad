import { For, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DESTINATIONS,
  type NotificationCategory,
  type NotificationDestination,
} from "../../lib/notification-routing"
import { useConfig } from "../../stores/preferences"
import { SettingsInfoTip } from "./settings-info-tip"

/** One row per notification category, one checkbox per destination. */
export const NotificationRoutingTable: Component<{
  /** This environment cannot show system notifications at all. */
  systemUnavailable: boolean
  /** A System box was just checked (the moment to ask for permission). */
  onSystemChecked: () => void
}> = (props) => {
  const { t } = useI18n()
  const { preferences, updatePreferences } = useConfig()
  const routing = () => preferences().notificationRouting
  const destinationLabel = (destination: NotificationDestination) => t(`settings.notifications.routing.${destination}`)
  const change = (category: NotificationCategory, destination: NotificationDestination, enabled: boolean) => {
    void updatePreferences({ notificationRouting: { ...routing(), [category]: { ...routing()[category], [destination]: enabled } } })
    if (enabled && destination === "system") props.onSystemChecked()
  }

  return (
    <table class="notification-routing">
      <caption class="sr-only">{t("settings.notifications.routing.caption")}</caption>
      <thead>
        <tr>
          <th scope="col"><span class="sr-only">{t("settings.notifications.routing.category")}</span></th>
          <For each={NOTIFICATION_DESTINATIONS}>{(destination) => (
            <th scope="col">{destinationLabel(destination)}<SettingsInfoTip text={t(`settings.notifications.routing.${destination}.info`)} /></th>
          )}</For>
        </tr>
      </thead>
      <tbody>
        <For each={NOTIFICATION_CATEGORIES}>{(category) => {
          const label = () => t(`settings.notifications.category.${category}`)
          return (
            <tr>
              <th scope="row">{label()}</th>
              <For each={NOTIFICATION_DESTINATIONS}>{(destination) => (
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${label()} · ${destinationLabel(destination)}`}
                    checked={routing()[category][destination]}
                    disabled={destination === "system" && props.systemUnavailable}
                    onChange={(event) => {
                      const next = event.currentTarget.checked
                      // The saved preference stays authoritative until it confirms the change.
                      event.currentTarget.checked = routing()[category][destination]
                      change(category, destination, next)
                    }}
                  />
                </td>
              )}</For>
            </tr>
          )
        }}</For>
      </tbody>
    </table>
  )
}

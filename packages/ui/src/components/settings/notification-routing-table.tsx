import { For, createSignal, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { afterSweep, toggleSweepGroup } from "../../lib/toggle-sweep"
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DESTINATIONS,
  type NotificationCategory,
  type NotificationDestination,
  type NotificationRouting,
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
  // The table being written: a quick second click builds on it rather than on a stale saved table.
  const [pending, setPending] = createSignal<NotificationRouting>()
  const routing = () => pending() ?? preferences().notificationRouting
  const destinationLabel = (destination: NotificationDestination) => t(`settings.notifications.routing.${destination}`)
  // Each write carries the whole table: a sweep across boxes writes it once, on release, and
  // writes go one after another so an older table never lands last.
  let writes = Promise.resolve()
  let writeQueued = false, systemChecked = false
  const write = () => {
    writeQueued = false
    // One permission request per gesture, however many System boxes it checked.
    if (systemChecked) {
      systemChecked = false
      props.onSystemChecked()
    }
    const next = pending()
    if (!next) return
    // A failed write shows the saved table again.
    writes = writes.then(async () => { await updatePreferences({ notificationRouting: next }) })
      .finally(() => { if (pending() === next) setPending(undefined) })
  }
  const change = (category: NotificationCategory, destination: NotificationDestination, enabled: boolean) => {
    setPending({ ...routing(), [category]: { ...routing()[category], [destination]: enabled } })
    if (enabled && destination === "system") systemChecked = true
    if (!writeQueued) {
      writeQueued = true
      afterSweep(write)
    }
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
                    data-toggle-sweep={toggleSweepGroup("notification-routing")}
                    onChange={(event) => change(category, destination, event.currentTarget.checked)}
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

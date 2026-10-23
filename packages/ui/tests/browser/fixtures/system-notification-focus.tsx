import { render } from "solid-js/web"
import { Toaster } from "solid-toast"
import { showToastNotification } from "../../../src/lib/notifications"
import { applyUiSettings } from "./ui-settings"

// In a browser window, system notifications go through the Notification API: record them.
const shown: string[] = []
class RecordingNotification {
  static permission = "granted"
  static requestPermission() { return Promise.resolve("granted") }
  constructor(title: string) { shown.push(title) }
}
;(window as any).Notification = RecordingNotification

await applyUiSettings({ locale: "en", notificationRouting: { needsInput: { screen: false, history: false, system: true } } as never })
render(() => <Toaster />, document.getElementById("root")!)

;(window as any).fixture = {
  notify: (title: string) => showToastNotification({ category: "needsInput", variant: "info", title, message: "A session needs your input" }),
  allowWhenFocused: (allow: boolean) => applyUiSettings({ osNotificationsAllowWhenVisible: allow }),
  shown: () => [...shown],
}

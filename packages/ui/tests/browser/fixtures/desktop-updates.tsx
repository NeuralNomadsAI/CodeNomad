import { render } from "solid-js/web"
import { Toaster } from "solid-toast"
import { requestDesktopUpdate, observeDesktopUpdates } from "../../../src/stores/desktop-updates"
import { initReleaseNotifications } from "../../../src/stores/releases"
import { getToastHistory, runToastAction } from "../../../src/lib/notifications"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { InfoSettingsSection } from "../../../src/components/settings/info-settings-section"
import "../../../src/index.css"

// "?settings" renders the real Preferences updates card instead of the check button.
const settings = new URLSearchParams(location.search).has("settings")
render(() => <>
  {settings
    ? <ConfigProvider><I18nProvider><InfoSettingsSection /></I18nProvider></ConfigProvider>
    : <button onClick={() => void requestDesktopUpdate()}>Check updates</button>}
  <Toaster />
</>, document.getElementById("root")!)
const dispose = observeDesktopUpdates()
// Runs the oldest retained action with this label, as the notification history panel would.
const runHistoryAction = (label: string) => runToastAction(getToastHistory().filter((item) => item.action?.label === label).at(-1)!.action!)
const history = () => getToastHistory().map((item) => item.message)
;(window as any).fixture = { check: requestDesktopUpdate, releases: initReleaseNotifications, observe: observeDesktopUpdates, runHistoryAction, history, dispose }

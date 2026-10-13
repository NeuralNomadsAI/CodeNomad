import { render } from "solid-js/web"
import { Toaster } from "solid-toast"
import { requestDesktopUpdate, observeDesktopUpdates } from "../../../src/stores/desktop-updates"
import { initReleaseNotifications } from "../../../src/stores/releases"
import { getToastHistory, runToastAction } from "../../../src/lib/notifications"
import "../../../src/index.css"

render(() => <><button onClick={() => void requestDesktopUpdate()}>Check updates</button><Toaster /></>, document.getElementById("root")!)
const dispose = observeDesktopUpdates()
// Runs the oldest retained action with this label, as the notification history panel would.
const runHistoryAction = (label: string) => runToastAction(getToastHistory().filter((item) => item.action?.label === label).at(-1)!.action!)
;(window as any).fixture = { check: requestDesktopUpdate, releases: initReleaseNotifications, observe: observeDesktopUpdates, runHistoryAction, dispose }

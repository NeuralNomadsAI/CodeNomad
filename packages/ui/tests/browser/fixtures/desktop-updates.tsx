import { render } from "solid-js/web"
import { Toaster } from "solid-toast"
import { requestDesktopUpdate, observeDesktopUpdates } from "../../../src/stores/desktop-updates"
import "../../../src/index.css"

render(() => <><button onClick={() => void requestDesktopUpdate()}>Check updates</button><Toaster /></>, document.getElementById("root")!)
const dispose = observeDesktopUpdates()
;(window as any).fixture = { check: requestDesktopUpdate, dispose }

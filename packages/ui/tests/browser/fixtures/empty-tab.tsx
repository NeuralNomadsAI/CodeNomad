import { render } from "solid-js/web"
import App from "../../../src/App"
import { ConfigProvider } from "../../../src/stores/preferences"
import { InstanceConfigProvider } from "../../../src/stores/instance-config"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { selectAppTab } from "../../../src/stores/app-tabs"
import { addRemoteRestoreTab, removeRemoteRestoreTab } from "../../../src/stores/remote-restore-tabs"
import { initializeClientState } from "../../../src/stores/client-state"
import "../../../src/index.css"

await initializeClientState()

render(() => <ConfigProvider><InstanceConfigProvider><I18nProvider><ThemeProvider>
  <App />
</ThemeProvider></I18nProvider></InstanceConfigProvider></ConfigProvider>, document.getElementById("root")!)

Object.assign(window, {
  openFixtureProject() {
    addRemoteRestoreTab({
      id: "waiting:demo", kind: "remote-restore", retry: async () => {}, remove: () => removeRemoteRestoreTab("waiting:demo"),
      snapshot: {
        kind: "workspace", backendId: "demo", folder: "/demo", occurrence: 0,
        drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      },
    })
    selectAppTab("waiting:demo")
  },
})

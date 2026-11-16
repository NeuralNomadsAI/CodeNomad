import { render } from "solid-js/web"
import App from "../../../src/App"
import { ConfigProvider } from "../../../src/stores/preferences"
import { InstanceConfigProvider } from "../../../src/stores/instance-config"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { showLaunchError, showWorkspaceLaunchError, launchError } from "../../../src/stores/launch-errors"
import { activeSettingsSection, closeSettings, settingsOpen } from "../../../src/stores/settings-screen"
import "../../../src/index.css"

serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.getOpenCodeLoginStart = async () => ({ state: "off" })

render(() => <ConfigProvider><InstanceConfigProvider><I18nProvider><ThemeProvider>
  <App />
</ThemeProvider></I18nProvider></InstanceConfigProvider></ConfigProvider>, document.getElementById("root")!)

;(window as any).fixture = {
  fail: (message: string, workspace: boolean, missingBinary: boolean) => {
    closeSettings()
    if (workspace) showWorkspaceLaunchError({ id: message, error: message, binaryLabel: "/fixture/opencode" } as any)
    else showLaunchError({ source: "create", message, binaryPath: "/fixture/opencode", missingBinary })
  },
  state: () => ({ error: launchError(), settingsOpen: settingsOpen(), section: activeSettingsSection() }),
}

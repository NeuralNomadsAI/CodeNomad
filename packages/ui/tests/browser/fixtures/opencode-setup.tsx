import { render } from "solid-js/web"
import OpenCodeSetup from "../../../src/components/opencode-setup"
import { OpenCodeSettingsSection } from "../../../src/components/settings/opencode-settings-section"
import { ConfigProvider, serverSettings, setThemePreference, updatePreferences } from "../../../src/stores/preferences"
import { ThemeProvider } from "../../../src/lib/theme"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { openOpenCodeSetup } from "../../../src/stores/opencode-setup"
import { createInstanceFetch } from "../../../src/lib/sdk-manager"
import "../../../src/index.css"
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchConfigOwner = async (_owner, patch) => patch as any
let resumed = 0
const params = new URLSearchParams(location.search)
const settings = params.has("settings")
render(() => <ConfigProvider><ThemeProvider><I18nProvider>
  {settings && <main style={{ padding: "24px", "max-width": "900px" }}><OpenCodeSettingsSection /></main>}
  <OpenCodeSetup automatic={!settings} />
</I18nProvider></ThemeProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: params.get("locale") === "fr" ? "fr" : "en" })
await setThemePreference(params.get("theme") === "dark" ? "dark" : "light")
;(window as any).fixture = {
  open: () => openOpenCodeSetup(async () => { resumed++ }), resumed: () => resumed,
  selectedBinary: () => serverSettings().opencodeBinary,
  unsupported: () => createInstanceFetch(`${location.origin}/workspaces/w/instance/`)(`${location.origin}/api/session/s/prompt`,
    { method: "POST", body: "{}" }).then(response => response.status),
}

import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ServiceSupervisionCard } from "../../../src/components/settings/service-supervision-card"
import { setActiveSettingsSection } from "../../../src/stores/settings-screen"
import { ConfigProvider, useConfig } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverEvents } from "../../../src/lib/server-events"
import { serverApi } from "../../../src/lib/api-client"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const params = new URLSearchParams(location.search)
const patchOwner = serverApi.patchConfigOwner
await applyUiSettings({ locale: (params.get("locale") || "en") as any, theme: params.has("light") ? "light" : "dark" })
const patchUI = serverApi.patchConfigOwner
serverApi.patchConfigOwner = (owner, change) => owner === "server" ? patchOwner(owner, change) : patchUI(owner, change)
const [mounted, setMounted] = createSignal(true)
setActiveSettingsSection("opencode")
function Fixture() {
  const config = useConfig()
  ;(window as any).fixture = {
    mount: setMounted,
    activate: (active: boolean) => setActiveSettingsSection(active ? "opencode" : "general"),
    select: config.updateLastUsedBinary,
    reconnect: () => { for (const handler of (serverEvents as any).openHandlers) handler() },
  }
  return <main class="settings-content" style={{ width: "min(700px, 100%)", margin: "auto", padding: "24px" }}>
    <Show when={mounted()}><ServiceSupervisionCard /></Show>
  </main>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

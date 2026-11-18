import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { OpenCodeLoginStartCard } from "../../../src/components/settings/opencode-login-start-card"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverEvents } from "../../../src/lib/server-events"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const params = new URLSearchParams(location.search)
await applyUiSettings({ locale: (params.get("locale") || "en") as any, theme: params.has("light") ? "light" : "dark" })
const [mounted, setMounted] = createSignal(true)
;(window as any).fixture = {
  mount: setMounted,
  reconnect: () => { for (const handler of (serverEvents as any).openHandlers) handler() },
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main class="settings-content" style={{ width: "min(700px, 100%)", margin: "auto", padding: "24px" }}>
    <Show when={mounted()}><OpenCodeLoginStartCard /></Show>
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

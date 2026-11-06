import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { AgentMemorySettingsCard } from "../../../src/components/settings/agent-memory-settings-card"
import { createPreferencesProjectContext } from "../../../src/components/settings/preferences-project-context"
import AlertDialog from "../../../src/components/alert-dialog"
import type { NativePreferencesRequest } from "../../../src/lib/native/preferences-window"
import { ConfigProvider } from "../../../src/stores/preferences"
import { confirmSettingsDiscard } from "../../../src/stores/settings-dirty-guard"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverEvents } from "../../../src/lib/server-events"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const params = new URLSearchParams(location.search)
await applyUiSettings({ locale: (params.get("locale") || "en") as any, theme: "dark" })
function Fixture() {
  const [mounted, setMounted] = createSignal(true)
  const [request, setRequest] = createSignal<NativePreferencesRequest>({ section: "general", instanceId: "project-a", workspacePath: "C:/project-a", location: { directory: "/repo-a" } })
  const project = createPreferencesProjectContext(request, () => true, (next, current) => { if (current()) setRequest(previous => ({ ...previous, ...next })) })
  ;(window as any).fixture = {
    context: (next?: Partial<NativePreferencesRequest>) => setRequest({ section: "general", ...next }),
    mount: setMounted,
    leave: async () => { if (await confirmSettingsDiscard()) setMounted(false) },
    event: (event: unknown) => (serverEvents as any).dispatchBatch([event]),
    reconnect: () => { for (const handler of (serverEvents as any).openHandlers) handler() },
  }
  return <><main class="settings-content" style={{ width: "min(700px, 100%)", margin: "auto", padding: "24px" }}>
    <Show when={mounted()}><AgentMemorySettingsCard instanceId={project()?.instanceId} location={project()?.location} /></Show>
  </main><AlertDialog /></>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { UsageSettingsSection } from "../../../src/components/settings/usage-settings-section"
import { SettingsScreen } from "../../../src/components/settings-screen"
import { setActiveSettingsSection } from "../../../src/stores/settings-screen"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"
const [instanceId, setInstanceId] = createSignal("usage"), [visible, setVisible] = createSignal(true)
let fail = false, defer = false, release: (() => void) | undefined
const queries: any[] = []
serverApi.getServiceUsage = async (id, query) => {
  queries.push(query)
  if (defer) { defer = false; await new Promise<void>(resolve => { release = resolve }) }
  if (fail) { fail = false; throw new Error("fixture failed") }
  const steps = id === "usage" ? 42 : 7
  const tokens = { input: 12345, output: 987, reasoning: 100, cache: { read: 6789, write: 456 } }
  return { scope: "service", stats: { range: { from: query.from, to: query.to }, sessions: 3, subagents: 2, prompts: 10, steps,
    tokens, cost: 1.2345, tools: { mode: "none" }, activeDays: 2, streak: 2,
    models: [{ model: { providerID: "fixture", id: "synthetic", variant: "high" }, tokens, steps, cost: 1.2345 }],
    activity: [{ date: "2026-09-25", steps: Math.floor(steps / 2) }, { date: "2026-09-26", steps: Math.ceil(steps / 2) }],
  } }
}
await applyUiSettings({})
setActiveSettingsSection("usage")
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={visible()}>
  {new URLSearchParams(location.search).has("parent")
    ? <SettingsScreen standalone providerContext={{ instanceId: instanceId() }} />
    : <main style={{ width: "min(760px, 100%)" }}><UsageSettingsSection instanceId={instanceId()} /></main>}
</Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { queries, setInstanceId, setVisible, fail: () => { fail = true }, defer: () => { defer = true }, release: () => release?.(),
  refresh: () => (serverEvents as any).dispatch({ type: "instance.event", instanceId: "usage", event: { type: "session.idle", data: {} } }) }

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
const [instanceId, setInstanceId] = createSignal(new URLSearchParams(location.search).get("instance") ?? "usage"), [visible, setVisible] = createSignal(true)
let fail = false, defer = false, release: (() => void) | undefined
let releaseCache: (() => void) | undefined
const queries: any[] = []
const backend = new URLSearchParams(location.search).has("backend")
const getUsage = serverApi.getServiceUsage
const memory = new Map<string, any>()
let owner = "fixture-service", identity = "fixture-discovery"
let connection = "fixture-connection"
if (!backend) serverApi.getServiceUsageOwner = async () => ({ owner, identity, connection })
if (!backend) serverApi.getCachedServiceUsage = async (id, timezone, days) => {
  const value = memory.get(`${id}:${days ?? 30}:${timezone}`)
  if (new URLSearchParams(location.search).has("heldCache")) await new Promise<void>(resolve => { releaseCache = resolve })
  return { days: days ?? 30, snapshot: value, owner, identity, connection }
}
serverApi.getServiceUsage = async (id, query, signal) => {
  queries.push(query)
  if (backend) return getUsage(id, query, signal)
  const sourceOwner = owner, sourceIdentity = identity, sourceConnection = connection
  if (defer) { defer = false; await new Promise<void>(resolve => { release = resolve }) }
  if (fail) { fail = false; throw new Error("fixture failed") }
  const steps = id === "usage" ? 42 : 7
  const tokens = { input: 12345, output: 987, reasoning: 100, cache: { read: 6789, write: 456 } }
  const snapshot = { scope: "service" as const, owner: sourceOwner, identity: sourceIdentity, connection: sourceConnection, stats: { range: { from: query.from, to: query.to }, sessions: 3, subagents: 2, prompts: 10, steps,
    tokens, cost: 1.2345, tools: { mode: "none" as const }, activeDays: 2, streak: 2,
    models: [{ model: { providerID: "fixture", id: "synthetic", variant: "high" }, tokens, steps, cost: 1.2345 }],
    activity: [{ date: "2026-09-25", steps: Math.floor(steps / 2) }, { date: "2026-09-26", steps: Math.ceil(steps / 2) }],
  } }
  memory.set(`${id}:${(query.to - query.from) / 86400000}:${query.timezone}`, snapshot)
  return snapshot
}
await applyUiSettings({})
setActiveSettingsSection("usage")
const mountedAt = performance.now()
if (new URLSearchParams(location.search).has("hidden")) Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
let metricsAt: number | undefined
const observer = new MutationObserver(() => { if (metricsAt === undefined && document.querySelector(".usage-metrics")) metricsAt = performance.now() })
observer.observe(document.getElementById("root")!, { childList: true, subtree: true })
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={visible()}>
  {new URLSearchParams(location.search).has("parent")
    ? <SettingsScreen standalone providerContext={{ instanceId: instanceId() }} />
    : <main style={{ width: "min(760px, 100%)" }}><UsageSettingsSection instanceId={instanceId()} /></main>}
</Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { queries, setInstanceId, setVisible, mountedAt, get metricsAt() { return metricsAt }, fail: () => { fail = true }, defer: () => { defer = true }, release: () => release?.(), releaseCache: () => releaseCache?.(),
  changeOwner: () => { owner = "changed-service"; connection += "next"; memory.clear() }, changeDiscovery: () => { identity = "changed-discovery"; connection += "next"; memory.clear() },
  documentHidden: (hidden: boolean) => { Object.defineProperty(document, "visibilityState", { configurable: true, value: hidden ? "hidden" : "visible" }); document.dispatchEvent(new Event("visibilitychange")) },
  connection: (status = "connected", generation = 1) => (serverEvents as any).dispatch({ type: "instance.eventStatus", instanceId: "usage", status, generation }),
  transport: (status: string) => (serverEvents as any).emitTransportStatus(status),
  refresh: (type = "session.execution.succeeded") => (serverEvents as any).dispatch({ type: "instance.event", instanceId: "usage", event: { type, data: { sessionID: "s" } } }) }

import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import StatusTab from "../../../src/components/instance/shell/right-panel/tabs/StatusTab"
import { ChatSettingsSection } from "../../../src/components/settings/chat-settings-section"
import TranscriptFilters from "../../../src/components/transcript-filters"
import { ConfigProvider, preferences, toggleUsageMetrics, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance, instances } from "../../../src/stores/instances"
import { sessions, setActiveSession, setProviders } from "../../../src/stores/session-state"
import { fetchSessions } from "../../../src/stores/session-api"
import { sseManager } from "../../../src/lib/sse-manager"
import { DEFAULT_RIGHT_PANEL_CUSTOMIZATION } from "../../../src/components/instance/shell/right-panel/registry"
import "../../../src/index.css"

const instanceId = "status-tokens", model = { providerID: "fixture", id: "paid" }
const nativeSessions = [
  { id: "parent", model }, { id: "child", parentID: "parent", model },
  { id: "grandchild", parentID: "child", model }, { id: "subscription", model: { ...model, id: "included" } },
].map(session => ({ ...session, title: session.id, agent: "build", projectID: "fixture", location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }))
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    list: async () => ({ data: nativeSessions, cursor: {} }), get: async ({ sessionID }: any) => nativeSessions.find(s => s.id === sessionID) },
  model: { default: async () => model }, shell: { list: async () => ({ data: [] }) },
}
const saved = new URLSearchParams(location.search).get("saved")
let config: any = { settings: { locale: "en", ...(saved === null ? {} : { showUsageMetrics: saved === "true", usageMetricsExpansion: "expanded" }) } }
serverApi.fetchConfigOwner = async () => config
serverApi.patchConfigOwner = async (_owner, patch: any) => {
  config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } }
  return config
}
serverApi.fetchStateOwner = async () => ({} as any)
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setProviders(prev => new Map(prev).set(instanceId, [{ id: "fixture", name: "Fixture", models: [
  { id: "paid", name: "Paid", providerId: "fixture", cost: { input: 1, output: 2 } },
  { id: "included", name: "Included", providerId: "fixture", cost: { input: 0, output: 0 } },
] }]))
await fetchSessions(instanceId)
setActiveSession(instanceId, "parent")
let seq = 0
const usage = (sessionID: string, input: number, output: number, cost: number, reasoning: number) => (sseManager as any).handleEvent(instanceId, {
  id: `usage_${++seq}`, type: "session.usage.updated", created: seq + 1, location: { directory: "/fixture" },
  data: { sessionID, cost, tokens: { input, output, reasoning, cache: { read: 0, write: 0 } } },
})
usage("parent", 1234567, 23456, 12.34, 500)
usage("child", 2000, 300, 1.2, 50)
usage("grandchild", 4000, 600, 2.4, 100)
usage("subscription", 9876, 543, 99, 20)
const [sessionId, select] = createSignal("parent")
const [expanded, setExpanded] = createSignal<string[]>([])
const [width, setWidth] = createSignal(460)
const [customization, setCustomization] = createSignal({ ...DEFAULT_RIGHT_PANEL_CUSTOMIZATION,
  hiddenStatusSectionIds: ["yolo-mode", "provider-usage", "background-processes", "mcp", "plugins"] })
const Fixture = () => {
  const { t } = useI18n()
  return <div style={{ display: "flex", gap: "24px", padding: "16px", "align-items": "start" }}>
    <aside data-status style={{ width: `${width()}px`, "flex-shrink": 0 }}>
      <StatusTab t={t} instanceId={instanceId} instance={instances().get(instanceId)!}
        activeSession={() => sessions().get(instanceId)?.get(sessionId()) ?? null} isActive={() => true}
        expandedItems={expanded} onExpandedItemsChange={setExpanded}
        customization={customization} onCustomizationChange={setCustomization} />
    </aside>
    <main style={{ width: "600px", "flex-shrink": 0 }}><TranscriptFilters /><ChatSettingsSection /></main>
  </div>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = { preferences, updatePreferences, toggleUsageMetrics, width: setWidth,
  select: (id: string) => { setActiveSession(instanceId, id); select(id) }, usage }

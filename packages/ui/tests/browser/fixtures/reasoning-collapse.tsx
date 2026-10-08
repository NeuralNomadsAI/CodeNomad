import { render } from "solid-js/web"
import MessageSection from "../../../src/components/message-section"
import TranscriptFilters from "../../../src/components/transcript-filters"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import "../../../src/index.css"

const instanceId = "reasoning-instance", sessionId = "reasoning-session"
const count = new URLSearchParams(location.search).get("steps") === "2" ? 2 : 1
const model = { providerID: "fixture", id: "fixture" }
const message = { id: "reasoning-message", type: "assistant", agent: "build", model,
  time: { created: 1, completed: 10 }, content: [
    ...Array.from({ length: count }, (_, index) => ({ type: "reasoning", text: `**Step ${index + 1}**\n\nReasoning body ${index + 1}.`, time: { start: 1, end: 9 } })),
    { type: "text", text: "The visible response stays readable." },
  ] }
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: 10 } }) },
  message: { list: async () => ({ data: [message], cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Reasoning", location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 10 },
} as any]])))
setActiveSession(instanceId, sessionId)
await applyUiSettings({ locale: "en", showThinkingBlocks: true, showMessageTimeline: false,
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: {} } })
await loadMessages(instanceId, sessionId, { force: true })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <TranscriptFilters />
  <main style={{ display: "flex", height: "700px", width: "1000px" }}>
    <MessageSection instanceId={instanceId} sessionId={sessionId} isActive={true} />
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { reload: () => loadMessages(instanceId, sessionId, { force: true }) }

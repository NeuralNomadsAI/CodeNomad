import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import TranscriptFilters from "../../../src/components/transcript-filters"
import { ChatSettingsSection } from "../../../src/components/settings/chat-settings-section"
import { ConfigProvider, updatePreferences, preferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { sessions, setActiveSession, setProviders } from "../../../src/stores/session-state"
import { fetchSessions, loadMessages } from "../../../src/stores/session-api"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { sseManager } from "../../../src/lib/sse-manager"
import { buildSessionSearchMatches } from "../../../src/lib/session-search"
import "../../../src/index.css"

const instanceId = "system-instance", sessionId = "system-session"
const model = { providerID: "fixture", id: "fixture" }
const text = "Today's date is now: Sun Sep 20 2026\n<system-reminder>Keep this context &amp; intact.</system-reminder>"
const nativeMessages: any[] = [
  { id: "msg_01", type: "user", text: "Continue the task", time: { created: 1 } },
  { id: "msg_02", type: "system", text, description: "Context updated", time: { created: 2 } },
  { id: "msg_03", type: "assistant", agent: "build", model, content: [{ type: "text", text: "Normal assistant response" }], time: { created: 3, completed: 4 } },
]
const info = { id: sessionId, title: "System fixture", agent: "build", model, projectID: "fixture", location: { directory: "/fixture" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 4 } }
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    list: async () => ({ data: [info], cursor: {} }), get: async () => info },
  model: { default: async () => model },
  message: { list: async () => ({ data: [...nativeMessages].reverse(), cursor: {} }) },
}
let config = JSON.parse(sessionStorage.getItem("system-settings") ?? '{"settings":{"locale":"en"}}')
serverApi.fetchConfigOwner = async () => config
serverApi.patchConfigOwner = async (_owner, patch: any) => {
  config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } }
  sessionStorage.setItem("system-settings", JSON.stringify(config))
  return config
}
serverApi.fetchStateOwner = async () => ({} as any)
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setProviders(prev => new Map(prev).set(instanceId, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
await fetchSessions(instanceId)
setActiveSession(instanceId, sessionId)
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div style={{ display: "flex", "flex-direction": "column", height: "100vh", width: "900px" }}>
    <header><TranscriptFilters /></header>
    <div style={{ display: "flex", flex: 1, "min-height": 0 }}>
      <SessionView sessionId={sessionId} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder="/fixture" escapeInDebounce={false} isActive={true} />
    </div>
  </div>
  <aside id="chat-settings"><ChatSettingsSection /></aside>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = {
  reload: () => loadMessages(instanceId, sessionId, { force: true }),
  live: () => (sseManager as any).handleEvent(instanceId, {
    id: "ev_live_context", type: "session.instructions.updated", created: 5,
    durable: { aggregateID: sessionId, seq: 1, version: 2 }, location: { directory: "/fixture" },
    data: { sessionID: sessionId, delta: { "AGENTS.md": "updated" }, text: "Live system context" },
  }),
  snapshot: () => ({ visibility: preferences().systemMessagesVisibility, nativeText: nativeMessages[1].text,
    ids: messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), config }),
  matches: () => buildSessionSearchMatches({ store: messageStoreBus.getOrCreate(instanceId), sessionId, query: "Today's date",
    includeThinking: false, includeSystem: preferences().systemMessagesVisibility !== "hidden" }),
}

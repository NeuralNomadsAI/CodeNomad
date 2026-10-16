import { render } from "solid-js/web"
import MessageSection from "../../../src/components/message-section"
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

// OpenCode V2 timing: reasoning carries created/completed, tools created/ran/completed.
const instanceId = "durations-instance", sessionId = "durations-session"
const model = { providerID: "fixture", id: "fixture" }
const now = Date.now()
const finished = { id: "finished-message", type: "assistant", agent: "build", model,
  time: { created: 1_000, completed: 9_000 }, content: [
    { type: "reasoning", text: "**Plan**\n\nLook at the file.", time: { created: 1_000, completed: 4_000 } },
    { type: "tool", id: "finished-tool", name: "shell", time: { created: 4_000, ran: 4_500, completed: 8_500 },
      state: { status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "ok" }] } },
  ] }
const running = { id: "running-message", type: "assistant", agent: "build", model,
  time: { created: now - 6_000 }, content: [
    { type: "reasoning", text: "**Still thinking**\n\nWeighing options.", time: { created: now - 6_000 } },
    { type: "tool", id: "running-tool", name: "shell", time: { created: now - 4_000, ran: now - 3_000 },
      state: { status: "running", input: { command: "npm run build" }, metadata: {} } },
  ] }
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: now } }) },
  message: { list: async () => ({ data: [finished, running], cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Durations", location: { directory: "/fixture" },
  status: "working", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: now },
} as any]])))
setActiveSession(instanceId, sessionId)
await applyUiSettings({ locale: "en", showThinkingBlocks: true, showMessageTimeline: false,
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: {} } })
await loadMessages(instanceId, sessionId, { force: true })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ display: "flex", height: "800px", width: "1000px" }}>
    <MessageSection instanceId={instanceId} sessionId={sessionId} isActive={true} />
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

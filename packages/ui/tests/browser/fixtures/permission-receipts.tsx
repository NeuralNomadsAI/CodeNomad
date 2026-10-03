import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import MessageSection from "../../../src/components/message-section"
import PermissionReceipts from "../../../src/components/permission-receipts"
import { ConfigProvider, setThemePreference } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import { serverEvents } from "../../../src/lib/server-events"
import "../../../src/index.css"

const instanceId = "receipt-instance", sessionId = "session-a", messageId = "message-a"
const direct = new URLSearchParams(location.search).has("direct")
const [scope, setScope] = createSignal({ instanceId, sessionId, messageId })
const [active, setActive] = createSignal(true)
const model = { providerID: "fixture", id: "fixture" }
const message = { id: messageId, type: "assistant", agent: "build", model, time: { created: 1, completed: 10 }, content: [
  ...(new URLSearchParams(location.search).has("toolOnly") ? [] : [{ type: "text", text: "Native response remains separate from permission receipts." }]),
  { id: "call-a", type: "tool", name: "shell", time: { created: 1, completed: 2 }, state: { status: "completed", input: { command: "echo hello" }, content: [{ type: "text", text: "hello" }] } },
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
  id: sessionId, instanceId, parentId: null, title: "Permissions", location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 10 },
} as any]])))
setActiveSession(instanceId, sessionId)
await applyUiSettings({ locale: "fr", showMessageTimeline: false,
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { bash: "hidden" } } })
await loadMessages(instanceId, sessionId, { force: true })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ display: "flex", height: "700px", width: "min(100%, 900px)" }}>
    {direct ? <div style={{ width: "100%" }}><PermissionReceipts {...scope()} active={active()} /></div>
      : <MessageSection instanceId={instanceId} sessionId={sessionId} isActive={active()} />}
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).receiptFixture = {
  select: setScope, active: setActive, theme: setThemePreference,
  event: (overrides = {}) => (serverEvents as any).dispatchBatch([{
    type: "permission.receiptsChanged", ...scope(), ...overrides,
  }]),
  reconnect: () => (serverEvents as any).notify((serverEvents as any).openHandlers, undefined, "open"),
}

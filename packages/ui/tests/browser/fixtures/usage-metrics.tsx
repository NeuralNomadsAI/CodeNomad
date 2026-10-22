import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import SessionView from "../../../src/components/session/session-view"
import TranscriptFilters from "../../../src/components/transcript-filters"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { sessions, setActiveSession, setAgents, setProviders } from "../../../src/stores/session-state"
import { fetchSessions } from "../../../src/stores/session-api"
import { sseManager } from "../../../src/lib/sse-manager"
import "../../../src/index.css"

// OpenCode V2 records each model step as one assistant message carrying the
// step's own token usage and cost; there are no step-start/step-finish parts.
const instanceId = "usage-instance", sessionId = "usage-session"
const model = { providerID: "fixture", id: "fixture" }
const usage = (input: number, output: number) => ({ input, output, reasoning: 5, cache: { read: 800, write: 16 } })
const nativeMessages: any[] = [
  { id: "msg_01", type: "user", text: "Count the files", time: { created: 1 } },
  { id: "msg_02", type: "assistant", agent: "build", model, finish: "tool-calls", cost: 0.0123, tokens: usage(1200, 34),
    content: [{ type: "text", text: "Looking at the tree" }, { type: "tool", id: "call_read", name: "read", time: { created: 2 },
      state: { status: "completed", input: { path: "a.ts" }, content: [{ type: "text", text: "file" }] } }],
    time: { created: 2, completed: 3 } },
  // A tool-only step: its usage joins the next response's line, so both reads stay one group.
  { id: "msg_02b", type: "assistant", agent: "build", model, finish: "tool-calls", cost: 0.25, tokens: usage(700, 8),
    content: [{ type: "tool", id: "call_read_b", name: "read", time: { created: 3 },
      state: { status: "completed", input: { path: "b.ts" }, content: [{ type: "text", text: "file" }] } }],
    time: { created: 3, completed: 4 } },
  { id: "msg_03", type: "assistant", agent: "build", model, finish: "stop", cost: 0.5, tokens: usage(1300, 12),
    content: [{ type: "text", text: "There are three files" }], time: { created: 4, completed: 5 } },
  { id: "msg_04", type: "idle", outcome: "succeeded", time: { created: 6 } },
]
const info = { id: sessionId, title: "Usage fixture", agent: "build", model, projectID: "fixture", location: { directory: "/fixture" },
  cost: 0, tokens: usage(0, 0), time: { created: 1, updated: 6 } }
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    list: async () => ({ data: [info], cursor: {} }), get: async () => info },
  model: { default: async () => model },
  message: { list: async ({ order }: { order?: string }) => ({
    data: order === "asc" ? [...nativeMessages] : [...nativeMessages].reverse(), cursor: {},
  }) },
}
let config: any = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => config
serverApi.patchConfigOwner = async (_owner, patch: any) => {
  config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } }
  return config
}
serverApi.fetchStateOwner = async () => ({} as any)
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setProviders(prev => new Map(prev).set(instanceId, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture Model", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
setAgents(prev => new Map(prev).set(instanceId, [{ id: "build", name: "Build", description: "", mode: "primary" }]))
await fetchSessions(instanceId)
setActiveSession(instanceId, sessionId)
const [width, setWidth] = createSignal(900)
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div data-usage-fixture style={{ display: "flex", "flex-direction": "column", height: "100vh", width: `${width()}px` }}>
    <header><TranscriptFilters /></header>
    <div style={{ display: "flex", flex: 1, "min-height": 0 }}>
      <SessionView sessionId={sessionId} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder="/fixture" escapeInDebounce={false} isActive={true} />
    </div>
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en", showUsageMetrics: true })
let seq = 0
const emit = (type: string, data: Record<string, unknown>) => (sseManager as any).handleEvent(instanceId, {
  id: `evt_live_${++seq}`, type, created: 10 + seq, durable: { aggregateID: sessionId, seq, version: 1 },
  location: { directory: "/fixture" }, data: { sessionID: sessionId, ...data },
})
;(window as any).fixture = {
  width: setWidth,
  // The live V2 step sequence recorded from an isolated OpenCode 2.1.0 run.
  startStep: () => {
    emit("session.execution.started", {})
    emit("session.step.started", { assistantMessageID: "msg_live", agent: "build", model, started: 11 })
    emit("session.text.started", { assistantMessageID: "msg_live" })
    emit("session.text.delta", { assistantMessageID: "msg_live", ordinal: 0, delta: "Live answer" })
  },
  endStep: () => {
    emit("session.text.ended", { assistantMessageID: "msg_live", text: "Live answer" })
    emit("session.step.ended", { assistantMessageID: "msg_live", finish: "stop", rawFinish: "stop", cost: 0, tokens: usage(4200, 99) })
  },
  // A live step that writes text and then calls a tool, which settles after the tool ran.
  startToolStep: () => {
    emit("session.execution.started", {})
    emit("session.step.started", { assistantMessageID: "msg_live_tool", agent: "build", model, started: 30 })
    emit("session.text.started", { assistantMessageID: "msg_live_tool" })
    emit("session.text.delta", { assistantMessageID: "msg_live_tool", ordinal: 0, delta: "Checking the build" })
    emit("session.text.ended", { assistantMessageID: "msg_live_tool", text: "Checking the build" })
    emit("session.tool.input.started", { assistantMessageID: "msg_live_tool", id: "call_live_tool", name: "custom_check" })
    emit("session.tool.called", { assistantMessageID: "msg_live_tool", id: "call_live_tool", input: { target: "build" } })
    emit("session.tool.success", { assistantMessageID: "msg_live_tool", id: "call_live_tool", content: [{ type: "text", text: "build ok" }], metadata: {} })
  },
  endToolStep: () => emit("session.step.ended", { assistantMessageID: "msg_live_tool", finish: "tool-calls", rawFinish: "tool-calls", cost: 0, tokens: usage(500, 7) }),
}

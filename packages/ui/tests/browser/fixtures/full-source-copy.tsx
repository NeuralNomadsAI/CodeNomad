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

const scenario = new URLSearchParams(location.search).get("scenario")
const instanceId = "full-source-instance", sessionId = "full-source-session", messageId = "full-source-message"
const filePath = "/fixture/example.ts"
const diagnostics = { [filePath]: Array.from({ length: scenario === "diagnostics-long" ? 1 : 137 }, (_, index) => ({
  message: scenario === "diagnostics-long"
    ? `Long diagnostic: ${"完整 diagnostic text ".repeat(250)}END-DIAGNOSTIC`
    : `Diagnostic ${String(index).padStart(3, "0")} 完整`,
  severity: 1, range: { start: { line: index, character: 2 } },
})) }
const todos = Array.from({ length: 237 }, (_, index) => ({
  id: `todo-${index}`, content: `Task ${String(index).padStart(3, "0")} 完整`, status: "pending", priority: "medium",
}))
const error = `Error start: ${"Original error 完整\n".repeat(900)}END-ERROR`
const textParts = Array.from({ length: 237 }, (_, index) => ({
  type: "text", text: `Paragraph ${String(index).padStart(3, "0")} 完整.\n\n`,
}))
const input = { filePath, payload: `INPUT-START ${"Untruncated input 完整 ".repeat(1200)} INPUT-END`, nested: { retained: true } }
const output = "Distinct output: this is not the tool input"
const name = scenario === "todo" ? "todowrite" : scenario === "error" || scenario === "input" ? "read" : "edit"
const tool = {
  id: "full-source-tool", type: "tool", name, time: { created: 1, completed: 2 },
  state: scenario === "error"
    ? { status: "error", input: { filePath }, error: { type: "unknown", message: error } }
    : { status: "completed", input: scenario === "input" ? input : { filePath },
        metadata: scenario === "todo" ? { todos } : scenario === "input" ? {} : { diagnostics },
        content: [{ type: "text", text: scenario === "input" ? output : "Tool completed" }] },
}
// Native API records enter through the real load/normalize/store/display path.
const message = { id: messageId, type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" },
  time: { created: 1, completed: 2 }, content: scenario === "parts" ? textParts : [tool] }
const requests: string[] = []
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: 2 } }) },
  message: { list: async () => { requests.push(sessionId); return { data: [message], cursor: {} } } },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Full source copy", location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 2 },
} as any]])))
setActiveSession(instanceId, sessionId)
await applyUiSettings({ showMessageTimeline: false, toolInputsVisibility: scenario === "input" ? "expanded" : "hidden", toolOutputExpansion: "expanded",
  diagnosticsExpansion: "collapsed",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { edit: "expanded", read: "expanded", other: "expanded" } } })
await loadMessages(instanceId, sessionId, { force: true })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ display: "flex", height: "800px", width: "1000px" }}>
    <MessageSection instanceId={instanceId} sessionId={sessionId} isActive={true} />
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
// Expected payloads are the original inputs, never bounded renderer projections.
;(window as any).fixture = { diagnostics, todos, error, textParts, input, output, sessionId, messageId, requests }

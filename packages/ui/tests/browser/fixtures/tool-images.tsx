import { Show } from "solid-js"
import { render } from "solid-js/web"
import ToolCall from "../../../src/components/tool-call"
import type { ToolCallPart } from "../../../src/components/tool-call/types"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import "../../../src/index.css"

const instanceId = "image-instance", sessionId = "image-session", messageId = "image-message"
const model = { providerID: "fixture", id: "fixture" }
let time = 1, messages: any[] = []
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: time } }) },
  message: { list: async () => ({ data: messages, cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Images", location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as any]])))
setActiveSession(instanceId, sessionId)
const store = messageStoreBus.getOrCreate(instanceId)
const record = () => store.getMessage(messageId)?.parts.tool
const emit = (type: string, data: any) => (sseManager as any).handleEvent(instanceId, {
  id: `event-${++time}`, type, created: time, location: { directory: "/fixture" },
  data: { sessionID: sessionId, assistantMessageID: messageId, ...data },
})
function image(mime: string, color: string, name?: string) {
  const canvas = document.createElement("canvas")
  canvas.width = 800; canvas.height = 360
  const context = canvas.getContext("2d")!
  context.fillStyle = color; context.fillRect(0, 0, 800, 360)
  context.fillStyle = "#ffffff"; context.font = "32px sans-serif"
  context.fillText("MCP image result", 48, 180)
  return { type: "file", mime, name, uri: canvas.toDataURL(mime) }
}
const png = image("image/png", "#355e76", "generated.png")
const jpeg = image("image/jpeg", "#695342")
function content(kind: string) {
  if (kind === "only") return [png]
  if (kind === "empty") return [{ type: "text", text: "Text-only result" }]
  if (kind === "broken") return [{ ...png, uri: "data:image/png;base64,broken" }]
  if (kind === "unsafe") return [{ ...png, uri: "javascript:window.unexpectedNavigation=true" }]
  return [{ type: "text", text: "Generated 2 images. Saved successfully." }, png, jpeg]
}
function completed(kind: string, name: string) {
  return { id: messageId, type: "assistant", agent: "build", model, time: { created: 1, completed: ++time },
    content: [{ id: "tool", type: "tool", name, time: { created: 1, completed: time },
      state: { status: "completed", input: { return_image: true }, content: content(kind) } }] }
}
await applyUiSettings({ toolInputsVisibility: "hidden", toolOutputExpansion: "expanded",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { other: "expanded", read: "expanded" } } })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ width: "min(720px, 100%)", padding: "20px", "box-sizing": "border-box" }}>
    <Show when={record()}>{part => <ToolCall toolCall={part().data as ToolCallPart} partVersion={part().revision}
      messageId={messageId} instanceId={instanceId} sessionId={sessionId} />}</Show>
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  history: async (kind = "mixed", name = "forge-painter_txt2img") => {
    messages = [completed(kind, name)]
    await loadMessages(instanceId, sessionId, { force: true })
  },
  start: () => {
    emit("session.step.started", { agent: "build", model, started: 1 })
    emit("session.tool.input.started", { id: "tool", name: "forge-painter_txt2img" })
    emit("session.tool.called", { id: "tool", input: { return_image: true } })
  },
  finish: () => {
    messages = [completed("mixed", "forge-painter_txt2img")]
    emit("session.tool.success", { id: "tool", content: content("mixed"), executed: true })
  },
  reload: () => loadMessages(instanceId, sessionId, { force: true }),
  execute: async (phase: string) => {
    const input = { code: "const results = await Promise.all([tools.paint({ prompt: 'sky' }), tools.fail({})]);\nreturn results" }
    const metadata = { toolCalls: [
      { tool: "paint", status: phase === "running" ? "running" : "completed", input: { prompt: "sky" } },
      { tool: "fail", status: phase === "running" ? "running" : "error", input: { test: true } },
    ], ...(phase === "running" ? {} : { error: true, truncated: true, outputPath: "/fixture/output.txt" }) }
    if (phase === "progress") {
      metadata.toolCalls.push({ tool: "third", status: "running", input: { test: true } })
      emit("session.tool.progress", { id: "tool", metadata })
      return
    }
    if (phase === "running") {
      emit("session.step.started", { agent: "build", model, started: 1 })
      emit("session.tool.input.started", { id: "tool", name: "execute" })
      emit("session.tool.called", { id: "tool", input })
      emit("session.tool.progress", { id: "tool", metadata })
      return
    }
    messages = [{ ...completed("mixed", "execute"), content: [{ id: "tool", type: "tool", name: "execute",
      time: { created: 1, completed: time }, state: { status: "completed", input, metadata, content: content("mixed") } }] }]
    if (phase === "history") await loadMessages(instanceId, sessionId, { force: true })
    else emit("session.tool.success", { id: "tool", content: content("mixed"), metadata, executed: true })
  },
}

import { batch } from "solid-js"
import { render } from "solid-js/web"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import MessageSection from "../../../src/components/message-section"
import { applyUiSettings } from "./ui-settings"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import "../../../src/index.css"

const params = new URLSearchParams(location.search)
const mode = params.get("mode") ?? "task"
const count = Math.min(1000, Math.max(1, Number(params.get("count") ?? 12)))
const outputSize = Math.min(2_000_000, Math.max(1000, Number(params.get("size") ?? 8000)))
const instanceId = "render-cost", parentId = "parent", childId = "child"
const model = { providerID: "fixture", id: "fixture" }
const output = Array.from({ length: Math.ceil(outputSize / "Output 00000 with deterministic text\n".length) }, (_, index) => `Output ${String(index).padStart(5, "0")} with deterministic text\n`).join("").slice(0, outputSize)
const tool = (index: number) => ({ id: `step-${index}`, type: "tool", name: "read",
  time: { created: index + 1, completed: index + 2 },
  state: { status: "completed", input: { filePath: `file-${index}.txt` }, metadata: {}, content: [{ type: "text", text: output }] } })
const history: Record<string, any[]> = mode === "task" ? {
  [parentId]: [{ id: "parent-message", type: "assistant", agent: "build", model, time: { created: 1, completed: 2 },
    content: [{ id: "parent-task", type: "tool", name: "subagent", time: { created: 1, completed: 2 },
      state: { status: "completed", input: { agent: "explore", description: "Deterministic child" }, metadata: { sessionId: childId }, content: [{ type: "text", text: "Task result" }] } }] }],
  [childId]: [{ id: "child-message", type: "assistant", agent: "build", model, time: { created: 3 },
    content: Array.from({ length: count }, (_, index) => tool(index)) }],
} : {
  [parentId]: Array.from({ length: count }, (_, index) => ({ id: `history-${index}`, type: "assistant", agent: "build", model,
    time: { created: index + 1, completed: index + 2 }, content: [{ type: "text", text: `History ${index}\n\n` + "A deterministic paragraph.\n\n".repeat(2 + index % 5) }] })),
}
const requests: string[] = []
let holdChildReads = false
let failChildRead = false
const heldReads: Array<() => void> = []
const client: any = { session: {
  active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
  get: async ({ sessionID }: any) => ({ id: sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }),
}, message: { list: async ({ sessionID, limit = 200, cursor }: any) => {
  requests.push(sessionID)
  if (sessionID === childId && holdChildReads) await new Promise<void>(resolve => heldReads.push(resolve))
  if (sessionID === childId && failChildRead) { failChildRead = false; throw new Error("Deterministic read failure") }
  const messages = history[sessionID] ?? []
  const end = cursor ? Number(cursor) : messages.length, start = Math.max(0, end - limit)
  return { data: messages.slice(start, end).reverse(), cursor: start ? { next: String(start) } : {} }
} } }
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map(Object.keys(history).map(id => [id, {
  id, instanceId, parentId: id === parentId ? null : parentId, title: id, location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as any]))))
setActiveSession(instanceId, parentId)
await applyUiSettings({ locale: "en", showMessageTimeline: mode !== "task", toolInputsVisibility: "hidden",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { task: "expanded", read: "collapsed" } } })
for (const id of Object.keys(history)) await loadMessages(instanceId, id, { force: true })

// Instrument a native operation, not a replacement renderer/store. Only ToolCall
// snapshot inputs are counted; timings below also work with instrumentation off.
let snapshots = 0, snapshotMs = 0
const instrumented = params.get("instrument") !== "off"
const clone = window.structuredClone.bind(window)
if (instrumented) window.structuredClone = ((value: any, options?: StructuredSerializeOptions) => {
  const matched = value?.type === "tool" && value.id?.startsWith("step-")
  const start = performance.now(), result = clone(value, options)
  if (matched) { snapshots++; snapshotMs += performance.now() - start }
  return result
}) as typeof structuredClone
const clipboard: string[] = []
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { clipboard.push(text) } } })
let eventId = 100
const emit = (type: string, data: any) => (sseManager as any).handleEvent(instanceId, {
  id: `event-${++eventId}`, type, created: eventId, location: { directory: "/fixture" },
  data: { sessionID: childId, assistantMessageID: "child-message", ...data },
})
const startText = () => {
  if (!history[childId][0].content.some((part: any) => part.type === "text")) history[childId][0].content.push({ type: "text", text: "" })
  emit("session.text.started", {})
}
const delta = () => {
  const text = history[childId][0].content.find((part: any) => part.type === "text")
  text.text += " x"
  emit("session.text.delta", { ordinal: count, delta: " x" })
}
const store = messageStoreBus.getOrCreate(instanceId)
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ display: "flex", height: "700px", width: "1000px" }}>
    <MessageSection instanceId={instanceId} sessionId={parentId} isActive={true} />
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
let added = 0, removed = 0
const countSteps = (nodes: NodeList) => Array.from(nodes).reduce((total, node) => total + (node instanceof Element
  ? Number(node.matches('.tool-call[data-part-id^="step-"]')) + node.querySelectorAll('.tool-call[data-part-id^="step-"]').length : 0), 0)
const recordMutations = (records: MutationRecord[]) => {
  for (const record of records) { added += countSteps(record.addedNodes); removed += countSteps(record.removedNodes) }
}
const observer = instrumented ? new MutationObserver(recordMutations) : undefined
observer?.observe(document.querySelector("main")!, { childList: true, subtree: true })
;(window as any).fixture = {
  startText,
  delta,
  hold: () => { holdChildReads = true },
  release: () => { holdChildReads = false; heldReads.splice(0).forEach(resolve => resolve()) },
  reproject: () => loadMessages(instanceId, childId, { force: true }),
  replaceChildTools: (indexes: number[], textIndexes: number[] = []) => {
    // Same native message identity, but a new authoritative part membership.
    history[childId][0].content = indexes.map(index => textIndexes.includes(index)
      ? { id: `step-${index}`, type: "text", text: output }
      : tool(index))
    return loadMessages(instanceId, childId, { force: true })
  },
  failRead: () => { failChildRead = true; delta() },
  clearChild: () => { history[childId] = []; return loadMessages(instanceId, childId, { force: true }) },
  toolOutput: () => (store.getMessage("child-message")?.parts["step-0"]?.data as any)?.state?.output,
  mutateTool: () => batch(() => {
    // Deliberately keep data identity and message revision unchanged; only the
    // existing normalized part revision invalidates this in-place update.
    const set = store.setState as any
    set("messages", "child-message", "parts", "step-0", "data", "state", "output", "Versioned in-place output")
    set("messages", "child-message", "parts", "step-0", "revision", (revision: number) => revision + 1)
  }),
  toolUpdate: (index: number, text: string) => {
    history[childId][0].content[index].state.content = [{ type: "text", text }]
    emit("session.tool.success", { id: `step-${index}`, content: [{ type: "text", text }], metadata: {} })
  },
  failTool: (index: number) => {
    const part = history[childId][0].content.find((part: any) => part.id === `step-${index}`)
    part.state = { ...part.state, status: "error", error: { message: "Deterministic failure" } }
    emit("session.tool.failed", { id: part.id, error: part.state.error, metadata: {} })
  },
  removeTool: (index: number) => store.removeMessagePart("child-message", `step-${index}`, childId),
  appendTool: () => {
    history[childId][0].content.push({ ...tool(count), id: "appended-step", state: {
      status: "completed", input: { filePath: "new.txt" }, metadata: {}, content: [{ type: "text", text: "New step output" }],
    } })
    emit("session.tool.input.started", { id: "appended-step", name: "read" })
    emit("session.tool.called", { id: "appended-step", input: { filePath: "new.txt" } })
    emit("session.tool.success", { id: "appended-step", content: [{ type: "text", text: "New step output" }], metadata: {} })
  },
  reset: () => { observer?.takeRecords(); snapshots = 0; snapshotMs = 0; added = 0; removed = 0 },
  measure: (updates: number) => {
    const start = performance.now()
    for (let index = 0; index < updates; index++) delta()
    const ms = performance.now() - start
    if (observer) recordMutations(observer.takeRecords())
    return { ms, snapshots, snapshotMs, added, removed }
  },
  snapshot: () => ({ snapshots, snapshotMs, added, removed, requests, clipboard, output, held: heldReads.length,
    partIds: store.getMessage("child-message")?.partIds,
    childRevision: store.getMessage("child-message")?.revision,
    loaded: store.getSessionMessageIds(parentId).length }),
}

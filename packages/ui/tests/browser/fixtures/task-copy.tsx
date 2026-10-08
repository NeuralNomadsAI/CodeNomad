import { createSignal, Show } from "solid-js"
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

const instanceId = "task-copy-instance", parentId = "parent", childId = "child", grandchildId = "grandchild"
const model = { providerID: "fixture", id: "fixture" }
const requests: Array<{ sessionID: string; ascending: boolean; signal?: AbortSignal }> = []
const clipboard: string[] = []
let held = false
const gates: Array<() => void> = []

function toolMessage(sessionID: string, index: number, target?: string) {
  const id = `${sessionID}-${String(index).padStart(4, "0")}`
  return { id, type: "assistant", agent: "build", model, time: { created: index + 1, completed: index + 2 },
    content: [{ id: target ? (sessionID === parentId ? "parent-task" : "nested-task") : `${id}-tool`,
      type: "tool", name: target ? "subagent" : "read", time: { created: index + 1, completed: index + 2 },
      state: { status: "completed", input: target ? { agent: "explore", description: `Explore ${target}` } : { filePath: `${id}.txt` },
        metadata: target ? { sessionId: target } : {},
        content: [{ type: "text", text: target ? "Task completed" : `Untruncated ${id}: ${"長い output\n".repeat(500)}` }] } }] }
}

const history: Record<string, ReturnType<typeof toolMessage>[]> = {
  [parentId]: [toolMessage(parentId, 0, childId)],
  [childId]: [...Array.from({ length: 230 }, (_, index) => toolMessage(childId, index)), toolMessage(childId, 230, grandchildId)],
  [grandchildId]: Array.from({ length: 230 }, (_, index) => toolMessage(grandchildId, index)),
}
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async ({ sessionID }: any) => ({ id: sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }) },
  message: { list: async ({ sessionID, cursor, order, limit = 200 }: any, options?: { signal?: AbortSignal }) => {
    const ascending = order === "asc" || cursor?.startsWith("asc:")
    requests.push({ sessionID, ascending, signal: options?.signal })
    // Deliberately ignore transport abort while held: the real consumer must
    // detach immediately and fence this response when the fixture releases it.
    if (held && ascending) await new Promise<void>(resolve => gates.push(resolve))
    const messages = history[sessionID] ?? []
    if (ascending) {
      const start = cursor ? Number(cursor.slice(4)) : 0
      const end = Math.min(messages.length, start + limit)
      return { data: messages.slice(start, end), cursor: end < messages.length ? { next: `asc:${end}` } : {} }
    }
    const end = cursor ? Number(cursor) : messages.length
    const start = Math.max(0, end - limit)
    return { data: messages.slice(start, end).reverse(), cursor: start ? { next: String(start) } : {} }
  } },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map(Object.keys(history).map(id => [id, {
  id, instanceId, parentId: id === parentId ? null : id === childId ? parentId : childId,
  title: id, location: { directory: "/fixture" }, status: "idle", agent: "build",
  model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as any]))))
setActiveSession(instanceId, parentId)
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  write: async (items: ClipboardItem[]) => { clipboard.push(await (await items[0].getType("text/plain")).text()) },
  writeText: async (text: string) => { clipboard.push(text) },
} })

await applyUiSettings({ showMessageTimeline: false, toolInputsVisibility: "hidden", toolOutputExpansion: "expanded",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { task: "expanded", read: "collapsed", other: "expanded" } } })
for (const id of Object.keys(history)) await loadMessages(instanceId, id, { force: true })
const [activeInstance, setActiveInstance] = createSignal(true)
const [selectedSession, setSelectedSession] = createSignal(parentId)
const [mounted, setMounted] = createSignal(true)
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={mounted()}>
  <main style={{ display: "flex", height: "800px", width: "1000px" }}>
    <MessageSection instanceId={instanceId} sessionId={parentId}
      isActive={activeInstance() && selectedSession() === parentId} />
  </main>
</Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  hold: () => { held = true },
  release: () => { held = false; gates.splice(0).forEach(resolve => resolve()) },
  selectSession: (id: string) => { setSelectedSession(id); setActiveSession(instanceId, id) },
  setActiveInstance,
  unmount: () => setMounted(false),
  snapshot: () => ({ selectedSession: selectedSession(), activeInstance: activeInstance(), clipboard,
    requests: requests.map(({ sessionID, ascending, signal }) => ({ sessionID, ascending, aborted: signal?.aborted ?? false })) }),
}

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
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

const instanceId = "tool-card-bounds-instance", parentId = "parent", childId = "child"
const model = { providerID: "fixture", id: "fixture" }
const requests: Array<{ sessionID: string }> = []

function longText(label: string, paragraphs: number) {
  return Array.from({ length: paragraphs }, (_, index) =>
    `${label} paragraph ${index}: ${"measured bounded content ".repeat(48)}`).join("\n\n")
}

// ?steps=N and ?report=N override the scenario sizes for boundary cases.
const initialSteps = Math.min(2_000, Math.max(1, Number(new URLSearchParams(location.search).get("steps") ?? 90)))
const reportParagraphs = Math.max(1, Number(new URLSearchParams(location.search).get("report") ?? 50))

// ~38k prompt and a parameterized report: both beyond the nested card pane
// bound, the default report beyond the transcript-wide prose bound too.
const PROMPT_TEXT = longText("Prompt", 30)
const REPORT_TEXT = longText("Report", reportParagraphs)

const parentMessage = {
  id: "parent-0", type: "assistant", agent: "build", model, time: { created: 1, completed: 2 },
  content: [{
    id: "parent-task", type: "tool", name: "task", time: { created: 1, completed: 2 },
    state: {
      status: "completed",
      input: { agent: "explore", description: "Bounded card content", prompt: PROMPT_TEXT },
      metadata: { sessionId: childId },
      content: [{ type: "text", text: REPORT_TEXT }],
    },
  }],
}

function childStep(index: number) {
  const id = `child-${String(index).padStart(4, "0")}`
  return {
    id, type: "assistant", agent: "build", model, time: { created: index + 1, completed: index + 2 },
    content: [{
      id: `${id}-tool`, type: "tool", name: "read", time: { created: index + 1, completed: index + 2 },
      state: { status: "completed", input: { filePath: `step-${index}.txt` }, metadata: {}, output: `Step ${index} output` },
    }],
  }
}

// initialSteps: 90 by default — beyond the mounted tail window, below the scan overflow bound.
let childHistory: any[] = Array.from({ length: initialSteps }, (_, index) => childStep(index))
const history: Record<string, any[]> = { [parentId]: [parentMessage], [childId]: childHistory }

const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async ({ sessionID }: any) => ({ id: sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }) },
  message: { list: async ({ sessionID, cursor, order, limit = 200 }: any) => {
    requests.push({ sessionID })
    const messages = history[sessionID] ?? []
    if (order === "asc" || cursor?.startsWith("asc:")) {
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
serverApi.querySessionHistory = async (_instanceId: string, input: { query: string }) => {
  const query = input.query.trim().toLocaleLowerCase()
  const taskText = `${PROMPT_TEXT}\n\n${REPORT_TEXT}`
  const hits = query && taskText.toLocaleLowerCase().includes(query)
    ? [{ sessionID: parentId, messageID: parentMessage.id, role: "assistant", partIndex: 0,
        kind: "tool" as const, excerpt: REPORT_TEXT.slice(0, 200) }]
    : []
  return { status: "page" as const, scanned: 1, tools: 1, reasoning: 0, skipped: 0,
    hits, candidates: [], cursor: null }
}
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([parentId, childId].map(id => [id, {
  id, instanceId, parentId: id === parentId ? null : parentId,
  title: id, location: { directory: "/fixture" }, status: "idle", agent: "build",
  model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as any]))))
setActiveSession(instanceId, parentId)

await applyUiSettings({ showMessageTimeline: false, toolInputsVisibility: "hidden", toolOutputExpansion: "expanded",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { task: "expanded", read: "collapsed", other: "expanded" } } })
for (const id of Object.keys(history)) await loadMessages(instanceId, id, { force: true })

const [mounted, setMounted] = createSignal(true)
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={mounted()}>
  <main style={{ display: "flex", height: "800px", width: "1000px" }}>
    <MessageSection instanceId={instanceId} sessionId={parentId} isActive={() => mounted()} />
  </main>
</Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

let stepCounter = childHistory.length
;(window as any).fixture = {
  /** Appends child steps the way a live child session produces them. */
  pushChildSteps: async (count: number) => {
    for (let index = 0; index < count; index++) childHistory.push(childStep(stepCounter++))
    await loadMessages(instanceId, childId, { force: true })
  },
  /** Unmounts and remounts the whole transcript, as row recycling does. */
  remount: async () => {
    setMounted(false)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    setMounted(true)
  },
  snapshot: () => ({ requests: requests.map(({ sessionID }) => ({ sessionID })) }),
}

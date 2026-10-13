import { For, Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import MessageBlock from "../../../src/components/message-block"
import { ConfigProvider, setThemePreference } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { sseManager } from "../../../src/lib/sse-manager"
import { serverApi } from "../../../src/lib/api-client"
import { applyUiSettings } from "./ui-settings"
import { mode, record, samples } from "./search-highlight-adapter"
import type { SessionSearchMatch } from "../../../src/lib/session-search"
import type { ClientPart } from "../../../src/types/message"
import "../../../src/index.css"

const params = new URLSearchParams(location.search)
let uiState: Record<string, unknown> = {}
serverApi.fetchStateOwner = async () => uiState as any
serverApi.patchStateOwner = async (_owner, patch) => (uiState = { ...uiState, ...(patch as object) }) as any
if (mode === "fallback") Object.defineProperty(window, "Highlight", { configurable: true, value: undefined })
const workload = params.get("workload") ?? "short"
const settings = {
  short: { rows: 2, lines: 8, dense: false },
  long: { rows: 1, lines: 1600, dense: false },
  dense: { rows: 1, lines: 400, dense: true },
  mixed: { rows: 12, lines: 20, dense: false },
  sparse: { rows: 1, lines: 1600, dense: false },
  missing: { rows: 1, lines: 1600, dense: false },
}[workload] ?? { rows: 2, lines: 8, dense: false }
const instanceId = "highlight-fixture", sessionId = "highlight-session"
const client: any = { session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) } } }
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: `/workspaces/${instanceId}/instance`, status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Highlight fixture", agent: "build", status: "idle", location: { directory: "/fixture" },
  time: { created: 1, updated: 1 }, model: { providerId: "fixture", modelId: "fixture" }, tokens: {}, cost: 0,
} as any]])))
const store = messageStoreBus.getOrCreate(instanceId)
setActiveSession(instanceId, sessionId)
const ids = Array.from({ length: settings.rows }, (_, i) => `message-${i}`)
const line = settings.dense ? "needle ribbon ".repeat(8) : "A readable sentence with needle and ribbon alongside ordinary words for the rendering comparison."
const text = Array.from({ length: settings.lines }, (_, i) => `${i}: ${workload === "missing" || (workload === "sparse" && i !== 40)
  ? "A readable sentence with ordinary content and no matching query tokens for the rendering comparison." : line}`).join("\n\n")
for (const [index, id] of ids.entries()) {
  const parts: ClientPart[] = workload === "mixed" ? [
    { type: "text", id: `${id}-text`, text: `**needle** and [ribbon](https://example.invalid)\n\n${text}` },
    { type: "reasoning", id: `${id}-reasoning`, text: `Thinking about needle and ribbon\n\n${text}` },
    { type: "tool", id: `${id}-tool`, callID: `${id}-call`, tool: "bash", state: { status: "completed", input: { command: "printf needle" }, output: text } },
  ] as ClientPart[] : [{ type: "text", id: `${id}-text`, text }]
  store.upsertMessage({ id, sessionId, role: workload === "mixed" ? "assistant" : "user", status: "complete", createdAt: index + 1, parts })
}
await applyUiSettings({ locale: "en", toolCallExpansionDefaults: { preset: "everything" } })
const [query, setQuery] = createSignal("")
const [active, setActive] = createSignal<SessionSearchMatch | null>(null)
const [visible, setVisible] = createSignal(true)
const [visibleIds, setVisibleIds] = createSignal(ids)
const [thinking, setThinking] = createSignal(true)
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
const settle = async () => { await frame(); await frame(); await frame() }
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div id="transcript" style={{ height: "720px", width: "900px", overflow: "auto", margin: "20px", padding: "12px" }}>
    <Show when={visible()}><For each={visibleIds()}>{(id, index) =>
      <MessageBlock instanceId={instanceId} sessionId={sessionId} messageId={id} messageIndex={index()} store={() => store}
        showThinking={thinking} thinkingDefaultExpanded={() => true} toolVisibility={() => "expanded"}
        usageMetricsVisibility={() => "hidden"} systemMessagesVisibility={() => "expanded"}
        searchQuery={query} activeSearchMatch={active} />
    }</For></Show>
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

function snapshot() {
  const ranges = [...(CSS.highlights?.get("codenomad-search") ?? [])] as Range[]
  const activeRanges = [...(CSS.highlights?.get("codenomad-search-active") ?? [])] as Range[]
  const marks = [...document.querySelectorAll("mark.session-search-match")]
  return { mode, workload, matches: ranges.length || marks.length,
    baseTextCharacters: text.length * ids.length,
    renderedCharacters: document.getElementById("transcript")!.textContent?.length,
    texts: ranges.length ? ranges.map(r => r.toString()) : marks.map(m => m.textContent),
    active: activeRanges.length || document.querySelectorAll("mark.session-search-match-active").length,
    detached: ranges.filter(r => !r.startContainer.isConnected).length,
    registries: [...(CSS.highlights?.keys() ?? [])].filter(key => key.startsWith("codenomad-search")),
    selection: getSelection()?.toString(), nodes: document.getElementById("transcript")!.querySelectorAll("*").length,
    text: document.getElementById("transcript")!.textContent,
  }
}
let serial = 0
let streamStarted = false
const streamId = "native-stream"
const emit = (type: string, data: unknown) => (sseManager as any).handleEvent(instanceId, {
  id: `event-${++serial}`, type, created: serial, location: { directory: "/fixture" }, data: { sessionID: sessionId, ...(data as object) },
})
async function change(value: string, occurrence: number | null = null, id = ids[0], part = "text") {
  setQuery(value)
  setActive(occurrence === null ? null : { id: `hit-${++serial}`, messageId: id, partId: `${id}-${part}`,
    role: "user", occurrence, start: 0, end: value.length, preview: value })
  await settle()
}
;(window as any).highlightFixture = {
  mode, workload, ids, change, snapshot, settle,
  theme: async (mode: "light" | "dark") => { await setThemePreference(mode); await settle() },
  visibility: async (value: boolean) => { setVisible(value); await settle() },
  rows: async (count: number) => { setVisibleIds(ids.slice(0, count)); await settle() },
  thinking: async (value: boolean) => { setThinking(value); await settle() },
  stream: async (delta: string) => {
    if (!streamStarted) {
      streamStarted = true
      emit("session.step.started", { assistantMessageID: streamId, agent: "build", model: { providerID: "fixture", id: "fixture" } })
      emit("session.text.started", { assistantMessageID: streamId })
      setVisibleIds([...ids, streamId])
    }
    emit("session.text.delta", { assistantMessageID: streamId, ordinal: 0, delta })
    await settle()
  },
  replace: async (value: string) => {
    const id = ids[0]
    store.upsertMessage({ id, sessionId, role: workload === "mixed" ? "assistant" : "user", status: "complete", createdAt: 1,
      parts: [{ type: "text", id: `${id}-text`, text: value }] })
    await settle()
  },
  select: () => {
    const container = document.querySelector(".message-text")!
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const at = walker.currentNode.nodeValue?.indexOf("needle") ?? -1
      if (at >= 0) {
        const range = document.createRange(); range.setStart(walker.currentNode, at); range.setEnd(walker.currentNode, at + 6)
        getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
        return getSelection()!.toString()
      }
    }
  },
  trial: async (value: string) => {
    let mutations = 0
    const longTasks: number[] = []
    const performanceObserver = PerformanceObserver.supportedEntryTypes.includes("longtask")
      ? new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration))) : undefined
    performanceObserver?.observe({ type: "longtask" })
    const observer = new MutationObserver(records => { mutations += records.length })
    observer.observe(document.getElementById("transcript")!, { childList: true, characterData: true, subtree: true })
    await frame()
    record(true)
    const start = performance.now()
    setQuery(value); setActive(null)
    await frame(); await frame()
    const paintOpportunityMs = performance.now() - start
    const synchronousMs = samples.reduce((sum, value) => sum + value, 0)
    record(false)
    observer.disconnect()
    longTasks.push(...(performanceObserver?.takeRecords() ?? []).map(entry => entry.duration))
    performanceObserver?.disconnect()
    return { synchronousMs, paintOpportunityMs, mutations, longTasks,
      extent: document.getElementById("transcript")!.scrollHeight, ...snapshot(), texts: undefined, text: undefined }
  },
}

import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { sessions, setSessions, setActiveSession, setProviders } from "../../../src/stores/session-state"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { sseManager } from "../../../src/lib/sse-manager"
import { getOpenCodeMessageRevision } from "../../../src/stores/opencode-data"
import "../../../src/index.css"

// Real SessionView, real native SSE dispatcher, real reducer and projection:
// only HTTP is fake. Streams an assistant text reply one delta per event.
const instanceId = "streaming-fixture", sessionId = "active"
const streamId = "msg_live"
const model = { providerID: "fixture", id: "fixture" }
let sequence = 1000, messageLists = 0, projections = 0
// The authoritative page the HTTP read serves; a reply's final row lands here.
;(window as any).__nativePage = [] as any[]
const [selected, select] = createSignal(sessionId)
const [visible, show] = createSignal(true)
const client: any = {
  session: {
    active: async () => ({}), inbox: { list: async () => [] },
    form: { list: async () => [] },
    get: async ({ sessionID }: any) => ({ id: sessionID, title: sessionID,
      location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
  },
  model: { default: async () => ({ data: model }) },
  permission: { list: async () => [] },
  message: { list: async ({ limit = 200 }: any) => {
    messageLists++
    const page: any[] = (window as any).__nativePage ?? []
    return { data: structuredClone(page.slice(-limit)).reverse(), cursor: {} }
  } },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build",
  model: { providerId: "fixture", modelId: "fixture" }, status: "idle", retry: null, idleSince: null,
  generationRecovery: null, runtimeStatusKnown: true, version: "1", projectID: "fixture",
  location: { directory: "/fixture" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
} as any]])))
setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture", models: [
  { id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } },
] }]))
setActiveSession(instanceId, sessionId)
const store = messageStoreBus.getOrCreate(instanceId)
// Projections are the store writes a frame coalesces; revisions are bumped per
// event at admission, so they must keep streaming while projections wait.
const hydrate = store.hydrateMessages.bind(store)
store.hydrateMessages = (...args: Parameters<typeof hydrate>) => {
  projections++
  return hydrate(...args)
}
const longtasks: number[] = []
new PerformanceObserver(list => {
  for (const entry of list.getEntries()) longtasks.push(entry.duration)
}).observe({ entryTypes: ["longtask"] })
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={visible()}>
  <SessionView sessionId={selected()} activeSessions={sessions().get(instanceId)!} instanceId={instanceId}
    instanceFolder="/fixture" escapeInDebounce={false} isActive={true} />
</Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

const emit = (type: string, data: any = {}) => {
  const started = performance.now()
  ;(sseManager as any).handleEvent(instanceId, {
    id: `event_${++sequence}`, type, created: sequence, location: { directory: "/fixture" }, data: { sessionID: sessionId, ...data },
  })
  return performance.now() - started
}
let currentStream = streamId
const storeText = () => Object.values(store.getMessage(currentStream)?.parts ?? {})
  .filter(part => part.data.type === "text").map(part => (part.data as any).text).join("")
;(window as any).streamingFixture = {
  resetCounts: () => { projections = 0; messageLists = 0; longtasks.length = 0 },
  snapshot: () => ({ projections, messageLists, revision: getOpenCodeMessageRevision(instanceId, sessionId),
    longtasks: [...longtasks], text: storeText(), ids: store.getSessionMessageIds(sessionId) }),
  startReply: (messageId = streamId) => {
    currentStream = messageId
    emit("session.step.started", { assistantMessageID: messageId, agent: "build", model, started: 500 })
    emit("session.text.started", { assistantMessageID: messageId, ordinal: 0 })
  },
  /** Dispatches `count` deltas in one JavaScript task, measuring each dispatch. */
  burst: (count = 400) => {
    const perDelta: number[] = []
    const started = performance.now()
    for (let index = 0; index < count; index++) perDelta.push(emit("session.text.delta", { assistantMessageID: currentStream, ordinal: 0, delta: `[${index}]` }))
    perDelta.sort((a, b) => a - b)
    return { dispatchMs: performance.now() - started, perDeltaMax: perDelta.at(-1),
      perDeltaP95: perDelta[Math.floor(perDelta.length * 0.95)] }
  },
  /** Spreads one delta across `count` spaced tasks, as a live tunnel delivers them. */
  spaced: async (count = 24) => {
    const perDelta: number[] = []
    for (let index = 0; index < count; index++) {
      perDelta.push(emit("session.text.delta", { assistantMessageID: currentStream, ordinal: 0, delta: `<${index}>` }))
      await new Promise(resolve => setTimeout(resolve, 4))
    }
    return { perDeltaMax: Math.max(...perDelta) }
  },
  endReply: (text: string) => {
    ;(window as any).__nativePage = [{ id: currentStream, type: "assistant", agent: "build", model,
      time: { created: sequence, completed: sequence }, content: [{ type: "text", text }] }]
    emit("session.text.ended", { assistantMessageID: currentStream, ordinal: 0, text })
    emit("session.step.ended", { assistantMessageID: currentStream, finish: "stop", cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
  },
  activate: (sessionID: string) => {
    show(false)
    select(sessionID)
    setActiveSession(instanceId, sessionID)
    show(true)
  },
  visibility: () => document.dispatchEvent(new Event("visibilitychange")),
}

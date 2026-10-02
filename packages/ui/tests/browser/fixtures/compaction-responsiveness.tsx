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

const instanceId = "compaction-fixture", model = { providerID: "fixture", id: "fixture" }
let sequence = 1000, messageLists = 0
const nativeMessages = new Map<string, any[]>()
const [selected, select] = createSignal("active")
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
  message: { list: async ({ sessionID, limit = 200 }: any) => {
    messageLists++
    return { data: structuredClone((nativeMessages.get(sessionID) ?? []).slice(-limit)).reverse(), cursor: {} }
  } },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map(["active", "inactive"].map(id => [id, {
  id, instanceId, parentId: null, title: id, agent: "build", model: { providerId: "fixture", modelId: "fixture" },
  status: "idle", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
  version: "1", projectID: "fixture", location: { directory: "/fixture" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
}]))))
setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture", models: [
  { id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } },
] }]))
setActiveSession(instanceId, "active")
const store = messageStoreBus.getOrCreate(instanceId)
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={visible()}>
  <SessionView sessionId={selected()} activeSessions={sessions().get(instanceId)!} instanceId={instanceId}
    instanceFolder="/fixture" escapeInDebounce={false} isActive={true} />
</Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

const emit = (sessionID: string, type: string, data: any = {}) => {
  if (type === "session.compaction.started") nativeMessages.set(sessionID, [...(nativeMessages.get(sessionID) ?? []), { id: `compact-${sessionID}`,
    type: "compaction", status: "running", reason: "manual", summary: "", recent: "", time: { created: sequence } }])
  if (type === "session.compaction.delta") nativeMessages.get(sessionID)!.at(-1).summary += data.text
  ;(sseManager as any).handleEvent(instanceId, {
    id: `event_${++sequence}`, type, created: sequence, location: { directory: "/fixture" }, data: { sessionID, ...data },
  })
}
const text = (sessionID: string) => {
  const message = store.getMessage(`compact-${sessionID}`)
  return message?.partIds.map(id => (message.parts[id].data as any).text).join("")
}
;(window as any).compactionFixture = {
  resetCounts: () => { (window as any).compactionCounts = { deltas: {}, projections: {} }; messageLists = 0 },
  seed: (sessionID: string, count: number) => nativeMessages.set(sessionID, Array.from({ length: count }, (_, index) => ({
    id: `history-${sessionID}-${String(index).padStart(4, "0")}`, type: "user", text: `History ${index}`, time: { created: index },
  }))),
  snapshot: () => ({ counts: (window as any).compactionCounts, messageLists,
    active: text("active"), inactive: text("inactive"), ids: store.getSessionMessageIds(selected()),
    revision: getOpenCodeMessageRevision(instanceId, selected()) }),
  start: (sessionID = "active") => {
    emit(sessionID, "session.compaction.started", { inputID: `compact-${sessionID}`, reason: "manual", recent: "" })
  },
  burst: (sessionID: string, count = 128) => {
    const started = performance.now()
    for (let index = 0; index < count; index++) emit(sessionID, "session.compaction.delta", { text: `[${index}]` })
    return performance.now() - started
  },
  phase: async (sessionID: string) => {
    for (let index = 0; index < 8; index++) {
      emit(sessionID, "session.compaction.delta", { text: `[${index}]` })
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  },
  end: (sessionID: string, summary: string) => {
    nativeMessages.set(sessionID, [{ id: `compact-${sessionID}`, type: "compaction", status: "completed",
      reason: "manual", summary, recent: "", model, time: { created: 1 } }])
    emit(sessionID, "session.compaction.ended", { reason: "manual", text: summary, recent: "", model })
  },
  fail: (sessionID: string) => emit(sessionID, "session.compaction.failed", {
    inputID: `compact-${sessionID}`, reason: "manual", error: { type: "fixture", message: "cancelled" },
  }),
  activate: (sessionID: string) => {
    show(false)
    select(sessionID)
    setActiveSession(instanceId, sessionID)
    show(true)
  },
  unmount: () => show(false),
  remount: () => show(true),
}

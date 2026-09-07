import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { sessions, setActiveSession, setProviders } from "../../../src/stores/session-state"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { sseManager } from "../../../src/lib/sse-manager"
import { fetchSessions, loadMessages } from "../../../src/stores/session-api"
import { projectOpenCodeMessages } from "../../../src/stores/opencode-data"
import "../../../src/index.css"

// Only the fake native authority survives page.reload. No UI store or module
// survives, and no replayed event can supply the undo marker after a cold load.
const instanceId = "undo-instance", sessionId = "undo-session", storageKey = "native-undo-fixture"
const model = { providerID: "fixture", id: "fixture" }
const native = JSON.parse(sessionStorage.getItem(storageKey) || "null") ?? {
  revert: null,
  prompts: 0,
  active: location.search.includes("busy"),
  messages: Array.from({ length: 6 }, (_, i) => i % 2 === 0
    ? { id: `msg_0${i + 1}`, type: "user", text: ["Earlier prompt", "Undo this prompt", "Later prompt"][i / 2], time: { created: i + 1 } }
    : { id: `msg_0${i + 1}`, type: "assistant", agent: "build", model, content: [{ type: "text", text: ["Earlier answer", "Undone answer", "Later answer"][(i - 1) / 2] }], time: { created: i + 1, completed: i + 1 } }),
}
const persist = () => sessionStorage.setItem(storageKey, JSON.stringify(native))
const info = () => ({ id: sessionId, title: "Undo fixture", agent: "build", model, projectID: "fixture", location: { directory: "/fixture" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 6 },
  ...(native.revert ? { revert: { ...native.revert } } : {}),
})
let clock = Date.now()
let waitCalls = 0, settle: (() => void) | undefined
const emit = (type: string, data: any) => (sseManager as any).handleEvent(instanceId, {
  id: `ev_${++clock}`, type, created: clock, location: { directory: "/fixture" }, data: { sessionID: sessionId, ...data },
})
const client: any = {
  session: {
    active: async () => ({}), inbox: { list: async () => [] },
    list: async () => ({ data: [info()], cursor: {} }), get: async () => info(),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
    switchAgent: async () => {}, switchModel: async () => {},
    interrupt: async () => ({ interrupted: true }),
    wait: async () => {
      waitCalls++
      await new Promise<void>(resolve => { settle = resolve })
      native.active = false
    },
    revert: { stage: async ({ messageID }: any) => {
      if (native.active) throw { _tag: "SessionBusyError", sessionID: sessionId, message: "busy" }
      native.revert = { messageID }
      persist()
      // Match native stage: keep every transcript record, publish the boundary
      // before the HTTP response, and never require another prompt to persist it.
      emit("session.revert.staged", { revert: { ...native.revert } })
      return { ...native.revert }
    } },
    prompt: async (input: any) => {
      if (native.revert) {
        const messageID = native.revert.messageID
        native.messages = native.messages.filter((message: any) => message.id < messageID)
        native.revert = null
        emit("session.revert.committed", { to: messageID })
      }
      native.prompts++
      native.messages.push({ id: input.id, type: "user", text: input.text, time: { created: ++clock } })
      persist()
      emit("session.inbox.enqueued", { inboxID: input.id, item: { type: "user", payload: { text: input.text }, delivery: "steer" } })
      emit("session.inbox.delivered", { inboxID: input.id })
      return { id: input.id }
    },
  },
  model: { default: async () => model },
  message: { list: async ({ cursor }: { cursor?: string }) => cursor
    ? { data: [], cursor: {} }
    : { data: [...native.messages].reverse(), cursor: { next: "terminal" } } },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setProviders(prev => new Map(prev).set(instanceId, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
const [visible, setVisible] = createSignal(true)
async function boot() {
  await fetchSessions(instanceId)
  setActiveSession(instanceId, sessionId)
  render(() => <ConfigProvider><I18nProvider><ThemeProvider>
    <Show when={visible()}><SessionView sessionId={sessionId} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder="/fixture" escapeInDebounce={false} isActive={true} /></Show>
  </ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
  ;(window as any).fixture = {
    switchAway: () => { setActiveSession(instanceId, "other"); setVisible(false) },
    return: async () => { await fetchSessions(instanceId); await loadMessages(instanceId, sessionId, { force: true }); setActiveSession(instanceId, sessionId); setVisible(true) },
    settle: () => settle?.(),
    reproject: () => projectOpenCodeMessages(instanceId, sessionId, { session: { message: { list: () => native.messages } } } as any),
    snapshot: () => ({ waitCalls, nativeCount: native.messages.length, prompts: native.prompts, revert: native.revert, storedRevert: messageStoreBus.getOrCreate(instanceId).getSessionRevert(sessionId), ids: messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId) }),
  }
}
void boot()

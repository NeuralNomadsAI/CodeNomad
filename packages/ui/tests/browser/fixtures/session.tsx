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
import { loadMessages } from "../../../src/stores/session-api"
import "../../../src/index.css"

// Real SessionView, prompt action and native SSE dispatcher; only HTTP is fake.
const instanceId = "browser-instance", sessionId = "browser-session"
const assistantId = "msg_assistant"
let time = Date.now(), calls = 0
let delayPrompt = false, admittedPrompt: any
let releasePrompt: (() => void) | undefined
const nativeMessages: any[] = []
const model = { providerID: "fixture", id: "fixture" }
const emit = (type: string, data: any) => (sseManager as any).handleEvent(instanceId, {
  id: `ev_${++time}`, type, created: time, location: { directory: "/fixture" },
  data: { sessionID: sessionId, ...data },
})
const client: any = {
  session: {
    active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => ({ id: sessionId, title: "fixture", location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
    switchAgent: async (data: any) => emit("session.agent.selected", data),
    switchModel: async (data: any) => emit("session.model.selected", data),
    message: async ({ messageID }: any) => ({ id: messageID, type: "model-switched", model, time: { created: time } }),
    prompt: async (input: any) => {
      if (delayPrompt) {
        admittedPrompt = input
        await new Promise<void>(resolve => { releasePrompt = resolve })
        return { id: input.id }
      }
      nativeMessages.push({ type: "user", text: input.text, id: input.id, time: { created: ++time } })
      emit("session.inbox.enqueued", { inboxID: input.id, item: { type: "user", payload: { text: input.text }, delivery: "steer" } })
      emit("session.inbox.delivered", { inboxID: input.id })
      return { id: input.id }
    },
  },
  model: { default: async () => ({ data: model }) },
  message: { list: async () => { calls++; return { data: nativeMessages.slice().reverse(), cursor: {} } } },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "New session", agent: "build",
  model: { providerId: "fixture", modelId: "fixture" }, status: "idle", retry: null, idleSince: null,
  generationRecovery: null, runtimeStatusKnown: true, version: "1", projectID: "fixture", location: { directory: "/fixture" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
}]])))
setProviders(prev => new Map(prev).set(instanceId, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
setActiveSession(instanceId, sessionId)
const [visible, setVisible] = createSignal(true)
const store = messageStoreBus.getOrCreate(instanceId)
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <Show when={visible()}><SessionView sessionId={sessionId} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder="/fixture" escapeInDebounce={false} isActive={true} /></Show>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  delayPrompt: () => { delayPrompt = true },
  acceptPrompt: () => releasePrompt?.(),
  echoPrompt: () => {
    emit("session.inbox.enqueued", { inboxID: admittedPrompt.id, item: { type: "user", payload: { text: admittedPrompt.text }, delivery: "steer" } })
  },
  persistPrompt: () => {
    nativeMessages.push({ type: "user", text: admittedPrompt.text, id: admittedPrompt.id, time: { created: ++time } })
    emit("session.inbox.delivered", { inboxID: admittedPrompt.id })
  },
  reload: () => loadMessages(instanceId, sessionId, { force: true }),
  admitted: () => admittedPrompt?.id,
  seedHistory: async () => {
    for (let i = 0; i < 60; i++) {
      nativeMessages.push({ id: `msg_${String(i).padStart(4, "0")}`, type: "assistant", agent: "build", model,
        time: { created: i + 1, completed: i + 1 }, content: [{ type: "text", text: `History ${i}\n\n` + "A previously rendered response.\n\n".repeat(3 + i % 5) }] })
    }
    await loadMessages(instanceId, sessionId, { force: true })
  },
  startEmpty: () => emit("session.step.started", { assistantMessageID: assistantId, agent: "build", model }),
  start: () => {
    emit("session.step.started", { assistantMessageID: assistantId, agent: "build", model })
    emit("session.text.started", { assistantMessageID: assistantId })
  },
  delta: (delta: string) => emit("session.text.delta", { assistantMessageID: assistantId, ordinal: 0, delta }),
  end: (text: string) => {
    nativeMessages.push({ id: assistantId, type: "assistant", agent: "build", model, time: { created: time, completed: time }, content: [{ type: "text", text }] })
    emit("session.text.ended", { assistantMessageID: assistantId, ordinal: 0, text })
  },
  dropAssistant: async () => {
    const index = nativeMessages.findIndex(message => message.id === assistantId)
    if (index >= 0) nativeMessages.splice(index, 1)
    await loadMessages(instanceId, sessionId, { force: true })
  },
  restoreAssistant: async (text: string) => {
    nativeMessages.push({ id: assistantId, type: "assistant", agent: "build", model, time: { created: time }, content: [{ type: "text", text }] })
    await loadMessages(instanceId, sessionId, { force: true })
  },
  switchAway: () => { setActiveSession(instanceId, "other"); setVisible(false) },
  return: () => { setActiveSession(instanceId, sessionId); setVisible(true) },
  snapshot: () => ({ calls, ids: store.getSessionMessageIds(sessionId), text: store.getMessage(assistantId)?.parts[`${assistantId}-text-0`]?.data.text }),
}

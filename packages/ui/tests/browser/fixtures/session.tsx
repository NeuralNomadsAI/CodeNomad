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
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

// Real SessionView, prompt action and native SSE dispatcher; only HTTP is fake.
const instanceId = "browser-instance", sessionId = "browser-session"
const assistantId = "msg_assistant"
let time = Date.now(), calls = 0
let delayPrompt = false, admittedPrompt: any
let releasePrompt: (() => void) | undefined
const nativeMessages: any[] = []
/** Prompts parked in the native inbox, as an authoritative resync lists them. */
const nativeInbox: any[] = []
const model = { providerID: "fixture", id: "fixture" }
const emit = (type: string, data: any) => (sseManager as any).handleEvent(instanceId, {
  id: `ev_${++time}`, type, created: time, location: { directory: "/fixture" },
  data: { sessionID: sessionId, ...data },
})
const client: any = {
  session: {
    active: async () => ({}), inbox: { list: async () => nativeInbox.map(item => ({ ...item })) },
    form: { list: async () => [] },
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
  permission: { list: async () => [] },
  message: { list: async ({ cursor, limit = 200 }: { cursor?: string; limit?: number } = {}) => {
    calls++
    const offset = Number(cursor ?? 0), messages = nativeMessages.slice().reverse()
    return { data: messages.slice(offset, offset + limit), cursor: offset + limit < messages.length ? { next: String(offset + limit) } : {} }
  } },
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
const [active, setActive] = createSignal(true)
const store = messageStoreBus.getOrCreate(instanceId)
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <Show when={visible()}><SessionView sessionId={sessionId} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder="/fixture" escapeInDebounce={false} isActive={active()} /></Show>
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
  /** Parks a follow-up in the native inbox while a turn runs (follow-up behaviour "queue"). */
  queueFollowUp: (id: string, text: string) => {
    nativeInbox.push({ id, sessionID: sessionId, type: "user", payload: { text }, delivery: "queue", time: { created: ++time } })
    emit("session.inbox.enqueued", { inboxID: id, item: { type: "user", payload: { text }, delivery: "queue" } })
  },
  /** The engine starts the parked follow-up: its native row persists and it leaves the inbox. */
  deliverQueued: (id: string) => {
    const [item] = nativeInbox.splice(nativeInbox.findIndex(entry => entry.id === id), 1)
    nativeMessages.push({ type: "user", text: item.payload.text, id, time: { created: ++time } })
    emit("session.inbox.delivered", { inboxID: id })
  },
  /** A history rewrite (pruning) replaces the session's reducer and reloads the page. */
  prune: () => emit("rpc.codenomad.session-pruning.pruned", { messageID: assistantId, revision: "a".repeat(64) }),
  admitted: () => admittedPrompt?.id,
  seedHistory: async (count = 60) => {
    for (let i = 0; i < count; i++) {
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
  /** Streams a reply after a completed `name` tool call in the same step. */
  startAfterTool: (name: string) => {
    emit("session.step.started", { assistantMessageID: assistantId, agent: "build", model })
    emit("session.tool.input.started", { assistantMessageID: assistantId, id: "tool-before-reply", name })
    emit("session.tool.called", { assistantMessageID: assistantId, id: "tool-before-reply", input: { filePath: "a.txt" } })
    emit("session.tool.success", { assistantMessageID: assistantId, id: "tool-before-reply", content: [{ type: "text", text: "read" }], metadata: {} })
    emit("session.text.started", { assistantMessageID: assistantId })
  },
  delta: (delta: string) => emit("session.text.delta", { assistantMessageID: assistantId, ordinal: 0, delta }),
  /** Starts a live step that streams model reasoning instead of reply text. */
  startReasoning: () => {
    emit("session.step.started", { assistantMessageID: assistantId, agent: "build", model })
    emit("session.reasoning.started", { assistantMessageID: assistantId })
  },
  reasoningDelta: (delta: string) => emit("session.reasoning.delta", { assistantMessageID: assistantId, delta }),
  endReasoning: (text: string) => emit("session.reasoning.ended", { assistantMessageID: assistantId, text }),
  /** Shows thinking rows (hidden by default) expanded, reactively after mount. */
  revealThinking: () => applyUiSettings({ showThinkingBlocks: true, thinkingBlocksExpansion: "expanded" }),
  appendTextPart: (text: string) => {
    emit("session.text.started", { assistantMessageID: assistantId })
    emit("session.text.delta", { assistantMessageID: assistantId, ordinal: 1, delta: text })
    emit("session.text.ended", { assistantMessageID: assistantId, ordinal: 1, text })
  },
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
  // Keeps the SessionView mounted, as a project tab or session switch does.
  setActive,
  snapshot: () => ({ calls, ids: store.getSessionMessageIds(sessionId), window: store.getMessageWindow(sessionId), scroll: store.getScrollSnapshot(sessionId, "message-stream"), text: store.getMessage(assistantId)?.parts[`${assistantId}-text-0`]?.data.text,
    replyText: Object.values(store.getMessage(assistantId)?.parts ?? {}).flatMap(part => part.data.type === "text" ? [part.data.text] : []).join("") }),
}

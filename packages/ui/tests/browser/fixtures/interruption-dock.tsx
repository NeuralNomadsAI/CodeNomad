import { For, createSignal } from "solid-js"
import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import { InterruptionDock } from "../../../src/components/interruption-dock"
import PermissionNotificationBanner from "../../../src/components/permission-notification-banner"
import { focusInterruption } from "../../../src/stores/interruption-navigation"
import { ConfigProvider, setThemePreference } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverApi } from "../../../src/lib/api-client"
import { addInstance, addPendingForm, addPermissionToQueue, getPermissionQueue } from "../../../src/stores/instances"
import { getFormQueue } from "../../../src/stores/forms"
import { sessions, setSessions, setActiveSession, activeSessionId, setProviders } from "../../../src/stores/session-state"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages, loadMessageAnchor } from "../../../src/stores/session-api"
import { applyUiSettings } from "./ui-settings"
import { getQuestionToolSearchText } from "../../../src/components/tool-call/search-text"
import "../../../src/index.css"
import { installActivationFrameGate } from "./activation-frame-gate"

const instanceId = "interruptions", sessionId = "s", toolId = "question-tool"
let messageId = "msg_0000"
const model = { providerID: "fixture", id: "fixture" }
let time = 1000, fail = false, hold = false, release: (() => void) | undefined
const replies: any[] = [], windows: any[] = []
let completed: string[][] | undefined
const longQuestions = [
  { header: "Deployment", question: "How should we deploy the updated interruption dock to existing workspaces?", options: [
    { label: "Gradual rollout", description: "Enable the new panel for a small group first, review feedback, then expand to all workspaces." },
    { label: "All workspaces", description: "Release the updated panel everywhere after the browser checks pass and support documentation is ready." },
    { label: "Preview only", description: "Keep the new interaction in preview while collecting keyboard and mobile accessibility feedback." },
  ] },
  { header: "Validation", question: "Which checks must finish before the release can proceed?", multiple: true, options: [
    { label: "Browser coverage", description: "Verify narrow layouts, keyboard navigation, persistent answers and bounded panel actions." },
    { label: "Visual review", description: "Review both light and dark appearances, question hierarchy and lengthy option descriptions." },
    { label: "Native integration", description: "Confirm that completed native questions retain their answers when the conversation is reloaded." },
  ] },
  { header: "Notes", question: "What additional release notes should the team include?", options: [] },
]
let questions: Array<{ header: string; question: string; options: Array<{ label: string; description: string }>; multiple?: boolean }> = [
  { question: "Which approach?", header: "Approach", options: [] },
]
const question = () => ({ id: messageId, type: "assistant", agent: "build", model, time: { created: 1, ...(completed ? { completed: 2 } : {}) },
  content: [{ type: "tool", id: toolId, name: "question", time: { created: 1 }, state: {
    status: completed ? "completed" : "running", input: { questions },
    ...(completed ? { output: { answers: completed }, metadata: { answers: completed }, content: [{ type: "text", text: "Answered" }] } : {}),
  } }] })
const history = () => [question(), ...Array.from({ length: 249 }, (_, index) => ({
  id: `msg_${String(index + 1).padStart(4, "0")}`, type: "assistant", agent: "build", model, time: { created: index + 2, completed: index + 3 },
  content: [{ type: "text", text: `History ${index + 1}\n\n` + "Earlier response.\n\n".repeat(4) }],
}))]
const emit = (type: string, data: any) => (sseManager as any).handleEvent(instanceId, {
  id: `event-${++time}`, type, created: time, location: { directory: "/fixture" }, data: { sessionID: sessionId, ...data },
})
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async ({ sessionID }: any) => ({ id: sessionID, title: sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: time } }),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
    form: { reply: async (input: any) => {
      replies.push(input)
      if (hold) await new Promise<void>(resolve => { release = resolve })
      if (fail) throw new Error("Reply failed")
      if (input.formID === "question") {
        completed = questions.map((_, index) => {
          const value = input.answer[`q${index}`]
          return Array.isArray(value) ? value : [String(value)]
        })
        emit("session.tool.success", { assistantMessageID: messageId, id: toolId, output: { answers: completed }, metadata: { answers: completed }, content: [{ type: "text", text: "Answered" }], executed: true })
      }
      emit("form.replied", { sessionID: input.sessionID, id: input.formID, answer: input.answer })
    }, cancel: async (input: any) => { replies.push(input); emit("form.cancelled", { sessionID: input.sessionID, id: input.formID }) } },
  },
  permission: { reply: async (input: any) => { replies.push(input) }, list: async () => ({ data: getPermissionQueue(instanceId) }) },
  form: { list: async () => ({ data: getFormQueue(instanceId) }) },
  model: { default: async () => ({ data: model }) },
  message: { list: async ({ sessionID, cursor, limit = 200 }: any) => {
    if (sessionID !== sessionId) return { data: [], cursor: {} }
    const offset = Number(cursor ?? 0), data = history().reverse()
    return { data: data.slice(offset, offset + limit), cursor: offset + limit < data.length ? { next: String(offset + limit) } : {} }
  } },
}
serverApi.fetchHistoryWindow = async (_instance, _session, target) => {
  windows.push(target)
  return { status: "window", messages: history().slice(0, 30), latest: false, resume: target, newer: { kind: "latest" } } as any
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map(["s", "other"].map(id => [id, {
  id, instanceId, parentId: null, title: id === "s" ? "Main session" : "Other session", location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as any]))))
setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 } }] }] as any))
setActiveSession(instanceId, sessionId)
const form = (id = "question", sid = sessionId) => ({ id, sessionID: sid, title: id === "question" ? "Questions" : "Other question",
  metadata: id === "question" ? { kind: "question", tool: { messageID: messageId, id: toolId } } : {},
  fields: (id === "question" ? questions : [{ header: "Approach", question: "Which approach?", options: [] }]).map((item, index) => ({
    key: `q${index}`, type: "multiple" in item && item.multiple ? "multiselect" : "string", title: item.header,
    description: item.question, required: true,
    ...(item.options.length ? { options: item.options.map(option => ({ value: option.label, ...option })) } : {}),
  })), state: { status: "pending" },
}) as any
let uiState: Record<string, unknown> = {}
serverApi.fetchStateOwner = async () => uiState as any
serverApi.patchStateOwner = async (_owner, patch) => {
  uiState = { ...uiState, ...patch as Record<string, unknown> }
  return uiState as any
}
serverApi.fetchPermissionReceipts = async () => ({ receipts: [] })
await applyUiSettings({ locale: "en", showMessageTimeline: false, toolInputsVisibility: "hidden", toolOutputExpansion: "expanded",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { other: "expanded" } } })
const activationFrames = installActivationFrameGate()
const [active, setActive] = createSignal(true)
const [conversationFocus, setConversationFocus] = createSignal(false)
const [phone, setPhone] = createSignal(false)
let focusHandled = 0
function App() {
  const panel = <InterruptionDock instanceId={instanceId} sessionId={activeSessionId().get(instanceId)} />
  return <main style={{ display: "flex", "flex-direction": "column", height: "100vh", width: "100%" }}>
    <PermissionNotificationBanner instanceId={instanceId} onClick={() => focusInterruption(instanceId)} />
    <For each={[activeSessionId().get(instanceId)!]}>{id => <SessionView
      sessionId={id} instanceId={instanceId} instanceFolder="/fixture" activeSessions={sessions().get(instanceId)!}
      escapeInDebounce={false} isActive={active()} isPhoneLayout={phone()} focusConversationOnActivate={conversationFocus()}
      onConversationFocusHandled={() => { focusHandled++ }}
      interruptionPanel={panel} onAgentChange={async () => {}} onModelChange={async () => {}} />}</For>
  </main>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><App /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
const store = messageStoreBus.getOrCreate(instanceId)
;(window as any).fixture = {
  activationFrames, active: setActive, conversationFocus: setConversationFocus, phone: setPhone,
  focusHandled: () => focusHandled,
  replies, windows,
  theme: setThemePreference,
  ask: () => emit("form.created", { form: form() }),
  liveAsk: (long = false) => {
    if (long) questions = longQuestions
    messageId = "msg_streaming"
    emit("session.step.started", { assistantMessageID: messageId, agent: "build", model })
    emit("session.tool.input.started", { assistantMessageID: messageId, id: toolId, name: "question" })
    emit("session.tool.called", { assistantMessageID: messageId, id: toolId, input: question().content[0].state.input })
    emit("form.created", { form: form() })
  },
  complete: (answers: unknown, output: unknown = { answers }) => {
    completed = answers as string[][]
    emit("session.tool.success", { assistantMessageID: messageId, id: toolId, output, metadata: { answers }, content: [{ type: "text", text: "Answered" }], executed: true })
    emit("form.replied", { id: "question", answer: {} })
    return getQuestionToolSearchText({ toolCall: question().content[0], toolName: "question", toolState: {
      ...question().content[0].state, status: "completed", metadata: { answers }, output,
    } } as any)
  },
  toolError: () => {
    emit("form.cancelled", { id: "question" })
    emit("session.tool.failed", { assistantMessageID: messageId, id: toolId, error: { message: "Question cancelled" }, metadata: {} })
  },
  other: () => addPendingForm(instanceId, form("other", "other")),
  global: () => addPendingForm(instanceId, { ...form("global-question", "global"), location: { directory: "/fixture" } }),
  refresh: () => addPendingForm(instanceId, { ...form(), title: "Questions refreshed" }),
  focus: (id = "question") => focusInterruption(instanceId, undefined, id),
  switch: (id: string) => setActiveSession(instanceId, id),
  permission: () => addPermissionToQueue(instanceId, { id: "permission", sessionID: sessionId, action: "bash", resources: ["git status"], metadata: {} }),
  remoteReply: () => emit("form.replied", { id: "question", answer: { q0: "Another client" } }),
  fail: (value: boolean) => { fail = value }, hold: () => { hold = true }, release: () => { hold = false; release?.() },
  reload: () => loadMessages(instanceId, sessionId, { force: true }),
  rehydrate: () => loadMessageAnchor(instanceId, sessionId, messageId),
  snapshot: () => ({ ids: store.getSessionMessageIds(sessionId), forms: getFormQueue(instanceId).map(item => item.id), question: store.getMessage(messageId) }),
}

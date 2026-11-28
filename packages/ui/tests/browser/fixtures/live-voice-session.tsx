import { render } from "solid-js/web"
import { Show } from "solid-js"
import AlertDialog from "../../../src/components/alert-dialog"
import { InterruptionDock } from "../../../src/components/interruption-dock"
import PromptInput from "../../../src/components/prompt-input"
import { SpeechSettingsSection } from "../../../src/components/settings/speech-settings-section"
import { serverApi } from "../../../src/lib/api-client"
import { useLiveVoiceConversation } from "../../../src/lib/hooks/use-live-voice-conversation"
import { I18nProvider } from "../../../src/lib/i18n"
import { refreshSessionRuntimeStatus } from "../../../src/stores/session-api"
import { sendMessage } from "../../../src/stores/session-actions"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { sseManager } from "../../../src/lib/sse-manager"
import { ThemeProvider } from "../../../src/lib/theme"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { MESSAGE_WINDOW_PAGE_SIZE } from "../../../src/stores/message-v2/message-window"
import { ConfigProvider } from "../../../src/stores/preferences"
import { activeSettingsSection, openSettingsRow, settingsOpen } from "../../../src/stores/settings-screen"
import { loadSpeechCapabilities } from "../../../src/stores/speech"
import { handleConversationAssistantPartUpdated } from "../../../src/stores/conversation-speech"
import { activeSessionId, getSessionDraftPrompt, sessions, setActiveSession, setSessionDraftPrompt, setSessions, setSessionStatus } from "../../../src/stores/session-state"
import { loadVoiceConversationEngine, setVoiceConversationEngine } from "../../../src/stores/voice-conversation-engine"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const instanceId = "live-voice-fixture", sessionId = "voice"
const params = new URLSearchParams(location.search)
const interactive = params.has("ui")
const title = params.get("title") ?? (interactive ? "Feature ABC — משימה 42" : "Conversation")
const path = "/voice-fixture"
const info = { capture: 0, released: 0, prompts: [] as unknown[], admissionHeld: false, admissionResumed: false, historyReads: 0,
  historyCursors: [] as (string | null)[],
}
const playback = { rendered: 0, flushed: -1 }
window.AudioWorkletNode = class extends AudioWorkletNode {
  constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
    super(...args)
    if (args[1] === "codenomad-live-playback") this.port.addEventListener("message", ({ data }) => {
      if (data.flush) {
        playback.flushed = data.rendered
        playback.rendered = 0
      } else if (typeof data.rendered === "number") playback.rendered = data.rendered
    })
  }
}
let firstPrompt: "start" | "delay" | "fail" | "holdAck" = "start"
let releaseAck: (() => void) | undefined
let latestPage: Promise<void> | undefined
let latestError: string | undefined
let releaseHistory: (() => void) | undefined
let microphone: MediaStreamTrack | undefined
let eventId = 0
let releaseAdmission: (() => void) | undefined
const emit = (type: string, data: object) => (sseManager as any).handleEvent(instanceId, {
  id: `event-${++eventId}`, type, created: eventId, location: { directory: path }, data: { sessionID: sessionId, ...data },
})
const question = { id: "question", sessionID: sessionId, title: "Native question", metadata: { kind: "question" },
  fields: [{ key: "q0", type: "string", title: "Approach", description: "Which approach?", required: true }],
  state: { status: "pending" } }
const client: any = {
  session: {
    switchAgent: async () => {},
    switchModel: async () => {},
    instructions: { entry: {
      remove: async () => {},
      put: async () => {
        if (!info.admissionHeld) return
        await new Promise<void>(resolve => { releaseAdmission = resolve })
        info.admissionResumed = true
      },
    } },
    prompt: async (input: { id: string; text: string }) => {
      info.prompts.push(input)
      if (input.text === "first") {
        if (firstPrompt === "fail") throw new Error("Prompt rejected")
        if (firstPrompt === "start") emit("session.execution.started", {})
        if (firstPrompt === "holdAck") await new Promise<void>(resolve => { releaseAck = resolve })
      }
      if (input.text === "Ask the agent") {
        emit("permission.asked", { id: "allow", action: "bash", resources: ["git status"], metadata: {} })
        emit("form.created", { form: question })
      }
      return { id: input.id }
    },
    active: async () => ({}),
    get: async () => ({
      id: sessionId, title, location: { directory: path }, time: { created: 1, updated: 1, idle: 1 },
    }),
    inbox: { list: async () => ({ data: [] }) },
  },
  message: { list: async () => {
    if (!latestPage) return { data: [], cursor: {} }
    info.historyReads++
    await latestPage
    return { data: [{ id: "latest-assistant", type: "assistant", agent: "build",
      model: { providerID: "fixture", id: "fixture" }, time: { created: 10 },
      ...(latestError ? { error: { type: "ProviderError", message: latestError, status: 429 } } : {}), content: [
        { type: "text", text: "Newest answer" }, { type: "reasoning", text: "Private reasoning" },
      ] }], cursor: {} }
  } },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: path, projectName: "Project", port: 0, pid: 0, proxyPath: path, status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([sessionId, "other"].map(id => [id, {
  id, instanceId, parentId: null, title, location: { directory: path },
  status: "idle", agent: "", model: { providerId: "", modelId: "" }, time: { created: 1, updated: 1, idle: 1 },
} as any]))))
setActiveInstanceId(instanceId)
setActiveSession(instanceId, sessionId)
setSessionDraftPrompt(instanceId, sessionId, "Unsent draft")
let geminiConfigured = true
serverApi.fetchSpeechCapabilities = async () => ({
  available: true, sttConfigured: true, supportsStt: true,
  voiceConversation: { geminiLive: { configured: geminiConfigured }, openaiRealtime: { configured: true } },
} as any)
const store = messageStoreBus.getOrCreate(instanceId)
store.upsertMessage({
  id: "assistant", sessionId, role: "assistant", status: "complete", createdAt: 1, updatedAt: 1,
  parts: [
    { id: "public", type: "text", text: "Visible answer" },
    { id: "thought", type: "reasoning", text: "Private thinking" },
    { id: "synthetic", type: "text", text: "Hidden report", synthetic: true },
    { id: "file", type: "file", filename: "private file" },
  ],
})
Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
  info.capture++
  const context = new AudioContext()
  const oscillator = context.createOscillator()
  const sink = context.createMediaStreamDestination()
  oscillator.connect(sink)
  oscillator.start()
  await context.resume()
  const track = sink.stream.getAudioTracks()[0]
  microphone = track
  const stop = track.stop.bind(track)
  track.stop = () => { stop(); info.released++; void context.close() }
  return sink.stream
} })

await loadVoiceConversationEngine()
await setVoiceConversationEngine(params.has("openai") ? "openai-realtime" : "gemini-live")
if (interactive) await applyUiSettings({ locale: params.has("he") ? "he" : "en", showPromptVoiceInput: true, followUpBehavior: "queue" })

function Fixture() {
  const current = () => activeSessionId().get(instanceId) ?? undefined
  const voice = useLiveVoiceConversation({
    instanceId: () => instanceId, sessionId: current, active: () => true, followUp: () => "queue", canSend: () => true,
  })
  Object.assign(window, { fixture: {
    info, switchSession: () => setActiveSession(instanceId, "other"),
    returnSession: () => setActiveSession(instanceId, sessionId),
    transcript: voice.transcript, state: voice.state,
    draft: () => getSessionDraftPrompt(instanceId, sessionId),
    userTexts: () => store.getSessionMessageIds(sessionId).map(id => store.getMessage(id))
      .filter(row => row?.role === "user").map(row => row!.parts[row!.partIds[0]].data),
    busy: () => setSessionStatus(instanceId, sessionId, "working"),
    setFirstPrompt: (value: typeof firstPrompt) => { firstPrompt = value },
    waitingAck: () => Boolean(releaseAck),
    releaseAck: () => releaseAck?.(),
    acknowledgementSettled: () => sessions().get(instanceId)?.get(sessionId)?.generationAdmissionToken === undefined,
    openHistory: (error?: string) => {
      for (let index = 0; index < MESSAGE_WINDOW_PAGE_SIZE - 1; index++) {
        store.upsertMessage({ id: `older-${index}`, sessionId, role: "assistant",
          status: "complete", parts: [], createdAt: index + 2, updatedAt: index + 2 })
      }
      store.setMessageWindow(sessionId, { kind: "history", resumeCursor: "older", newerCursors: [null] })
      latestError = error
      latestPage = new Promise(resolve => { releaseHistory = resolve })
    },
    releaseHistory: () => releaseHistory?.(),
    hideLatestPage(repeated = false) {
      const revert = { messageID: "m01000" }
      setSessions(previous => {
        const own = new Map(previous.get(instanceId))
        own.set(sessionId, { ...own.get(sessionId)!, revert })
        return new Map(previous).set(instanceId, own)
      })
      store.setSessionRevert(sessionId, revert)
      info.historyCursors = []
      const row = (id: string, text: string) => ({
        id, type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" },
        time: { created: 10 }, content: [{ type: "text", text }],
      })
      client.message.list = async ({ cursor }: { cursor?: string }) => {
        info.historyCursors.push(cursor ?? null)
        return cursor && !repeated
          ? { data: [row("m00999", "Last answer still visible")], cursor: {} }
          : {
            data: Array.from({ length: MESSAGE_WINDOW_PAGE_SIZE }, (_, index) => row(`m0${2000 - index}`, "Hidden by undo")),
            cursor: { next: "older-visible" },
          }
      }
    },
    history: () => ({ kind: store.getMessageWindow(sessionId)?.kind, ids: store.getSessionMessageIds(sessionId) }),
    startExecution: () => emit("session.execution.started", {}),
    finishExecution: () => emit("session.execution.succeeded", {}),
    resyncIdle: async () => {
      emit("server.connected", { daemon: "voice-fixture" })
      await refreshSessionRuntimeStatus(instanceId)
      const session = sessions().get(instanceId)?.get(sessionId)
      return { known: session?.runtimeStatusKnown, status: session?.status, idle: session?.time.idle }
    },
    holdAdmission: () => { info.admissionHeld = true },
    waitingAdmission: () => Boolean(releaseAdmission),
    releaseAdmission: (keepHolding = true) => {
      info.admissionHeld = keepHolding
      const pending = releaseAdmission
      releaseAdmission = undefined
      pending?.()
    },
  } })
  return <main>
    <button onClick={voice.start}>Start</button>
    <button onClick={voice.acceptConsent}>Accept</button>
    <button onClick={voice.dismiss}>Close</button>
    <InterruptionDock instanceId={instanceId} sessionId={current()} />
  </main>
}

function Interactive() {
  const current = () => activeSessionId().get(instanceId) ?? sessionId
  Object.assign(window, { fixture: {
    info, switchSession: () => setActiveSession(instanceId, "other"), setVoiceConversationEngine,
    openVoiceSettings: () => openSettingsRow("speech", "voice-dictation"),
    playback,
    setFirstPrompt: (value: typeof firstPrompt) => { firstPrompt = value },
    holdAdmission: () => { info.admissionHeld = true },
    waitingAdmission: () => Boolean(releaseAdmission),
    releaseAdmission: () => { info.admissionHeld = false; releaseAdmission?.() },
    userPrompts: () => store.getSessionMessageIds(sessionId).flatMap(id => {
      const row = store.getMessage(id)
      if (row?.role !== "user") return []
      return [{ id, text: row.parts[row.partIds[0]]?.data.text, status: row.status }]
    }),
    removeProviderKey: () => { geminiConfigured = false; return loadSpeechCapabilities(true) },
    microphoneEnabled: () => microphone?.enabled,
    async holdClassicSummary() {
      const probe = { requested: false, aborted: false, played: 0, release: () => {} }
      const AudioConstructor = window.Audio
      window.Audio = class extends AudioConstructor {
        async play() { probe.played++ }
        pause() {}
        load() {}
      }
      serverApi.synthesizeSpeechStream = (_input, signal) => {
        probe.requested = true
        signal.addEventListener("abort", () => { probe.aborted = true }, { once: true })
        // Deliberately return a late successful response despite cancellation.
        return new Promise(resolve => { probe.release = () => resolve(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg" } })) })
      }
      serverApi.fetchSpeechCapabilities = async () => ({
        available: true, supportsTts: true, ttsConfigured: true, supportsStt: true, sttConfigured: true,
      } as any)
      await loadSpeechCapabilities(true)
      await setVoiceConversationEngine("classic")
      Object.assign(window, { classic: {
        probe,
        emitSummary: () => handleConversationAssistantPartUpdated(instanceId, {
          id: "summary-text", type: "text", sessionID: sessionId, messageID: "summary",
          text: "```spoken\nPending Classic summary.\n```",
        }, { role: "assistant" } as any),
      } })
    },
  } })
  return <main style={{ display: "flex", "min-height": "100dvh", "flex-direction": "column", "justify-content": "flex-end" }}>
    <AlertDialog />
    <InterruptionDock instanceId={instanceId} sessionId={current()} />
    <PromptInput instanceId={instanceId} instanceFolder={path} sessionId={current()} isActive
      onSend={async (text, attachments, delivery, restoredPayload, admitDelivery) => {
        await sendMessage(instanceId, current(), text, attachments, { delivery: admitDelivery ?? delivery, pendingDelivery: delivery, restoredPayload })
      }} />
    <Show when={settingsOpen() && activeSettingsSection() === "speech"}><SpeechSettingsSection /></Show>
  </main>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider>{interactive ? <Interactive /> : <Fixture />}</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

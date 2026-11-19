import { render } from "solid-js/web"
import { Show } from "solid-js"
import AlertDialog from "../../../src/components/alert-dialog"
import { InterruptionDock } from "../../../src/components/interruption-dock"
import PromptInput from "../../../src/components/prompt-input"
import { SpeechSettingsSection } from "../../../src/components/settings/speech-settings-section"
import { serverApi } from "../../../src/lib/api-client"
import { useLiveVoiceConversation } from "../../../src/lib/hooks/use-live-voice-conversation"
import { I18nProvider } from "../../../src/lib/i18n"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { sseManager } from "../../../src/lib/sse-manager"
import { ThemeProvider } from "../../../src/lib/theme"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { ConfigProvider } from "../../../src/stores/preferences"
import { activeSettingsSection, openSettingsRow, settingsOpen } from "../../../src/stores/settings-screen"
import { activeSessionId, getSessionDraftPrompt, setActiveSession, setSessionDraftPrompt, setSessions, setSessionStatus } from "../../../src/stores/session-state"
import { loadVoiceConversationEngine, setVoiceConversationEngine } from "../../../src/stores/voice-conversation-engine"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const instanceId = "live-voice-fixture", sessionId = "voice"
const params = new URLSearchParams(location.search)
const interactive = params.has("ui")
const title = params.get("title") ?? (interactive ? "Feature ABC — משימה 42" : "Conversation")
const path = "/voice-fixture"
const info = { capture: 0, released: 0, prompts: [] as unknown[], admissionHeld: false }
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
    instructions: { entry: {
      remove: async () => {},
      put: async () => { if (info.admissionHeld) await new Promise<void>(resolve => { releaseAdmission = resolve }) },
    } },
    prompt: async (input: { id: string; text: string }) => {
      info.prompts.push(input)
      if (input.text === "first") emit("session.execution.started", {})
      if (input.text === "Ask the agent") {
        emit("permission.asked", { id: "allow", action: "bash", resources: ["git status"], metadata: {} })
        emit("form.created", { form: question })
      }
      return { id: input.id }
    },
    active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
  },
  message: { list: async () => ({ data: [], cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: path, projectName: "Project", port: 0, pid: 0, proxyPath: path, status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([sessionId, "other"].map(id => [id, {
  id, instanceId, parentId: null, title, location: { directory: path },
  status: "idle", agent: "", model: { providerId: "", modelId: "" }, time: { created: 1, updated: 1 },
} as any]))))
setActiveInstanceId(instanceId)
setActiveSession(instanceId, sessionId)
setSessionDraftPrompt(instanceId, sessionId, "Unsent draft")
serverApi.fetchSpeechCapabilities = async () => ({
  available: true, sttConfigured: true, supportsStt: true,
  voiceConversation: { geminiLive: { configured: true }, openaiRealtime: { configured: true } },
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
if (interactive) await applyUiSettings({ locale: params.has("he") ? "he" : "en", showPromptVoiceInput: true })

function Fixture() {
  const current = () => activeSessionId().get(instanceId) ?? undefined
  const voice = useLiveVoiceConversation({
    instanceId: () => instanceId, sessionId: current, active: () => true, followUp: () => "queue", canSend: () => true,
  })
  Object.assign(window, { fixture: {
    info, switchSession: () => setActiveSession(instanceId, "other"),
    transcript: voice.transcript, state: voice.state,
    draft: () => getSessionDraftPrompt(instanceId, sessionId),
    userTexts: () => store.getSessionMessageIds(sessionId).map(id => store.getMessage(id))
      .filter(row => row?.role === "user").map(row => row!.parts[row!.partIds[0]].data),
    busy: () => setSessionStatus(instanceId, sessionId, "working"),
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
    microphoneEnabled: () => microphone?.enabled,
  } })
  return <main style={{ display: "flex", "min-height": "100dvh", "flex-direction": "column", "justify-content": "flex-end" }}>
    <AlertDialog />
    <InterruptionDock instanceId={instanceId} sessionId={current()} />
    <PromptInput instanceId={instanceId} instanceFolder={path} sessionId={current()} isActive
      onSend={async () => { throw new Error("Dictation must never send") }} />
    <Show when={settingsOpen() && activeSettingsSection() === "speech"}><SpeechSettingsSection /></Show>
  </main>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider>{interactive ? <Interactive /> : <Fixture />}</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

import { createSignal, Index } from "solid-js"
import { render } from "solid-js/web"
import ToolCall from "../../../src/components/tool-call"
import { useSpeech } from "../../../src/lib/hooks/use-speech"
import { serverApi } from "../../../src/lib/api-client"
import { authRecovery } from "../../../src/lib/auth-recovery"
import { getToastHistory } from "../../../src/lib/notifications"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { ConfigProvider } from "../../../src/stores/preferences"
import { resetSpeechCapabilities } from "../../../src/stores/speech"
import { handleConversationAssistantPartUpdated, toggleConversationMode } from "../../../src/stores/conversation-speech"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { setSessions } from "../../../src/stores/session-state"
import { setActiveSessionId } from "../../../src/stores/session-selection-state"
import type { Session } from "../../../src/types/session"
import type { MessageInfo } from "../../../src/types/message"

const capabilities = { available: true, ttsConfigured: true, supportsTts: true, supportsStreamingTts: true }
serverApi.fetchSpeechCapabilities = async () => capabilities as any
const pending: Array<{ resolve: (value: Response) => void; signal: AbortSignal }> = []
let resolveCapabilities: (() => void) | undefined
const synthesizeSpeechStream = serverApi.synthesizeSpeechStream
serverApi.synthesizeSpeechStream = (_request, signal) => new Promise(resolve => pending.push({ resolve, signal }))

const audios: FakeAudio[] = [], revoked: string[] = []
let waitForDecoder: Promise<void> | undefined
let decoderReady: (() => void) | undefined
class FakeAudio extends EventTarget {
  src: string
  currentTime = 0
  paused = true
  loads = 0
  constructor(src: string) { super(); this.src = src; audios.push(this) }
  async play() { if (waitForDecoder) await waitForDecoder; this.paused = false }
  pause() { this.paused = true }
  load() { this.loads++ }
}
class FakeMediaSource extends EventTarget {
  readyState = "open"
  static isTypeSupported() { return true }
  addSourceBuffer() {
    const buffer = new EventTarget()
    let appends = 0
    return Object.assign(buffer, {
      appendBuffer: () => queueMicrotask(() => {
        buffer.dispatchEvent(new Event("updateend"))
        if (++appends === 2) decoderReady?.()
      }),
    })
  }
  endOfStream() {}
}
window.Audio = FakeAudio as any
window.MediaSource = FakeMediaSource as any
let urlSequence = 0
URL.createObjectURL = source => {
  if (source instanceof FakeMediaSource) queueMicrotask(() => source.dispatchEvent(new Event("sourceopen")))
  return `blob:speech-${++urlSequence}`
}
URL.revokeObjectURL = url => { revoked.push(url) }

const Providers = (props: any) => <ConfigProvider><I18nProvider><ThemeProvider>{props.children}</ThemeProvider></I18nProvider></ConfigProvider>
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const owners = new Map<string, { speech: ReturnType<typeof useSpeech>; setId: (id: string) => void; replace: () => void; dispose: () => void }>()
function mount(key: string, id: string, mode: "buffered" | "streaming" = "buffered") {
  const root = document.createElement("section")
  document.body.append(root)
  const [record, setRecord] = createSignal({ id, text: "Read this" })
  let speech!: ReturnType<typeof useSpeech>
  function Harness() { speech = useSpeech({ id: () => record().id, text: () => record().text, settingsOverride: () => ({ playbackMode: mode, ttsFormat: "mp3" }) }); return null }
  const dispose = render(() => <Providers><Harness /></Providers>, root)
  owners.set(key, { speech, setId: id => setRecord(record => ({ ...record, id })), replace: () => setRecord(record => ({ ...record, text: `${record.text} updated` })), dispose: () => { dispose(); root.remove() } })
}

function startClassic() {
  const instanceId = "speech-classic", sessionID = "ses_classic", messageID = "msg_classic"
  addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
  setActiveInstanceId(instanceId)
  setSessions(new Map([[instanceId, new Map([[sessionID, { id: sessionID, parentId: null } as Session]])]]))
  setActiveSessionId(new Map([[instanceId, sessionID]]))
  toggleConversationMode(instanceId)
  handleConversationAssistantPartUpdated(instanceId, {
    id: "spoken", type: "text", text: "```spoken\nRead this\n```", sessionID, messageID,
  }, { role: "assistant", id: messageID, sessionID } as MessageInfo)
}

// The real tool card is position-recycled exactly like MessageBlock's Index.
const refs: WeakRef<Element>[] = []
let cycle = 0
async function cards(count: number, drift: boolean) {
  for (let index = 0; index < count; index++) {
    const root = document.createElement("section")
    document.body.append(root)
    const id = `tool-${cycle++}`
    const [rows, setRows] = createSignal([id])
    const part = (id: string): any => ({ id, type: "tool", tool: "read", state: { status: "completed", input: { path: "README.md" }, output: "ok", time: { start: 1, end: 2 } } })
    const dispose = render(() => <Providers><Index each={rows()}>{row => <ToolCall instanceId="speech-instance" sessionId="speech-session" messageId="speech-message" toolCall={part(row())} forceCollapsed />}</Index></Providers>, root)
    await tick()
    const card = root.querySelector(".tool-call")!
    if (!card) throw new Error("Real tool card did not mount")
    refs.push(new WeakRef(card))
    if (drift) {
      setRows([`${id}-replacement`])
      await tick()
      if (root.querySelector(".tool-call") !== card) throw new Error("Index must recycle the existing card")
      if (card.getAttribute("data-part-id") !== `${id}-replacement`) throw new Error("Tool identity did not change")
    }
    dispose()
    root.remove()
  }
}

;(window as any).fixture = {
  mount, cards,
  startClassic,
  classicFailed: () => getToastHistory().some(toast => toast.title === "Conversation playback failed"),
  useRealTransport: () => { serverApi.synthesizeSpeechStream = synthesizeSpeechStream },
  authRequired: () => authRecovery.required() && authRecovery.pairingRequired(),
  holdCapabilities: () => {
    resetSpeechCapabilities()
    serverApi.fetchSpeechCapabilities = () => new Promise(resolve => { resolveCapabilities = () => resolve(capabilities as any) })
  },
  resolveCapabilities: () => resolveCapabilities!(),
  retained: () => refs.filter(ref => ref.deref()).length,
  change: (key: string, id: string) => owners.get(key)!.setId(id),
  replace: (key: string) => owners.get(key)!.replace(),
  remove: (key: string) => { owners.get(key)!.dispose(); owners.delete(key) },
  toggleAfterRemove: (key: string) => {
    const owner = owners.get(key)!
    owner.dispose()
    owners.delete(key)
    return owner.speech.toggle()
  },
  toggle: (key: string) => { void owners.get(key)!.speech.toggle() },
  state: (key: string) => owners.get(key)!.speech.state(),
  resolve: (index: number) => pending[index].resolve(new Response(new Uint8Array([97]), { headers: { "content-type": "audio/mpeg" } })),
  resolveSplit: (index: number) => {
    waitForDecoder = new Promise(resolve => { decoderReady = resolve })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.enqueue(new Uint8Array([2]))
        controller.close()
      },
    })
    pending[index].resolve(new Response(stream, { headers: { "content-type": "audio/mpeg" } }))
  },
  finish: (index: number, event = "ended") => audios[index].dispatchEvent(new Event(event)),
  snapshot: () => ({ pending: pending.length, aborted: pending.map(request => request.signal.aborted), revoked: [...revoked], audios: audios.map(audio => ({ paused: audio.paused, src: audio.src, loads: audio.loads })) }),
}

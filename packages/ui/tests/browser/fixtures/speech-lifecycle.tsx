import { createSignal, Index } from "solid-js"
import { render } from "solid-js/web"
import ToolCall from "../../../src/components/tool-call"
import { useSpeech } from "../../../src/lib/hooks/use-speech"
import { serverApi } from "../../../src/lib/api-client"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { ConfigProvider } from "../../../src/stores/preferences"
import { resetSpeechCapabilities } from "../../../src/stores/speech"

const capabilities = { available: true, ttsConfigured: true, supportsTts: true, supportsStreamingTts: true }
serverApi.fetchSpeechCapabilities = async () => capabilities as any
const pending: Array<{ resolve: (value: any) => void; signal?: AbortSignal }> = []
let resolveCapabilities: (() => void) | undefined
serverApi.synthesizeSpeech = () => new Promise(resolve => pending.push({ resolve }))
serverApi.synthesizeSpeechStream = (_request, signal) => new Promise(resolve => pending.push({ resolve, signal }))

const audios: FakeAudio[] = [], revoked: string[] = []
class FakeAudio extends EventTarget {
  src: string
  currentTime = 0
  paused = true
  loads = 0
  constructor(src: string) { super(); this.src = src; audios.push(this) }
  async play() { this.paused = false }
  pause() { this.paused = true }
  load() { this.loads++ }
}
class FakeMediaSource extends EventTarget {
  static isTypeSupported() { return true }
}
window.Audio = FakeAudio as any
window.MediaSource = FakeMediaSource as any
let urlSequence = 0
URL.createObjectURL = () => `blob:speech-${++urlSequence}`
URL.revokeObjectURL = url => { revoked.push(url) }

const Providers = (props: any) => <ConfigProvider><I18nProvider><ThemeProvider>{props.children}</ThemeProvider></I18nProvider></ConfigProvider>
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const owners = new Map<string, { speech: ReturnType<typeof useSpeech>; setId: (id: string) => void; dispose: () => void }>()
function mount(key: string, id: string, mode: "buffered" | "streaming" = "buffered") {
  const root = document.createElement("section")
  document.body.append(root)
  const [identity, setId] = createSignal(id)
  let speech!: ReturnType<typeof useSpeech>
  function Harness() { speech = useSpeech({ id: identity, text: () => "Read this", settingsOverride: () => ({ playbackMode: mode, ttsFormat: "mp3" }) }); return null }
  const dispose = render(() => <Providers><Harness /></Providers>, root)
  owners.set(key, { speech, setId, dispose: () => { dispose(); root.remove() } })
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
  holdCapabilities: () => {
    resetSpeechCapabilities()
    serverApi.fetchSpeechCapabilities = () => new Promise(resolve => { resolveCapabilities = () => resolve(capabilities as any) })
  },
  resolveCapabilities: () => resolveCapabilities!(),
  retained: () => refs.filter(ref => ref.deref()).length,
  change: (key: string, id: string) => owners.get(key)!.setId(id),
  remove: (key: string) => { owners.get(key)!.dispose(); owners.delete(key) },
  toggle: (key: string) => { void owners.get(key)!.speech.toggle() },
  state: (key: string) => owners.get(key)!.speech.state(),
  stop: (key: string) => owners.get(key)!.speech.stop(),
  resolve: (index: number) => pending[index].resolve(pending[index].signal
    ? new Response(new ReadableStream({ start(controller) { controller.close() } }), { headers: { "content-type": "audio/mpeg" } })
    : { audioBase64: "YQ==", mimeType: "audio/mpeg" }),
  finish: (index: number, event = "ended") => audios[index].dispatchEvent(new Event(event)),
  snapshot: () => ({ pending: pending.length, aborted: pending.map(request => request.signal?.aborted ?? false), revoked: [...revoked], audios: audios.map(audio => ({ paused: audio.paused, src: audio.src, loads: audio.loads })) }),
}

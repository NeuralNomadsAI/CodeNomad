import { createSignal } from "solid-js"
import type { VoiceConversationEngine } from "../../../server/src/api-types"
import { localTransport } from "../lib/backend-transport"
import { serverApi } from "../lib/api-client"
import { generateUUID } from "../lib/client-identity"
import { isDesktopHost, isNativeApplicationWindow } from "../lib/runtime-env"
import { loadSpeechCapabilities, speechCapabilities, speechCapabilitiesError } from "./speech"

const prefix = "codenomad:voice-conversation-engine:"
const browserKey = () => `${prefix}${localTransport.baseUrl ?? window.location.origin}`
const useDesktopEngine = () => isDesktopHost() && isNativeApplicationWindow()
  && speechCapabilities()?.desktopVoiceConversationEngine === true

function parseEngine(value: unknown): VoiceConversationEngine {
  if (value === "gemini-live" || value === "openai-realtime" || value === "classic") return value
  throw new Error("Invalid conversation engine")
}

function readBrowserEngine() {
  try { return parseEngine(localStorage.getItem(browserKey()) ?? "classic") } catch { return "classic" }
}

const [browserEngine, setBrowserEngine] = createSignal(readBrowserEngine())
const [desktopEngine, setDesktopEngine] = createSignal<VoiceConversationEngine>()
const [desktopEngineReadFailed, setDesktopEngineReadFailed] = createSignal(false)
let pending: Promise<void> | undefined
let sequence = 0
const desktopChange = `${prefix}desktop-changed`
if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (event.key === null || event.key === browserKey()) setBrowserEngine(readBrowserEngine())
    if (event.key === desktopChange && useDesktopEngine()) void loadVoiceConversationEngine(true).catch(() => {})
  })
}

export async function loadVoiceConversationEngine(refresh = false) {
  await loadSpeechCapabilities()
  if (useDesktopEngine() && (refresh || !desktopEngine() || desktopEngineReadFailed())) {
    if (!pending || refresh) {
      const revision = ++sequence
      const read = serverApi.getDesktopVoiceConversationEngine().then(({ engine }) => {
        if (revision !== sequence) return
        setDesktopEngine(parseEngine(engine))
        setDesktopEngineReadFailed(false)
      }).catch(error => {
        if (revision === sequence) setDesktopEngineReadFailed(true)
        throw error
      }).finally(() => { if (pending === read) pending = undefined })
      pending = read
    }
    await pending
  }
}

export const voiceConversationEngineLoaded = () =>
  Boolean(speechCapabilities()) && (!useDesktopEngine() || desktopEngine() !== undefined)

export const voiceConversationReadFailed = () =>
  Boolean(speechCapabilitiesError()) || (useDesktopEngine() && desktopEngineReadFailed())

export const voiceConversationEngine = (): VoiceConversationEngine =>
  useDesktopEngine() ? desktopEngine() ?? "classic" : browserEngine()

export async function setVoiceConversationEngine(value: VoiceConversationEngine) {
  const engine = parseEngine(value)
  await loadVoiceConversationEngine()
  if (!speechCapabilities()) throw new Error("Conversation settings unavailable")
  if (useDesktopEngine()) {
    const revision = ++sequence
    const result = await serverApi.setDesktopVoiceConversationEngine(engine)
    if (revision === sequence) setDesktopEngine(parseEngine(result.engine))
    try { localStorage.setItem(desktopChange, generateUUID()) } catch { /* The write is already confirmed. */ }
  } else {
    localStorage.setItem(browserKey(), engine)
    setBrowserEngine(engine)
  }
}

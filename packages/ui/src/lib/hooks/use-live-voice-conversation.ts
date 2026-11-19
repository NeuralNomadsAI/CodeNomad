import { createRenderEffect, createSignal, onCleanup } from "solid-js"
import { liveVoiceTarget, type LiveVoiceEngine } from "../../../../server/src/speech/live-voice-contract"
import { liveVoiceAgent, liveVoiceContext, liveVoiceTargetSession } from "../../stores/live-voice-agent"
import type { FollowUpBehavior } from "../../stores/preferences"
import { speechCapabilities } from "../../stores/speech"
import { voiceConversationEngine, voiceConversationEngineLoaded } from "../../stores/voice-conversation-engine"
import { CODENOMAD_API_BASE } from "../api-base"
import { liveVoiceAudioUnavailable, startLiveVoiceAudio } from "../live-voice-audio"
import { hasLiveVoiceConsent, rememberLiveVoiceConsent } from "../live-voice-consent"
import { openLiveVoiceSession, type LiveVoiceStopReason, type LiveVoiceTranscriptRow } from "../live-voice-session"

export type LiveVoiceUnavailable = "loading" | "noSession" | "missingKey" | "secureContext" | "remoteWebKit" | "device"
export type LiveVoiceState =
  | { phase: "closed" }
  | { phase: "consent" | "starting" | "live"; engine: LiveVoiceEngine }
  | { phase: "ended"; engine: LiveVoiceEngine; reason: LiveVoiceStopReason }

export function useLiveVoiceConversation(options: {
  instanceId: () => string
  sessionId: () => string | undefined
  active: () => boolean
  followUp: () => FollowUpBehavior
  canSend: () => boolean
  composerSending?: () => boolean
}) {
  const [state, setState] = createSignal<LiveVoiceState>({ phase: "closed" })
  const [transcript, setTranscript] = createSignal<readonly LiveVoiceTranscriptRow[]>([])
  const selectedEngine = (): LiveVoiceEngine | undefined => {
    const engine = voiceConversationEngine()
    return engine === "classic" ? undefined : engine
  }
  const target = () => options.active() ? liveVoiceTargetSession(options.instanceId(), options.sessionId()) : undefined
  const server = () => new URL(CODENOMAD_API_BASE ?? window.location.origin).origin
  type Target = NonNullable<ReturnType<typeof target>>
  let owner: { engine: LiveVoiceEngine; key: string; client: Target["instance"]["client"]; server: string } | undefined
  let session: ReturnType<typeof openLiveVoiceSession> | undefined
  function sameTarget(bound: Target | undefined) {
    return !!bound && owner?.key === bound.key && owner.client === bound.instance.client
  }

  function unavailable(): LiveVoiceUnavailable | undefined {
    if (!voiceConversationEngineLoaded()) return "loading"
    const engine = selectedEngine()
    if (!engine) return
    const provider = engine === "gemini-live" ? "geminiLive" : "openaiRealtime"
    if (!speechCapabilities()?.voiceConversation?.[provider]?.configured) return "missingKey"
    if (!target()) return "noSession"
    return liveVoiceAudioUnavailable()
  }

  function dismiss() {
    owner = undefined
    session?.stop()
    session = undefined
    setState({ phase: "closed" })
    setTranscript([])
  }

  function begin(consent: boolean) {
    const engine = selectedEngine()
    const bound = target()
    if (!engine || !bound || unavailable()) return false
    const origin = server()
    if (consent) {
      if (state().phase !== "consent" || owner?.engine !== engine || !sameTarget(bound) || owner.server !== origin) return false
      rememberLiveVoiceConsent(origin, engine)
    } else {
      if (state().phase === "starting" || state().phase === "live") return false
      setTranscript([])
      owner = { engine, key: bound.key, client: bound.instance.client, server: origin }
      if (!hasLiveVoiceConsent(origin, engine)) {
        setState({ phase: "consent", engine })
        return true
      }
    }
    const audience = owner
    const current = () => owner === audience && sameTarget(target()) && selectedEngine() === engine && server() === origin
    setState({ phase: "starting", engine })
    session = openLiveVoiceSession({
      engine, context: liveVoiceContext(bound), current,
      startAudio: startLiveVoiceAudio,
      socket: () => {
        const url = new URL(liveVoiceTarget(engine), origin)
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        return new WebSocket(url)
      },
      execute: liveVoiceAgent(bound, options),
      onReady: () => setState({ phase: "live", engine }),
      onStop: reason => {
        session = undefined
        if (owner !== audience) return
        if (reason === "targetChanged") dismiss()
        else setState({ phase: "ended", engine, reason })
      },
      onTranscript: setTranscript,
    })
    return true
  }

  createRenderEffect(() => {
    const current = target()
    const engine = selectedEngine()
    if (owner && (!sameTarget(current) || owner.engine !== engine || owner.server !== server())) dismiss()
  })
  // In particular, do not retain a consent prompt or transcript across a bfcache restore.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", dismiss)
    onCleanup(() => window.removeEventListener("pagehide", dismiss))
  }
  onCleanup(dismiss)

  return {
    state, transcript, unavailable, dismiss,
    start: () => begin(false),
    acceptConsent: () => begin(true),
    stop: () => session?.stop(),
  }
}

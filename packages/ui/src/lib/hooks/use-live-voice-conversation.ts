import { batch, createRenderEffect, createSignal, onCleanup } from "solid-js"
import { liveVoiceTarget, type LiveVoiceEngine } from "../../../../server/src/speech/live-voice-contract"
import { liveVoiceAgent, liveVoiceContext, liveVoiceTargetSession } from "../../stores/live-voice-agent"
import type { FollowUpBehavior } from "../../stores/preferences"
import { speechCapabilities } from "../../stores/speech"
import { voiceConversationEngine, voiceConversationEngineLoaded, voiceConversationReadFailed } from "../../stores/voice-conversation-engine"
import { localTransport } from "../backend-transport"
import { LOCAL_BACKEND_ID, parseInstanceKey } from "../backend-identity"
import { liveVoiceAudioUnavailable, startLiveVoiceAudio } from "../live-voice-audio"
import { hasLiveVoiceConsent, rememberLiveVoiceConsent } from "../live-voice-consent"
import { openLiveVoiceSession, type LiveVoiceActivity, type LiveVoiceStopReason, type LiveVoiceTranscriptRow } from "../live-voice-session"

export type LiveVoiceUnavailable = "loading" | "capabilitiesError" | "noSession" | "missingKey" | "secureContext" | "remoteWebKit" | "device" | "composerUnavailable"
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
}) {
  const [state, setState] = createSignal<LiveVoiceState>({ phase: "closed" })
  const [transcript, setTranscript] = createSignal<readonly LiveVoiceTranscriptRow[]>([])
  const [activity, setActivity] = createSignal<LiveVoiceActivity>("listening")
  const [canInterrupt, setCanInterrupt] = createSignal(false)
  const [muted, setMuted] = createSignal(false)
  const selectedEngine = (): LiveVoiceEngine | undefined => {
    const engine = voiceConversationEngine()
    return engine === "classic" ? undefined : engine
  }
  const belongsToRendererServer = () => parseInstanceKey(options.instanceId()).backendId === LOCAL_BACKEND_ID
  // The socket belongs to this renderer's server; never send a relayed session to it.
  const target = () => options.active() && belongsToRendererServer()
    ? liveVoiceTargetSession(options.instanceId(), options.sessionId()) : undefined
  const server = () => new URL(localTransport.baseUrl ?? window.location.origin).origin
  const needsConsent = () => {
    const engine = selectedEngine()
    return !!engine && !hasLiveVoiceConsent(server(), engine)
  }
  const engineCurrent = (engine: LiveVoiceEngine) => !voiceConversationEngineLoaded() || selectedEngine() === engine
  type Target = NonNullable<ReturnType<typeof target>>
  let owner: { engine: LiveVoiceEngine; key: string; client: Target["instance"]["client"]; server: string } | undefined
  let session: ReturnType<typeof openLiveVoiceSession> | undefined
  function sameTarget(bound: Target | undefined) {
    return !!bound && owner?.key === bound.key && owner.client === bound.instance.client
  }

  function unavailable(): LiveVoiceUnavailable | undefined {
    if (!belongsToRendererServer()) return "composerUnavailable"
    if (voiceConversationReadFailed()) return "capabilitiesError"
    if (!voiceConversationEngineLoaded()) return "loading"
    const engine = selectedEngine()
    if (!engine) return
    const audioUnavailable = liveVoiceAudioUnavailable()
    if (audioUnavailable) return audioUnavailable
    const provider = engine === "gemini-live" ? "geminiLive" : "openaiRealtime"
    if (!speechCapabilities()?.voiceConversation?.[provider]?.configured) return "missingKey"
    if (!target()) return "noSession"
  }

  function resetActivity() {
    setActivity("listening")
    setCanInterrupt(false)
    setMuted(false)
  }

  function dismiss() {
    owner = undefined
    session?.stop()
    session = undefined
    batch(() => {
      setState({ phase: "closed" })
      setTranscript([])
      resetActivity()
    })
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
    const current = () => owner === audience && sameTarget(target()) && engineCurrent(engine) && server() === origin
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
        if (owner !== audience) return
        session = undefined
        if (reason === "targetChanged") dismiss()
        else batch(() => {
          setState({ phase: "ended", engine, reason })
          resetActivity()
        })
      },
      onTranscript: setTranscript,
      onActivity: (value, interruptible) => batch(() => {
        setActivity(value)
        setCanInterrupt(interruptible)
      }),
    })
    return true
  }

  createRenderEffect(() => {
    const current = target()
    const loaded = voiceConversationEngineLoaded()
    const engine = loaded ? selectedEngine() : undefined
    if (owner && (!sameTarget(current) || (loaded && owner.engine !== engine) || owner.server !== server())) dismiss()
  })
  // In particular, do not retain a consent prompt or transcript across a bfcache restore.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", dismiss)
    onCleanup(() => window.removeEventListener("pagehide", dismiss))
  }
  onCleanup(dismiss)

  return {
    state, transcript, unavailable, needsConsent, dismiss, activity, canInterrupt, muted,
    start: () => begin(false),
    acceptConsent: () => begin(true),
    stop: () => session?.stop(),
    interrupt: () => session?.interrupt(),
    activityLevel: () => session?.activityLevel() ?? 0,
    toggleMute() {
      const next = !muted()
      if (session?.setMuted(next)) setMuted(next)
    },
  }
}

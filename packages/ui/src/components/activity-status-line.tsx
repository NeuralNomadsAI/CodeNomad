import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import { getSessionInfo, sessions } from "../stores/session-state"
import { isSessionBusy, getSessionStatus } from "../stores/session-status"
import { getActiveQuestion } from "../stores/question-store"
import { getRandomLoadingVerb } from "../lib/loading-verbs"
import { getRandomPenguinFact } from "../lib/penguin-facts"
import { getStreamingMetrics, sampleCurrentRate, getRollingTokPerSec } from "../stores/streaming-metrics"

interface ActivityStatusLineProps {
  instanceId: string
  sessionId: string
  store: () => InstanceMessageStore
}

type ActivityDisplayMode = "idle" | "working" | "waiting-question" | "waiting-permission" | "compacting"

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs}s`
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export default function ActivityStatusLine(props: ActivityStatusLineProps) {
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0)
  const [loadingVerb, setLoadingVerb] = createSignal(getRandomLoadingVerb())
  const [penguinFact, setPenguinFact] = createSignal(getRandomPenguinFact())

  const busy = () => isSessionBusy(props.instanceId, props.sessionId)

  const sessionInfo = () => getSessionInfo(props.instanceId, props.sessionId)

  const displayMode = createMemo<ActivityDisplayMode>(() => {
    if (!busy()) return "idle"

    const activeQuestion = getActiveQuestion(props.instanceId, props.sessionId)
    if (activeQuestion) return "waiting-question"

    const instanceSessions = sessions().get(props.instanceId)
    const session = instanceSessions?.get(props.sessionId)
    if (session?.pendingPermission) return "waiting-permission"

    const status = getSessionStatus(props.instanceId, props.sessionId)
    if (status === "compacting") return "compacting"

    return "working"
  })

  const isActivelyWorking = () => displayMode() === "working" || displayMode() === "compacting"
  const isWaiting = () => displayMode() === "waiting-question" || displayMode() === "waiting-permission"
  const isIdle = () => displayMode() === "idle"

  const cost = () => {
    const info = sessionInfo()
    return info?.cost ?? 0
  }

  const metrics = () => getStreamingMetrics(props.instanceId, props.sessionId)

  const tokenBreakdown = createMemo(() => {
    const info = sessionInfo()
    if (!info) return null
    const inTok = info.inputTokens || 0
    const outTok = info.outputTokens || 0
    const m = metrics()
    // During streaming, add the live estimate to cumulative completed output
    const isStreaming = Boolean(m && !m.completedOutputTokens && m.estimatedOutputTokens > 0)
    const displayOut = isStreaming ? outTok + m!.estimatedOutputTokens : outTok
    if (inTok === 0 && displayOut === 0) return null
    return { in: inTok, out: displayOut, isEstimate: isStreaming }
  })

  const ttft = createMemo(() => {
    const m = metrics()
    if (!m || !m.requestSentAt || !m.firstTokenAt) return null
    return (m.firstTokenAt - m.requestSentAt) / 1000
  })

  // Tick counter for live tok/s refresh during streaming
  const [tickCount, setTickCount] = createSignal(0)

  createEffect(() => {
    if (!isActivelyWorking()) return
    const id = setInterval(() => {
      setTickCount((n) => n + 1)
      sampleCurrentRate(props.instanceId, props.sessionId)
    }, 3000)
    onCleanup(() => clearInterval(id))
  })

  const tokensPerSec = createMemo(() => {
    tickCount()
    return getRollingTokPerSec(props.instanceId, props.sessionId)
  })

  // Elapsed timer — resets when session becomes busy, counts up every second
  createEffect(() => {
    if (!busy() || !isActivelyWorking()) return

    setElapsedSeconds(0)
    const id = setInterval(() => setElapsedSeconds((s) => s + 1), 1000)
    onCleanup(() => clearInterval(id))
  })

  // Rotating loading verb — only while actively working
  createEffect(() => {
    if (!busy() || !isActivelyWorking()) return

    setLoadingVerb(getRandomLoadingVerb())
    const id = setInterval(() => setLoadingVerb(getRandomLoadingVerb()), 10000)
    onCleanup(() => clearInterval(id))
  })

  // Rotating penguin fact — only while actively working
  createEffect(() => {
    if (!busy() || !isActivelyWorking()) return

    setPenguinFact(getRandomPenguinFact())
    const id = setInterval(() => setPenguinFact(getRandomPenguinFact()), 8000)
    onCleanup(() => clearInterval(id))
  })

  // Verb text depends on display mode
  const verbText = createMemo(() => {
    const mode = displayMode()
    if (mode === "idle") return "Ready"
    if (mode === "waiting-question") return "Waiting for input"
    if (mode === "waiting-permission") return "Permission required"
    if (mode === "compacting") return "Compacting..."
    return `${loadingVerb()}...`
  })

  const showPenguinFact = () => isActivelyWorking()

  // CSS modifier class for the status bar state
  const stateClass = () => {
    const mode = displayMode()
    if (mode === "idle") return "activity-status-line--idle"
    if (mode === "waiting-question" || mode === "waiting-permission") return "activity-status-line--waiting"
    if (mode === "compacting") return "activity-status-line--compacting"
    return "activity-status-line--working"
  }

  return (
    <div class={`activity-status-line ${stateClass()}`}>
      <div class="activity-status-main">
        <span class={`activity-status-dot activity-status-dot--${displayMode()}`} />
        <span class="activity-status-verb">{verbText()}</span>
        <Show when={isActivelyWorking()}>
          <span class="activity-status-elapsed">{formatElapsed(elapsedSeconds())}</span>
        </Show>
        <Show when={tokenBreakdown()}>
          <span class="activity-status-separator">|</span>
          <span class="activity-status-tokens">
            <span class="activity-metric-in">↑ {formatTokenCount(tokenBreakdown()!.in)}</span>
            {" "}
            <span class="activity-metric-out">↓ {tokenBreakdown()!.isEstimate ? "~" : ""}{formatTokenCount(tokenBreakdown()!.out)}</span>
          </span>
        </Show>
        <Show when={!isActivelyWorking() && ttft() !== null}>
          <span class="activity-status-separator">|</span>
          <span class="activity-status-ttft">TTFT {ttft()!.toFixed(1)}s</span>
        </Show>
        <Show when={tokensPerSec() !== null}>
          <span class="activity-status-separator">|</span>
          <span class="activity-status-tps">{tokensPerSec()} tok/s</span>
        </Show>
        <Show when={cost() > 0}>
          <span class="activity-status-separator">|</span>
          <span class="activity-status-cost">${cost().toFixed(4)}</span>
        </Show>
      </div>
      <Show when={showPenguinFact()}>
        <div class="activity-status-fact">
          <span class="activity-status-fact-icon">&gt;</span>
          <span>{penguinFact()}</span>
        </div>
      </Show>
    </div>
  )
}

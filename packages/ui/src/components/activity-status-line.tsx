import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import { getSessionInfo, sessions } from "../stores/session-state"
import { isSessionBusy, getSessionStatus } from "../stores/session-status"
import { getActiveQuestion } from "../stores/question-store"
import { getRandomLoadingVerb } from "../lib/loading-verbs"
import { getRandomPenguinFact } from "../lib/penguin-facts"
import { getStreamingMetrics, sampleCurrentRate, getRollingTokPerSec } from "../stores/streaming-metrics"
import { showToastNotification } from "../lib/notifications"
import { cn } from "../lib/cn"

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

  // Context pressure warning — fires once per session when crossing 70%
  const [pressureWarningFired, setPressureWarningFired] = createSignal(false)

  const contextPercentage = createMemo(() => {
    const info = sessionInfo()
    if (!info || !info.contextWindow) return 0
    const used = (info.inputTokens || 0) + (info.outputTokens || 0)
    return Math.min((used / info.contextWindow) * 100, 100)
  })

  createEffect(() => {
    const pct = contextPercentage()
    if (pct >= 70 && !pressureWarningFired()) {
      setPressureWarningFired(true)
      const rounded = Math.round(pct)
      showToastNotification({
        title: "Context window filling",
        message: `Context at ${rounded}% \u2014 consider compacting or starting a new session.`,
        variant: rounded >= 85 ? "error" : "warning",
        duration: 6000,
      })
    }
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

  // Dot color class based on display mode
  const dotClass = () => {
    const mode = displayMode()
    if (mode === "idle") return "bg-muted-foreground opacity-70"
    if (mode === "working") return "bg-info animate-activity-dot-pulse"
    if (mode === "compacting") return "bg-violet-500 animate-activity-dot-pulse"
    // waiting-question or waiting-permission
    return "bg-warning"
  }

  // Verb color class based on display mode
  const verbColorClass = () => {
    const mode = displayMode()
    if (mode === "idle") return "text-muted-foreground"
    if (mode === "working") return "text-info"
    if (mode === "compacting") return "text-violet-400"
    if (mode === "waiting-question" || mode === "waiting-permission") return "text-warning"
    return "text-muted-foreground"
  }

  return (
    <div class="shrink-0 border-t border-border px-3 py-1.5 bg-background max-sm:px-2 max-sm:py-1">
      <div class="flex items-center gap-2 text-sm text-muted-foreground max-sm:flex-wrap max-sm:gap-x-2 max-sm:gap-y-1">
        <span class={cn("size-2 rounded-full shrink-0", dotClass())} />
        <span class={cn("font-medium", verbColorClass())}>{verbText()}</span>
        <Show when={isActivelyWorking()}>
          <span class="text-muted-foreground tabular-nums">{formatElapsed(elapsedSeconds())}</span>
        </Show>
        <Show when={tokenBreakdown()}>
          <span class="text-border">|</span>
          <span class="text-muted-foreground tabular-nums">
            <span class="text-muted-foreground">
              {"\u2191 "}{formatTokenCount(tokenBreakdown()!.in)}
            </span>
            {" "}
            <span class={cn(
              "text-muted-foreground",
              displayMode() === "working" && "text-info"
            )}>
              {"\u2193 "}{tokenBreakdown()!.isEstimate ? "~" : ""}{formatTokenCount(tokenBreakdown()!.out)}
            </span>
          </span>
        </Show>
        <Show when={!isActivelyWorking() && ttft() !== null}>
          <span class="text-border">|</span>
          <span class="text-muted-foreground tabular-nums">TTFT {ttft()!.toFixed(1)}s</span>
        </Show>
        <Show when={tokensPerSec() !== null}>
          <span class="text-border">|</span>
          <span class={cn(
            "text-muted-foreground tabular-nums",
            displayMode() === "working" && "text-info"
          )}>{tokensPerSec()} tok/s</span>
        </Show>
        <Show when={cost() > 0}>
          <span class="text-border">|</span>
          <span class="text-muted-foreground tabular-nums">${cost().toFixed(4)}</span>
        </Show>
        <Show when={contextPercentage() > 0}>
          <span class="text-border md:hidden">|</span>
          <span class={cn(
            "tabular-nums md:hidden",
            contextPercentage() >= 85 ? "text-destructive font-medium" : contextPercentage() >= 70 ? "text-warning" : "text-muted-foreground"
          )}>
            ctx {Math.round(contextPercentage())}%
          </span>
        </Show>
      </div>
      <Show when={showPenguinFact()}>
        <div class="flex items-baseline gap-1.5 text-xs text-muted-foreground pl-5 pt-0.5 animate-activity-fact-fade max-sm:pl-4">
          <span class="text-muted-foreground font-semibold shrink-0">&gt;</span>
          <span>{penguinFact()}</span>
        </div>
      </Show>
    </div>
  )
}

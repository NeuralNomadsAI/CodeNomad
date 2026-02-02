import { Component, Show, createSignal } from "solid-js"
import {
  RefreshCw,
  RotateCcw,
  Zap,
  AlertCircle,
  CheckCircle,
  Loader2,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Separator } from "./ui"

const log = getLogger("session-retry-panel")

interface SessionError {
  type: "api_error" | "timeout" | "rate_limit" | "context_overflow" | "model_unavailable" | "unknown"
  message: string
  timestamp: string
  lastCheckpoint?: string
  sessionId: string
  contextTokens?: number
  maxTokens?: number
}

interface SessionRetryPanelProps {
  error?: SessionError
  onResume?: (sessionId: string) => void | Promise<void>
  onStartFresh?: () => void
}

type RetryState = "error" | "resuming" | "resumed" | "resume-failed" | "starting-fresh"

const ERROR_LABELS: Record<string, string> = {
  api_error: "API Error",
  timeout: "Timeout",
  rate_limit: "Rate Limited",
  context_overflow: "Context Overflow",
  model_unavailable: "Model Unavailable",
  unknown: "Unknown Error",
}

const SessionRetryPanel: Component<SessionRetryPanelProps> = (props) => {
  const [state, setState] = createSignal<RetryState>("error")

  const tokenSavings = () => {
    if (!props.error?.contextTokens || !props.error?.maxTokens) return null
    const preserved = props.error.contextTokens
    const savings = Math.round((preserved / props.error.maxTokens) * 100)
    return { percent: Math.min(savings, 70), tokens: preserved }
  }

  const handleResume = async () => {
    if (!props.error || !props.onResume) return
    setState("resuming")
    try {
      await props.onResume(props.error.sessionId)
      setState("resumed")
    } catch {
      setState("resume-failed")
      log.warn("Resume failed, falling back to start fresh")
    }
  }

  const handleStartFresh = () => {
    setState("starting-fresh")
    props.onStartFresh?.()
  }

  return (
    <Show when={props.error}>
      <Card class="border-destructive/30">
        <CardHeader class="pb-2">
          <CardTitle class="flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertCircle class="h-4 w-4" />
            Session Error
          </CardTitle>
        </CardHeader>

        <CardContent class="flex flex-col gap-3 pt-0">
          {/* Error Info */}
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center gap-2">
              <Badge class="bg-destructive/10 text-destructive text-[10px]">
                {ERROR_LABELS[props.error!.type] ?? "Error"}
              </Badge>
              <span class="text-[10px] text-muted-foreground">
                {new Date(props.error!.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <p class="text-xs text-foreground">{props.error!.message}</p>
            <Show when={props.error!.lastCheckpoint}>
              <p class="text-[10px] text-muted-foreground">
                Last checkpoint: {props.error!.lastCheckpoint}
              </p>
            </Show>
          </div>

          <Separator />

          {/* Actions */}
          <Show when={state() === "error" || state() === "resume-failed"}>
            <div class="flex flex-col gap-2">
              <Show when={state() === "resume-failed"}>
                <p class="text-[10px] text-warning">
                  Resume failed. You can try starting a fresh session instead.
                </p>
              </Show>

              <Button
                size="sm"
                onClick={handleResume}
                disabled={!props.onResume}
                class="justify-start"
              >
                <RotateCcw class="mr-2 h-3.5 w-3.5" />
                Resume Session
                <Show when={tokenSavings()}>
                  <Badge class="ml-2 bg-success/10 text-success text-[9px]">
                    ~{tokenSavings()!.percent}% token savings
                  </Badge>
                </Show>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleStartFresh}
                disabled={!props.onStartFresh}
                class="justify-start"
              >
                <RefreshCw class="mr-2 h-3.5 w-3.5" />
                Start Fresh
              </Button>

              <Show when={tokenSavings()}>
                <p class="text-[10px] text-muted-foreground">
                  Estimated savings based on {tokenSavings()!.tokens.toLocaleString()} preserved context tokens.
                </p>
              </Show>
            </div>
          </Show>

          <Show when={state() === "resuming"}>
            <div class="flex items-center gap-2 text-xs text-primary">
              <Loader2 class="h-4 w-4 animate-spin" />
              Resuming session...
            </div>
          </Show>

          <Show when={state() === "resumed"}>
            <div class="flex items-center gap-2 text-xs text-success">
              <CheckCircle class="h-4 w-4" />
              Session resumed successfully
            </div>
          </Show>

          <Show when={state() === "starting-fresh"}>
            <div class="flex items-center gap-2 text-xs text-primary">
              <Loader2 class="h-4 w-4 animate-spin" />
              Creating new session...
            </div>
          </Show>
        </CardContent>
      </Card>
    </Show>
  )
}

export default SessionRetryPanel

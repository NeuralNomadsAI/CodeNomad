import { Component, For, Show, createSignal, createResource, createMemo } from "solid-js"
import {
  Circle,
  Loader2,
  Play,
  Wrench,
  AlertTriangle,
  CheckCircle,
  StopCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Zap,
  Clock,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Separator } from "./ui"

const log = getLogger("agent-lifecycle-panel")

type AgentVisualState = "idle" | "spawning" | "running" | "working" | "stuck" | "done" | "stopped" | "dead"

interface AgentLifecycleEntry {
  id: string
  name: string
  model: string
  state: AgentVisualState
  currentTask?: string
  currentOperation?: string
  lastActive?: string
  stuckSinceMs?: number
  errorMessage?: string
  stopReason?: string
  taskSummary?: string
  sessionId?: string
  tokensUsed?: number
  transitions?: Array<{ from: string; to: string; trigger: string; timestamp: string }>
}

interface AgentLifecyclePanelProps {
  folder?: string
  compact?: boolean
  onIntervene?: (agentId: string) => void
  onRestart?: (agentId: string) => void
}

const STATE_CONFIG = {
  idle: { icon: Circle, color: "text-muted-foreground", bg: "bg-muted/30", label: "Idle" },
  spawning: { icon: Loader2, color: "text-primary", bg: "bg-primary/10", label: "Spawning", animate: "animate-pulse" },
  running: { icon: Play, color: "text-primary", bg: "bg-primary/10", label: "Running" },
  working: { icon: Wrench, color: "text-success", bg: "bg-success/10", label: "Working" },
  stuck: { icon: AlertTriangle, color: "text-warning", bg: "bg-warning/10", label: "Stuck" },
  done: { icon: CheckCircle, color: "text-success", bg: "bg-success/10", label: "Done" },
  stopped: { icon: StopCircle, color: "text-muted-foreground", bg: "bg-muted/30", label: "Stopped" },
  dead: { icon: XCircle, color: "text-destructive", bg: "bg-destructive/10", label: "Dead" },
} as const

const AgentLifecyclePanel: Component<AgentLifecyclePanelProps> = (props) => {
  const [expandedAgent, setExpandedAgent] = createSignal<string | null>(null)

  const fetchAgents = async (folder: string | undefined): Promise<AgentLifecycleEntry[]> => {
    try {
      const resp = await fetch("/api/era/agents/lifecycle")
      if (!resp.ok) return []
      const data = await resp.json()
      return data.agents ?? []
    } catch (err) {
      log.error("Failed to fetch agent lifecycle:", err)
      return []
    }
  }

  const [agents] = createResource(() => props.folder, fetchAgents)

  const formatRelativeTime = (ts?: string) => {
    if (!ts) return ""
    const ms = Date.now() - new Date(ts).getTime()
    if (ms < 60000) return "just now"
    if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`
    return `${Math.round(ms / 3600000)}h ago`
  }

  const formatMs = (ms: number) => {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`
    return `${Math.round(ms / 60000)}m`
  }

  return (
    <Card class="flex flex-col gap-0">
      <CardHeader class="flex flex-row items-center justify-between pb-2">
        <CardTitle class="flex items-center gap-2 text-sm font-semibold">
          <Play class="h-4 w-4 text-primary" />
          Agent Lifecycle
        </CardTitle>
        <Badge class="text-[10px]">
          {(agents() ?? []).length} agents
        </Badge>
      </CardHeader>

      <CardContent class="flex flex-col gap-1.5 pt-0">
        <Show
          when={!agents.loading && (agents() ?? []).length > 0}
          fallback={
            <p class="text-xs text-muted-foreground">
              {agents.loading ? "Loading..." : "No agents."}
            </p>
          }
        >
          <For each={agents() ?? []}>
            {(agent) => {
              const config = STATE_CONFIG[agent.state]
              const Icon = config.icon
              const isExpanded = () => expandedAgent() === agent.id

              return (
                <div class={cn("rounded-md border", config.bg, agent.state === "stuck" ? "border-warning/30" : "border-border")}>
                  <button
                    class="flex w-full items-center gap-2 p-2 text-left"
                    onClick={() => setExpandedAgent(isExpanded() ? null : agent.id)}
                  >
                    <Icon class={cn(
                      "h-4 w-4 shrink-0",
                      config.color,
                      "animate" in config && config.animate
                    )} />
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-1.5">
                        <span class="text-xs font-medium truncate">{agent.name}</span>
                        <Badge class={cn("text-[9px] px-1 py-0", config.bg, config.color)}>
                          {config.label}
                        </Badge>
                      </div>
                      <Show when={agent.currentTask}>
                        <p class="text-[10px] text-muted-foreground truncate">{agent.currentTask}</p>
                      </Show>
                      <Show when={agent.currentOperation}>
                        <p class="text-[10px] text-muted-foreground truncate">{agent.currentOperation}</p>
                      </Show>
                      <Show when={agent.taskSummary}>
                        <p class="text-[10px] text-muted-foreground truncate">{agent.taskSummary}</p>
                      </Show>
                      <Show when={agent.errorMessage}>
                        <p class="text-[10px] text-destructive truncate">{agent.errorMessage}</p>
                      </Show>
                      <Show when={agent.stopReason}>
                        <p class="text-[10px] text-muted-foreground truncate">{agent.stopReason}</p>
                      </Show>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <Show when={agent.lastActive}>
                        <span class="text-[10px] text-muted-foreground flex items-center gap-0.5">
                          <Clock class="h-2.5 w-2.5" />
                          {formatRelativeTime(agent.lastActive)}
                        </span>
                      </Show>
                      <Show when={agent.stuckSinceMs !== undefined}>
                        <span class="text-[10px] text-warning">
                          {formatMs(agent.stuckSinceMs!)} stuck
                        </span>
                      </Show>
                      {isExpanded() ? (
                        <ChevronDown class="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight class="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                  </button>

                  <Show when={isExpanded()}>
                    <div class="px-8 pb-2 flex flex-col gap-1.5">
                      <Separator />
                      <div class="grid grid-cols-2 gap-1 text-[10px]">
                        <span class="text-muted-foreground">Model:</span>
                        <span>{agent.model}</span>
                        <Show when={agent.sessionId}>
                          <span class="text-muted-foreground">Session:</span>
                          <span class="font-mono truncate">{agent.sessionId}</span>
                        </Show>
                        <Show when={agent.tokensUsed !== undefined}>
                          <span class="text-muted-foreground">Tokens:</span>
                          <span>{agent.tokensUsed!.toLocaleString()}</span>
                        </Show>
                      </div>

                      <Show when={agent.transitions && agent.transitions.length > 0}>
                        <Separator />
                        <span class="text-[10px] font-medium text-muted-foreground">Transition History</span>
                        <div class="flex flex-col gap-0.5">
                          <For each={agent.transitions!.slice(-5)}>
                            {(t) => (
                              <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                                <span>{t.from}</span>
                                <span>→</span>
                                <span>{t.to}</span>
                                <span class="text-[9px]">({t.trigger})</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>

                      {/* Action Buttons */}
                      <div class="flex gap-2 mt-1">
                        <Show when={agent.state === "stuck" && props.onIntervene}>
                          <Button
                            size="sm"
                            variant="outline"
                            class="h-6 text-[10px] text-warning border-warning/30"
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onIntervene?.(agent.id)
                            }}
                          >
                            <Zap class="mr-1 h-3 w-3" />
                            Intervene
                          </Button>
                        </Show>
                        <Show when={agent.state === "dead" && props.onRestart}>
                          <Button
                            size="sm"
                            variant="outline"
                            class="h-6 text-[10px] text-destructive border-destructive/30"
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onRestart?.(agent.id)
                            }}
                          >
                            <RotateCcw class="mr-1 h-3 w-3" />
                            Restart
                          </Button>
                        </Show>
                      </div>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
      </CardContent>
    </Card>
  )
}

export default AgentLifecyclePanel

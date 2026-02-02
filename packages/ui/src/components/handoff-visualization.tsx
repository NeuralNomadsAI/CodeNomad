import { Component, For, Show, createSignal, createResource, createMemo } from "solid-js"
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Hash,
  Clock,
  FileText,
  Zap,
  Activity,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Separator } from "./ui"

const log = getLogger("handoff-visualization")

interface HandoffEntry {
  id: string
  fromSessionId: string
  toSessionId?: string
  timestamp: string
  contextUsage: number
  reason: "context_exhaustion" | "error" | "manual"
  workSummary: string
  completedTasks: string[]
  pendingTasks: string[]
  keyDecisions: string[]
  filesModified: string[]
}

interface HandoffChainNode {
  sessionId: string
  duration?: number
  tokensUsed?: number
  progress?: string
}

interface HandoffVisualizationProps {
  sessionId?: string
  folder?: string
  compact?: boolean
  onNavigateSession?: (sessionId: string) => void
}

const REASON_CONFIG = {
  context_exhaustion: { label: "Context Full", color: "text-warning", bg: "bg-warning/10" },
  error: { label: "Error", color: "text-destructive", bg: "bg-destructive/10" },
  manual: { label: "Manual", color: "text-primary", bg: "bg-primary/10" },
} as const

const HandoffVisualization: Component<HandoffVisualizationProps> = (props) => {
  const [expandedHandoff, setExpandedHandoff] = createSignal<string | null>(null)

  const fetchHandoffs = async (sessionId: string | undefined): Promise<{ handoffs: HandoffEntry[]; chain: HandoffChainNode[] }> => {
    try {
      const params = new URLSearchParams()
      if (sessionId) params.set("sessionId", sessionId)
      const resp = await fetch(`/api/era/handoffs?${params}`)
      if (!resp.ok) return { handoffs: [], chain: [] }
      const data = await resp.json()
      return { handoffs: data.handoffs ?? [], chain: data.chain ?? [] }
    } catch (err) {
      log.error("Failed to fetch handoffs:", err)
      return { handoffs: [], chain: [] }
    }
  }

  const [data] = createResource(() => props.sessionId, fetchHandoffs)

  const chainStats = createMemo(() => {
    const chain = data()?.chain ?? []
    if (chain.length === 0) return null
    const totalTokens = chain.reduce((sum, n) => sum + (n.tokensUsed ?? 0), 0)
    const totalDuration = chain.reduce((sum, n) => sum + (n.duration ?? 0), 0)
    return {
      sessions: chain.length,
      totalTokens,
      totalDuration,
      handoffs: (data()?.handoffs ?? []).length,
    }
  })

  const formatDuration = (ms: number) => {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`
    return `${(ms / 3600000).toFixed(1)}h`
  }

  return (
    <Card class="flex flex-col gap-0">
      <CardHeader class="flex flex-row items-center justify-between pb-2">
        <CardTitle class="flex items-center gap-2 text-sm font-semibold">
          <ArrowRightLeft class="h-4 w-4 text-primary" />
          Session Handoffs
        </CardTitle>
        <Show when={chainStats()}>
          <Badge class="text-[10px]">
            {chainStats()!.sessions} sessions, {chainStats()!.handoffs} handoffs
          </Badge>
        </Show>
      </CardHeader>

      <CardContent class="flex flex-col gap-3 pt-0">
        <Show
          when={!data.loading && (data()?.handoffs ?? []).length > 0}
          fallback={
            <p class="text-xs text-muted-foreground">
              {data.loading ? "Loading..." : "No handoffs in this session."}
            </p>
          }
        >
          {/* Chain Statistics */}
          <Show when={chainStats()}>
            <div class="grid grid-cols-4 gap-2 text-center">
              <div class="flex flex-col">
                <span class="text-lg font-semibold">{chainStats()!.sessions}</span>
                <span class="text-[10px] text-muted-foreground">Sessions</span>
              </div>
              <div class="flex flex-col">
                <span class="text-lg font-semibold">{chainStats()!.handoffs}</span>
                <span class="text-[10px] text-muted-foreground">Handoffs</span>
              </div>
              <div class="flex flex-col">
                <span class="text-lg font-semibold">{chainStats()!.totalTokens > 0 ? `${Math.round(chainStats()!.totalTokens / 1000)}k` : "—"}</span>
                <span class="text-[10px] text-muted-foreground">Tokens</span>
              </div>
              <div class="flex flex-col">
                <span class="text-lg font-semibold">{chainStats()!.totalDuration > 0 ? formatDuration(chainStats()!.totalDuration) : "—"}</span>
                <span class="text-[10px] text-muted-foreground">Duration</span>
              </div>
            </div>

            <Separator />
          </Show>

          {/* Chain Timeline */}
          <Show when={(data()?.chain ?? []).length > 0}>
            <div class="flex items-center gap-1 overflow-x-auto py-1">
              <For each={data()!.chain}>
                {(node, idx) => (
                  <>
                    <Show when={idx() > 0}>
                      <div class="flex flex-col items-center">
                        <ArrowRightLeft class="h-3 w-3 text-primary" />
                      </div>
                    </Show>
                    <button
                      class="flex flex-col items-center gap-0.5 rounded-md border border-border px-2 py-1 hover:bg-muted/50 transition-colors shrink-0"
                      onClick={() => props.onNavigateSession?.(node.sessionId)}
                    >
                      <span class="text-[10px] font-mono">{node.sessionId.slice(0, 8)}</span>
                      <Show when={node.tokensUsed}>
                        <span class="text-[9px] text-muted-foreground">{Math.round((node.tokensUsed ?? 0) / 1000)}k tok</span>
                      </Show>
                    </button>
                  </>
                )}
              </For>
            </div>

            <Separator />
          </Show>

          {/* Handoff List */}
          <For each={data()!.handoffs}>
            {(handoff) => {
              const config = REASON_CONFIG[handoff.reason]
              const isExpanded = () => expandedHandoff() === handoff.id

              return (
                <div class="rounded-md border border-border">
                  {/* Baton Pass Marker */}
                  <button
                    class="flex w-full items-center gap-2 p-2 text-left hover:bg-muted/30 transition-colors"
                    onClick={() => setExpandedHandoff(isExpanded() ? null : handoff.id)}
                  >
                    <div class="flex items-center gap-1 text-primary">
                      <ArrowRightLeft class="h-4 w-4" />
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-1.5">
                        <span class="text-[10px] font-mono text-muted-foreground">
                          {handoff.fromSessionId.slice(0, 8)}
                        </span>
                        <span class="text-[10px] text-muted-foreground">→</span>
                        <span class="text-[10px] font-mono text-muted-foreground">
                          {handoff.toSessionId?.slice(0, 8) ?? "pending"}
                        </span>
                      </div>
                      <div class="flex items-center gap-2 mt-0.5">
                        <Badge class={cn("text-[9px] px-1 py-0", config.bg, config.color)}>
                          {config.label}
                        </Badge>
                        <span class="text-[10px] text-muted-foreground">
                          {Math.round(handoff.contextUsage * 100)}% context
                        </span>
                      </div>
                    </div>
                    <span class="text-[10px] text-muted-foreground shrink-0">
                      {new Date(handoff.timestamp).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}
                    </span>
                    {isExpanded() ? (
                      <ChevronDown class="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight class="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>

                  {/* Context Summary */}
                  <Show when={isExpanded()}>
                    <div class="px-3 pb-2 flex flex-col gap-1.5 border-t border-border pt-1.5">
                      <p class="text-xs">{handoff.workSummary}</p>

                      <Show when={handoff.completedTasks.length > 0}>
                        <div class="flex flex-col gap-0.5">
                          <span class="text-[10px] font-medium text-muted-foreground">Completed</span>
                          <For each={handoff.completedTasks}>
                            {(task) => (
                              <span class="text-[10px] text-success flex items-center gap-1">✓ {task}</span>
                            )}
                          </For>
                        </div>
                      </Show>

                      <Show when={handoff.pendingTasks.length > 0}>
                        <div class="flex flex-col gap-0.5">
                          <span class="text-[10px] font-medium text-muted-foreground">Remaining</span>
                          <For each={handoff.pendingTasks}>
                            {(task) => (
                              <span class="text-[10px] text-foreground flex items-center gap-1">○ {task}</span>
                            )}
                          </For>
                        </div>
                      </Show>

                      <Show when={handoff.keyDecisions.length > 0}>
                        <div class="flex flex-col gap-0.5">
                          <span class="text-[10px] font-medium text-muted-foreground">Key Decisions</span>
                          <For each={handoff.keyDecisions}>
                            {(d) => <span class="text-[10px] text-muted-foreground">• {d}</span>}
                          </For>
                        </div>
                      </Show>

                      <Show when={handoff.filesModified.length > 0}>
                        <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <FileText class="h-3 w-3" />
                          {handoff.filesModified.length} files modified
                        </div>
                      </Show>
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

export default HandoffVisualization

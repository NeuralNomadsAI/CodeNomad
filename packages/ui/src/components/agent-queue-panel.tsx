import { Component, For, Show, createSignal, createResource, createMemo } from "solid-js"
import {
  Loader2,
  Clock,
  AlertTriangle,
  Cpu,
  Hash,
  Zap,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Separator } from "./ui"

const log = getLogger("agent-queue-panel")

interface QueuedAgent {
  id: string
  name: string
  model: string
  status: "running" | "queued" | "stale"
  position?: number
  currentTask?: string
  tokensUsed?: number
  elapsedMs?: number
  lastActivity?: string
  staleDurationMs?: number
}

interface AgentQueuePanelProps {
  folder?: string
  compact?: boolean
}

const STATUS_CONFIG = {
  running: { color: "text-primary", bg: "bg-primary/10", border: "border-primary/20", label: "Running" },
  queued: { color: "text-muted-foreground", bg: "bg-muted/50", border: "border-border", label: "Queued" },
  stale: { color: "text-warning", bg: "bg-warning/10", border: "border-warning/20", label: "Stale" },
} as const

const AgentQueuePanel: Component<AgentQueuePanelProps> = (props) => {
  const fetchQueue = async (folder: string | undefined): Promise<QueuedAgent[]> => {
    try {
      const resp = await fetch("/api/era/agents/queue")
      if (!resp.ok) return []
      const data = await resp.json()
      return data.agents ?? []
    } catch (err) {
      log.error("Failed to fetch agent queue:", err)
      return []
    }
  }

  const [agents] = createResource(() => props.folder, fetchQueue)

  const grouped = createMemo(() => {
    const all = agents() ?? []
    return {
      running: all.filter((a) => a.status === "running"),
      queued: all.filter((a) => a.status === "queued"),
      stale: all.filter((a) => a.status === "stale"),
    }
  })

  const formatTime = (ms: number) => {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`
    return `${Math.round(ms / 3600000)}h`
  }

  return (
    <Card class="flex flex-col gap-0">
      <CardHeader class="flex flex-row items-center justify-between pb-2">
        <CardTitle class="flex items-center gap-2 text-sm font-semibold">
          <Cpu class="h-4 w-4 text-primary" />
          Agent Queue
        </CardTitle>
        <Badge class="text-[10px]">
          {(agents() ?? []).length} total
        </Badge>
      </CardHeader>

      <CardContent class="flex flex-col gap-2 pt-0">
        <Show
          when={!agents.loading && (agents() ?? []).length > 0}
          fallback={
            <p class="text-xs text-muted-foreground">
              {agents.loading ? "Loading..." : "No agents in queue."}
            </p>
          }
        >
          <For each={["running", "queued", "stale"] as const}>
            {(status) => (
              <Show when={grouped()[status].length > 0}>
                <div class="flex flex-col gap-1">
                  <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {STATUS_CONFIG[status].label} ({grouped()[status].length})
                  </span>
                  <For each={grouped()[status]}>
                    {(agent) => {
                      const config = STATUS_CONFIG[agent.status]
                      return (
                        <div class={cn(
                          "flex items-center gap-2 rounded-md border p-2 text-xs",
                          config.border, config.bg
                        )}>
                          <Show when={agent.status === "running"}>
                            <Loader2 class={cn("h-3.5 w-3.5 shrink-0 animate-spin", config.color)} />
                          </Show>
                          <Show when={agent.status === "queued"}>
                            <Hash class={cn("h-3.5 w-3.5 shrink-0", config.color)} />
                          </Show>
                          <Show when={agent.status === "stale"}>
                            <AlertTriangle class={cn("h-3.5 w-3.5 shrink-0", config.color)} />
                          </Show>
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-1.5">
                              <span class="font-medium truncate">{agent.name}</span>
                              <Badge class="text-[9px] px-1 py-0 bg-muted/50">{agent.model}</Badge>
                            </div>
                            <Show when={agent.currentTask}>
                              <p class="text-[10px] text-muted-foreground truncate mt-0.5">
                                {agent.currentTask}
                              </p>
                            </Show>
                          </div>
                          <div class="flex items-center gap-1.5 shrink-0">
                            <Show when={agent.position !== undefined}>
                              <Badge class="text-[9px] px-1 py-0">{agent.position}th</Badge>
                            </Show>
                            <Show when={agent.elapsedMs !== undefined}>
                              <span class="text-[10px] text-muted-foreground flex items-center gap-0.5">
                                <Clock class="h-2.5 w-2.5" />
                                {formatTime(agent.elapsedMs!)}
                              </span>
                            </Show>
                            <Show when={agent.staleDurationMs !== undefined}>
                              <span class="text-[10px] text-warning flex items-center gap-0.5">
                                <Zap class="h-2.5 w-2.5" />
                                {formatTime(agent.staleDurationMs!)} stale
                              </span>
                            </Show>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            )}
          </For>
        </Show>
      </CardContent>
    </Card>
  )
}

export default AgentQueuePanel

import { Component, For, Show, createSignal, createResource } from "solid-js"
import {
  Cog,
  GitMerge,
  Clock,
  User,
  Mail,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Separator } from "./ui"

const log = getLogger("gate-status-panel")

type GateType = "gh:run" | "gh:pr" | "timer" | "human" | "mail"
type GateStatus = "waiting" | "resolved" | "rejected" | "timed-out" | "cancelled"

interface GateEntry {
  id: string
  type: GateType
  status: GateStatus
  planId?: string
  stepId?: string
  createdAt: string
  resolvedAt?: string
  waiters: string[]
  metadata: Record<string, unknown>
  resolution?: {
    outcome: string
    resolvedBy?: string
    comment?: string
  }
}

interface GateStatusPanelProps {
  folder?: string
  planId?: string
  onApprove?: (gateId: string, comment?: string) => void
  onReject?: (gateId: string, reason?: string) => void
}

const GATE_ICONS: Record<GateType, typeof Cog> = {
  "gh:run": Cog,
  "gh:pr": GitMerge,
  timer: Clock,
  human: User,
  mail: Mail,
}

const GATE_LABELS: Record<GateType, string> = {
  "gh:run": "CI Check",
  "gh:pr": "PR Merge",
  timer: "Timer",
  human: "Approval",
  mail: "Message",
}

const STATUS_CONFIG = {
  waiting: { color: "text-primary", bg: "bg-primary/10", border: "border-primary/20", label: "Waiting", animate: true },
  resolved: { color: "text-success", bg: "bg-success/10", border: "border-success/20", label: "Resolved", animate: false },
  rejected: { color: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/20", label: "Rejected", animate: false },
  "timed-out": { color: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/20", label: "Timed Out", animate: false },
  cancelled: { color: "text-muted-foreground", bg: "bg-muted/30", border: "border-border", label: "Cancelled", animate: false },
} as const

const GateStatusPanel: Component<GateStatusPanelProps> = (props) => {
  const [approveComment, setApproveComment] = createSignal("")

  const fetchGates = async (planId: string | undefined): Promise<GateEntry[]> => {
    try {
      const params = new URLSearchParams()
      if (planId) params.set("planId", planId)
      const resp = await fetch(`/api/era/gates/status?${params}`)
      if (!resp.ok) return []
      const data = await resp.json()
      return data.gates ?? []
    } catch (err) {
      log.error("Failed to fetch gates:", err)
      return []
    }
  }

  const [gates, { refetch }] = createResource(() => props.planId, fetchGates)

  const formatTime = (ts: string) => {
    const ms = Date.now() - new Date(ts).getTime()
    if (ms < 60000) return "just now"
    if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`
    return `${Math.round(ms / 3600000)}h ago`
  }

  return (
    <Card class="flex flex-col gap-0">
      <CardHeader class="flex flex-row items-center justify-between pb-2">
        <CardTitle class="flex items-center gap-2 text-sm font-semibold">
          <Clock class="h-4 w-4 text-primary" />
          Gates
        </CardTitle>
        <Badge class="text-[10px]">
          {(gates() ?? []).filter((g) => g.status === "waiting").length} waiting
        </Badge>
      </CardHeader>

      <CardContent class="flex flex-col gap-1.5 pt-0">
        <Show
          when={!gates.loading && (gates() ?? []).length > 0}
          fallback={
            <p class="text-xs text-muted-foreground">
              {gates.loading ? "Loading..." : "No active gates."}
            </p>
          }
        >
          <For each={gates() ?? []}>
            {(gate) => {
              const config = STATUS_CONFIG[gate.status]
              const Icon = GATE_ICONS[gate.type]
              return (
                <div class={cn("rounded-md border p-2.5", config.border, config.bg)}>
                  <div class="flex items-center gap-2">
                    <div class={cn("relative", config.animate && "animate-pulse")}>
                      <Icon class={cn("h-4 w-4", config.color)} />
                      <Show when={gate.status === "resolved"}>
                        <CheckCircle class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 text-success" />
                      </Show>
                      <Show when={gate.status === "timed-out" || gate.status === "rejected"}>
                        <XCircle class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 text-destructive" />
                      </Show>
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-1.5">
                        <span class="text-xs font-medium">{GATE_LABELS[gate.type]}</span>
                        <Badge class={cn("text-[9px] px-1 py-0", config.color)}>{config.label}</Badge>
                      </div>
                      <span class="text-[10px] text-muted-foreground">{formatTime(gate.createdAt)}</span>
                    </div>
                    <Show when={gate.waiters.length > 0}>
                      <Badge class="text-[9px]">{gate.waiters.length} waiting</Badge>
                    </Show>
                  </div>

                  {/* Resolution info */}
                  <Show when={gate.resolution}>
                    <div class="mt-1.5 text-[10px] text-muted-foreground">
                      <Show when={gate.resolution!.resolvedBy}>
                        <span>Resolved by {gate.resolution!.resolvedBy}</span>
                      </Show>
                      <Show when={gate.resolution!.comment}>
                        <p class="mt-0.5 italic">"{gate.resolution!.comment}"</p>
                      </Show>
                    </div>
                  </Show>

                  {/* Inline Approve/Reject for human gates */}
                  <Show when={gate.type === "human" && gate.status === "waiting" && (props.onApprove || props.onReject)}>
                    <Separator class="my-1.5" />
                    <div class="flex items-center gap-2">
                      <Button
                        size="sm"
                        class="h-6 text-[10px] bg-success/10 text-success hover:bg-success/20 border-0"
                        onClick={() => props.onApprove?.(gate.id, approveComment())}
                      >
                        <CheckCircle class="mr-1 h-3 w-3" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        class="h-6 text-[10px] text-destructive border-destructive/30"
                        onClick={() => props.onReject?.(gate.id)}
                      >
                        <XCircle class="mr-1 h-3 w-3" />
                        Reject
                      </Button>
                    </div>
                  </Show>

                  {/* GitHub link for gh:run gates */}
                  <Show when={gate.type === "gh:run" && typeof gate.metadata.owner === "string" && typeof gate.metadata.repo === "string"}>
                    <div class="mt-1">
                      <a
                        href={`https://github.com/${encodeURIComponent(gate.metadata.owner as string)}/${encodeURIComponent(gate.metadata.repo as string)}/actions`}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-[10px] text-primary hover:underline flex items-center gap-1"
                      >
                        View on GitHub <ExternalLink class="h-2.5 w-2.5" />
                      </a>
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

export default GateStatusPanel

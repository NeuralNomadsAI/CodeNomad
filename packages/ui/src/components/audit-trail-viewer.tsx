import { Component, For, Show, createSignal, createResource, createMemo } from "solid-js"
import {
  Clock,
  Filter,
  RefreshCw,
  FileText,
  User,
  Tag,
  ChevronDown,
  ChevronRight,
  History,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Separator,
} from "./ui"

const log = getLogger("audit-trail-viewer")

interface AuditEvent {
  id: string
  type: string
  actor: { agentType: string; sessionId: string; model: string }
  timestamp: string
  target?: string
  description: string
  metadata?: Record<string, unknown>
}

interface AuditTrailViewerProps {
  folder?: string
  issueId?: string
  compact?: boolean
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  created: "text-success",
  updated: "text-info",
  status_changed: "text-warning",
  commented: "text-muted-foreground",
  closed: "text-success",
  plan_created: "text-purple-500",
  plan_checkpoint: "text-purple-400",
  verification_passed: "text-success",
  verification_failed: "text-destructive",
  file_modified: "text-info",
  session_started: "text-primary",
  session_ended: "text-muted-foreground",
  compacted: "text-muted-foreground",
}

const AuditTrailViewer: Component<AuditTrailViewerProps> = (props) => {
  const [actorFilter, setActorFilter] = createSignal("")
  const [typeFilter, setTypeFilter] = createSignal("")
  const [isCollapsed, setIsCollapsed] = createSignal(props.compact ?? false)

  const [events, { refetch }] = createResource(
    () => ({ folder: props.folder, actor: actorFilter(), type: typeFilter() }),
    async (source): Promise<AuditEvent[]> => {
      try {
        const params = new URLSearchParams()
        if (source.folder) params.set("folder", source.folder)
        if (source.actor) params.set("actor", source.actor)
        if (source.type) params.set("type", source.type)
        params.set("limit", "50")

        const res = await fetch(`/api/era/audit/events?${params}`)
        if (!res.ok) return []
        const data = await res.json()
        return data.events ?? []
      } catch (err) {
        log.error("Failed to fetch audit events", err)
        return []
      }
    },
  )

  const uniqueActors = createMemo(() => {
    const actors = new Set<string>()
    for (const event of events() ?? []) {
      actors.add(event.actor.agentType)
    }
    return Array.from(actors)
  })

  const uniqueTypes = createMemo(() => {
    const types = new Set<string>()
    for (const event of events() ?? []) {
      types.add(event.type)
    }
    return Array.from(types)
  })

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - date.getTime()

    if (diff < 60_000) return "just now"
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return date.toLocaleDateString()
  }

  return (
    <Card>
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <button
            class="flex items-center gap-2 cursor-pointer"
            onClick={() => setIsCollapsed(!isCollapsed())}
          >
            {isCollapsed() ? <ChevronRight class="h-4 w-4" /> : <ChevronDown class="h-4 w-4" />}
            <History class="h-4 w-4 text-muted-foreground" />
            <CardTitle class="text-sm font-medium">Audit Trail</CardTitle>
            <Badge variant="outline" class="text-[10px]">
              {events()?.length ?? 0} events
            </Badge>
          </button>
          <Button variant="ghost" size="icon" class="h-6 w-6" onClick={() => refetch()} aria-label="Refresh audit trail">
            <RefreshCw class={cn("h-3.5 w-3.5", events.loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>

      <Show when={!isCollapsed()}>
        <CardContent class="space-y-3">
          {/* Filters */}
          <div class="flex items-center gap-2">
            <div class="flex items-center gap-1 flex-1">
              <Filter class="h-3 w-3 text-muted-foreground shrink-0" />
              <Input
                placeholder="Filter by actor..."
                value={actorFilter()}
                onInput={(e) => setActorFilter(e.currentTarget.value)}
                class="h-7 text-xs"
              />
            </div>
            <Show when={uniqueTypes().length > 0}>
              <div class="flex gap-1 flex-wrap">
                <For each={uniqueTypes().slice(0, 5)}>
                  {(type) => (
                    <button
                      class={cn(
                        "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                        typeFilter() === type
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border text-muted-foreground hover:bg-accent"
                      )}
                      onClick={() => setTypeFilter(typeFilter() === type ? "" : type)}
                    >
                      {type.replace(/_/g, " ")}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* Timeline */}
          <Show when={events.loading && !events()}>
            <div class="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
              <RefreshCw class="h-3 w-3 animate-spin" />
              Loading events...
            </div>
          </Show>

          <div class="max-h-72 overflow-y-auto space-y-0">
            <For each={events()}>
              {(event, i) => {
                const typeColor = EVENT_TYPE_COLORS[event.type] ?? "text-muted-foreground"

                return (
                  <div class="relative pl-5 pb-3">
                    {/* Timeline line */}
                    <Show when={i() < (events()?.length ?? 0) - 1}>
                      <div class="absolute left-[7px] top-4 bottom-0 w-px bg-border" />
                    </Show>

                    {/* Timeline dot */}
                    <div class={cn("absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 border-background", typeColor === "text-success" ? "bg-success" : typeColor === "text-destructive" ? "bg-destructive" : typeColor === "text-warning" ? "bg-warning" : typeColor === "text-info" ? "bg-info" : "bg-muted-foreground")} />

                    <div class="space-y-0.5">
                      <div class="flex items-center gap-2">
                        <span class={cn("text-xs font-medium", typeColor)}>
                          {event.type.replace(/_/g, " ")}
                        </span>
                        <span class="text-[10px] text-muted-foreground">
                          {formatTime(event.timestamp)}
                        </span>
                      </div>
                      <p class="text-xs text-foreground/80">{event.description}</p>
                      <div class="flex items-center gap-2">
                        <Badge variant="outline" class="text-[9px] px-1 py-0">
                          <User class="h-2.5 w-2.5 mr-0.5" />
                          {event.actor.agentType}
                        </Badge>
                        <Show when={event.target}>
                          <Badge variant="outline" class="text-[9px] px-1 py-0">
                            <Tag class="h-2.5 w-2.5 mr-0.5" />
                            {event.target}
                          </Badge>
                        </Show>
                      </div>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>

          <Show when={!events.loading && (!events() || events()!.length === 0)}>
            <div class="text-center py-4">
              <History class="h-6 w-6 text-muted-foreground mx-auto mb-2" />
              <p class="text-xs text-muted-foreground">No audit events recorded yet.</p>
            </div>
          </Show>
        </CardContent>
      </Show>
    </Card>
  )
}

export default AuditTrailViewer

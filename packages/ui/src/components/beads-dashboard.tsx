import { Component, For, Show, createSignal, createResource, createMemo } from "solid-js"
import {
  Circle,
  ArrowRight,
  Filter,
  RefreshCw,
  GitBranch,
  AlertTriangle,
  CheckCircle,
  Clock,
  Pause,
  Play,
  Target,
  Maximize2,
  Minimize2,
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
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Input,
} from "./ui"

const log = getLogger("beads-dashboard")

interface BeadIssue {
  id: string
  title: string
  status: string
  assignee?: string
  labels?: string[]
  dependencies?: string[]
  priority?: number
}

interface GraphNode {
  id: string
  title: string
  status: string
  x?: number
  y?: number
}

interface GraphEdge {
  from: string
  to: string
  type: string
}

interface BeadsDashboardProps {
  folder?: string
  onIssueSelect?: (issueId: string) => void
}

const STATUS_CONFIG: Record<string, { icon: Component<{ class?: string }>; color: string; bg: string }> = {
  open: { icon: (p) => <Circle class={p.class} />, color: "text-info", bg: "bg-info/10" },
  "in-progress": { icon: (p) => <Play class={p.class} />, color: "text-warning", bg: "bg-warning/10" },
  blocked: { icon: (p) => <Pause class={p.class} />, color: "text-destructive", bg: "bg-destructive/10" },
  done: { icon: (p) => <CheckCircle class={p.class} />, color: "text-success", bg: "bg-success/10" },
  ready: { icon: (p) => <Target class={p.class} />, color: "text-primary", bg: "bg-primary/10" },
}

const DEFAULT_STATUS = { icon: (p: { class?: string }) => <Circle class={p.class} />, color: "text-muted-foreground", bg: "bg-muted" }

const BeadsDashboard: Component<BeadsDashboardProps> = (props) => {
  const [statusFilter, setStatusFilter] = createSignal<string | null>(null)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [expanded, setExpanded] = createSignal(false)
  const [selectedIssue, setSelectedIssue] = createSignal<string | null>(null)

  const [issueData, { refetch: refetchIssues }] = createResource(
    () => ({ folder: props.folder, status: statusFilter() }),
    async (source) => {
      try {
        const params = new URLSearchParams()
        if (source.folder) params.set("folder", source.folder)
        if (source.status) params.set("status", source.status)
        const res = await fetch(`/api/era/beads/issues?${params}`)
        if (!res.ok) return { issues: [], total: 0 }
        return await res.json()
      } catch (err) {
        log.error("Failed to fetch beads issues", err)
        return { issues: [], total: 0 }
      }
    },
  )

  const [graphData] = createResource(
    () => props.folder,
    async (folder: string | undefined) => {
      try {
        const params = folder ? `?folder=${encodeURIComponent(folder)}` : ""
        const res = await fetch(`/api/era/beads/graph${params}`)
        if (!res.ok) return { nodes: [], edges: [] }
        return await res.json()
      } catch (err) {
        log.log("Beads graph not available", err)
        return { nodes: [], edges: [] }
      }
    },
  )

  const issues = createMemo<BeadIssue[]>(() => issueData()?.issues ?? [])

  const filteredIssues = createMemo(() => {
    let result = issues()
    const query = searchQuery().toLowerCase()
    if (query) {
      result = result.filter(
        (i) =>
          i.title.toLowerCase().includes(query) ||
          i.id.toLowerCase().includes(query)
      )
    }
    return result
  })

  const statusCounts = createMemo(() => {
    const counts: Record<string, number> = {}
    for (const issue of issues()) {
      counts[issue.status] = (counts[issue.status] ?? 0) + 1
    }
    return counts
  })

  const handleIssueClick = (issueId: string) => {
    setSelectedIssue(issueId)
    props.onIssueSelect?.(issueId)
  }

  const graphNodes = createMemo<GraphNode[]>(() => graphData()?.nodes ?? [])
  const graphEdges = createMemo<GraphEdge[]>(() => graphData()?.edges ?? [])

  return (
    <Card class={cn(expanded() && "fixed inset-4 z-50 shadow-2xl")}>
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <GitBranch class="h-4 w-4 text-muted-foreground" />
            <CardTitle class="text-sm font-medium">Beads Issue Dashboard</CardTitle>
            <Badge variant="outline" class="text-[10px]">
              {issues().length} issues
            </Badge>
          </div>
          <div class="flex items-center gap-1">
            <Button variant="ghost" size="icon" class="h-6 w-6" onClick={() => setExpanded(!expanded())} aria-label="Toggle expanded view">
              {expanded() ? <Minimize2 class="h-3.5 w-3.5" /> : <Maximize2 class="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="icon" class="h-6 w-6" onClick={() => refetchIssues()} aria-label="Refresh issues">
              <RefreshCw class={cn("h-3.5 w-3.5", issueData.loading && "animate-spin")} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="list">
          <TabsList class="mb-3 h-8">
            <TabsTrigger value="list" class="text-xs px-3 py-1">List</TabsTrigger>
            <TabsTrigger value="graph" class="text-xs px-3 py-1">Graph</TabsTrigger>
          </TabsList>

          <TabsContent value="list" class="space-y-3">
            {/* Filters */}
            <div class="flex items-center gap-2">
              <Input
                placeholder="Search issues..."
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
                class="h-7 text-xs"
              />
              <div class="flex gap-1">
                <For each={Object.entries(statusCounts())}>
                  {([status, count]) => {
                    const cfg = STATUS_CONFIG[status] ?? DEFAULT_STATUS
                    const isActive = () => statusFilter() === status

                    return (
                      <button
                        class={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                          isActive()
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:bg-accent"
                        )}
                        onClick={() => setStatusFilter(isActive() ? null : status)}
                      >
                        {status} ({count})
                      </button>
                    )
                  }}
                </For>
              </div>
            </div>

            {/* Issue List */}
            <Show when={issueData.loading && issues().length === 0}>
              <div class="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
                <RefreshCw class="h-3 w-3 animate-spin" />
                Loading issues...
              </div>
            </Show>

            <div class={cn("space-y-1", expanded() ? "max-h-[calc(100vh-240px)] overflow-y-auto" : "max-h-64 overflow-y-auto")}>
              <For each={filteredIssues()}>
                {(issue) => {
                  const cfg = STATUS_CONFIG[issue.status] ?? DEFAULT_STATUS
                  const Icon = cfg.icon
                  const isSelected = () => selectedIssue() === issue.id

                  return (
                    <button
                      class={cn(
                        "w-full flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors",
                        isSelected() ? "border-primary bg-primary/5" : "border-border hover:bg-accent/50",
                        "cursor-pointer"
                      )}
                      onClick={() => handleIssueClick(issue.id)}
                    >
                      <Icon class={cn("h-3.5 w-3.5 shrink-0", cfg.color)} />
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                          <span class="text-[10px] text-muted-foreground font-mono">{issue.id}</span>
                          <span class="text-xs font-medium truncate">{issue.title}</span>
                        </div>
                        <Show when={issue.labels && issue.labels.length > 0}>
                          <div class="flex gap-1 mt-0.5">
                            <For each={issue.labels!.slice(0, 3)}>
                              {(label) => (
                                <Badge variant="outline" class="text-[9px] px-1 py-0">
                                  {label}
                                </Badge>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                      <Show when={issue.assignee}>
                        <span class="text-[10px] text-muted-foreground shrink-0">
                          {issue.assignee}
                        </span>
                      </Show>
                    </button>
                  )
                }}
              </For>
            </div>

            <Show when={filteredIssues().length === 0 && !issueData.loading}>
              <div class="text-center py-6">
                <AlertTriangle class="h-6 w-6 text-muted-foreground mx-auto mb-2" />
                <p class="text-xs text-muted-foreground">
                  {issues().length === 0
                    ? "No beads issues found. Run `beads init` to get started."
                    : "No issues match your filters."}
                </p>
              </div>
            </Show>
          </TabsContent>

          <TabsContent value="graph">
            <Show
              when={graphNodes().length > 0}
              fallback={
                <div class="text-center py-8">
                  <GitBranch class="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p class="text-xs text-muted-foreground">
                    No dependency graph available.
                  </p>
                  <p class="text-[10px] text-muted-foreground mt-1">
                    Add dependencies between beads issues to visualize the graph.
                  </p>
                </div>
              }
            >
              <div class={cn("relative border rounded-lg bg-background/50", expanded() ? "h-[calc(100vh-240px)]" : "h-64")}>
                <svg class="w-full h-full" viewBox="0 0 800 400">
                  {/* Edges */}
                  <For each={graphEdges()}>
                    {(edge) => {
                      const fromNode = () => graphNodes().find((n) => n.id === edge.from)
                      const toNode = () => graphNodes().find((n) => n.id === edge.to)

                      return (
                        <Show when={fromNode() && toNode()}>
                          <line
                            x1={fromNode()!.x ?? 100}
                            y1={fromNode()!.y ?? 100}
                            x2={toNode()!.x ?? 200}
                            y2={toNode()!.y ?? 200}
                            stroke="hsl(var(--border))"
                            stroke-width="1.5"
                            marker-end="url(#arrowhead)"
                          />
                        </Show>
                      )
                    }}
                  </For>

                  {/* Arrow marker */}
                  <defs>
                    <marker id="arrowhead" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
                      <polygon points="0 0, 6 2, 0 4" fill="hsl(var(--muted-foreground))" />
                    </marker>
                  </defs>

                  {/* Nodes */}
                  <For each={graphNodes()}>
                    {(node, i) => {
                      const x = () => node.x ?? 100 + (i() % 6) * 120
                      const y = () => node.y ?? 60 + Math.floor(i() / 6) * 80
                      const cfg = STATUS_CONFIG[node.status] ?? DEFAULT_STATUS

                      return (
                        <g
                          class="cursor-pointer"
                          onClick={() => handleIssueClick(node.id)}
                        >
                          <rect
                            x={x() - 50}
                            y={y() - 15}
                            width="100"
                            height="30"
                            rx="6"
                            fill="hsl(var(--card))"
                            stroke="hsl(var(--border))"
                            stroke-width="1"
                          />
                          <text
                            x={x()}
                            y={y() + 4}
                            text-anchor="middle"
                            class="text-[10px] fill-foreground"
                          >
                            {node.title.length > 14 ? node.title.slice(0, 14) + "..." : node.title}
                          </text>
                        </g>
                      )
                    }}
                  </For>
                </svg>
              </div>
            </Show>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

export default BeadsDashboard

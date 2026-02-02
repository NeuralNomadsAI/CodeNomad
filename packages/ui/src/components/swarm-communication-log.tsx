import { Component, For, Show, createSignal, createResource, createMemo } from "solid-js"
import {
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Search,
  Filter,
  ArrowRight,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import { Card, CardContent, CardHeader, CardTitle, Badge, Button, Separator } from "./ui"

const log = getLogger("swarm-communication-log")

interface SwarmMessage {
  id: string
  from: string
  to: string
  type: string
  category: "permission" | "task" | "plan" | "lifecycle" | "shutdown"
  timestamp: string
  payload?: string
}

interface SwarmCommunicationLogProps {
  folder?: string
  compact?: boolean
}

const CATEGORY_COLORS = {
  permission: "text-purple-400",
  task: "text-blue-400",
  plan: "text-green-400",
  lifecycle: "text-muted-foreground",
  shutdown: "text-destructive",
} as const

const SwarmCommunicationLog: Component<SwarmCommunicationLogProps> = (props) => {
  const [collapsed, setCollapsed] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [filterType, setFilterType] = createSignal<string | null>(null)
  const [expandedMsg, setExpandedMsg] = createSignal<string | null>(null)

  const fetchMessages = async (folder: string | undefined): Promise<SwarmMessage[]> => {
    try {
      const resp = await fetch("/api/era/swarm/messages")
      if (!resp.ok) return []
      const data = await resp.json()
      return data.messages ?? []
    } catch (err) {
      log.error("Failed to fetch swarm messages:", err)
      return []
    }
  }

  const [messages] = createResource(() => props.folder, fetchMessages)

  const filtered = createMemo(() => {
    let result = messages() ?? []
    const q = searchQuery().toLowerCase()
    if (q) {
      result = result.filter(
        (m) =>
          m.from.toLowerCase().includes(q) ||
          m.to.toLowerCase().includes(q) ||
          m.type.toLowerCase().includes(q)
      )
    }
    const ft = filterType()
    if (ft) result = result.filter((m) => m.category === ft)
    return result
  })

  const formatTime = (ts: string) => {
    const d = new Date(ts)
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
  }

  return (
    <Card class="flex flex-col gap-0">
      <CardHeader
        class="flex flex-row items-center justify-between pb-2 cursor-pointer"
        onClick={() => setCollapsed((p) => !p)}
      >
        <CardTitle class="flex items-center gap-2 text-sm font-semibold">
          <MessageSquare class="h-4 w-4 text-primary" />
          Swarm Communication
          {collapsed() ? (
            <ChevronRight class="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown class="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </CardTitle>
        <Badge class="text-[10px]">
          {(messages() ?? []).length} msgs
        </Badge>
      </CardHeader>

      <Show when={!collapsed()}>
        <CardContent class="flex flex-col gap-2 pt-0">
          {/* Search + Filter */}
          <div class="flex items-center gap-2">
            <div class="relative flex-1">
              <Search class="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Filter by agent or type..."
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
                class="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-[11px] outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <Button
              variant={filterType() ? "default" : "outline"}
              size="sm"
              class="h-7 px-2 text-[10px]"
              onClick={() => {
                const cats = [null, "permission", "task", "plan", "lifecycle", "shutdown"]
                const cur = cats.indexOf(filterType())
                setFilterType(cats[(cur + 1) % cats.length] as string | null)
              }}
            >
              <Filter class="h-3 w-3" />
            </Button>
          </div>

          <Show when={filterType()}>
            <Badge class={cn("w-fit text-[10px]", CATEGORY_COLORS[filterType() as keyof typeof CATEGORY_COLORS])}>
              {filterType()}
            </Badge>
          </Show>

          <Separator />

          {/* Messages */}
          <div class="flex flex-col gap-0.5 max-h-48 overflow-y-auto font-mono text-[11px]">
            <Show
              when={(filtered().length > 0)}
              fallback={<p class="text-xs text-muted-foreground">No messages.</p>}
            >
              <For each={filtered()}>
                {(msg) => (
                  <div>
                    <button
                      class="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-muted/50"
                      onClick={() => setExpandedMsg(expandedMsg() === msg.id ? null : msg.id)}
                    >
                      <span class="text-[10px] text-muted-foreground shrink-0">{formatTime(msg.timestamp)}</span>
                      <span class="text-foreground font-medium">{msg.from}</span>
                      <ArrowRight class="h-3 w-3 text-muted-foreground shrink-0" />
                      <span class="text-foreground font-medium">{msg.to}</span>
                      <span class={cn("text-[10px]", CATEGORY_COLORS[msg.category])}>{msg.type}</span>
                    </button>
                    <Show when={expandedMsg() === msg.id && msg.payload}>
                      <pre class="ml-16 text-[10px] text-muted-foreground bg-muted/30 rounded p-1.5 mt-0.5 overflow-x-auto">
                        {msg.payload}
                      </pre>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </CardContent>
      </Show>
    </Card>
  )
}

export default SwarmCommunicationLog

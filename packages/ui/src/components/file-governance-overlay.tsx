import { Component, For, Show, createSignal, createResource, createMemo } from "solid-js"
import {
  Shield,
  ShieldCheck,
  ShieldOff,
  Lock,
  Unlock,
  FileCode,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Filter,
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
  Separator,
} from "./ui"

const log = getLogger("file-governance-overlay")

interface GovernanceRule {
  id: string
  categoryId: string
  categoryName: string
  action: "allow" | "deny" | "ask" | "audit"
  source: string
}

interface FileGovernanceOverlayProps {
  folder?: string
  files?: string[]
}

const ACTION_CONFIG: Record<string, { icon: Component<{ class?: string }>; color: string; bg: string; label: string }> = {
  allow: {
    icon: (p) => <Unlock class={p.class} />,
    color: "text-success",
    bg: "bg-success/10",
    label: "Allowed",
  },
  deny: {
    icon: (p) => <Lock class={p.class} />,
    color: "text-destructive",
    bg: "bg-destructive/10",
    label: "Denied",
  },
  ask: {
    icon: (p) => <Shield class={p.class} />,
    color: "text-warning",
    bg: "bg-warning/10",
    label: "Ask",
  },
  audit: {
    icon: (p) => <ShieldCheck class={p.class} />,
    color: "text-info",
    bg: "bg-info/10",
    label: "Audit",
  },
}

const FileGovernanceOverlay: Component<FileGovernanceOverlayProps> = (props) => {
  const [filterText, setFilterText] = createSignal("")
  const [expandedCategories, setExpandedCategories] = createSignal<Set<string>>(new Set())

  const [rules, { refetch }] = createResource<GovernanceRule[]>(async () => {
    try {
      const params = new URLSearchParams()
      if (props.folder) params.set("folder", props.folder)
      const res = await fetch(`/api/era/governance/file-rules?${params}`)
      if (!res.ok) return []
      const data = await res.json()
      return data.rules ?? []
    } catch (err) {
      log.error("Failed to fetch governance rules", err)
      return []
    }
  })

  const groupedRules = createMemo(() => {
    const allRules = rules() ?? []
    const filter = filterText().toLowerCase()
    const filtered = filter
      ? allRules.filter(
          (r) =>
            r.id.toLowerCase().includes(filter) ||
            r.categoryName.toLowerCase().includes(filter)
        )
      : allRules

    const groups = new Map<string, { categoryName: string; rules: GovernanceRule[] }>()
    for (const rule of filtered) {
      if (!groups.has(rule.categoryId)) {
        groups.set(rule.categoryId, { categoryName: rule.categoryName, rules: [] })
      }
      groups.get(rule.categoryId)!.rules.push(rule)
    }
    return groups
  })

  const actionCounts = createMemo(() => {
    const counts: Record<string, number> = {}
    for (const rule of rules() ?? []) {
      counts[rule.action] = (counts[rule.action] ?? 0) + 1
    }
    return counts
  })

  const toggleCategory = (categoryId: string) => {
    const next = new Set(expandedCategories())
    if (next.has(categoryId)) {
      next.delete(categoryId)
    } else {
      next.add(categoryId)
    }
    setExpandedCategories(next)
  }

  const getFileStatus = (filePath: string): GovernanceRule | null => {
    const allRules = rules() ?? []
    // Simple path matching — check if any deny rule pattern matches
    for (const rule of allRules) {
      if (rule.action === "deny" && filePath.includes(rule.id)) {
        return rule
      }
    }
    return null
  }

  return (
    <Card>
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Shield class="h-4 w-4 text-muted-foreground" />
            <CardTitle class="text-sm font-medium">File Governance</CardTitle>
            <Show when={rules()}>
              <Badge variant="outline" class="text-[10px]">
                {rules()!.length} rules
              </Badge>
            </Show>
          </div>
          <Button variant="ghost" size="icon" class="h-6 w-6" onClick={() => refetch()} aria-label="Refresh governance rules">
            <RefreshCw class={cn("h-3.5 w-3.5", rules.loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent class="space-y-3">
        {/* Action Summary */}
        <Show when={Object.keys(actionCounts()).length > 0}>
          <div class="flex items-center gap-2">
            <For each={Object.entries(actionCounts())}>
              {([action, count]) => {
                const cfg = ACTION_CONFIG[action]
                if (!cfg) return null
                const Icon = cfg.icon

                return (
                  <div class={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px]", cfg.bg, cfg.color)}>
                    <Icon class="h-2.5 w-2.5" />
                    {count} {cfg.label}
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        {/* Filter */}
        <div class="flex items-center gap-1">
          <Filter class="h-3 w-3 text-muted-foreground shrink-0" />
          <Input
            placeholder="Filter rules..."
            value={filterText()}
            onInput={(e) => setFilterText(e.currentTarget.value)}
            class="h-7 text-xs"
          />
        </div>

        {/* File Status Overlay */}
        <Show when={props.files && props.files.length > 0}>
          <div class="space-y-1">
            <p class="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
              File Status
            </p>
            <For each={props.files}>
              {(file) => {
                const status = () => getFileStatus(file)
                const isDenied = () => status()?.action === "deny"

                return (
                  <div
                    class={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1 text-xs",
                      isDenied() ? "bg-destructive/5 text-destructive/80" : "text-foreground"
                    )}
                  >
                    <FileCode class={cn("h-3 w-3 shrink-0", isDenied() ? "text-destructive" : "text-muted-foreground")} />
                    <span class={cn("truncate font-mono text-[11px]", isDenied() && "line-through")}>
                      {file}
                    </span>
                    <Show when={isDenied()}>
                      <Lock class="h-3 w-3 text-destructive shrink-0 ml-auto" />
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
          <Separator />
        </Show>

        {/* Rules by Category */}
        <Show when={rules.loading && !rules()}>
          <div class="flex items-center gap-2 text-xs text-muted-foreground py-2 justify-center">
            <RefreshCw class="h-3 w-3 animate-spin" />
            Loading rules...
          </div>
        </Show>

        <div class="max-h-64 overflow-y-auto space-y-1">
          <For each={Array.from(groupedRules().entries())}>
            {([categoryId, group]) => {
              const isExpanded = () => expandedCategories().has(categoryId)

              return (
                <div>
                  <button
                    class="w-full flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium hover:bg-accent/50 cursor-pointer"
                    onClick={() => toggleCategory(categoryId)}
                  >
                    {isExpanded() ? <ChevronDown class="h-3 w-3" /> : <ChevronRight class="h-3 w-3" />}
                    {group.categoryName}
                    <Badge variant="outline" class="text-[9px] px-1 py-0 ml-auto">
                      {group.rules.length}
                    </Badge>
                  </button>

                  <Show when={isExpanded()}>
                    <div class="pl-5 space-y-0.5">
                      <For each={group.rules}>
                        {(rule) => {
                          const cfg = ACTION_CONFIG[rule.action] ?? ACTION_CONFIG.audit
                          const Icon = cfg.icon

                          return (
                            <div class="flex items-center gap-2 rounded px-2 py-1 text-[11px]">
                              <Icon class={cn("h-3 w-3 shrink-0", cfg.color)} />
                              <span class="font-mono truncate flex-1">{rule.id}</span>
                              <Badge variant="outline" class={cn("text-[9px] px-1 py-0", cfg.color)}>
                                {rule.action}
                              </Badge>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>

        <Show when={!rules.loading && (!rules() || rules()!.length === 0)}>
          <div class="text-center py-4">
            <ShieldOff class="h-6 w-6 text-muted-foreground mx-auto mb-2" />
            <p class="text-xs text-muted-foreground">
              No governance rules found for this project.
            </p>
          </div>
        </Show>
      </CardContent>
    </Card>
  )
}

export default FileGovernanceOverlay

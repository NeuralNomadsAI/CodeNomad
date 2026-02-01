import { Component, createSignal, createMemo, createEffect, onMount, For, Show } from "solid-js"
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  Search,
  X,
  RefreshCw,
  AlertTriangle,
  Lock,
  ToggleLeft,
  ToggleRight,
  GitBranch,
  Code2,
  Terminal,
  Server,
  Eye,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { Badge } from "./ui"
import {
  governanceRules,
  governanceSummary,
  hardcodedRules,
  defaultRules,
  projectRules,
  isGovernanceLoading,
  governanceError,
  isAuditMode,
  refreshGovernanceRules,
  setRuleOverride,
  removeRuleOverride,
  type GovernanceRule,
} from "../stores/era-governance"
import { isEraInstalled } from "../stores/era-status"

interface ActiveRulesPanelProps {
  folder?: string
}

// Rule categories for grouping
type RuleCategory = "security" | "git" | "code" | "system" | "other"

function categorizeRule(rule: GovernanceRule): RuleCategory {
  const id = rule.id.toLowerCase()
  const pattern = rule.pattern.toLowerCase()

  if (id.includes("secret") || id.includes("env") || id.includes("credential") ||
      pattern.includes(".env") || pattern.includes("password") || pattern.includes("api_key")) {
    return "security"
  }
  if (id.includes("git") || pattern.includes("git ") || pattern.includes("push") ||
      pattern.includes("force") || pattern.includes("branch")) {
    return "git"
  }
  if (id.includes("code") || id.includes("lint") || id.includes("format") ||
      pattern.includes("npm") || pattern.includes("yarn") || pattern.includes("pnpm")) {
    return "code"
  }
  if (id.includes("system") || id.includes("rm ") || id.includes("sudo") ||
      pattern.includes("rm -rf") || pattern.includes("sudo")) {
    return "system"
  }
  return "other"
}

const categoryConfig: Record<RuleCategory, { label: string; icon: typeof Shield; color: string }> = {
  security: { label: "Security", icon: ShieldAlert, color: "text-destructive" },
  git: { label: "Git", icon: GitBranch, color: "text-info" },
  code: { label: "Code", icon: Code2, color: "text-info" },
  system: { label: "System", icon: Terminal, color: "text-warning" },
  other: { label: "Other", icon: Server, color: "text-muted-foreground" },
}

const ActiveRulesPanel: Component<ActiveRulesPanelProps> = (props) => {
  const [searchQuery, setSearchQuery] = createSignal("")
  const [selectedCategory, setSelectedCategory] = createSignal<RuleCategory | "all">("all")
  const [selectedSource, setSelectedSource] = createSignal<"all" | "hardcoded" | "default" | "project">("all")
  const [togglingRules, setTogglingRules] = createSignal<Set<string>>(new Set())

  onMount(() => {
    refreshGovernanceRules(props.folder)
  })

  createEffect(() => {
    if (props.folder) {
      refreshGovernanceRules(props.folder)
    }
  })

  const filteredRules = createMemo(() => {
    let rules = governanceRules()

    // Filter by search
    const query = searchQuery().toLowerCase()
    if (query) {
      rules = rules.filter(r =>
        r.id.toLowerCase().includes(query) ||
        r.pattern.toLowerCase().includes(query) ||
        r.reason.toLowerCase().includes(query)
      )
    }

    // Filter by category
    const category = selectedCategory()
    if (category !== "all") {
      rules = rules.filter(r => categorizeRule(r) === category)
    }

    // Filter by source
    const source = selectedSource()
    if (source !== "all") {
      rules = rules.filter(r => r.source === source)
    }

    return rules
  })

  // Group filtered rules by category for display
  const groupedFilteredRules = createMemo(() => {
    const rules = filteredRules()
    const groups: Record<RuleCategory, GovernanceRule[]> = {
      security: [],
      git: [],
      code: [],
      system: [],
      other: [],
    }

    for (const rule of rules) {
      const category = categorizeRule(rule)
      groups[category].push(rule)
    }

    return groups
  })

  const handleRuleToggle = async (rule: GovernanceRule) => {
    if (!props.folder || !rule.overridable) return

    setTogglingRules(prev => new Set(prev).add(rule.id))
    try {
      if (rule.action === "deny") {
        await setRuleOverride(rule.id, "allow", "Enabled via UI toggle", props.folder)
      } else {
        await removeRuleOverride(rule.id, props.folder)
      }
    } finally {
      setTogglingRules(prev => {
        const next = new Set(prev)
        next.delete(rule.id)
        return next
      })
    }
  }

  const totalRules = () => governanceRules().length
  const activeBlocks = () => governanceRules().filter(r => r.action === "deny").length
  const overrideCount = () => defaultRules().filter(r => r.action === "allow").length

  return (
    <div class={cn("flex flex-col gap-4")}>
      {/* Header */}
      <div class={cn("flex items-center justify-between gap-4 flex-wrap")}>
        <div>
          <h2 class={cn("flex items-center gap-2 text-lg font-semibold text-foreground")}>
            <ShieldCheck class="w-5 h-5 text-accent" />
            Active Rules
          </h2>
          <p class={cn("text-sm mt-1 text-muted-foreground")}>Runtime rules that control what actions the AI can perform</p>
        </div>

        <Show when={!isGovernanceLoading() && !governanceError()}>
          <div class={cn("flex items-center gap-3")}>
            <div class={cn("text-center")}>
              <span class={cn("block text-sm font-semibold text-foreground")}>{totalRules()}</span>
              <span class={cn("text-xs text-muted-foreground")}>Rules</span>
            </div>
            <div class={cn("text-center")}>
              <span class={cn("block text-sm font-semibold text-destructive")}>{activeBlocks()}</span>
              <span class={cn("text-xs text-muted-foreground")}>Blocking</span>
            </div>
            <div class={cn("text-center")}>
              <span class={cn("block text-sm font-semibold text-success")}>{overrideCount()}</span>
              <span class={cn("text-xs text-muted-foreground")}>Overrides</span>
            </div>
            <Show when={isAuditMode()}>
              <Badge variant="outline" class="text-warning">
                <Eye class="w-3 h-3" /> Audit Mode
              </Badge>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={!isEraInstalled()}>
        <div class={cn("flex items-center gap-2 p-4 rounded-md bg-warning/10 text-warning")}>
          <AlertTriangle class="w-5 h-5" />
          <div>
            <strong>Era Code Not Installed</strong>
            <p>Install Era Code to view and manage governance rules.</p>
          </div>
        </div>
      </Show>

      <Show when={isEraInstalled()}>
        {/* Filters */}
        <div class={cn("flex items-center gap-3 flex-wrap mb-4")}>
          {/* Search */}
          <div class={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg flex-1 max-w-xs bg-secondary border border-border")}>
            <Search class="w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              class={cn("flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground")}
              placeholder="Search rules..."
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
            />
            <Show when={searchQuery()}>
              <button type="button" onClick={() => setSearchQuery("")}>
                <X class="w-3 h-3" />
              </button>
            </Show>
          </div>

          {/* Category Filter */}
          <select
            class={cn("px-3 py-1.5 rounded-md text-sm bg-secondary border border-border text-foreground")}
            value={selectedCategory()}
            onChange={(e) => setSelectedCategory(e.currentTarget.value as RuleCategory | "all")}
          >
            <option value="all">All Categories</option>
            <option value="security">Security</option>
            <option value="git">Git</option>
            <option value="code">Code</option>
            <option value="system">System</option>
            <option value="other">Other</option>
          </select>

          {/* Source Filter */}
          <select
            class={cn("px-3 py-1.5 rounded-md text-sm bg-secondary border border-border text-foreground")}
            value={selectedSource()}
            onChange={(e) => setSelectedSource(e.currentTarget.value as "all" | "hardcoded" | "default" | "project")}
          >
            <option value="all">All Sources</option>
            <option value="hardcoded">Hardcoded</option>
            <option value="default">Default</option>
            <option value="project">Project</option>
          </select>
        </div>

        <Show when={isGovernanceLoading()}>
          <div class={cn("flex items-center justify-center gap-3 py-8 text-muted-foreground")}>
            <RefreshCw class="w-5 h-5 animate-spin" />
            <span>Loading rules...</span>
          </div>
        </Show>

        <Show when={governanceError()}>
          <div class={cn("flex items-center gap-2 p-4 rounded-md bg-destructive/10 text-destructive")}>
            <AlertTriangle class="w-5 h-5" />
            <span>{governanceError()}</span>
          </div>
        </Show>

        <Show when={!isGovernanceLoading() && !governanceError()}>
          <Show when={filteredRules().length === 0}>
            <div class={cn("flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground")}>
              <Shield class="w-8 h-8 opacity-50" />
              <p>No rules match your filters</p>
            </div>
          </Show>

          <div class={cn("space-y-4")}>
            <For each={Object.entries(groupedFilteredRules()).filter(([_, rules]) => rules.length > 0)}>
              {([category, rules]) => {
                const config = categoryConfig[category as RuleCategory]
                const CategoryIcon = config.icon
                return (
                  <div class={cn("rounded-lg border border-border overflow-hidden")}>
                    <div class={cn("flex items-center gap-2 px-3 py-2 bg-secondary")}>
                      <CategoryIcon class={cn("w-4 h-4", config.color)} />
                      <span class={cn("text-sm font-medium text-foreground")}>{config.label}</span>
                      <Badge variant="secondary" class="ml-auto">{rules.length}</Badge>
                    </div>
                    <div class={cn("divide-y divide-border")}>
                      <For each={rules}>
                        {(rule) => {
                          const isToggling = () => togglingRules().has(rule.id)
                          const isBlocking = () => rule.action === "deny"

                          return (
                            <div class={cn(
                              "p-3",
                              !isBlocking() && "bg-success/5"
                            )}>
                              <div class={cn("flex items-start justify-between gap-3")}>
                                <div class={cn("flex-1 min-w-0")}>
                                  <div class={cn("flex items-center gap-2 mb-1")}>
                                    <span class={cn("font-mono text-xs text-foreground")}>{rule.id}</span>
                                    <Show when={rule.source === "hardcoded"}>
                                      <span title="Cannot be overridden">
                                        <Lock class="w-3 h-3 text-destructive" />
                                      </span>
                                    </Show>
                                  </div>
                                  <p class={cn("text-sm mb-1 text-muted-foreground")}>{rule.reason}</p>
                                  <code class={cn("text-xs px-2 py-1 rounded font-mono bg-accent text-muted-foreground break-all")}>{rule.pattern}</code>
                                </div>
                                <div class={cn("flex items-center gap-2 flex-shrink-0")}>
                                  <Badge variant={isBlocking() ? "destructive" : "default"}>
                                    {isBlocking() ? "Block" : "Allow"}
                                  </Badge>
                                  <Show when={rule.overridable && props.folder}>
                                    <button
                                      type="button"
                                      class={cn(
                                        "flex items-center justify-center w-8 h-8 rounded transition-colors",
                                        !isBlocking()
                                          ? "text-success hover:opacity-80"
                                          : "text-muted-foreground hover:text-foreground",
                                        "disabled:opacity-50 disabled:cursor-not-allowed"
                                      )}
                                      onClick={() => handleRuleToggle(rule)}
                                      disabled={isToggling()}
                                      title={isBlocking() ? "Click to allow" : "Click to block"}
                                    >
                                      <Show when={isToggling()}>
                                        <RefreshCw class="w-5 h-5 animate-spin" />
                                      </Show>
                                      <Show when={!isToggling()}>
                                        {isBlocking() ? <ToggleLeft class="w-5 h-5" /> : <ToggleRight class="w-5 h-5" />}
                                      </Show>
                                    </button>
                                  </Show>
                                </div>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export default ActiveRulesPanel

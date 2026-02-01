import { Component, createSignal, createMemo, createEffect, For, Show, onMount } from "solid-js"
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  FileText,
  Globe,
  Folder,
  ChevronDown,
  ChevronRight,
  Search,
  ToggleLeft,
  ToggleRight,
  RefreshCw,
  AlertTriangle,
  Lock,
  Unlock,
  Edit3,
  X,
  Plus,
  Filter,
  BookOpen,
  Terminal,
  GitBranch,
  Code2,
  Server,
  Eye,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { Badge, Button } from "./ui"
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
import {
  fetchDirectives,
  projectDirectives,
  globalDirectives,
  constitution,
  isDirectivesLoading,
  saveDirectives,
} from "../stores/era-directives"
import { isEraInstalled } from "../stores/era-status"

interface UnifiedGovernancePanelProps {
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

const UnifiedGovernancePanel: Component<UnifiedGovernancePanelProps> = (props) => {
  const [searchQuery, setSearchQuery] = createSignal("")
  const [selectedCategory, setSelectedCategory] = createSignal<RuleCategory | "all">("all")
  const [selectedSource, setSelectedSource] = createSignal<"all" | "hardcoded" | "default" | "project">("all")
  const [togglingRules, setTogglingRules] = createSignal<Set<string>>(new Set())
  const [expandedSection, setExpandedSection] = createSignal<"constitution" | "global" | "project" | null>(null)
  const [editingDirective, setEditingDirective] = createSignal<"project" | "global" | null>(null)
  const [editContent, setEditContent] = createSignal("")
  const [isSaving, setIsSaving] = createSignal(false)
  const [saveMessage, setSaveMessage] = createSignal<{ type: "success" | "error"; text: string } | null>(null)

  // Load data on mount
  onMount(() => {
    refreshGovernanceRules(props.folder)
    fetchDirectives(props.folder)
  })

  createEffect(() => {
    if (props.folder) {
      refreshGovernanceRules(props.folder)
      fetchDirectives(props.folder)
    }
  })

  // Categorized and filtered rules
  const categorizedRules = createMemo(() => {
    const rules = governanceRules()
    const categories: Record<RuleCategory, GovernanceRule[]> = {
      security: [],
      git: [],
      code: [],
      system: [],
      other: [],
    }

    for (const rule of rules) {
      const category = categorizeRule(rule)
      categories[category].push(rule)
    }

    return categories
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

  const startEditDirective = (type: "project" | "global") => {
    const content = type === "project"
      ? projectDirectives()?.content || ""
      : globalDirectives()?.content || ""
    setEditContent(content)
    setEditingDirective(type)
    setSaveMessage(null)
  }

  const cancelEditDirective = () => {
    setEditingDirective(null)
    setEditContent("")
    setSaveMessage(null)
  }

  const handleSaveDirective = async () => {
    const type = editingDirective()
    if (!type) return

    setIsSaving(true)
    setSaveMessage(null)

    try {
      const result = await saveDirectives(props.folder || "", type, editContent())
      if (result.success) {
        setSaveMessage({ type: "success", text: "Saved successfully" })
        await fetchDirectives(props.folder)
        setTimeout(() => {
          setEditingDirective(null)
          setSaveMessage(null)
        }, 1500)
      } else {
        setSaveMessage({ type: "error", text: result.error || "Failed to save" })
      }
    } catch (error) {
      setSaveMessage({ type: "error", text: "Failed to save" })
    } finally {
      setIsSaving(false)
    }
  }

  const totalRules = () => governanceRules().length
  const activeBlocks = () => governanceRules().filter(r => r.action === "deny").length
  const overrideCount = () => defaultRules().filter(r => r.action === "allow").length

  // Extract summary from directives
  const getDirectiveSummary = (content: string | undefined, maxLines = 3): string[] => {
    if (!content) return []
    const lines = content.split("\n")
      .filter(l => l.trim() && !l.startsWith("#"))
      .slice(0, maxLines)
    return lines
  }

  return (
    <div class={cn("flex flex-col gap-6")}>
      {/* Header */}
      <div class={cn("flex items-center justify-between gap-4 flex-wrap")}>
        <div class={cn("flex items-center gap-3")}>
          <Shield class="w-6 h-6 text-accent" />
          <div>
            <h2 class={cn("text-lg font-semibold text-foreground")}>Governance</h2>
            <p class={cn("text-sm text-muted-foreground")}>Rules and directives that control AI behavior</p>
          </div>
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
            <p>Install Era Code to enable governance rules and enforcement.</p>
          </div>
        </div>
      </Show>

      <Show when={isEraInstalled()}>
        {/* Hierarchy Section */}
        <div class={cn("flex flex-col gap-4")}>
          <h3 class={cn("text-sm font-semibold text-foreground")}>Hierarchy</h3>
          <p class={cn("text-xs text-muted-foreground -mt-2")}>Rules are applied in order: Constitution → Global → Project</p>

          <div class={cn("flex flex-col gap-3")}>
            {/* Constitution Card */}
            <div class={cn("rounded-lg border border-border overflow-hidden")}>
              <div class={cn("flex items-center gap-3 px-4 py-3 bg-secondary")}>
                <div class={cn("flex items-center justify-center w-8 h-8 rounded-lg bg-destructive/10 text-destructive")}>
                  <Lock class="w-5 h-5" />
                </div>
                <div class={cn("flex-1 min-w-0")}>
                  <h4 class={cn("text-sm font-semibold text-foreground")}>Constitution</h4>
                  <span class={cn("text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium")}>Immutable</span>
                </div>
                <button
                  type="button"
                  class={cn("p-1.5 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent")}
                  onClick={() => setExpandedSection(s => s === "constitution" ? null : "constitution")}
                >
                  {expandedSection() === "constitution" ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
                </button>
              </div>
              <p class={cn("px-4 py-1 text-xs text-muted-foreground border-t border-border")}>
                Foundational safety rules that cannot be overridden
              </p>
              <Show when={expandedSection() === "constitution"}>
                <div class={cn("p-4 border-t border-border")}>
                  <Show when={constitution()?.exists && constitution()?.content}>
                    <pre class={cn("p-3 rounded-lg text-xs font-mono whitespace-pre-wrap break-all bg-accent text-muted-foreground overflow-auto max-h-[300px]")}>{constitution()!.content}</pre>
                  </Show>
                  <Show when={!constitution()?.exists}>
                    <p class={cn("text-sm text-muted-foreground")}>No constitution file found</p>
                  </Show>
                </div>
              </Show>
            </div>

            {/* Global Directives Card */}
            <div class={cn("rounded-lg border border-border overflow-hidden")}>
              <div class={cn("flex items-center gap-3 px-4 py-3 bg-secondary")}>
                <div class={cn("flex items-center justify-center w-8 h-8 rounded-lg bg-info/10 text-info")}>
                  <Globe class="w-5 h-5" />
                </div>
                <div class={cn("flex-1 min-w-0")}>
                  <h4 class={cn("text-sm font-semibold text-foreground")}>Global Directives</h4>
                  <span class={cn("text-xs px-2 py-0.5 rounded-full bg-info/10 text-info font-medium")}>User</span>
                </div>
                <div class={cn("flex items-center gap-1")}>
                  <button
                    type="button"
                    class={cn("p-1.5 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent")}
                    onClick={() => startEditDirective("global")}
                    title="Edit global directives"
                  >
                    <Edit3 class="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    class={cn("p-1.5 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent")}
                    onClick={() => setExpandedSection(s => s === "global" ? null : "global")}
                  >
                    {expandedSection() === "global" ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <p class={cn("px-4 py-1 text-xs text-muted-foreground border-t border-border")}>
                Your personal preferences across all projects
              </p>
              <Show when={globalDirectives()?.exists}>
                <div class={cn("px-4 py-2 border-t border-border")}>
                  <For each={getDirectiveSummary(globalDirectives()?.content)}>
                    {(line) => <span class={cn("block text-xs text-muted-foreground truncate")}>{line}</span>}
                  </For>
                </div>
              </Show>
              <Show when={!globalDirectives()?.exists}>
                <div class={cn("px-4 py-2 border-t border-border")}>
                  <button
                    type="button"
                    class={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                      "bg-accent text-muted-foreground hover:text-foreground"
                    )}
                    onClick={() => startEditDirective("global")}
                  >
                    <Plus class="w-4 h-4" /> Create Global Directives
                  </button>
                </div>
              </Show>
              <Show when={expandedSection() === "global" && globalDirectives()?.content}>
                <div class={cn("p-4 border-t border-border")}>
                  <pre class={cn("p-3 rounded-lg text-xs font-mono whitespace-pre-wrap break-all bg-accent text-muted-foreground overflow-auto max-h-[300px]")}>{globalDirectives()!.content}</pre>
                </div>
              </Show>
            </div>

            {/* Project Directives Card */}
            <div class={cn("rounded-lg border border-border overflow-hidden")}>
              <div class={cn("flex items-center gap-3 px-4 py-3 bg-secondary")}>
                <div class={cn("flex items-center justify-center w-8 h-8 rounded-lg bg-success/10 text-success")}>
                  <Folder class="w-5 h-5" />
                </div>
                <div class={cn("flex-1 min-w-0")}>
                  <h4 class={cn("text-sm font-semibold text-foreground")}>Project Directives</h4>
                  <span class={cn("text-xs px-2 py-0.5 rounded-full bg-success/10 text-success font-medium")}>Project</span>
                </div>
                <div class={cn("flex items-center gap-1")}>
                  <Show when={props.folder}>
                    <button
                      type="button"
                      class={cn("p-1.5 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent")}
                      onClick={() => startEditDirective("project")}
                      title="Edit project directives"
                    >
                      <Edit3 class="w-4 h-4" />
                    </button>
                  </Show>
                  <button
                    type="button"
                    class={cn("p-1.5 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent")}
                    onClick={() => setExpandedSection(s => s === "project" ? null : "project")}
                  >
                    {expandedSection() === "project" ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <p class={cn("px-4 py-1 text-xs text-muted-foreground border-t border-border")}>
                Conventions specific to this codebase
              </p>
              <Show when={!props.folder}>
                <p class={cn("px-4 py-2 text-sm text-muted-foreground italic border-t border-border")}>Open a project to manage project directives</p>
              </Show>
              <Show when={props.folder && projectDirectives()?.exists}>
                <div class={cn("px-4 py-2 border-t border-border")}>
                  <For each={getDirectiveSummary(projectDirectives()?.content)}>
                    {(line) => <span class={cn("block text-xs text-muted-foreground truncate")}>{line}</span>}
                  </For>
                </div>
              </Show>
              <Show when={props.folder && !projectDirectives()?.exists}>
                <div class={cn("px-4 py-2 border-t border-border")}>
                  <button
                    type="button"
                    class={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                      "bg-accent text-muted-foreground hover:text-foreground"
                    )}
                    onClick={() => startEditDirective("project")}
                  >
                    <Plus class="w-4 h-4" /> Create Project Directives
                  </button>
                </div>
              </Show>
              <Show when={expandedSection() === "project" && projectDirectives()?.content}>
                <div class={cn("p-4 border-t border-border")}>
                  <pre class={cn("p-3 rounded-lg text-xs font-mono whitespace-pre-wrap break-all bg-accent text-muted-foreground overflow-auto max-h-[300px]")}>{projectDirectives()!.content}</pre>
                </div>
              </Show>
            </div>
          </div>
        </div>

        {/* Rules Section */}
        <div class={cn("flex flex-col gap-4")}>
          <div class={cn("flex items-center justify-between gap-4 flex-wrap")}>
            <h3 class={cn("text-sm font-semibold text-foreground")}>Active Rules</h3>
            <div class={cn("flex items-center gap-3 flex-wrap")}>
              {/* Search */}
              <div class={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg flex-1 max-w-xs bg-secondary border border-border")}>
                <Search class="w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search rules..."
                  class={cn("flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground")}
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
                              <div class={cn("p-3", !isBlocking() && "bg-success/5")}>
                                <div class={cn("flex items-start justify-between gap-3")}>
                                  <div class={cn("flex-1 min-w-0")}>
                                    <div class={cn("flex items-center gap-2 mb-1")}>
                                      <span class={cn("font-mono text-xs text-foreground")}>{rule.id}</span>
                                      <Show when={rule.source === "hardcoded"}>
                                        <Lock class="w-3 h-3 text-destructive" title="Cannot be overridden" />
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
        </div>

        {/* Edit Directive Modal */}
        <Show when={editingDirective()}>
          <div class={cn("fixed inset-0 flex items-center justify-center p-4 bg-black/60 z-[100]")} onClick={cancelEditDirective}>
            <div class={cn("w-full max-w-lg rounded-xl overflow-hidden bg-background border border-border shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]")} onClick={(e) => e.stopPropagation()}>
              <div class={cn("flex items-center justify-between px-6 py-4 border-b border-border")}>
                <h3 class={cn("text-lg font-semibold text-foreground")}>
                  {editingDirective() === "project" ? "Edit Project Directives" : "Edit Global Directives"}
                </h3>
                <button type="button" class={cn("p-1 rounded transition-colors text-muted-foreground hover:text-foreground")} onClick={cancelEditDirective}>
                  <X class="w-5 h-5" />
                </button>
              </div>
              <div class={cn("p-6")}>
                <textarea
                  class={cn(
                    "w-full rounded-lg p-4 text-sm resize-none min-h-[300px]",
                    "bg-secondary border border-border text-foreground",
                    "font-mono leading-relaxed",
                    "placeholder:text-muted-foreground",
                    "focus:outline-none focus:border-info"
                  )}
                  value={editContent()}
                  onInput={(e) => setEditContent(e.currentTarget.value)}
                  placeholder={`# ${editingDirective() === "project" ? "Project" : "Global"} Directives\n\nAdd your guidelines here...`}
                />
              </div>
              <div class={cn("flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-secondary")}>
                <Show when={saveMessage()}>
                  <span class={cn(
                    "text-sm mr-auto",
                    saveMessage()?.type === "error" ? "text-destructive" : "text-success"
                  )}>
                    {saveMessage()?.text}
                  </span>
                </Show>
                <Button variant="outline" size="sm" onClick={cancelEditDirective}>
                  Cancel
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSaveDirective}
                  disabled={isSaving()}
                >
                  {isSaving() ? <RefreshCw class="w-4 h-4 animate-spin" /> : "Save"}
                </Button>
              </div>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export default UnifiedGovernancePanel

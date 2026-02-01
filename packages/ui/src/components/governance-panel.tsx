import { Component, Show, For, createSignal, createEffect, onMount, createMemo } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, Shield, ShieldAlert, ShieldCheck, ShieldOff, AlertTriangle, Info, ChevronDown, ChevronRight, FileCode, FileText, Book, ExternalLink, ToggleLeft, ToggleRight } from "lucide-solid"
import { cn } from "../lib/cn"
import {
  governanceRules,
  governanceSummary,
  hardcodedRules,
  defaultRules,
  projectRules,
  isGovernanceLoading,
  governanceError,
  refreshGovernanceRules,
  isAuditMode,
  setRuleOverride,
  removeRuleOverride,
  type GovernanceRule,
} from "../stores/era-governance"
import {
  fetchDirectives,
  projectDirectives,
  globalDirectives,
  isDirectivesLoading,
} from "../stores/era-directives"
import GovernanceAdvancedPanel from "./governance-advanced-panel"
import DirectivesEditorPanel from "./directives-editor-panel"
import ConstitutionViewerPanel from "./constitution-viewer-panel"

interface GovernancePanelProps {
  open: boolean
  onClose: () => void
  folder?: string
}

const GovernancePanel: Component<GovernancePanelProps> = (props) => {
  const [expandedSections, setExpandedSections] = createSignal<Record<string, boolean>>({
    hardcoded: false,
    default: false,
    project: false,
    projectDirectives: false,
    globalDirectives: false,
  })
  const [advancedPanelOpen, setAdvancedPanelOpen] = createSignal(false)
  const [directivesPanelOpen, setDirectivesPanelOpen] = createSignal(false)
  const [constitutionPanelOpen, setConstitutionPanelOpen] = createSignal(false)
  const [issueModalOpen, setIssueModalOpen] = createSignal(false)
  const [togglingRules, setTogglingRules] = createSignal<Set<string>>(new Set())

  // Track which rules have overrides (action = "allow" means overridden)
  const overriddenRuleIds = createMemo(() => {
    return new Set(defaultRules().filter(r => r.action === "allow").map(r => r.id))
  })

  const activeOverridesCount = createMemo(() => overriddenRuleIds().size)

  onMount(() => {
    refreshGovernanceRules(props.folder)
    fetchDirectives(props.folder)
  })

  createEffect(() => {
    if (props.open && props.folder) {
      refreshGovernanceRules(props.folder)
      fetchDirectives(props.folder)
    }
  })

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }))
  }

  const handleRuleToggle = async (rule: GovernanceRule) => {
    if (!props.folder) return

    // Add to toggling set
    setTogglingRules(prev => new Set(prev).add(rule.id))

    try {
      if (rule.action === "deny") {
        // Currently denied, enable override (allow)
        await setRuleOverride(rule.id, "allow", "Enabled via UI toggle", props.folder)
      } else {
        // Currently allowed (overridden), remove override
        await removeRuleOverride(rule.id, props.folder)
      }
    } finally {
      // Remove from toggling set
      setTogglingRules(prev => {
        const next = new Set(prev)
        next.delete(rule.id)
        return next
      })
    }
  }

  const openGitHubIssue = () => {
    const title = encodeURIComponent("Governance Change Request")
    const body = encodeURIComponent(`## Requested Change

**Type:** [Rule Addition / Rule Modification / Rule Removal]

**Rule ID (if modifying/removing):**

**Pattern (if adding):**

## Justification

[Explain why this governance change is needed]

## Impact Assessment

- **Security Impact:** [Low / Medium / High]
- **Workflow Impact:** [Describe how this affects development workflows]

## Additional Context

[Any other relevant information]
`)
    window.open(`https://github.com/anthropics/era-code/issues/new?title=${title}&body=${body}`, "_blank")
  }

  return (
    <>
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="settings-panel-overlay" />
        <div class="fixed inset-y-0 right-0 z-50 flex">
          <Dialog.Content class="settings-panel governance-panel">
            <div class="flex items-center justify-between px-4 py-3 border-b border-border">
              <Dialog.Title class="text-sm font-semibold text-foreground">
                <Shield class="w-5 h-5" />
                <span>Governance Rules</span>
              </Dialog.Title>
              <Dialog.CloseButton class="settings-panel-close">
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            <div class="settings-panel-content">
              {/* Loading State */}
              <Show when={isGovernanceLoading()}>
                <div class={cn("flex items-center justify-center gap-3 py-8 text-muted-foreground")}>
                  <div class={cn("w-5 h-5 border-2 border-t-transparent border-muted-foreground rounded-full animate-spin")} />
                  <span>Loading governance rules...</span>
                </div>
              </Show>

              {/* Error State */}
              <Show when={governanceError()}>
                <div class={cn("flex items-center gap-2 p-4 rounded-md bg-destructive/10 text-destructive")}>
                  <AlertTriangle class="w-5 h-5" />
                  <span>{governanceError()}</span>
                </div>
              </Show>

              {/* Summary */}
              <Show when={!isGovernanceLoading() && governanceSummary()}>
                <div class={cn("flex flex-col gap-2 p-4 rounded-lg bg-secondary border border-border")}>
                  <div class={cn("flex items-center justify-between")}>
                    <span class={cn("text-sm text-muted-foreground")}>Total Rules</span>
                    <span class={cn("text-sm font-semibold text-foreground")}>{governanceSummary()!.totalRules}</span>
                  </div>
                  <div class={cn("flex items-center justify-between")}>
                    <span class={cn("text-sm text-muted-foreground")}>Active Overrides</span>
                    <span class={cn("text-sm font-semibold text-foreground")}>{activeOverridesCount()}</span>
                  </div>
                  <Show when={isAuditMode()}>
                    <div class={cn("flex items-center gap-2 mt-1 text-sm text-warning")}>
                      <Info class="w-4 h-4" />
                      <span>Audit Mode Active</span>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Quick Actions */}
              <Show when={!isGovernanceLoading()}>
                <div class={cn("flex items-center gap-2 mt-4")}>
                  <button
                    type="button"
                    class={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                      "bg-secondary border border-border text-foreground",
                      "hover:bg-accent"
                    )}
                    onClick={() => setAdvancedPanelOpen(true)}
                  >
                    <FileCode class="w-4 h-4" />
                    <span>Advanced Config</span>
                  </button>
                  <button
                    type="button"
                    class={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                      "bg-secondary border border-border text-foreground",
                      "hover:bg-accent"
                    )}
                    onClick={() => setDirectivesPanelOpen(true)}
                  >
                    <FileText class="w-4 h-4" />
                    <span>Directives</span>
                  </button>
                  <button
                    type="button"
                    class={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                      "bg-secondary border border-border text-foreground",
                      "hover:bg-accent",
                      "disabled:opacity-50 disabled:cursor-not-allowed"
                    )}
                    onClick={() => setConstitutionPanelOpen(true)}
                    disabled={!props.folder}
                  >
                    <Book class="w-4 h-4" />
                    <span>Constitution</span>
                  </button>
                </div>
              </Show>

              {/* Hardcoded Rules Section */}
              <Show when={!isGovernanceLoading() && hardcodedRules().length > 0}>
                <div class={cn("mt-4 rounded-lg border border-border overflow-hidden")}>
                  <button
                    class={cn(
                      "flex items-center gap-2 w-full px-4 py-3 text-left transition-colors",
                      "bg-secondary hover:bg-accent"
                    )}
                    onClick={() => toggleSection("hardcoded")}
                  >
                    {expandedSections().hardcoded ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <ShieldAlert class="w-4 h-4 text-destructive" />
                    <span class={cn("text-sm font-medium text-foreground")}>Hardcoded Rules</span>
                    <span class={cn("ml-auto text-xs px-2 py-0.5 rounded-full bg-accent text-muted-foreground")}>{hardcodedRules().length}</span>
                  </button>
                  <p class={cn("px-4 py-1 text-xs text-muted-foreground bg-secondary border-t border-border")}>
                    Safety rules that cannot be overridden
                  </p>
                  <Show when={expandedSections().hardcoded}>
                    <div class={cn("divide-y divide-border")}>
                      <For each={hardcodedRules()}>
                        {(rule) => (
                          <div class={cn("p-4")}>
                            <div class={cn("flex items-center gap-2 mb-1")}>
                              <span class={cn("font-mono text-xs text-foreground")}>{rule.id}</span>
                              <span class={cn("text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium")}>Deny</span>
                              <span class={cn("text-destructive")} title="Cannot be overridden">
                                <ShieldOff class="w-3 h-3" />
                              </span>
                            </div>
                            <div class={cn("mb-1")}>
                              <code class={cn("text-xs px-2 py-1 rounded font-mono bg-accent text-muted-foreground break-all")}>{rule.pattern}</code>
                            </div>
                            <div class={cn("text-sm text-muted-foreground")}>{rule.reason}</div>
                            <Show when={rule.suggestion}>
                              <div class={cn("flex items-center gap-2 mt-2 text-xs text-info")}>
                                <Info class="w-3 h-3" />
                                <span>{rule.suggestion}</span>
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Default Rules Section */}
              <Show when={!isGovernanceLoading() && defaultRules().length > 0}>
                <div class={cn("mt-4 rounded-lg border border-border overflow-hidden")}>
                  <button
                    class={cn(
                      "flex items-center gap-2 w-full px-4 py-3 text-left transition-colors",
                      "bg-secondary hover:bg-accent"
                    )}
                    onClick={() => toggleSection("default")}
                  >
                    {expandedSections().default ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <Shield class="w-4 h-4 text-warning" />
                    <span class={cn("text-sm font-medium text-foreground")}>Default Rules</span>
                    <span class={cn("ml-auto text-xs px-2 py-0.5 rounded-full bg-accent text-muted-foreground")}>{defaultRules().length}</span>
                  </button>
                  <p class={cn("px-4 py-1 text-xs text-muted-foreground bg-secondary border-t border-border")}>
                    Can be overridden in project governance config
                  </p>
                  <Show when={expandedSections().default}>
                    <div class={cn("divide-y divide-border")}>
                      <For each={defaultRules()}>
                        {(rule) => {
                          const isOverridden = () => rule.action === "allow"
                          const isToggling = () => togglingRules().has(rule.id)

                          return (
                            <div class={cn("p-4", isOverridden() && "bg-success/5")}>
                              <div class={cn("flex items-center gap-2 mb-1")}>
                                <span class={cn("font-mono text-xs text-foreground")}>{rule.id}</span>
                                <Show when={isOverridden()}>
                                  <span class={cn("text-xs px-2 py-0.5 rounded-full bg-success/10 text-success font-medium")}>Allow</span>
                                </Show>
                                <Show when={!isOverridden()}>
                                  <span class={cn("text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium")}>Deny</span>
                                </Show>
                                {/* Toggle Switch */}
                                <button
                                  type="button"
                                  class={cn(
                                    "flex items-center justify-center w-8 h-8 rounded transition-colors ml-auto",
                                    isOverridden()
                                      ? "text-success hover:opacity-80"
                                      : "text-muted-foreground hover:text-foreground",
                                    "disabled:opacity-50 disabled:cursor-not-allowed"
                                  )}
                                  onClick={() => handleRuleToggle(rule)}
                                  disabled={isToggling() || !props.folder}
                                  title={!props.folder ? "Open a project to toggle rules" : isOverridden() ? "Click to deny (remove override)" : "Click to allow (add override)"}
                                >
                                  <Show when={isToggling()}>
                                    <div class={cn("w-5 h-5 border-2 border-t-transparent border-current rounded-full animate-spin")} />
                                  </Show>
                                  <Show when={!isToggling()}>
                                    <Show when={isOverridden()}>
                                      <ToggleRight class="w-5 h-5" />
                                    </Show>
                                    <Show when={!isOverridden()}>
                                      <ToggleLeft class="w-5 h-5" />
                                    </Show>
                                  </Show>
                                </button>
                              </div>
                              <div class={cn("mb-1")}>
                                <code class={cn("text-xs px-2 py-1 rounded font-mono bg-accent text-muted-foreground break-all")}>{rule.pattern}</code>
                              </div>
                              <div class={cn("text-sm text-muted-foreground")}>{rule.reason}</div>
                              <Show when={rule.suggestion}>
                                <div class={cn("flex items-center gap-2 mt-2 text-xs text-info")}>
                                  <Info class="w-3 h-3" />
                                  <span>{rule.suggestion}</span>
                                </div>
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Project Rules Section */}
              <Show when={!isGovernanceLoading() && projectRules().length > 0}>
                <div class={cn("mt-4 rounded-lg border border-border overflow-hidden")}>
                  <button
                    class={cn(
                      "flex items-center gap-2 w-full px-4 py-3 text-left transition-colors",
                      "bg-secondary hover:bg-accent"
                    )}
                    onClick={() => toggleSection("project")}
                  >
                    {expandedSections().project ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <ShieldCheck class="w-4 h-4 text-info" />
                    <span class={cn("text-sm font-medium text-foreground")}>Project Rules</span>
                    <span class={cn("ml-auto text-xs px-2 py-0.5 rounded-full bg-accent text-muted-foreground")}>{projectRules().length}</span>
                  </button>
                  <p class={cn("px-4 py-1 text-xs text-muted-foreground bg-secondary border-t border-border")}>
                    Custom rules defined in this project
                  </p>
                  <Show when={expandedSections().project}>
                    <div class={cn("divide-y divide-border")}>
                      <For each={projectRules()}>
                        {(rule) => {
                          const isOverridden = () => rule.action === "allow"
                          const isToggling = () => togglingRules().has(rule.id)

                          return (
                            <div class={cn("p-4", isOverridden() && "bg-success/5")}>
                              <div class={cn("flex items-center gap-2 mb-1")}>
                                <span class={cn("font-mono text-xs text-foreground")}>{rule.id}</span>
                                <Show when={rule.action === "allow"}>
                                  <span class={cn("text-xs px-2 py-0.5 rounded-full bg-success/10 text-success font-medium")}>Allow</span>
                                </Show>
                                <Show when={rule.action === "deny"}>
                                  <span class={cn("text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium")}>Deny</span>
                                </Show>
                                {/* Toggle Switch for project rules */}
                                <button
                                  type="button"
                                  class={cn(
                                    "flex items-center justify-center w-8 h-8 rounded transition-colors ml-auto",
                                    isOverridden()
                                      ? "text-success hover:opacity-80"
                                      : "text-muted-foreground hover:text-foreground",
                                    "disabled:opacity-50 disabled:cursor-not-allowed"
                                  )}
                                  onClick={() => handleRuleToggle(rule)}
                                  disabled={isToggling() || !props.folder}
                                  title={!props.folder ? "Open a project to toggle rules" : isOverridden() ? "Click to deny (remove override)" : "Click to allow (add override)"}
                                >
                                  <Show when={isToggling()}>
                                    <div class={cn("w-5 h-5 border-2 border-t-transparent border-current rounded-full animate-spin")} />
                                  </Show>
                                  <Show when={!isToggling()}>
                                    <Show when={isOverridden()}>
                                      <ToggleRight class="w-5 h-5" />
                                    </Show>
                                    <Show when={!isOverridden()}>
                                      <ToggleLeft class="w-5 h-5" />
                                    </Show>
                                  </Show>
                                </button>
                              </div>
                              <div class={cn("mb-1")}>
                                <code class={cn("text-xs px-2 py-1 rounded font-mono bg-accent text-muted-foreground break-all")}>{rule.pattern}</code>
                              </div>
                              <div class={cn("text-sm text-muted-foreground")}>{rule.reason}</div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Project Directives Section */}
              <Show when={!isDirectivesLoading()}>
                <div class={cn("mt-4 rounded-lg border border-border overflow-hidden")}>
                  <button
                    class={cn(
                      "flex items-center gap-2 w-full px-4 py-3 text-left transition-colors",
                      "bg-secondary hover:bg-accent"
                    )}
                    onClick={() => toggleSection("projectDirectives")}
                  >
                    {expandedSections().projectDirectives ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <FileText class="w-4 h-4 text-info" />
                    <span class={cn("text-sm font-medium text-foreground")}>Project Directives</span>
                    <Show when={projectDirectives()?.exists}>
                      <span class={cn("ml-auto text-xs px-2 py-0.5 rounded-full bg-accent text-muted-foreground")}>1</span>
                    </Show>
                  </button>
                  <p class={cn("px-4 py-1 text-xs text-muted-foreground bg-secondary border-t border-border")}>
                    Project-specific development guidelines
                  </p>
                  <Show when={expandedSections().projectDirectives}>
                    <div class={cn("p-4")}>
                      <Show when={projectDirectives()?.exists && projectDirectives()?.content}>
                        <div class={cn("mb-3")}>
                          <pre class={cn("p-3 rounded-lg text-xs font-mono whitespace-pre-wrap break-all bg-accent text-muted-foreground overflow-auto max-h-[200px]")}>{projectDirectives()!.content.slice(0, 500)}{projectDirectives()!.content.length > 500 ? "..." : ""}</pre>
                        </div>
                        <button
                          type="button"
                          class={cn(
                            "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                            "bg-info/10 text-info hover:bg-info/20"
                          )}
                          onClick={() => setDirectivesPanelOpen(true)}
                        >
                          Edit Directives
                        </button>
                      </Show>
                      <Show when={!projectDirectives()?.exists}>
                        <div class={cn("text-center py-4")}>
                          <p class={cn("text-sm text-muted-foreground mb-3")}>No project directives configured.</p>
                          <button
                            type="button"
                            class={cn(
                              "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                              "bg-info/10 text-info hover:bg-info/20"
                            )}
                            onClick={() => setDirectivesPanelOpen(true)}
                          >
                            Create Directives
                          </button>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Global Directives Section */}
              <Show when={!isDirectivesLoading()}>
                <div class={cn("mt-4 rounded-lg border border-border overflow-hidden")}>
                  <button
                    class={cn(
                      "flex items-center gap-2 w-full px-4 py-3 text-left transition-colors",
                      "bg-secondary hover:bg-accent"
                    )}
                    onClick={() => toggleSection("globalDirectives")}
                  >
                    {expandedSections().globalDirectives ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <FileText class="w-4 h-4 text-success" />
                    <span class={cn("text-sm font-medium text-foreground")}>Global Directives</span>
                    <Show when={globalDirectives()?.exists}>
                      <span class={cn("ml-auto text-xs px-2 py-0.5 rounded-full bg-accent text-muted-foreground")}>1</span>
                    </Show>
                  </button>
                  <p class={cn("px-4 py-1 text-xs text-muted-foreground bg-secondary border-t border-border")}>
                    Guidelines that apply across all projects
                  </p>
                  <Show when={expandedSections().globalDirectives}>
                    <div class={cn("p-4")}>
                      <Show when={globalDirectives()?.exists && globalDirectives()?.content}>
                        <div class={cn("mb-3")}>
                          <pre class={cn("p-3 rounded-lg text-xs font-mono whitespace-pre-wrap break-all bg-accent text-muted-foreground overflow-auto max-h-[200px]")}>{globalDirectives()!.content.slice(0, 500)}{globalDirectives()!.content.length > 500 ? "..." : ""}</pre>
                        </div>
                        <button
                          type="button"
                          class={cn(
                            "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                            "bg-info/10 text-info hover:bg-info/20"
                          )}
                          onClick={() => setDirectivesPanelOpen(true)}
                        >
                          Edit Directives
                        </button>
                      </Show>
                      <Show when={!globalDirectives()?.exists}>
                        <div class={cn("text-center py-4")}>
                          <p class={cn("text-sm text-muted-foreground mb-3")}>No global directives configured.</p>
                          <button
                            type="button"
                            class={cn(
                              "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                              "bg-info/10 text-info hover:bg-info/20"
                            )}
                            onClick={() => setDirectivesPanelOpen(true)}
                          >
                            Create Directives
                          </button>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Constitution Section with GitHub Issue Button */}
              <Show when={!isGovernanceLoading()}>
                <div class={cn("mt-4 rounded-lg border border-border overflow-hidden")}>
                  <div class={cn("flex items-center justify-between px-4 py-3 bg-secondary")}>
                    <div class={cn("flex items-center gap-2")}>
                      <Book class="w-4 h-4 text-info" />
                      <span class={cn("text-sm font-medium text-foreground")}>Constitution</span>
                    </div>
                    <button
                      type="button"
                      class={cn(
                        "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                        "bg-accent text-foreground hover:bg-accent/80",
                        "disabled:opacity-50 disabled:cursor-not-allowed"
                      )}
                      onClick={() => setConstitutionPanelOpen(true)}
                      disabled={!props.folder}
                    >
                      View
                    </button>
                  </div>
                  <p class={cn("px-4 py-1 text-xs text-muted-foreground bg-secondary border-t border-border")}>
                    Immutable architectural constraints for this project
                  </p>
                  <div class={cn("px-4 py-3 border-t border-border")}>
                    <button
                      type="button"
                      class={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full justify-center",
                        "bg-secondary border border-dashed border-border text-muted-foreground",
                        "hover:border-info hover:text-info"
                      )}
                      onClick={openGitHubIssue}
                    >
                      <ExternalLink class="w-4 h-4" />
                      <span>Request Governance Change</span>
                    </button>
                  </div>
                </div>
              </Show>

              {/* No Rules State */}
              <Show when={!isGovernanceLoading() && !governanceError() && governanceRules().length === 0}>
                <div class={cn("flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground")}>
                  <Shield class="w-8 h-8 opacity-50" />
                  <span>No governance rules found</span>
                </div>
              </Show>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>

    {/* Advanced Config Panel */}
    <GovernanceAdvancedPanel
      open={advancedPanelOpen()}
      onClose={() => setAdvancedPanelOpen(false)}
      folder={props.folder}
    />

    {/* Directives Editor Panel */}
    <DirectivesEditorPanel
      open={directivesPanelOpen()}
      onClose={() => setDirectivesPanelOpen(false)}
      folder={props.folder}
    />

    {/* Constitution Viewer Panel */}
    <ConstitutionViewerPanel
      open={constitutionPanelOpen()}
      onClose={() => setConstitutionPanelOpen(false)}
      folder={props.folder}
    />
    </>
  )
}

export default GovernancePanel

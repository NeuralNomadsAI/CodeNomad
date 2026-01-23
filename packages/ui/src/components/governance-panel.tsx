import { Component, Show, For, createSignal, createEffect, onMount, createMemo } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, Shield, ShieldAlert, ShieldCheck, ShieldOff, AlertTriangle, Info, ChevronDown, ChevronRight, FileCode, FileText, Book, ExternalLink, ToggleLeft, ToggleRight } from "lucide-solid"
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
            <div class="settings-panel-header">
              <Dialog.Title class="settings-panel-title">
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
                <div class="governance-loading">
                  <div class="governance-loading-spinner" />
                  <span>Loading governance rules...</span>
                </div>
              </Show>

              {/* Error State */}
              <Show when={governanceError()}>
                <div class="governance-error">
                  <AlertTriangle class="w-5 h-5" />
                  <span>{governanceError()}</span>
                </div>
              </Show>

              {/* Summary */}
              <Show when={!isGovernanceLoading() && governanceSummary()}>
                <div class="governance-summary">
                  <div class="governance-summary-row">
                    <span class="governance-summary-label">Total Rules</span>
                    <span class="governance-summary-value">{governanceSummary()!.totalRules}</span>
                  </div>
                  <div class="governance-summary-row">
                    <span class="governance-summary-label">Active Overrides</span>
                    <span class="governance-summary-value">{activeOverridesCount()}</span>
                  </div>
                  <Show when={isAuditMode()}>
                    <div class="governance-audit-mode">
                      <Info class="w-4 h-4" />
                      <span>Audit Mode Active</span>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Quick Actions */}
              <Show when={!isGovernanceLoading()}>
                <div class="governance-quick-actions">
                  <button
                    type="button"
                    class="governance-quick-action"
                    onClick={() => setAdvancedPanelOpen(true)}
                  >
                    <FileCode class="w-4 h-4" />
                    <span>Advanced Config</span>
                  </button>
                  <button
                    type="button"
                    class="governance-quick-action"
                    onClick={() => setDirectivesPanelOpen(true)}
                  >
                    <FileText class="w-4 h-4" />
                    <span>Directives</span>
                  </button>
                  <button
                    type="button"
                    class="governance-quick-action"
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
                <div class="governance-section">
                  <button
                    class="governance-section-header"
                    onClick={() => toggleSection("hardcoded")}
                  >
                    {expandedSections().hardcoded ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <ShieldAlert class="w-4 h-4 text-red-400" />
                    <span>Hardcoded Rules</span>
                    <span class="governance-section-count">{hardcodedRules().length}</span>
                  </button>
                  <p class="governance-section-description">
                    Safety rules that cannot be overridden
                  </p>
                  <Show when={expandedSections().hardcoded}>
                    <div class="governance-rules-list">
                      <For each={hardcodedRules()}>
                        {(rule) => (
                          <div class="governance-rule">
                            <div class="governance-rule-header">
                              <span class="governance-rule-id">{rule.id}</span>
                              <span class="governance-action-badge governance-action-deny">Deny</span>
                              <span class="governance-rule-locked" title="Cannot be overridden">
                                <ShieldOff class="w-3 h-3" />
                              </span>
                            </div>
                            <div class="governance-rule-pattern">
                              <code>{rule.pattern}</code>
                            </div>
                            <div class="governance-rule-reason">{rule.reason}</div>
                            <Show when={rule.suggestion}>
                              <div class="governance-rule-suggestion">
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
                <div class="governance-section">
                  <button
                    class="governance-section-header"
                    onClick={() => toggleSection("default")}
                  >
                    {expandedSections().default ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <Shield class="w-4 h-4 text-yellow-400" />
                    <span>Default Rules</span>
                    <span class="governance-section-count">{defaultRules().length}</span>
                  </button>
                  <p class="governance-section-description">
                    Can be overridden in project governance config
                  </p>
                  <Show when={expandedSections().default}>
                    <div class="governance-rules-list">
                      <For each={defaultRules()}>
                        {(rule) => {
                          const isOverridden = () => rule.action === "allow"
                          const isToggling = () => togglingRules().has(rule.id)

                          return (
                            <div class={`governance-rule ${isOverridden() ? "governance-rule-overridden" : ""}`}>
                              <div class="governance-rule-header">
                                <span class="governance-rule-id">{rule.id}</span>
                                <Show when={isOverridden()}>
                                  <span class="governance-action-badge governance-action-allow">Allow</span>
                                </Show>
                                <Show when={!isOverridden()}>
                                  <span class="governance-action-badge governance-action-deny">Deny</span>
                                </Show>
                                {/* Toggle Switch */}
                                <button
                                  type="button"
                                  class={`governance-rule-toggle ${isOverridden() ? "governance-rule-toggle-on" : "governance-rule-toggle-off"}`}
                                  onClick={() => handleRuleToggle(rule)}
                                  disabled={isToggling() || !props.folder}
                                  title={!props.folder ? "Open a project to toggle rules" : isOverridden() ? "Click to deny (remove override)" : "Click to allow (add override)"}
                                >
                                  <Show when={isToggling()}>
                                    <div class="governance-rule-toggle-spinner" />
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
                              <div class="governance-rule-pattern">
                                <code>{rule.pattern}</code>
                              </div>
                              <div class="governance-rule-reason">{rule.reason}</div>
                              <Show when={rule.suggestion}>
                                <div class="governance-rule-suggestion">
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
                <div class="governance-section">
                  <button
                    class="governance-section-header"
                    onClick={() => toggleSection("project")}
                  >
                    {expandedSections().project ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <ShieldCheck class="w-4 h-4 text-blue-400" />
                    <span>Project Rules</span>
                    <span class="governance-section-count">{projectRules().length}</span>
                  </button>
                  <p class="governance-section-description">
                    Custom rules defined in this project
                  </p>
                  <Show when={expandedSections().project}>
                    <div class="governance-rules-list">
                      <For each={projectRules()}>
                        {(rule) => {
                          const isOverridden = () => rule.action === "allow"
                          const isToggling = () => togglingRules().has(rule.id)

                          return (
                            <div class={`governance-rule ${isOverridden() ? "governance-rule-overridden" : ""}`}>
                              <div class="governance-rule-header">
                                <span class="governance-rule-id">{rule.id}</span>
                                <Show when={rule.action === "allow"}>
                                  <span class="governance-action-badge governance-action-allow">Allow</span>
                                </Show>
                                <Show when={rule.action === "deny"}>
                                  <span class="governance-action-badge governance-action-deny">Deny</span>
                                </Show>
                                {/* Toggle Switch for project rules */}
                                <button
                                  type="button"
                                  class={`governance-rule-toggle ${isOverridden() ? "governance-rule-toggle-on" : "governance-rule-toggle-off"}`}
                                  onClick={() => handleRuleToggle(rule)}
                                  disabled={isToggling() || !props.folder}
                                  title={!props.folder ? "Open a project to toggle rules" : isOverridden() ? "Click to deny (remove override)" : "Click to allow (add override)"}
                                >
                                  <Show when={isToggling()}>
                                    <div class="governance-rule-toggle-spinner" />
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
                              <div class="governance-rule-pattern">
                                <code>{rule.pattern}</code>
                              </div>
                              <div class="governance-rule-reason">{rule.reason}</div>
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
                <div class="governance-section">
                  <button
                    class="governance-section-header"
                    onClick={() => toggleSection("projectDirectives")}
                  >
                    {expandedSections().projectDirectives ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <FileText class="w-4 h-4 text-purple-400" />
                    <span>Project Directives</span>
                    <Show when={projectDirectives()?.exists}>
                      <span class="governance-section-count">1</span>
                    </Show>
                  </button>
                  <p class="governance-section-description">
                    Project-specific development guidelines
                  </p>
                  <Show when={expandedSections().projectDirectives}>
                    <div class="governance-directives-content">
                      <Show when={projectDirectives()?.exists && projectDirectives()?.content}>
                        <div class="governance-directive-preview">
                          <pre>{projectDirectives()!.content.slice(0, 500)}{projectDirectives()!.content.length > 500 ? "..." : ""}</pre>
                        </div>
                        <button
                          type="button"
                          class="governance-directive-edit-btn"
                          onClick={() => setDirectivesPanelOpen(true)}
                        >
                          Edit Directives
                        </button>
                      </Show>
                      <Show when={!projectDirectives()?.exists}>
                        <div class="governance-directives-empty">
                          <p>No project directives configured.</p>
                          <button
                            type="button"
                            class="governance-directive-create-btn"
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
                <div class="governance-section">
                  <button
                    class="governance-section-header"
                    onClick={() => toggleSection("globalDirectives")}
                  >
                    {expandedSections().globalDirectives ? (
                      <ChevronDown class="w-4 h-4" />
                    ) : (
                      <ChevronRight class="w-4 h-4" />
                    )}
                    <FileText class="w-4 h-4 text-green-400" />
                    <span>Global Directives</span>
                    <Show when={globalDirectives()?.exists}>
                      <span class="governance-section-count">1</span>
                    </Show>
                  </button>
                  <p class="governance-section-description">
                    Guidelines that apply across all projects
                  </p>
                  <Show when={expandedSections().globalDirectives}>
                    <div class="governance-directives-content">
                      <Show when={globalDirectives()?.exists && globalDirectives()?.content}>
                        <div class="governance-directive-preview">
                          <pre>{globalDirectives()!.content.slice(0, 500)}{globalDirectives()!.content.length > 500 ? "..." : ""}</pre>
                        </div>
                        <button
                          type="button"
                          class="governance-directive-edit-btn"
                          onClick={() => setDirectivesPanelOpen(true)}
                        >
                          Edit Directives
                        </button>
                      </Show>
                      <Show when={!globalDirectives()?.exists}>
                        <div class="governance-directives-empty">
                          <p>No global directives configured.</p>
                          <button
                            type="button"
                            class="governance-directive-create-btn"
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
                <div class="governance-section governance-section-constitution">
                  <div class="governance-constitution-header">
                    <div class="governance-constitution-info">
                      <Book class="w-4 h-4 text-blue-400" />
                      <span>Constitution</span>
                    </div>
                    <button
                      type="button"
                      class="governance-constitution-view-btn"
                      onClick={() => setConstitutionPanelOpen(true)}
                      disabled={!props.folder}
                    >
                      View
                    </button>
                  </div>
                  <p class="governance-section-description">
                    Immutable architectural constraints for this project
                  </p>
                  <button
                    type="button"
                    class="governance-request-change-btn"
                    onClick={openGitHubIssue}
                  >
                    <ExternalLink class="w-4 h-4" />
                    <span>Request Governance Change</span>
                  </button>
                </div>
              </Show>

              {/* No Rules State */}
              <Show when={!isGovernanceLoading() && !governanceError() && governanceRules().length === 0}>
                <div class="governance-empty">
                  <Shield class="w-8 h-8" />
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

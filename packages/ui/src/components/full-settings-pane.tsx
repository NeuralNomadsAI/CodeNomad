import { Component, Show, createSignal, For, createMemo, onMount, createEffect } from "solid-js"
import { Portal } from "solid-js/web"
import { Dialog } from "@kobalte/core/dialog"
import {
  ArrowLeft,
  X,
  Settings,
  MonitorPlay,
  Cpu,
  Key,
  Plug,
  Zap,
  Shield,
  FileText,
  Terminal,
  User,
  Sparkles,
  Info,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Check,
  AlertCircle,
  Github,
  Lock,
  Globe,
  Plus,
  Trash2,
  Edit2,
  Save,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  AlertTriangle,
  ToggleLeft,
  ToggleRight,
  Book,
  FileCode,
  FolderCog,
  Folder,
} from "lucide-solid"
import UnifiedGovernancePanel from "./unified-governance-panel"
import ConstitutionPanel from "./constitution-panel"
import GlobalDirectivesPanel from "./global-directives-panel"
import ProjectDirectivesPanel from "./project-directives-panel"
import ActiveRulesPanel from "./active-rules-panel"
import type { Instance } from "../types/instance"
import {
  preferences,
  toggleShowThinkingBlocks,
  toggleShowTimelineTools,
  toggleUsageMetrics,
  toggleDefaultToolCallsCollapsed,
  toggleShowVerboseOutput,
  toggleAutoApprovePermissions,
  toggleAutoCleanupBlankSessions,
  toggleStopInstanceOnLastSessionDelete,
  setDiffViewMode,
  setThinkingBlocksExpansion,
  setToolOutputExpansion,
  setDiagnosticsExpansion,
  useConfig,
} from "../stores/preferences"
import {
  isEraInstalled,
  eraVersion,
  eraAssetCounts,
  areEraAssetsAvailable,
} from "../stores/era-status"
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
  saveDirectives,
} from "../stores/era-directives"
import { getCommands, fetchCommands } from "../stores/commands"
import { instances } from "../stores/instances"
import McpSettingsPanel from "./mcp-settings-panel"
// ProviderSettingsPanel removed - functionality now in ProviderConfigModal via Model Catalog
import EnvironmentVariablesEditor from "./environment-variables-editor"
import type { Command as SDKCommand } from "@opencode-ai/sdk"
import {
  syncModelsData,
  getModelsCacheStatus,
  getModelsData,
  isModelsSyncing,
  getAllProviders,
  getProviderLogoUrl,
  getModel,
  formatModelCost,
  type ModelsDevModel,
} from "../lib/models-api"
import ModelCatalogPanel from "./model-catalog-panel"
import ProviderConfigModal from "./provider-config-modal"
import { providers as instanceProviders } from "../stores/sessions"
import {
  isGCloudAuthenticated,
  isGCloudExpired,
  gcloudAccount,
  gcloudProject,
  gcloudTokenExpiry,
  formatTokenExpiry,
  checkGCloudAuth,
  gcloudLogout,
  isGCloudLoading,
} from "../stores/gcloud-auth"
import {
  isGitHubAuthenticated,
  isGitHubLoading,
  githubUsername,
  githubError,
  checkGitHubAuth,
  initiateGitHubLogin,
  githubLogout,
  isGhCliInstalled,
  isGhCliChecked,
  checkGhCliInstalled,
  installGhCli,
} from "../stores/github-auth"

type SettingsSection =
  | "general"
  | "session"
  | "models"
  | "mcp"
  | "commands"
  | "governance-constitution"
  | "governance-global"
  | "governance-project"
  | "governance-rules"
  | "environment"
  | "accounts"
  | "era-code"
  | "about"

interface FullSettingsPaneProps {
  open: boolean
  onClose: () => void
  instance: Instance | null
  initialSection?: SettingsSection
  onOpenGCloudModal?: () => void
}

const FullSettingsPane: Component<FullSettingsPaneProps> = (props) => {
  const [activeSection, setActiveSection] = createSignal<SettingsSection>(
    props.initialSection ?? "general"
  )

  const navSections = [
    {
      title: "Application",
      items: [
        { id: "general" as const, label: "General", icon: Settings },
        { id: "session" as const, label: "Session", icon: MonitorPlay },
      ],
    },
    {
      title: "AI",
      items: [
        { id: "models" as const, label: "Models", icon: Cpu },
      ],
    },
    {
      title: "Integrations",
      items: [
        { id: "mcp" as const, label: "MCP Servers", icon: Plug },
        { id: "commands" as const, label: "Slash Commands", icon: Zap },
      ],
    },
    {
      title: "Governance",
      items: [
        { id: "governance-constitution" as const, label: "Constitution", icon: Lock },
        { id: "governance-global" as const, label: "Global Directives", icon: Globe },
        { id: "governance-project" as const, label: "Project Directives", icon: FolderCog },
        { id: "governance-rules" as const, label: "Active Rules", icon: ShieldCheck },
      ],
    },
    {
      title: "System",
      items: [
        { id: "environment" as const, label: "Environment", icon: Terminal },
        { id: "accounts" as const, label: "Accounts", icon: User },
        { id: "era-code" as const, label: "Era Code", icon: Sparkles },
        { id: "about" as const, label: "About", icon: Info },
      ],
    },
  ]

  const renderSection = () => {
    switch (activeSection()) {
      case "general":
        return <GeneralSection />
      case "session":
        return <SessionSection />
      case "models":
        return <ModelsSection />
      case "mcp":
        return <McpSection folder={props.instance?.folder} />
      case "commands":
        return <CommandsSection instanceId={props.instance?.id} />
      case "governance-constitution":
        return <ConstitutionPanel folder={props.instance?.folder} />
      case "governance-global":
        return <GlobalDirectivesPanel folder={props.instance?.folder} />
      case "governance-project":
        return <ProjectDirectivesPanel folder={props.instance?.folder} />
      case "governance-rules":
        return <ActiveRulesPanel folder={props.instance?.folder} />
      case "environment":
        return <EnvironmentSection instance={props.instance} />
      case "accounts":
        return <AccountsSection onOpenGCloudModal={props.onOpenGCloudModal} />
      case "era-code":
        return <EraCodeSection />
      case "about":
        return <AboutSection />
      default:
        return null
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <div class="full-settings-overlay">
          <div class="full-settings-container">
            {/* Header */}
            <header class="full-settings-header">
              <div class="full-settings-header-left">
                <button
                  type="button"
                  class="full-settings-back-btn"
                  onClick={props.onClose}
                >
                  <ArrowLeft class="w-4 h-4" />
                  <span>Back</span>
                </button>
                <h1 class="full-settings-title">Settings</h1>
              </div>
              <div class="full-settings-header-right">
                <button
                  type="button"
                  class="full-settings-close-btn"
                  onClick={props.onClose}
                >
                  <X class="w-5 h-5" />
                </button>
              </div>
            </header>

            {/* Main content */}
            <div class="full-settings-main">
              {/* Navigation */}
              <nav class="full-settings-nav">
                <For each={navSections}>
                  {(section) => (
                    <div class="full-settings-nav-section">
                      <div class="full-settings-nav-section-title">{section.title}</div>
                      <For each={section.items}>
                        {(item) => (
                          <button
                            type="button"
                            class={`full-settings-nav-item ${activeSection() === item.id ? "active" : ""}`}
                            onClick={() => setActiveSection(item.id)}
                          >
                            <item.icon />
                            <span>{item.label}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </nav>

              {/* Content */}
              <div class="full-settings-content">
                <div class={`full-settings-content-inner ${activeSection() === "models" ? "wide" : ""}`}>
                  {renderSection()}
                </div>
              </div>
            </div>
          </div>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

// ============================================
// Section Components
// ============================================

const GeneralSection: Component = () => {
  const { preferences: prefs, setDiffViewMode, setThinkingBlocksExpansion, setToolOutputExpansion, setDiagnosticsExpansion } = useConfig()

  return (
    <div class="full-settings-section">
      <h2 class="full-settings-section-title">General</h2>
      <p class="full-settings-section-subtitle">Display and interface settings</p>

      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Display Options</h3>

        <div class="full-settings-toggle-row">
          <div class="full-settings-toggle-info">
            <div class="full-settings-toggle-title">Show thinking blocks</div>
            <div class="full-settings-toggle-description">Display Claude's reasoning process</div>
          </div>
          <button
            type="button"
            class={`full-settings-toggle-switch ${prefs().showThinkingBlocks ? "active" : ""}`}
            onClick={toggleShowThinkingBlocks}
          >
            <span class="full-settings-toggle-switch-handle" />
          </button>
        </div>

        <div class="full-settings-toggle-row">
          <div class="full-settings-toggle-info">
            <div class="full-settings-toggle-title">Show timeline tools</div>
            <div class="full-settings-toggle-description">Display tool timeline in session view</div>
          </div>
          <button
            type="button"
            class={`full-settings-toggle-switch ${prefs().showTimelineTools ? "active" : ""}`}
            onClick={toggleShowTimelineTools}
          >
            <span class="full-settings-toggle-switch-handle" />
          </button>
        </div>

        <div class="full-settings-toggle-row">
          <div class="full-settings-toggle-info">
            <div class="full-settings-toggle-title">Show usage metrics</div>
            <div class="full-settings-toggle-description">Display token and cost information</div>
          </div>
          <button
            type="button"
            class={`full-settings-toggle-switch ${prefs().showUsageMetrics ? "active" : ""}`}
            onClick={toggleUsageMetrics}
          >
            <span class="full-settings-toggle-switch-handle" />
          </button>
        </div>
      </div>

      <div class="full-settings-section-divider" />

      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Diff View</h3>

        <div class="full-settings-radio-group">
          <button
            type="button"
            class={`full-settings-radio-option ${prefs().diffViewMode === "split" ? "selected" : ""}`}
            onClick={() => setDiffViewMode("split")}
          >
            <div class="full-settings-radio-circle" />
            <span class="full-settings-radio-label">Split View</span>
          </button>
          <button
            type="button"
            class={`full-settings-radio-option ${prefs().diffViewMode === "unified" ? "selected" : ""}`}
            onClick={() => setDiffViewMode("unified")}
          >
            <div class="full-settings-radio-circle" />
            <span class="full-settings-radio-label">Unified View</span>
          </button>
        </div>
      </div>

      <div class="full-settings-section-divider" />

      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Default Expansions</h3>

        <div class="full-settings-field">
          <label class="full-settings-field-label">Thinking blocks</label>
          <select
            class="full-settings-select"
            value={prefs().thinkingBlocksExpansion ?? "expanded"}
            onChange={(e) => setThinkingBlocksExpansion(e.currentTarget.value as "expanded" | "collapsed")}
          >
            <option value="expanded">Expanded</option>
            <option value="collapsed">Collapsed</option>
          </select>
        </div>

        <div class="full-settings-field">
          <label class="full-settings-field-label">Tool output</label>
          <select
            class="full-settings-select"
            value={prefs().toolOutputExpansion ?? "collapsed"}
            onChange={(e) => setToolOutputExpansion(e.currentTarget.value as "expanded" | "collapsed")}
          >
            <option value="expanded">Expanded</option>
            <option value="collapsed">Collapsed</option>
          </select>
        </div>

        <div class="full-settings-field">
          <label class="full-settings-field-label">Diagnostics</label>
          <select
            class="full-settings-select"
            value={prefs().diagnosticsExpansion ?? "collapsed"}
            onChange={(e) => setDiagnosticsExpansion(e.currentTarget.value as "expanded" | "collapsed")}
          >
            <option value="expanded">Expanded</option>
            <option value="collapsed">Collapsed</option>
          </select>
        </div>
      </div>
    </div>
  )
}

const SessionSection: Component = () => {
  const { preferences: prefs } = useConfig()

  return (
    <div class="full-settings-section">
      <h2 class="full-settings-section-title">Session</h2>
      <p class="full-settings-section-subtitle">Session behavior and permissions</p>

      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Permissions</h3>

        <div class="full-settings-toggle-row">
          <div class="full-settings-toggle-info">
            <div class="full-settings-toggle-title">Auto-approve permissions</div>
            <div class="full-settings-toggle-description">
              Skip permission prompts for file edits and commands
              (equivalent to --dangerously-skip-permissions)
            </div>
          </div>
          <button
            type="button"
            class={`full-settings-toggle-switch ${prefs().autoApprovePermissions ? "active" : ""}`}
            onClick={toggleAutoApprovePermissions}
          >
            <span class="full-settings-toggle-switch-handle" />
          </button>
        </div>
      </div>

      <div class="full-settings-section-divider" />

      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Session Behavior</h3>

        <div class="full-settings-toggle-row">
          <div class="full-settings-toggle-info">
            <div class="full-settings-toggle-title">Auto-cleanup blank sessions</div>
            <div class="full-settings-toggle-description">Remove sessions with no messages on close</div>
          </div>
          <button
            type="button"
            class={`full-settings-toggle-switch ${prefs().autoCleanupBlankSessions ? "active" : ""}`}
            onClick={toggleAutoCleanupBlankSessions}
          >
            <span class="full-settings-toggle-switch-handle" />
          </button>
        </div>

        <div class="full-settings-toggle-row">
          <div class="full-settings-toggle-info">
            <div class="full-settings-toggle-title">Stop instance on last session delete</div>
            <div class="full-settings-toggle-description">Terminate instance when all sessions are closed</div>
          </div>
          <button
            type="button"
            class={`full-settings-toggle-switch ${prefs().stopInstanceOnLastSessionDelete ? "active" : ""}`}
            onClick={toggleStopInstanceOnLastSessionDelete}
          >
            <span class="full-settings-toggle-switch-handle" />
          </button>
        </div>
      </div>

      <div class="full-settings-section-divider" />

      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Chat Window</h3>

        <div class="full-settings-toggle-row">
          <div class="full-settings-toggle-info">
            <div class="full-settings-toggle-title">Collapse tool calls by default</div>
            <div class="full-settings-toggle-description">Tool call sections start collapsed in messages</div>
          </div>
          <button
            type="button"
            class={`full-settings-toggle-switch ${prefs().defaultToolCallsCollapsed ? "active" : ""}`}
            onClick={toggleDefaultToolCallsCollapsed}
          >
            <span class="full-settings-toggle-switch-handle" />
          </button>
        </div>

        <div class="full-settings-toggle-row">
          <div class="full-settings-toggle-info">
            <div class="full-settings-toggle-title">Show verbose output</div>
            <div class="full-settings-toggle-description">Display real-time streaming text while generating</div>
          </div>
          <button
            type="button"
            class={`full-settings-toggle-switch ${prefs().showVerboseOutput ? "active" : ""}`}
            onClick={toggleShowVerboseOutput}
          >
            <span class="full-settings-toggle-switch-handle" />
          </button>
        </div>
      </div>
    </div>
  )
}

type AgentType = "main" | "plan" | "explore"

interface DefaultModels {
  main: { providerId: string; modelId: string }
  plan: { providerId: string; modelId: string }
  explore: { providerId: string; modelId: string }
}

const ModelsSection: Component = () => {
  const { preferences, setDefaultModels } = useConfig()
  const [lastUpdated, setLastUpdated] = createSignal<number | null>(null)
  const [syncError, setSyncError] = createSignal<string | null>(null)
  const [editingAgent, setEditingAgent] = createSignal<AgentType | null>(null)

  // Get default models from preferences or use defaults
  const defaultModels = createMemo((): DefaultModels => {
    const saved = preferences().modelDefaultsByAgent
    return {
      main: saved?.main ?? { providerId: "anthropic", modelId: "claude-sonnet-4-20250514" },
      plan: saved?.plan ?? { providerId: "anthropic", modelId: "claude-sonnet-4-20250514" },
      explore: saved?.explore ?? { providerId: "anthropic", modelId: "claude-3-5-haiku-20241022" },
    }
  })

  // Get model data for an agent's default
  const getAgentModelData = (agent: AgentType): ModelsDevModel | undefined => {
    const model = defaultModels()[agent]
    return getModel(model.providerId, model.modelId)
  }

  // Get connected provider IDs from active instances
  const connectedProviderIds = createMemo(() => {
    const ids = new Set<string>()
    for (const [instanceId, providerList] of instanceProviders()) {
      for (const provider of providerList) {
        ids.add(provider.id)
      }
    }
    return ids
  })

  // Fetch cache status on mount
  onMount(async () => {
    const status = await getModelsCacheStatus()
    if (status.lastUpdated) {
      setLastUpdated(status.lastUpdated)
    }
  })

  const handleSync = async () => {
    setSyncError(null)
    const result = await syncModelsData()
    if (result.success && result.lastUpdated) {
      setLastUpdated(result.lastUpdated)
    } else if (result.error) {
      setSyncError(result.error)
    }
  }

  const formatLastUpdated = (timestamp: number | null) => {
    if (!timestamp) return "Never"
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - timestamp

    if (diff < 60000) return "Just now"
    if (diff < 3600000) return `${Math.floor(diff / 60000)} minutes ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`
    return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  const handleEditAgent = (agent: AgentType) => {
    setEditingAgent(agent)
  }

  const handleModelSelect = (providerId: string, modelId: string) => {
    const agent = editingAgent()
    if (!agent) return

    const updated = { ...defaultModels() }
    updated[agent] = { providerId, modelId }
    setDefaultModels(updated)
    setEditingAgent(null)
  }

  // Handle model selection from catalog
  const handleCatalogModelSelect = (providerId: string, modelId: string) => {
    // If we're editing an agent, apply the selection
    const agent = editingAgent()
    if (agent) {
      handleModelSelect(providerId, modelId)
    }
  }

  // Provider config modal state
  const [configureProviderId, setConfigureProviderId] = createSignal<string | null>(null)

  // Handle configure provider from catalog - open the config modal
  const handleConfigureProvider = (providerId: string) => {
    setConfigureProviderId(providerId)
  }

  const agentLabels: Record<AgentType, string> = {
    main: "Main Agent",
    plan: "Plan Agent",
    explore: "Explore Agent",
  }

  const agentIcons: Record<AgentType, string> = {
    main: "🤖",
    plan: "📋",
    explore: "🔍",
  }

  const agentDescriptions: Record<AgentType, string> = {
    main: "Primary coding assistant",
    plan: "Architecture & planning",
    explore: "Quick searches",
  }

  // Get price class for color coding
  const getPriceClass = (model: ModelsDevModel | undefined) => {
    if (!model?.cost) return ""
    const avgCost = (model.cost.input + model.cost.output) / 2
    if (avgCost === 0) return "text-green-500"
    if (avgCost < 1) return "text-green-400"
    if (avgCost < 10) return "text-yellow-500"
    return "text-red-400"
  }

  return (
    <div class="full-settings-section">
      {/* Header with sync button */}
      <div class="flex items-start justify-between mb-4">
        <div>
          <h2 class="full-settings-section-title">Models</h2>
          <p class="full-settings-section-subtitle">Browse models, compare pricing, and configure defaults</p>
        </div>
        <button
          type="button"
          class="full-settings-btn full-settings-btn-ghost text-xs"
          onClick={handleSync}
          disabled={isModelsSyncing()}
          title={`Prices last synced: ${formatLastUpdated(lastUpdated())}`}
        >
          <RefreshCw class={`w-3.5 h-3.5 ${isModelsSyncing() ? "animate-spin" : ""}`} />
          {isModelsSyncing() ? "Syncing..." : "Sync Prices"}
        </button>
      </div>

      {/* Quick Access Cards - Agent Defaults with Pricing */}
      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Quick Access</h3>
        <p class="text-xs text-secondary mb-3">Default models for each agent type</p>

        <div class="models-quick-access-grid">
          <For each={(["main", "plan", "explore"] as AgentType[])}>
            {(agent) => {
              const model = () => defaultModels()[agent]
              const modelData = () => getAgentModelData(agent)

              return (
                <div class="models-quick-access-card">
                  <div class="models-quick-access-header">
                    <span class="models-quick-access-icon">{agentIcons[agent]}</span>
                    <div class="models-quick-access-agent">
                      <span class="models-quick-access-agent-name">{agentLabels[agent]}</span>
                      <span class="models-quick-access-agent-desc">{agentDescriptions[agent]}</span>
                    </div>
                  </div>

                  <div class="models-quick-access-model">
                    <div class="models-quick-access-model-name">
                      {modelData()?.name || model().modelId}
                    </div>
                    <div class="models-quick-access-model-provider">
                      {model().providerId}
                    </div>
                  </div>

                  <div class="models-quick-access-pricing">
                    <Show when={modelData()?.cost} fallback={<span class="text-muted">—</span>}>
                      <span class={`models-quick-access-price ${getPriceClass(modelData())}`}>
                        ${modelData()!.cost!.input}/${modelData()!.cost!.output}
                      </span>
                      <span class="models-quick-access-price-label">per 1M tokens</span>
                    </Show>
                  </div>

                  <button
                    type="button"
                    class="models-quick-access-change"
                    onClick={() => handleEditAgent(agent)}
                  >
                    Change
                  </button>
                </div>
              )
            }}
          </For>
        </div>
      </div>

      <div class="full-settings-section-divider" />

      {/* Model Catalog - Browsable list with pricing */}
      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Model Catalog</h3>
        <p class="text-xs text-secondary mb-3">Browse all available models with pricing and capabilities</p>

        <ModelCatalogPanel
          connectedProviderIds={connectedProviderIds()}
          onSelectModel={handleCatalogModelSelect}
          onConfigureProvider={handleConfigureProvider}
        />
      </div>

      {/* Provider Config Modal */}
      <ProviderConfigModal
        open={Boolean(configureProviderId())}
        onClose={() => setConfigureProviderId(null)}
        providerId={configureProviderId()}
      />

      {/* Sync status footer */}
      <Show when={syncError()}>
        <div class="mt-2 text-xs text-status-error">
          Sync error: {syncError()}
        </div>
      </Show>

      {/* Model Selector Modal */}
      <Show when={editingAgent()} fallback={null}>
        {(agent) => (
            <ModelSelectorInline
              open={Boolean(editingAgent())}
              agentLabel={agentLabels[editingAgent()!]}
              currentProviderId={defaultModels()[editingAgent()!].providerId}
              currentModelId={defaultModels()[editingAgent()!].modelId}
              onSelect={handleModelSelect}
              onCancel={() => setEditingAgent(null)}
            />
          )
        }
      </Show>
    </div>
  )
}

// Inline model selector component for editing default models
interface ModelSelectorInlineProps {
  open: boolean
  agentLabel: string
  currentProviderId: string
  currentModelId: string
  onSelect: (providerId: string, modelId: string) => void
  onCancel: () => void
}

const ModelSelectorInline: Component<ModelSelectorInlineProps> = (props) => {
  const [selectedProvider, setSelectedProvider] = createSignal(props.currentProviderId)
  const [selectedModel, setSelectedModel] = createSignal(props.currentModelId)
  const [providerSearch, setProviderSearch] = createSignal("")
  const [modelSearch, setModelSearch] = createSignal("")
  const [showProviderList, setShowProviderList] = createSignal(false)
  const [showModelList, setShowModelList] = createSignal(false)

  const providers = createMemo(() => getAllProviders())
  const models = createMemo(() => {
    const providerId = selectedProvider()
    const data = getModelsData()
    if (!data || !providerId || !data[providerId]) return []
    return Object.values(data[providerId].models || {})
  })

  const filteredProviders = createMemo(() => {
    const search = providerSearch().toLowerCase()
    if (!search) return providers()
    return providers().filter(p =>
      p.name.toLowerCase().includes(search) || p.id.toLowerCase().includes(search)
    )
  })

  const filteredModels = createMemo(() => {
    const search = modelSearch().toLowerCase()
    if (!search) return models()
    return models().filter(m =>
      (m.name || m.id).toLowerCase().includes(search) || m.id.toLowerCase().includes(search)
    )
  })

  const selectedProviderData = createMemo(() => {
    const id = selectedProvider()
    return providers().find(p => p.id === id)
  })

  const selectedModelData = createMemo(() => {
    const id = selectedModel()
    return models().find(m => m.id === id)
  })

  // Reset when opening
  createEffect(() => {
    if (props.open) {
      setSelectedProvider(props.currentProviderId)
      setSelectedModel(props.currentModelId)
      setProviderSearch("")
      setModelSearch("")
      setShowProviderList(false)
      setShowModelList(false)
    }
  })

  const handleSelectProvider = (providerId: string) => {
    setSelectedProvider(providerId)
    setSelectedModel("")
    setShowProviderList(false)
    setProviderSearch("")
  }

  const handleSelectModel = (modelId: string) => {
    setSelectedModel(modelId)
    setShowModelList(false)
    setModelSearch("")
  }

  const handleSave = () => {
    props.onSelect(selectedProvider(), selectedModel())
  }

  // Use a Portal to render outside the parent container
  return (
    <Show when={props.open}>
      <Portal>
        {/* Backdrop */}
        <div
          class="fixed inset-0 bg-black/60"
          style={{ "z-index": 100 }}
          onClick={props.onCancel}
        />
        {/* Modal Content */}
        <div
          class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 modal-surface w-full max-w-lg p-6 flex flex-col gap-4"
          style={{ "z-index": 101 }}
        >
        <h2 class="text-lg font-semibold text-primary">
          Select Model for {props.agentLabel}
        </h2>

        <div class="flex flex-col gap-4">
          {/* Provider Selector */}
          <div class="relative">
            <label class="text-xs text-secondary mb-2 block">Provider</label>
            <button
              type="button"
              class="w-full px-3 py-2.5 rounded-lg border border-base bg-surface-secondary hover:bg-surface-tertiary transition-colors flex items-center gap-3 text-left"
              onClick={() => {
                setShowProviderList(!showProviderList())
                setShowModelList(false)
              }}
            >
              <Show
                when={selectedProviderData()}
                fallback={<span class="text-muted">Select provider...</span>}
              >
                {(provider) => (
                  <>
                    <div class="w-6 h-6 flex-shrink-0 flex items-center justify-center">
                      <img
                        src={getProviderLogoUrl(provider().id)}
                        alt={provider().name}
                        class="w-6 h-6 object-contain provider-logo-img-sm"
                        onError={(e) => { e.currentTarget.style.display = 'none' }}
                      />
                    </div>
                    <span class="text-primary flex-1">{provider().name}</span>
                  </>
                )}
              </Show>
              <ChevronDown class="w-4 h-4 text-muted flex-shrink-0" />
            </button>

            <Show when={showProviderList()}>
              <div class="absolute top-full left-0 right-0 mt-1 bg-surface-secondary border border-base rounded-lg shadow-lg z-10 max-h-64 overflow-hidden flex flex-col">
                <div class="p-2 border-b border-base">
                  <input
                    type="text"
                    class="w-full px-2 py-1.5 text-sm bg-surface-primary rounded border border-base focus:border-accent-primary outline-none text-primary"
                    placeholder="Search providers..."
                    value={providerSearch()}
                    onInput={(e) => setProviderSearch(e.currentTarget.value)}
                  />
                </div>
                <div class="overflow-y-auto flex-1">
                  <For each={filteredProviders()}>
                    {(provider) => (
                      <button
                        type="button"
                        class={`w-full px-3 py-2 flex items-center gap-3 hover:bg-surface-tertiary transition-colors text-left ${
                          selectedProvider() === provider.id ? "bg-surface-tertiary" : ""
                        }`}
                        onClick={() => handleSelectProvider(provider.id)}
                      >
                        <div class="w-6 h-6 flex-shrink-0 flex items-center justify-center">
                          <img
                            src={getProviderLogoUrl(provider.id)}
                            alt={provider.name}
                            class="w-6 h-6 object-contain provider-logo-img-sm"
                            onError={(e) => { e.currentTarget.style.display = 'none' }}
                          />
                        </div>
                        <span class="text-sm text-primary">{provider.name}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>

          {/* Model Selector */}
          <Show when={selectedProvider()}>
            <div class="relative">
              <label class="text-xs text-secondary mb-2 block">Model</label>
              <button
                type="button"
                class="w-full px-3 py-2.5 rounded-lg border border-base bg-surface-secondary hover:bg-surface-tertiary transition-colors flex items-center gap-3 text-left"
                onClick={() => {
                  setShowModelList(!showModelList())
                  setShowProviderList(false)
                }}
              >
                <Show
                  when={selectedModelData()}
                  fallback={<span class="text-muted">Select model...</span>}
                >
                  {(model) => (
                    <span class="text-primary flex-1">{model().name || model().id}</span>
                  )}
                </Show>
                <ChevronDown class="w-4 h-4 text-muted flex-shrink-0" />
              </button>

              <Show when={showModelList()}>
                <div class="absolute top-full left-0 right-0 mt-1 bg-surface-secondary border border-base rounded-lg shadow-lg z-10 max-h-64 overflow-hidden flex flex-col">
                  <div class="p-2 border-b border-base">
                    <input
                      type="text"
                      class="w-full px-2 py-1.5 text-sm bg-surface-primary rounded border border-base focus:border-accent-primary outline-none text-primary"
                      placeholder="Search models..."
                      value={modelSearch()}
                      onInput={(e) => setModelSearch(e.currentTarget.value)}
                    />
                  </div>
                  <div class="overflow-y-auto flex-1">
                    <For each={filteredModels()}>
                      {(model) => (
                        <button
                          type="button"
                          class={`w-full px-3 py-2 hover:bg-surface-tertiary transition-colors text-left ${
                            selectedModel() === model.id ? "bg-surface-tertiary" : ""
                          }`}
                          onClick={() => handleSelectModel(model.id)}
                        >
                          <div class="text-sm text-primary">{model.name || model.id}</div>
                          <div class="text-[11px] text-muted">{model.id}</div>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            class="selector-button selector-button-secondary"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            class="selector-button selector-button-primary"
            onClick={handleSave}
            disabled={!selectedProvider() || !selectedModel()}
          >
            Save
          </button>
        </div>
      </div>
      </Portal>
    </Show>
  )
}

interface McpSectionProps {
  folder?: string
}

const McpSection: Component<McpSectionProps> = (props) => {
  return (
    <div class="full-settings-section">
      <h2 class="full-settings-section-title">MCP Servers</h2>
      <p class="full-settings-section-subtitle">Model Context Protocol server configuration</p>

      <McpSettingsPanel folder={props.folder} />
    </div>
  )
}

interface CommandsSectionProps {
  instanceId?: string | null
}

const BUILT_IN_COMMANDS = ["init", "undo", "redo", "share", "help", "compact", "cost", "bug", "config", "doctor", "model", "context"]

const CommandsSection: Component<CommandsSectionProps> = (props) => {
  const [showBuiltIn, setShowBuiltIn] = createSignal(true)
  const [showCustom, setShowCustom] = createSignal(true)
  const [isAddingCommand, setIsAddingCommand] = createSignal(false)
  const [editingCommand, setEditingCommand] = createSignal<string | null>(null)
  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [saveSuccess, setSaveSuccess] = createSignal(false)

  // Form state
  const [formName, setFormName] = createSignal("")
  const [formTemplate, setFormTemplate] = createSignal("")
  const [formDescription, setFormDescription] = createSignal("")
  const [formAgent, setFormAgent] = createSignal("")
  const [formModel, setFormModel] = createSignal("")
  const [formSubtask, setFormSubtask] = createSignal(false)

  const allCommands = createMemo(() => {
    if (!props.instanceId) return []
    return getCommands(props.instanceId)
  })

  const builtInCommands = createMemo(() => {
    return allCommands().filter((cmd) => BUILT_IN_COMMANDS.includes(cmd.name))
  })

  const customCommands = createMemo(() => {
    return allCommands().filter((cmd) => !BUILT_IN_COMMANDS.includes(cmd.name))
  })

  const getInstance = () => {
    if (!props.instanceId) return null
    return instances().get(props.instanceId)
  }

  const resetForm = () => {
    setFormName("")
    setFormTemplate("")
    setFormDescription("")
    setFormAgent("")
    setFormModel("")
    setFormSubtask(false)
  }

  const startAddCommand = () => {
    resetForm()
    setEditingCommand(null)
    setIsAddingCommand(true)
    setSaveError(null)
  }

  const startEditCommand = (cmd: SDKCommand) => {
    setFormName(cmd.name)
    setFormTemplate(cmd.template)
    setFormDescription(cmd.description || "")
    setFormAgent(cmd.agent || "")
    setFormModel(cmd.model || "")
    setFormSubtask(cmd.subtask || false)
    setIsAddingCommand(false)
    setEditingCommand(cmd.name)
    setSaveError(null)
  }

  const cancelEdit = () => {
    resetForm()
    setIsAddingCommand(false)
    setEditingCommand(null)
    setSaveError(null)
  }

  const saveCommand = async () => {
    const instance = getInstance()
    if (!instance?.client) {
      setSaveError("No active instance")
      return
    }

    const name = formName().trim()
    const template = formTemplate().trim()

    if (!name) {
      setSaveError("Command name is required")
      return
    }

    if (!template) {
      setSaveError("Template is required")
      return
    }

    if (!/^[a-zA-Z][a-zA-Z0-9-_]*$/.test(name)) {
      setSaveError("Command name must start with a letter and contain only letters, numbers, hyphens, and underscores")
      return
    }

    try {
      const newCommand: Record<string, unknown> = { template }
      if (formDescription().trim()) newCommand.description = formDescription().trim()
      if (formAgent().trim()) newCommand.agent = formAgent().trim()
      if (formModel().trim()) newCommand.model = formModel().trim()
      if (formSubtask()) newCommand.subtask = true

      const configResponse = await instance.client.config.get({})
      const currentConfig = configResponse.data || {}

      const updatedConfig = {
        ...currentConfig,
        command: {
          ...(currentConfig.command || {}),
          [name]: newCommand,
        },
      }

      await instance.client.config.update({ body: updatedConfig })
      await fetchCommands(props.instanceId!, instance.client)

      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
      cancelEdit()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save command")
    }
  }

  const deleteCommand = async (commandName: string) => {
    const instance = getInstance()
    if (!instance?.client) return

    try {
      const configResponse = await instance.client.config.get({})
      const currentConfig = configResponse.data || {}

      if (!currentConfig.command?.[commandName]) {
        setSaveError("Command not found in config")
        return
      }

      const { [commandName]: _, ...remainingCommands } = currentConfig.command

      await instance.client.config.update({
        body: { ...currentConfig, command: remainingCommands },
      })

      await fetchCommands(props.instanceId!, instance.client)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to delete command")
    }
  }

  const isEditing = () => isAddingCommand() || editingCommand() !== null

  return (
    <div class="full-settings-section">
      <h2 class="full-settings-section-title">Slash Commands</h2>
      <p class="full-settings-section-subtitle">Built-in and custom commands</p>

      {/* Success/Error Messages */}
      <Show when={saveSuccess()}>
        <div class="full-settings-card" style="background-color: rgba(34, 197, 94, 0.1); border-color: #22c55e;">
          <div class="flex items-center gap-2 text-green-500 text-sm">
            <Check class="w-4 h-4" />
            Command saved successfully
          </div>
        </div>
      </Show>

      <Show when={saveError()}>
        <div class="full-settings-card" style="background-color: rgba(239, 68, 68, 0.1); border-color: #ef4444;">
          <div class="flex items-center gap-2 text-red-500 text-sm">
            <AlertCircle class="w-4 h-4" />
            {saveError()}
          </div>
        </div>
      </Show>

      {/* Add/Edit Form */}
      <Show when={isEditing()}>
        <div class="full-settings-card">
          <div class="full-settings-card-header">
            <span class="full-settings-card-title">
              {isAddingCommand() ? "Add Custom Command" : `Edit /${editingCommand()}`}
            </span>
          </div>
          <div class="flex flex-col gap-3 mt-3">
            <div class="full-settings-field">
              <label class="full-settings-field-label">Command Name *</label>
              <input
                type="text"
                class="full-settings-input"
                placeholder="e.g., test, deploy, review"
                value={formName()}
                onInput={(e) => setFormName(e.currentTarget.value)}
                disabled={editingCommand() !== null}
              />
              <span class="text-xs text-muted">Used as /{formName() || "command"}</span>
            </div>

            <div class="full-settings-field">
              <label class="full-settings-field-label">Template *</label>
              <textarea
                class="full-settings-input"
                placeholder="The prompt sent to the LLM. Use $ARGUMENTS for user input."
                value={formTemplate()}
                onInput={(e) => setFormTemplate(e.currentTarget.value)}
                rows={3}
                style="resize: vertical; min-height: 80px;"
              />
            </div>

            <div class="full-settings-field">
              <label class="full-settings-field-label">Description</label>
              <input
                type="text"
                class="full-settings-input"
                placeholder="Brief explanation shown in the picker"
                value={formDescription()}
                onInput={(e) => setFormDescription(e.currentTarget.value)}
              />
            </div>

            <div class="flex gap-3">
              <div class="full-settings-field flex-1">
                <label class="full-settings-field-label">Agent</label>
                <input
                  type="text"
                  class="full-settings-input"
                  placeholder="e.g., build, code"
                  value={formAgent()}
                  onInput={(e) => setFormAgent(e.currentTarget.value)}
                />
              </div>
              <div class="full-settings-field flex-1">
                <label class="full-settings-field-label">Model</label>
                <input
                  type="text"
                  class="full-settings-input"
                  placeholder="e.g., anthropic/claude-sonnet"
                  value={formModel()}
                  onInput={(e) => setFormModel(e.currentTarget.value)}
                />
              </div>
            </div>

            <label class="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={formSubtask()}
                onChange={(e) => setFormSubtask(e.currentTarget.checked)}
              />
              <span>Run as subtask (spawns subagent)</span>
            </label>

            <div class="flex justify-end gap-2 mt-2">
              <button type="button" class="full-settings-btn full-settings-btn-secondary" onClick={cancelEdit}>
                Cancel
              </button>
              <button type="button" class="full-settings-btn full-settings-btn-primary" onClick={saveCommand}>
                <Save class="w-4 h-4" />
                Save Command
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Main Content (when not editing) */}
      <Show when={!isEditing()}>
        {/* Custom Commands Section */}
        <div class="full-settings-subsection">
          <div class="flex items-center justify-between">
            <button
              type="button"
              class="flex items-center gap-2 text-sm font-medium text-secondary hover:text-primary"
              onClick={() => setShowCustom(!showCustom())}
            >
              {showCustom() ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
              <span>Custom Commands</span>
              <span class="text-xs text-muted">({customCommands().length})</span>
            </button>
            <Show when={props.instanceId}>
              <button
                type="button"
                class="full-settings-btn full-settings-btn-ghost text-xs"
                onClick={startAddCommand}
              >
                <Plus class="w-3 h-3" />
                Add Command
              </button>
            </Show>
          </div>

          <Show when={showCustom()}>
            <Show when={!props.instanceId}>
              <div class="full-settings-card mt-3">
                <div class="flex items-center gap-2 text-sm text-muted">
                  <AlertCircle class="w-4 h-4" />
                  Open a project to manage custom commands
                </div>
              </div>
            </Show>
            <Show when={props.instanceId && customCommands().length === 0}>
              <div class="full-settings-card mt-3">
                <div class="text-sm text-muted">
                  No custom commands defined. Click "Add Command" to create one.
                </div>
              </div>
            </Show>
            <div class="full-settings-list mt-2">
              <For each={customCommands()}>
                {(cmd) => (
                  <div class="full-settings-list-item">
                    <div class="full-settings-list-item-info flex-1">
                      <div class="full-settings-list-item-title">/{cmd.name}</div>
                      <Show when={cmd.description}>
                        <div class="full-settings-list-item-subtitle">{cmd.description}</div>
                      </Show>
                      <div class="flex gap-2 mt-1">
                        <Show when={cmd.agent}>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-surface-tertiary text-muted">agent: {cmd.agent}</span>
                        </Show>
                        <Show when={cmd.model}>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-surface-tertiary text-muted">model: {cmd.model}</span>
                        </Show>
                        <Show when={cmd.subtask}>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-surface-tertiary text-muted">subtask</span>
                        </Show>
                      </div>
                    </div>
                    <div class="flex gap-1">
                      <button
                        type="button"
                        class="p-1.5 rounded hover:bg-surface-tertiary transition-colors text-muted hover:text-primary"
                        onClick={() => startEditCommand(cmd)}
                        title="Edit command"
                      >
                        <Edit2 class="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        class="p-1.5 rounded hover:bg-red-500/10 transition-colors text-muted hover:text-red-500"
                        onClick={() => deleteCommand(cmd.name)}
                        title="Delete command"
                      >
                        <Trash2 class="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="full-settings-section-divider" />

        {/* Built-in Commands Section */}
        <div class="full-settings-subsection">
          <button
            type="button"
            class="flex items-center gap-2 text-sm font-medium text-secondary hover:text-primary"
            onClick={() => setShowBuiltIn(!showBuiltIn())}
          >
            {showBuiltIn() ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
            <span>Built-in Commands</span>
            <span class="text-xs text-muted">({builtInCommands().length})</span>
          </button>

          <Show when={showBuiltIn()}>
            <div class="full-settings-list mt-2">
              <For each={builtInCommands()}>
                {(cmd) => (
                  <div class="full-settings-list-item">
                    <div class="full-settings-list-item-info">
                      <div class="full-settings-list-item-title">/{cmd.name}</div>
                      <Show when={cmd.description}>
                        <div class="full-settings-list-item-subtitle">{cmd.description}</div>
                      </Show>
                    </div>
                    <span class="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500">built-in</span>
                  </div>
                )}
              </For>
              <Show when={builtInCommands().length === 0}>
                <div class="full-settings-list-item">
                  <div class="text-sm text-muted">
                    {props.instanceId ? "Loading commands..." : "Open a project to see built-in commands"}
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

interface GovernanceSectionProps {
  folder?: string
}

const GovernanceSection: Component<GovernanceSectionProps> = (props) => {
  const [expandedSections, setExpandedSections] = createSignal<Record<string, boolean>>({
    hardcoded: false,
    default: true,
    project: false,
  })
  const [togglingRules, setTogglingRules] = createSignal<Set<string>>(new Set())

  // Load governance data on mount and when folder changes
  onMount(() => {
    refreshGovernanceRules(props.folder)
  })

  createEffect(() => {
    if (props.folder) {
      refreshGovernanceRules(props.folder)
    }
  })

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const handleRuleToggle = async (rule: GovernanceRule) => {
    if (!props.folder) return

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

  const activeOverridesCount = createMemo(() =>
    defaultRules().filter(r => r.action === "allow").length
  )

  return (
    <div class="full-settings-section">
      <h2 class="full-settings-section-title">Governance</h2>
      <p class="full-settings-section-subtitle">Era Code governance rules and enforcement</p>

      <Show when={!isEraInstalled()}>
        <div class="full-settings-card">
          <div class="full-settings-card-header">
            <span class="full-settings-card-title">Era Code Not Installed</span>
          </div>
          <div class="full-settings-card-description">
            Install Era Code to enable governance rules and enforcement.
          </div>
        </div>
      </Show>

      <Show when={isEraInstalled()}>
        {/* Loading State */}
        <Show when={isGovernanceLoading()}>
          <div class="full-settings-card">
            <div class="flex items-center gap-2 text-sm text-muted">
              <RefreshCw class="w-4 h-4 animate-spin" />
              Loading governance rules...
            </div>
          </div>
        </Show>

        {/* Error State */}
        <Show when={governanceError()}>
          <div class="full-settings-card" style="background-color: rgba(239, 68, 68, 0.1); border-color: #ef4444;">
            <div class="flex items-center gap-2 text-red-500 text-sm">
              <AlertTriangle class="w-4 h-4" />
              {governanceError()}
            </div>
          </div>
        </Show>

        {/* Summary Card */}
        <Show when={!isGovernanceLoading() && governanceSummary()}>
          <div class="full-settings-card">
            <div class="flex items-center justify-between">
              <div class="flex gap-6 text-sm">
                <div>
                  <span class="text-muted">Total Rules: </span>
                  <span class="font-medium">{governanceSummary()!.totalRules}</span>
                </div>
                <div>
                  <span class="text-muted">Active Overrides: </span>
                  <span class="font-medium">{activeOverridesCount()}</span>
                </div>
              </div>
              <Show when={isAuditMode()}>
                <span class="text-xs px-2 py-1 rounded bg-yellow-500/10 text-yellow-500">Audit Mode</span>
              </Show>
            </div>
          </div>
        </Show>

        {/* Hardcoded Rules Section */}
        <Show when={!isGovernanceLoading() && hardcodedRules().length > 0}>
          <div class="full-settings-subsection mt-4">
            <button
              type="button"
              class="flex items-center gap-2 text-sm font-medium text-secondary hover:text-primary w-full"
              onClick={() => toggleSection("hardcoded")}
            >
              {expandedSections().hardcoded ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
              <ShieldAlert class="w-4 h-4 text-red-400" />
              <span>Hardcoded Rules</span>
              <span class="text-xs text-muted">({hardcodedRules().length})</span>
            </button>
            <p class="text-xs text-muted mt-1 ml-6">Safety rules that cannot be overridden</p>

            <Show when={expandedSections().hardcoded}>
              <div class="full-settings-list mt-2">
                <For each={hardcodedRules()}>
                  {(rule) => (
                    <div class="full-settings-list-item flex-col !items-start gap-1">
                      <div class="flex items-center gap-2">
                        <span class="font-mono text-xs text-primary">{rule.id}</span>
                        <span class="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-500">Deny</span>
                        <ShieldOff class="w-3 h-3 text-muted" title="Cannot be overridden" />
                      </div>
                      <code class="text-xs text-muted break-all">{rule.pattern}</code>
                      <span class="text-xs text-secondary">{rule.reason}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        {/* Default Rules Section */}
        <Show when={!isGovernanceLoading() && defaultRules().length > 0}>
          <div class="full-settings-subsection mt-4">
            <button
              type="button"
              class="flex items-center gap-2 text-sm font-medium text-secondary hover:text-primary w-full"
              onClick={() => toggleSection("default")}
            >
              {expandedSections().default ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
              <Shield class="w-4 h-4 text-yellow-400" />
              <span>Default Rules</span>
              <span class="text-xs text-muted">({defaultRules().length})</span>
            </button>
            <p class="text-xs text-muted mt-1 ml-6">Can be overridden in project governance config</p>

            <Show when={expandedSections().default}>
              <div class="full-settings-list mt-2">
                <For each={defaultRules()}>
                  {(rule) => {
                    const isOverridden = () => rule.action === "allow"
                    const isToggling = () => togglingRules().has(rule.id)

                    return (
                      <div class={`full-settings-list-item flex-col !items-start gap-1 ${isOverridden() ? "opacity-60" : ""}`}>
                        <div class="flex items-center gap-2 w-full">
                          <span class="font-mono text-xs text-primary">{rule.id}</span>
                          <Show when={isOverridden()}>
                            <span class="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-500">Allow</span>
                          </Show>
                          <Show when={!isOverridden()}>
                            <span class="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-500">Deny</span>
                          </Show>
                          <div class="flex-1" />
                          <button
                            type="button"
                            class={`p-1 rounded transition-colors ${isOverridden() ? "text-green-500 hover:text-green-400" : "text-muted hover:text-primary"}`}
                            onClick={() => handleRuleToggle(rule)}
                            disabled={isToggling() || !props.folder}
                            title={!props.folder ? "Open a project to toggle rules" : isOverridden() ? "Click to deny" : "Click to allow"}
                          >
                            <Show when={isToggling()}>
                              <RefreshCw class="w-4 h-4 animate-spin" />
                            </Show>
                            <Show when={!isToggling()}>
                              {isOverridden() ? <ToggleRight class="w-5 h-5" /> : <ToggleLeft class="w-5 h-5" />}
                            </Show>
                          </button>
                        </div>
                        <code class="text-xs text-muted break-all">{rule.pattern}</code>
                        <span class="text-xs text-secondary">{rule.reason}</span>
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
          <div class="full-settings-subsection mt-4">
            <button
              type="button"
              class="flex items-center gap-2 text-sm font-medium text-secondary hover:text-primary w-full"
              onClick={() => toggleSection("project")}
            >
              {expandedSections().project ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
              <ShieldCheck class="w-4 h-4 text-blue-400" />
              <span>Project Rules</span>
              <span class="text-xs text-muted">({projectRules().length})</span>
            </button>
            <p class="text-xs text-muted mt-1 ml-6">Custom rules defined in this project</p>

            <Show when={expandedSections().project}>
              <div class="full-settings-list mt-2">
                <For each={projectRules()}>
                  {(rule) => (
                    <div class="full-settings-list-item flex-col !items-start gap-1">
                      <div class="flex items-center gap-2">
                        <span class="font-mono text-xs text-primary">{rule.id}</span>
                        <Show when={rule.action === "allow"}>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-500">Allow</span>
                        </Show>
                        <Show when={rule.action === "deny"}>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-500">Deny</span>
                        </Show>
                      </div>
                      <code class="text-xs text-muted break-all">{rule.pattern}</code>
                      <span class="text-xs text-secondary">{rule.reason}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        {/* No Rules State */}
        <Show when={!isGovernanceLoading() && !governanceError() && governanceRules().length === 0}>
          <div class="full-settings-card mt-4">
            <div class="flex items-center gap-2 text-sm text-muted">
              <Shield class="w-4 h-4" />
              No governance rules found
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}

interface DirectivesSectionProps {
  folder?: string
}

const DirectivesSection: Component<DirectivesSectionProps> = (props) => {
  const [editingProject, setEditingProject] = createSignal(false)
  const [editingGlobal, setEditingGlobal] = createSignal(false)
  const [projectContent, setProjectContent] = createSignal("")
  const [globalContent, setGlobalContent] = createSignal("")
  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [saveSuccess, setSaveSuccess] = createSignal(false)
  const [isSaving, setIsSaving] = createSignal(false)

  // Load directives on mount and when folder changes
  onMount(() => {
    fetchDirectives(props.folder)
  })

  createEffect(() => {
    if (props.folder) {
      fetchDirectives(props.folder)
    }
  })

  // Sync content when directives change
  createEffect(() => {
    if (projectDirectives()?.content) {
      setProjectContent(projectDirectives()!.content)
    }
  })

  createEffect(() => {
    if (globalDirectives()?.content) {
      setGlobalContent(globalDirectives()!.content)
    }
  })

  const startEditProject = () => {
    setProjectContent(projectDirectives()?.content || "")
    setEditingProject(true)
    setSaveError(null)
  }

  const startEditGlobal = () => {
    setGlobalContent(globalDirectives()?.content || "")
    setEditingGlobal(true)
    setSaveError(null)
  }

  const cancelEdit = () => {
    setEditingProject(false)
    setEditingGlobal(false)
    setSaveError(null)
  }

  const saveProjectDirectives = async () => {
    setIsSaving(true)
    setSaveError(null)
    try {
      await saveDirectives(props.folder || "", "project", projectContent())
      await fetchDirectives(props.folder)
      setEditingProject(false)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save directives")
    } finally {
      setIsSaving(false)
    }
  }

  const saveGlobalDirectives = async () => {
    setIsSaving(true)
    setSaveError(null)
    try {
      await saveDirectives("", "global", globalContent())
      await fetchDirectives(props.folder)
      setEditingGlobal(false)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save directives")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div class="full-settings-section">
      <h2 class="full-settings-section-title">Directives</h2>
      <p class="full-settings-section-subtitle">Project and global directives</p>

      {/* Success/Error Messages */}
      <Show when={saveSuccess()}>
        <div class="full-settings-card" style="background-color: rgba(34, 197, 94, 0.1); border-color: #22c55e;">
          <div class="flex items-center gap-2 text-green-500 text-sm">
            <Check class="w-4 h-4" />
            Directives saved successfully
          </div>
        </div>
      </Show>

      <Show when={saveError()}>
        <div class="full-settings-card" style="background-color: rgba(239, 68, 68, 0.1); border-color: #ef4444;">
          <div class="flex items-center gap-2 text-red-500 text-sm">
            <AlertCircle class="w-4 h-4" />
            {saveError()}
          </div>
        </div>
      </Show>

      {/* Loading State */}
      <Show when={isDirectivesLoading()}>
        <div class="full-settings-card">
          <div class="flex items-center gap-2 text-sm text-muted">
            <RefreshCw class="w-4 h-4 animate-spin" />
            Loading directives...
          </div>
        </div>
      </Show>

      {/* Project Directives Section */}
      <Show when={!isDirectivesLoading()}>
        <div class="full-settings-subsection">
          <div class="flex items-center justify-between">
            <h3 class="full-settings-subsection-title">Project Directives</h3>
            <span class="text-xs text-muted font-mono">.era/memory/directives.md</span>
          </div>

          <Show when={!editingProject()}>
            <div class="full-settings-card mt-2">
              <Show when={projectDirectives()?.exists && projectDirectives()?.content}>
                <pre class="text-xs text-secondary whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                  {projectDirectives()!.content.slice(0, 500)}
                  {projectDirectives()!.content.length > 500 ? "..." : ""}
                </pre>
                <div class="flex justify-end mt-3">
                  <button
                    type="button"
                    class="full-settings-btn full-settings-btn-ghost text-xs"
                    onClick={startEditProject}
                    disabled={!props.folder}
                  >
                    <Edit2 class="w-3 h-3" />
                    Edit
                  </button>
                </div>
              </Show>
              <Show when={!projectDirectives()?.exists}>
                <div class="text-sm text-muted">
                  No project directives configured.
                </div>
                <div class="flex justify-end mt-3">
                  <button
                    type="button"
                    class="full-settings-btn full-settings-btn-primary text-xs"
                    onClick={startEditProject}
                    disabled={!props.folder}
                  >
                    <Plus class="w-3 h-3" />
                    Create Directives
                  </button>
                </div>
              </Show>
              <Show when={!props.folder}>
                <div class="text-xs text-muted mt-2">
                  Open a project to edit project directives
                </div>
              </Show>
            </div>
          </Show>

          <Show when={editingProject()}>
            <div class="full-settings-card mt-2">
              <textarea
                class="full-settings-input font-mono text-xs"
                value={projectContent()}
                onInput={(e) => setProjectContent(e.currentTarget.value)}
                rows={12}
                style="resize: vertical; min-height: 200px;"
                placeholder="# Project Directives&#10;&#10;Enter your project-specific guidelines here..."
              />
              <div class="flex justify-end gap-2 mt-3">
                <button type="button" class="full-settings-btn full-settings-btn-secondary text-xs" onClick={cancelEdit}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="full-settings-btn full-settings-btn-primary text-xs"
                  onClick={saveProjectDirectives}
                  disabled={isSaving()}
                >
                  <Show when={isSaving()} fallback={<Save class="w-3 h-3" />}>
                    <RefreshCw class="w-3 h-3 animate-spin" />
                  </Show>
                  {isSaving() ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </Show>
        </div>

        <div class="full-settings-section-divider" />

        {/* Global Directives Section */}
        <div class="full-settings-subsection">
          <div class="flex items-center justify-between">
            <h3 class="full-settings-subsection-title">Global Directives</h3>
            <span class="text-xs text-muted font-mono">~/.era/memory/directives.md</span>
          </div>

          <Show when={!editingGlobal()}>
            <div class="full-settings-card mt-2">
              <Show when={globalDirectives()?.exists && globalDirectives()?.content}>
                <pre class="text-xs text-secondary whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                  {globalDirectives()!.content.slice(0, 500)}
                  {globalDirectives()!.content.length > 500 ? "..." : ""}
                </pre>
                <div class="flex justify-end mt-3">
                  <button
                    type="button"
                    class="full-settings-btn full-settings-btn-ghost text-xs"
                    onClick={startEditGlobal}
                  >
                    <Edit2 class="w-3 h-3" />
                    Edit
                  </button>
                </div>
              </Show>
              <Show when={!globalDirectives()?.exists}>
                <div class="text-sm text-muted">
                  No global directives configured.
                </div>
                <div class="flex justify-end mt-3">
                  <button
                    type="button"
                    class="full-settings-btn full-settings-btn-primary text-xs"
                    onClick={startEditGlobal}
                  >
                    <Plus class="w-3 h-3" />
                    Create Directives
                  </button>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={editingGlobal()}>
            <div class="full-settings-card mt-2">
              <textarea
                class="full-settings-input font-mono text-xs"
                value={globalContent()}
                onInput={(e) => setGlobalContent(e.currentTarget.value)}
                rows={12}
                style="resize: vertical; min-height: 200px;"
                placeholder="# Global Directives&#10;&#10;Enter guidelines that apply to all projects..."
              />
              <div class="flex justify-end gap-2 mt-3">
                <button type="button" class="full-settings-btn full-settings-btn-secondary text-xs" onClick={cancelEdit}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="full-settings-btn full-settings-btn-primary text-xs"
                  onClick={saveGlobalDirectives}
                  disabled={isSaving()}
                >
                  <Show when={isSaving()} fallback={<Save class="w-3 h-3" />}>
                    <RefreshCw class="w-3 h-3 animate-spin" />
                  </Show>
                  {isSaving() ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </Show>
        </div>

        <div class="full-settings-section-divider" />

        {/* Constitution Section */}
        <div class="full-settings-subsection">
          <div class="flex items-center gap-2">
            <h3 class="full-settings-subsection-title">Constitution</h3>
            <span class="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 flex items-center gap-1">
              <Lock class="w-3 h-3" />
              Read-only
            </span>
          </div>
          <div class="full-settings-card mt-2">
            <div class="text-sm text-muted">
              Immutable architectural constraints. The constitution defines the foundational rules that cannot be overridden by directives or governance settings.
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

interface EnvironmentSectionProps {
  instance: Instance | null
}

const EnvironmentSection: Component<EnvironmentSectionProps> = (props) => {
  return (
    <div class="full-settings-section">
      <h2 class="full-settings-section-title">Environment</h2>
      <p class="full-settings-section-subtitle">Environment variables and instance details</p>

      <EnvironmentVariablesEditor />

      <Show when={props.instance}>
        <div class="full-settings-section-divider" />

        <div class="full-settings-subsection">
          <h3 class="full-settings-subsection-title">Current Instance</h3>
          <div class="full-settings-card">
            <table class="w-full text-sm">
              <tbody>
                <tr>
                  <td class="py-1 text-secondary">ID</td>
                  <td class="py-1 font-mono">{props.instance?.id.slice(0, 8)}...</td>
                </tr>
                <tr>
                  <td class="py-1 text-secondary">Folder</td>
                  <td class="py-1 font-mono truncate max-w-[300px]">{props.instance?.folder}</td>
                </tr>
                <tr>
                  <td class="py-1 text-secondary">Port</td>
                  <td class="py-1 font-mono">{props.instance?.port}</td>
                </tr>
                <tr>
                  <td class="py-1 text-secondary">Status</td>
                  <td class="py-1">{props.instance?.status}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </Show>
    </div>
  )
}

interface AccountsSectionProps {
  onOpenGCloudModal?: () => void
}

const AccountsSection: Component<AccountsSectionProps> = (props) => {
  const [ghInstalling, setGhInstalling] = createSignal(false)
  const [ghInstallError, setGhInstallError] = createSignal<string | null>(null)
  const [loginMessage, setLoginMessage] = createSignal<string | null>(null)

  // Check CLI and auth status on mount
  onMount(async () => {
    await Promise.all([
      checkGhCliInstalled(),
      checkGCloudAuth(),
    ])
    // Check GitHub auth after CLI check completes
    if (isGhCliInstalled()) {
      await checkGitHubAuth()
    }
  })

  const handleGCloudLogout = async () => {
    await gcloudLogout()
  }

  const handleGCloudRefresh = async () => {
    await checkGCloudAuth()
  }

  const handleGitHubLogin = async () => {
    setLoginMessage(null)
    const result = await initiateGitHubLogin()
    if (result.error && result.success) {
      // This is the device code message
      setLoginMessage(result.error)
    } else if (!result.success) {
      setLoginMessage(result.error || "Login failed")
    }
  }

  const handleGitHubLogout = async () => {
    await githubLogout()
  }

  const handleGitHubRefresh = async () => {
    await checkGitHubAuth()
  }

  const handleInstallGhCli = async () => {
    setGhInstalling(true)
    setGhInstallError(null)
    const result = await installGhCli()
    setGhInstalling(false)
    if (!result.success) {
      setGhInstallError(result.error || "Installation failed")
    }
  }

  const isGCloudConnected = () => isGCloudAuthenticated() && !isGCloudExpired()
  const isGCloudExpiredStatus = () => isGCloudAuthenticated() && isGCloudExpired()

  return (
    <div class="full-settings-section">
      <h2 class="full-settings-section-title">Accounts</h2>
      <p class="full-settings-section-subtitle">Connect accounts for enhanced integrations</p>

      {/* GitHub Section */}
      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">GitHub</h3>
        <div class="full-settings-account-card">
          <div class="full-settings-account-header">
            <div class="full-settings-account-icon">
              <Github class="w-5 h-5" />
            </div>
            <div class="full-settings-account-info">
              <div class="full-settings-account-name">GitHub</div>
              <div class={`full-settings-account-status ${isGitHubAuthenticated() ? "connected" : ""}`}>
                {isGitHubAuthenticated() ? `Connected as ${githubUsername()}` : "Not connected"}
              </div>
            </div>
            <Show when={isGitHubAuthenticated()}>
              <button
                type="button"
                class="full-settings-btn full-settings-btn-ghost ml-auto"
                onClick={handleGitHubRefresh}
                disabled={isGitHubLoading()}
                title="Refresh status"
              >
                <RefreshCw class={`w-4 h-4 ${isGitHubLoading() ? "animate-spin" : ""}`} />
              </button>
            </Show>
          </div>

          {/* Show loading state while checking CLI */}
          <Show when={!isGhCliChecked()}>
            <div class="full-settings-card-description mt-3">
              <RefreshCw class="w-4 h-4 animate-spin inline mr-2" />
              Checking GitHub CLI status...
            </div>
          </Show>

          {/* Show CLI not installed warning (only after check completes) */}
          <Show when={isGhCliChecked() && !isGhCliInstalled()}>
            <div class="full-settings-account-warning mt-3">
              <AlertCircle class="w-4 h-4" />
              <span>GitHub CLI (gh) is not installed. Install it to enable GitHub authentication.</span>
            </div>
            <Show when={ghInstallError()}>
              <div class="full-settings-account-error mt-2">
                <span class="text-status-error text-xs">{ghInstallError()}</span>
              </div>
            </Show>
            <div class="full-settings-card-actions">
              <button
                type="button"
                class="full-settings-btn full-settings-btn-primary"
                onClick={handleInstallGhCli}
                disabled={ghInstalling()}
              >
                <Show when={ghInstalling()} fallback={<Terminal class="w-4 h-4" />}>
                  <RefreshCw class="w-4 h-4 animate-spin" />
                </Show>
                {ghInstalling() ? "Installing..." : "Install GitHub CLI"}
              </button>
            </div>
          </Show>

          {/* Show connected state */}
          <Show when={isGhCliChecked() && isGhCliInstalled() && isGitHubAuthenticated()}>
            <div class="full-settings-card-description mt-3">
              Connected for PR creation, issue management, and GitHub Copilot integration.
            </div>
            <div class="full-settings-card-actions">
              <button
                type="button"
                class="full-settings-btn full-settings-btn-danger"
                onClick={handleGitHubLogout}
              >
                <X class="w-4 h-4" />
                Disconnect
              </button>
            </div>
          </Show>

          {/* Show login state */}
          <Show when={isGhCliChecked() && isGhCliInstalled() && !isGitHubAuthenticated()}>
            <div class="full-settings-card-description mt-3">
              Connect for PR creation, issue management, and GitHub Copilot integration.
            </div>
            <Show when={loginMessage()}>
              <div class="full-settings-account-info-box mt-2">
                <Info class="w-4 h-4" />
                <span>{loginMessage()}</span>
              </div>
            </Show>
            <Show when={githubError()}>
              <div class="full-settings-account-error mt-2">
                <AlertCircle class="w-4 h-4" />
                <span class="text-status-error text-xs">{githubError()}</span>
              </div>
            </Show>
            <div class="full-settings-card-actions">
              <button
                type="button"
                class="full-settings-btn full-settings-btn-primary"
                onClick={handleGitHubLogin}
                disabled={isGitHubLoading()}
              >
                <Show when={isGitHubLoading()} fallback={<Github class="w-4 h-4" />}>
                  <RefreshCw class="w-4 h-4 animate-spin" />
                </Show>
                {isGitHubLoading() ? "Connecting..." : "Connect with GitHub"}
              </button>
            </div>
          </Show>
        </div>
      </div>

      <div class="full-settings-section-divider" />

      {/* Google Cloud Section */}
      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Google Cloud</h3>
        <div class="full-settings-account-card">
          <div class="full-settings-account-header">
            <div class="full-settings-account-icon">
              <Globe class="w-5 h-5" />
            </div>
            <div class="full-settings-account-info">
              <div class="full-settings-account-name">Google Cloud</div>
              <div class={`full-settings-account-status ${isGCloudConnected() ? "connected" : isGCloudExpiredStatus() ? "expired" : ""}`}>
                {isGCloudConnected() ? "Connected" : isGCloudExpiredStatus() ? "Session Expired" : "Not connected"}
              </div>
            </div>
            <Show when={isGCloudAuthenticated()}>
              <button
                type="button"
                class="full-settings-btn full-settings-btn-ghost ml-auto"
                onClick={handleGCloudRefresh}
                disabled={isGCloudLoading()}
                title="Refresh status"
              >
                <RefreshCw class={`w-4 h-4 ${isGCloudLoading() ? "animate-spin" : ""}`} />
              </button>
            </Show>
          </div>

          <Show when={isGCloudConnected()}>
            <div class="full-settings-account-details mt-3">
              <div class="full-settings-account-detail">
                <span class="full-settings-account-detail-label">Account</span>
                <span class="full-settings-account-detail-value">{gcloudAccount()}</span>
              </div>
              <Show when={gcloudProject()}>
                <div class="full-settings-account-detail">
                  <span class="full-settings-account-detail-label">Project</span>
                  <span class="full-settings-account-detail-value">{gcloudProject()}</span>
                </div>
              </Show>
              <div class="full-settings-account-detail">
                <span class="full-settings-account-detail-label">Token expires</span>
                <span class="full-settings-account-detail-value">
                  {formatTokenExpiry(gcloudTokenExpiry())}
                </span>
              </div>
            </div>
            <div class="full-settings-card-actions">
              <button
                type="button"
                class="full-settings-btn full-settings-btn-danger"
                onClick={handleGCloudLogout}
              >
                <X class="w-4 h-4" />
                Disconnect
              </button>
            </div>
          </Show>

          <Show when={isGCloudExpiredStatus()}>
            <div class="full-settings-account-warning mt-3">
              <AlertCircle class="w-4 h-4" />
              <span>Your session has expired. Please reauthenticate to continue using Google Cloud features.</span>
            </div>
            <div class="full-settings-card-actions">
              <button
                type="button"
                class="full-settings-btn full-settings-btn-primary"
                onClick={() => props.onOpenGCloudModal?.()}
              >
                <Globe class="w-4 h-4" />
                Reauthenticate
              </button>
            </div>
          </Show>

          <Show when={!isGCloudAuthenticated()}>
            <div class="full-settings-card-description mt-3">
              Connect for cloud infrastructure, AI services, and Vertex AI integration.
            </div>
            <div class="full-settings-card-actions">
              <button
                type="button"
                class="full-settings-btn full-settings-btn-primary"
                onClick={() => props.onOpenGCloudModal?.()}
              >
                <Globe class="w-4 h-4" />
                Connect with Google
              </button>
            </div>
          </Show>
        </div>
      </div>

      <div class="full-settings-section-divider" />

      {/* Coming Soon Section */}
      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Coming Soon</h3>
        <div class="full-settings-list">
          <div class="full-settings-list-item">
            <div class="full-settings-list-item-info">
              <div class="full-settings-list-item-title">Linear</div>
              <div class="full-settings-list-item-subtitle">Project and issue tracking</div>
            </div>
            <span class="full-settings-coming-soon">Coming Soon</span>
          </div>
          <div class="full-settings-list-item">
            <div class="full-settings-list-item-info">
              <div class="full-settings-list-item-title">Notion</div>
              <div class="full-settings-list-item-subtitle">Documentation and knowledge base</div>
            </div>
            <span class="full-settings-coming-soon">Coming Soon</span>
          </div>
          <div class="full-settings-list-item">
            <div class="full-settings-list-item-info">
              <div class="full-settings-list-item-title">Slack</div>
              <div class="full-settings-list-item-subtitle">Team communication</div>
            </div>
            <span class="full-settings-coming-soon">Coming Soon</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const EraCodeSection: Component = () => {
  const counts = createMemo(() => eraAssetCounts())

  return (
    <div class="full-settings-section">
      <h2 class="full-settings-section-title">Era Code</h2>
      <p class="full-settings-section-subtitle">Era Code CLI status and installed assets</p>

      {/* Version and status */}
      <div class="full-settings-era-version">
        <div class="full-settings-era-status">
          <Show
            when={isEraInstalled()}
            fallback={
              <span class="full-settings-era-not-installed">
                <AlertCircle class="w-4 h-4" />
                Not Installed
              </span>
            }
          >
            <span class="full-settings-era-installed">
              <Check class="w-4 h-4" />
              Installed
            </span>
          </Show>
        </div>
        <Show when={eraVersion()}>
          <div class="full-settings-era-version-value">v{eraVersion()}</div>
        </Show>
      </div>

      <Show when={isEraInstalled()}>
        {/* Assets grid */}
        <Show when={areEraAssetsAvailable() && counts()}>
          <div class="full-settings-assets-grid">
            <div class="full-settings-asset-card">
              <div class="full-settings-asset-count">{counts()!.agents}</div>
              <div class="full-settings-asset-label">Agents</div>
            </div>
            <div class="full-settings-asset-card">
              <div class="full-settings-asset-count">{counts()!.commands}</div>
              <div class="full-settings-asset-label">Commands</div>
            </div>
            <div class="full-settings-asset-card">
              <div class="full-settings-asset-count">{counts()!.skills}</div>
              <div class="full-settings-asset-label">Skills</div>
            </div>
            <div class="full-settings-asset-card">
              <div class="full-settings-asset-count">{counts()!.plugins}</div>
              <div class="full-settings-asset-label">Plugins</div>
            </div>
          </div>
        </Show>

        <div class="full-settings-section-divider" />

        {/* Installation paths */}
        <div class="full-settings-subsection">
          <h3 class="full-settings-subsection-title">Installation</h3>
          <div class="full-settings-card">
            <table class="w-full text-sm">
              <tbody>
                <tr>
                  <td class="py-1 text-secondary">Binary Path</td>
                  <td class="py-1 font-mono text-xs">~/.era/era-code/bin/era-start.sh</td>
                </tr>
                <tr>
                  <td class="py-1 text-secondary">Assets Path</td>
                  <td class="py-1 font-mono text-xs">~/.era/era-code/opencode/</td>
                </tr>
                <tr>
                  <td class="py-1 text-secondary">Config Path</td>
                  <td class="py-1 font-mono text-xs">~/.era/credentials.json</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="full-settings-card-actions mt-4">
          <button type="button" class="full-settings-btn full-settings-btn-secondary">
            <RefreshCw class="w-4 h-4" />
            Check for Updates
          </button>
        </div>
      </Show>

      <Show when={!isEraInstalled()}>
        <div class="full-settings-card">
          <div class="full-settings-card-header">
            <span class="full-settings-card-title">Era Code Not Installed</span>
          </div>
          <div class="full-settings-card-description">
            Install Era Code for governance enforcement, custom agents, and enhanced development workflows.
          </div>
          <div class="full-settings-card-actions">
            <button type="button" class="full-settings-btn full-settings-btn-primary">
              <ExternalLink class="w-4 h-4" />
              Install Era Code
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

const APP_VERSION = "0.4.0" // TODO: Import from package.json or env var

const AboutSection: Component = () => {
  const openLink = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer")
  }

  return (
    <div class="full-settings-section">
      <h2 class="full-settings-section-title">About</h2>
      <p class="full-settings-section-subtitle">Version information and links</p>

      <div class="full-settings-era-version">
        <div class="full-settings-era-version-label">Era Code</div>
        <div class="full-settings-era-version-value">v{APP_VERSION}</div>
      </div>

      <div class="full-settings-section-divider" />

      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Components</h3>
        <div class="full-settings-card">
          <table class="w-full text-sm">
            <tbody>
              <tr>
                <td class="py-1 text-secondary">UI Version</td>
                <td class="py-1">{APP_VERSION}</td>
              </tr>
              <tr>
                <td class="py-1 text-secondary">Server Version</td>
                <td class="py-1">{APP_VERSION}</td>
              </tr>
              <tr>
                <td class="py-1 text-secondary">OpenCode Binary</td>
                <td class="py-1 font-mono">{APP_VERSION}</td>
              </tr>
              <Show when={isEraInstalled()}>
                <tr>
                  <td class="py-1 text-secondary">Era Code CLI</td>
                  <td class="py-1">{eraVersion()} (installed)</td>
                </tr>
              </Show>
            </tbody>
          </table>
        </div>
      </div>

      <div class="full-settings-section-divider" />

      <div class="full-settings-subsection">
        <h3 class="full-settings-subsection-title">Links</h3>
        <div class="flex gap-2 flex-wrap">
          <button
            type="button"
            class="full-settings-btn full-settings-btn-secondary"
            onClick={() => openLink("https://github.com/neural-nomads/era-code#readme")}
          >
            <ExternalLink class="w-4 h-4" />
            Documentation
          </button>
          <button
            type="button"
            class="full-settings-btn full-settings-btn-secondary"
            onClick={() => openLink("https://github.com/neural-nomads/era-code")}
          >
            <Github class="w-4 h-4" />
            GitHub
          </button>
          <button
            type="button"
            class="full-settings-btn full-settings-btn-secondary"
            onClick={() => openLink("https://github.com/neural-nomads/era-code/issues/new")}
          >
            <AlertCircle class="w-4 h-4" />
            Report Issue
          </button>
        </div>
      </div>
    </div>
  )
}

export default FullSettingsPane

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
  Activity,
  Sun,
  Moon,
  Monitor,
  BookmarkPlus,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { Button, Input, Switch, Separator } from "./ui"
import UnifiedGovernancePanel from "./unified-governance-panel"
import ConstitutionPanel from "./constitution-panel"
import ActivityMonitor from "./activity-monitor"
import OpenCodeBinarySelector from "./opencode-binary-selector"
import GlobalDirectivesPanel from "./global-directives-panel"
import ProjectDirectivesPanel from "./project-directives-panel"
import ActiveRulesPanel from "./active-rules-panel"
import SavedInstructionsPanel from "./saved-instructions-panel"
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
import {
  useUpdateStatus,
  useIsCheckingUpdates,
  triggerUpdateCheck,
  formatLastChecked,
} from "../stores/update-checker"
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
import { serverApi } from "../lib/api-client"
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
  | "saved-instructions"
  | "environment"
  | "accounts"
  | "activity-monitor"
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
        { id: "saved-instructions" as const, label: "Saved Instructions", icon: BookmarkPlus },
      ],
    },
    {
      title: "System",
      items: [
        { id: "environment" as const, label: "Environment", icon: Terminal },
        { id: "accounts" as const, label: "Accounts", icon: User },
        { id: "activity-monitor" as const, label: "Activity Monitor", icon: Activity },
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
      case "saved-instructions":
        return <SavedInstructionsPanel folder={props.instance?.folder} />
      case "environment":
        return <EnvironmentSection instance={props.instance} />
      case "accounts":
        return <AccountsSection onOpenGCloudModal={props.onOpenGCloudModal} />
      case "activity-monitor":
        return <ActivityMonitor />
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
        <div class="fixed inset-0 z-50 flex flex-col bg-background">
          <div class="flex flex-col h-full w-full bg-background">
            {/* Header */}
            <header class="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary shrink-0">
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-transparent border-none text-muted-foreground text-sm cursor-pointer transition-colors hover:bg-accent hover:text-foreground"
                  onClick={props.onClose}
                >
                  <ArrowLeft class="w-4 h-4" />
                  <span>Back</span>
                </button>
                <h1 class="text-lg font-semibold text-foreground">Settings</h1>
              </div>
              <div class="flex items-center">
                <button
                  type="button"
                  class="flex items-center justify-center w-8 h-8 rounded-md bg-transparent border-none text-muted-foreground cursor-pointer transition-colors hover:bg-accent hover:text-foreground"
                  onClick={props.onClose}
                >
                  <X class="w-5 h-5" />
                </button>
              </div>
            </header>

            {/* Main content */}
            <div class="flex flex-1 overflow-hidden">
              {/* Navigation */}
              <nav class="w-[220px] shrink-0 p-4 px-3 border-r border-border bg-secondary overflow-y-auto">
                <For each={navSections}>
                  {(section) => (
                    <div class="mb-5 last:mb-0">
                      <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-2 mb-1.5">{section.title}</div>
                      <For each={section.items}>
                        {(item) => (
                          <button
                            type="button"
                            class={cn(
                              "flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md bg-transparent border-none text-sm text-left cursor-pointer transition-colors text-muted-foreground hover:bg-accent hover:text-foreground",
                              activeSection() === item.id && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                            )}
                            onClick={() => setActiveSection(item.id)}
                          >
                            <item.icon class="w-4 h-4 shrink-0" />
                            <span>{item.label}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </nav>

              {/* Content */}
              <div class="flex-1 overflow-y-auto px-8 py-6">
                <div class={cn("max-w-[720px] mx-auto", activeSection() === "models" && "max-w-[1200px]")}>
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
  const { preferences: prefs, setDiffViewMode, setThinkingBlocksExpansion, setToolOutputExpansion, setDiagnosticsExpansion, setDefaultClonePath, themePreference, setThemePreference } = useConfig()
  const [clonePathInput, setClonePathInput] = createSignal(prefs().defaultClonePath ?? "")

  return (
    <div class="mb-8">
      <h2 class="text-xl font-semibold text-foreground mb-1">General</h2>
      <p class="text-sm text-muted-foreground mb-6">Display and interface settings</p>

      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Display Options</h3>

        <div class="flex items-center justify-between py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground mb-0.5">Show thinking blocks</div>
            <div class="text-xs text-muted-foreground">Display Claude's reasoning process</div>
          </div>
          <Switch
            checked={prefs().showThinkingBlocks}
            onChange={toggleShowThinkingBlocks}
            class="ml-4"
          />
        </div>

        <div class="flex items-center justify-between py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground mb-0.5">Show timeline tools</div>
            <div class="text-xs text-muted-foreground">Display tool timeline in session view</div>
          </div>
          <Switch
            checked={prefs().showTimelineTools}
            onChange={toggleShowTimelineTools}
            class="ml-4"
          />
        </div>

        <div class="flex items-center justify-between py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground mb-0.5">Show usage metrics</div>
            <div class="text-xs text-muted-foreground">Display token and cost information</div>
          </div>
          <Switch
            checked={prefs().showUsageMetrics}
            onChange={toggleUsageMetrics}
            class="ml-4"
          />
        </div>
      </div>

      <Separator class="my-6" />

      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Theme</h3>

        <div class="flex items-center justify-between py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground mb-0.5">Appearance</div>
            <div class="text-xs text-muted-foreground">Choose light, dark, or follow your system preference</div>
          </div>
          <div class="flex rounded-lg border border-border overflow-hidden ml-4">
            <button
              type="button"
              class={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                themePreference() === "light" ? "bg-info text-info-foreground" : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              onClick={() => setThemePreference("light")}
            >
              <Sun class="w-3.5 h-3.5" />
              Light
            </button>
            <button
              type="button"
              class={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-x border-border",
                themePreference() === "dark" ? "bg-info text-info-foreground" : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              onClick={() => setThemePreference("dark")}
            >
              <Moon class="w-3.5 h-3.5" />
              Dark
            </button>
            <button
              type="button"
              class={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                themePreference() === "system" ? "bg-info text-info-foreground" : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              onClick={() => setThemePreference("system")}
            >
              <Monitor class="w-3.5 h-3.5" />
              System
            </button>
          </div>
        </div>
      </div>

      <Separator class="my-6" />

      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Diff View</h3>

        <div class="flex flex-col gap-2">
          <button
            type="button"
            class={cn(
              "flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-border bg-secondary cursor-pointer transition-colors hover:bg-accent",
              prefs().diffViewMode === "split" && "border-primary bg-primary/10"
            )}
            onClick={() => setDiffViewMode("split")}
          >
            <div class={cn(
              "w-[18px] h-[18px] rounded-full border-2 border-border flex items-center justify-center shrink-0",
              prefs().diffViewMode === "split" && "border-primary after:content-[''] after:w-2.5 after:h-2.5 after:rounded-full after:bg-primary"
            )} />
            <span class="text-sm">Split View</span>
          </button>
          <button
            type="button"
            class={cn(
              "flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-border bg-secondary cursor-pointer transition-colors hover:bg-accent",
              prefs().diffViewMode === "unified" && "border-primary bg-primary/10"
            )}
            onClick={() => setDiffViewMode("unified")}
          >
            <div class={cn(
              "w-[18px] h-[18px] rounded-full border-2 border-border flex items-center justify-center shrink-0",
              prefs().diffViewMode === "unified" && "border-primary after:content-[''] after:w-2.5 after:h-2.5 after:rounded-full after:bg-primary"
            )} />
            <span class="text-sm">Unified View</span>
          </button>
        </div>
      </div>

      <Separator class="my-6" />

      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Default Expansions</h3>

        <div class="mb-4">
          <label class="block text-sm font-medium text-foreground mb-1.5">Thinking blocks</label>
          <select
            class="px-3 py-2 rounded-md bg-secondary border border-border text-foreground text-sm min-w-[180px] cursor-pointer focus:outline-none focus:border-primary"
            value={prefs().thinkingBlocksExpansion ?? "expanded"}
            onChange={(e) => setThinkingBlocksExpansion(e.currentTarget.value as "expanded" | "collapsed")}
          >
            <option value="expanded">Expanded</option>
            <option value="collapsed">Collapsed</option>
          </select>
        </div>

        <div class="mb-4">
          <label class="block text-sm font-medium text-foreground mb-1.5">Tool output</label>
          <select
            class="px-3 py-2 rounded-md bg-secondary border border-border text-foreground text-sm min-w-[180px] cursor-pointer focus:outline-none focus:border-primary"
            value={prefs().toolOutputExpansion ?? "collapsed"}
            onChange={(e) => setToolOutputExpansion(e.currentTarget.value as "expanded" | "collapsed")}
          >
            <option value="expanded">Expanded</option>
            <option value="collapsed">Collapsed</option>
          </select>
        </div>

        <div class="mb-4">
          <label class="block text-sm font-medium text-foreground mb-1.5">Diagnostics</label>
          <select
            class="px-3 py-2 rounded-md bg-secondary border border-border text-foreground text-sm min-w-[180px] cursor-pointer focus:outline-none focus:border-primary"
            value={prefs().diagnosticsExpansion ?? "collapsed"}
            onChange={(e) => setDiagnosticsExpansion(e.currentTarget.value as "expanded" | "collapsed")}
          >
            <option value="expanded">Expanded</option>
            <option value="collapsed">Collapsed</option>
          </select>
        </div>
      </div>

      <Separator class="my-6" />

      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">GitHub</h3>

        <div class="mb-4">
          <label class="block text-sm font-medium text-foreground mb-1.5">Default clone path</label>
          <div class="flex gap-2 items-center">
            <Input
              type="text"
              class="flex-1"
              value={clonePathInput()}
              placeholder="~/Projects"
              onInput={(e) => setClonePathInput(e.currentTarget.value)}
              onBlur={() => setDefaultClonePath(clonePathInput())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setDefaultClonePath(clonePathInput())
                  e.currentTarget.blur()
                }
              }}
            />
            <Button
              variant="outline"
              type="button"
              onClick={async () => {
                try {
                  const result = await serverApi.pickFolder({
                    title: "Select Default Clone Directory",
                    defaultPath: clonePathInput() || undefined,
                  })
                  if (result.path) {
                    setClonePathInput(result.path)
                    setDefaultClonePath(result.path)
                  }
                } catch {
                  // Fallback: user can type path manually
                }
              }}
              class="whitespace-nowrap"
            >
              <Folder class="w-4 h-4" />
              Browse
            </Button>
          </div>
          <div class="text-xs text-muted-foreground mt-1">
            Where new repos are cloned. Defaults to ~/Projects when not set.
          </div>
        </div>
      </div>
    </div>
  )
}

const SessionSection: Component = () => {
  const { preferences: prefs } = useConfig()

  return (
    <div class="mb-8">
      <h2 class="text-xl font-semibold text-foreground mb-1">Session</h2>
      <p class="text-sm text-muted-foreground mb-6">Session behavior and permissions</p>

      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Permissions</h3>

        <div class="flex items-center justify-between py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground mb-0.5">Auto-approve permissions</div>
            <div class="text-xs text-muted-foreground">
              Skip permission prompts for file edits and commands
              (equivalent to --dangerously-skip-permissions)
            </div>
          </div>
          <Switch
            checked={prefs().autoApprovePermissions}
            onChange={toggleAutoApprovePermissions}
            class="ml-4"
          />
        </div>
      </div>

      <Separator class="my-6" />

      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Session Behavior</h3>

        <div class="flex items-center justify-between py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground mb-0.5">Auto-cleanup blank sessions</div>
            <div class="text-xs text-muted-foreground">Remove sessions with no messages on close</div>
          </div>
          <Switch
            checked={prefs().autoCleanupBlankSessions}
            onChange={toggleAutoCleanupBlankSessions}
            class="ml-4"
          />
        </div>

        <div class="flex items-center justify-between py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground mb-0.5">Stop instance on last session delete</div>
            <div class="text-xs text-muted-foreground">Terminate instance when all sessions are closed</div>
          </div>
          <Switch
            checked={prefs().stopInstanceOnLastSessionDelete}
            onChange={toggleStopInstanceOnLastSessionDelete}
            class="ml-4"
          />
        </div>
      </div>

      <Separator class="my-6" />

      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Chat Window</h3>

        <div class="flex items-center justify-between py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground mb-0.5">Collapse tool calls by default</div>
            <div class="text-xs text-muted-foreground">Tool call sections start collapsed in messages</div>
          </div>
          <Switch
            checked={prefs().defaultToolCallsCollapsed}
            onChange={toggleDefaultToolCallsCollapsed}
            class="ml-4"
          />
        </div>

        <div class="flex items-center justify-between py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground mb-0.5">Show verbose output</div>
            <div class="text-xs text-muted-foreground">Display real-time streaming text while generating</div>
          </div>
          <Switch
            checked={prefs().showVerboseOutput}
            onChange={toggleShowVerboseOutput}
            class="ml-4"
          />
        </div>
      </div>
    </div>
  )
}

type AgentType = "main" | "plan" | "explore" | "coder" | "test-writer" | "reviewer"

/** All agent types as a typed array — ensures exhaustiveness with AGENT_META */
const ALL_AGENT_TYPES: AgentType[] = ["main", "plan", "explore", "coder", "test-writer", "reviewer"]

/** Metadata for each agent type. Record<AgentType, ...> enforces exhaustive coverage. */
const AGENT_META: Record<AgentType, { label: string; icon: string; desc: string }> = {
  main:          { label: "Main Agent",     icon: "🤖", desc: "Primary coding assistant" },
  plan:          { label: "Plan Agent",     icon: "📋", desc: "Architecture & planning" },
  explore:       { label: "Explore Agent",  icon: "🔍", desc: "Quick searches" },
  coder:         { label: "Coder Agent",    icon: "🔨", desc: "Implementation specialist" },
  "test-writer": { label: "Test Writer",    icon: "🧪", desc: "Test generation & execution" },
  reviewer:      { label: "Reviewer Agent", icon: "📝", desc: "Code review & quality" },
}

type DefaultModels = Record<AgentType, { providerId: string; modelId: string }>

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
      coder: saved?.coder ?? { providerId: "anthropic", modelId: "claude-sonnet-4-20250514" },
      "test-writer": saved?.["test-writer"] ?? { providerId: "anthropic", modelId: "claude-sonnet-4-20250514" },
      reviewer: saved?.reviewer ?? { providerId: "anthropic", modelId: "claude-sonnet-4-20250514" },
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

  // Agent display metadata is derived from the module-level AGENT_META constant
  const agentLabels = Object.fromEntries(ALL_AGENT_TYPES.map(t => [t, AGENT_META[t].label])) as Record<AgentType, string>
  const agentIcons = Object.fromEntries(ALL_AGENT_TYPES.map(t => [t, AGENT_META[t].icon])) as Record<AgentType, string>
  const agentDescriptions = Object.fromEntries(ALL_AGENT_TYPES.map(t => [t, AGENT_META[t].desc])) as Record<AgentType, string>

  // Get price class for color coding
  const getPriceClass = (model: ModelsDevModel | undefined) => {
    if (!model?.cost) return ""
    const avgCost = (model.cost.input + model.cost.output) / 2
    if (avgCost === 0) return "text-success"
    if (avgCost < 1) return "text-success"
    if (avgCost < 10) return "text-warning"
    return "text-destructive"
  }

  return (
    <div class="mb-8">
      {/* Header with sync button */}
      <div class="flex items-start justify-between mb-4">
        <div>
          <h2 class="text-xl font-semibold text-foreground mb-1">Models</h2>
          <p class="text-sm text-muted-foreground mb-6">Browse models, compare pricing, and configure defaults</p>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 p-1.5 rounded text-xs bg-transparent border-none text-muted-foreground cursor-pointer transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          onClick={handleSync}
          disabled={isModelsSyncing()}
          title={`Prices last synced: ${formatLastUpdated(lastUpdated())}`}
        >
          <RefreshCw class={`w-3.5 h-3.5 ${isModelsSyncing() ? "animate-spin" : ""}`} />
          {isModelsSyncing() ? "Syncing..." : "Sync Prices"}
        </button>
      </div>

      {/* Quick Access Cards - Agent Defaults with Pricing */}
      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Quick Access</h3>
        <p class="text-xs text-muted-foreground mb-3">Default models for each agent type</p>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <For each={ALL_AGENT_TYPES}>
            {(agent) => {
              const model = () => defaultModels()[agent]
              const modelData = () => getAgentModelData(agent)

              return (
                <div class="flex flex-col gap-2.5 p-3.5 bg-secondary border border-border rounded-lg transition-all hover:border-border/80 hover:shadow-md">
                  <div class="flex items-start gap-2">
                    <span class="text-xl leading-none shrink-0">{agentIcons[agent]}</span>
                    <div class="flex flex-col min-w-0">
                      <span class="text-[0.8125rem] font-semibold text-foreground">{agentLabels[agent]}</span>
                      <span class="text-[0.6875rem] text-muted-foreground">{agentDescriptions[agent]}</span>
                    </div>
                  </div>

                  <div class="px-2.5 py-2 bg-background rounded-md min-w-0">
                    <div class="text-xs font-medium text-foreground truncate">
                      {modelData()?.name || model().modelId}
                    </div>
                    <div class="text-[0.6875rem] text-muted-foreground">
                      {model().providerId}
                    </div>
                  </div>

                  <div class="flex items-baseline gap-1.5">
                    <Show when={modelData()?.cost} fallback={<span class="text-muted-foreground">—</span>}>
                      <span class={`text-sm font-semibold font-mono ${getPriceClass(modelData())}`}>
                        ${modelData()!.cost!.input}/${modelData()!.cost!.output}
                      </span>
                      <span class="text-[0.625rem] text-muted-foreground">per 1M tokens</span>
                    </Show>
                  </div>

                  <button
                    type="button"
                    class="self-start px-3 py-1.5 text-xs font-medium text-info bg-transparent border border-info rounded-md cursor-pointer transition-all hover:bg-info/10"
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

      <div class="h-px bg-border my-6" />

      {/* Model Catalog - Browsable list with pricing */}
      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Model Catalog</h3>
        <p class="text-xs text-muted-foreground mb-3">Browse all available models with pricing and capabilities</p>

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
          class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background/95 backdrop-blur-sm rounded-xl border border-border shadow-xl w-full max-w-lg p-6 flex flex-col gap-4"
          data-modal-surface
          style={{ "z-index": 101 }}
        >
        <h2 class="text-lg font-semibold text-primary">
          Select Model for {props.agentLabel}
        </h2>

        <div class="flex flex-col gap-4">
          {/* Provider Selector */}
          <div class="relative">
            <label class="text-xs text-muted-foreground mb-2 block">Provider</label>
            <button
              type="button"
              class="w-full px-3 py-2.5 rounded-lg border border-border bg-secondary hover:bg-accent transition-colors flex items-center gap-3 text-left"
              onClick={() => {
                setShowProviderList(!showProviderList())
                setShowModelList(false)
              }}
            >
              <Show
                when={selectedProviderData()}
                fallback={<span class="text-muted-foreground">Select provider...</span>}
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
              <ChevronDown class="w-4 h-4 text-muted-foreground flex-shrink-0" />
            </button>

            <Show when={showProviderList()}>
              <div class="absolute top-full left-0 right-0 mt-1 bg-secondary border border-border rounded-lg shadow-lg z-10 max-h-64 overflow-hidden flex flex-col">
                <div class="p-2 border-b border-border">
                  <input
                    type="text"
                    class="w-full px-2 py-1.5 text-sm bg-background rounded border border-border focus:border-info outline-none text-primary"
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
                        class={`w-full px-3 py-2 flex items-center gap-3 hover:bg-accent transition-colors text-left ${
                          selectedProvider() === provider.id ? "bg-accent" : ""
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
              <label class="text-xs text-muted-foreground mb-2 block">Model</label>
              <button
                type="button"
                class="w-full px-3 py-2.5 rounded-lg border border-border bg-secondary hover:bg-accent transition-colors flex items-center gap-3 text-left"
                onClick={() => {
                  setShowModelList(!showModelList())
                  setShowProviderList(false)
                }}
              >
                <Show
                  when={selectedModelData()}
                  fallback={<span class="text-muted-foreground">Select model...</span>}
                >
                  {(model) => (
                    <span class="text-primary flex-1">{model().name || model().id}</span>
                  )}
                </Show>
                <ChevronDown class="w-4 h-4 text-muted-foreground flex-shrink-0" />
              </button>

              <Show when={showModelList()}>
                <div class="absolute top-full left-0 right-0 mt-1 bg-secondary border border-border rounded-lg shadow-lg z-10 max-h-64 overflow-hidden flex flex-col">
                  <div class="p-2 border-b border-border">
                    <input
                      type="text"
                      class="w-full px-2 py-1.5 text-sm bg-background rounded border border-border focus:border-info outline-none text-primary"
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
                          class={`w-full px-3 py-2 hover:bg-accent transition-colors text-left ${
                            selectedModel() === model.id ? "bg-accent" : ""
                          }`}
                          onClick={() => handleSelectModel(model.id)}
                        >
                          <div class="text-sm text-primary">{model.name || model.id}</div>
                          <div class="text-xs text-muted-foreground">{model.id}</div>
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
            class="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-md transition-colors cursor-pointer bg-secondary text-secondary-foreground hover:bg-secondary/80"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            class="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-md transition-colors cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90"
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
    <div class="mb-8">
      <h2 class="text-xl font-semibold text-foreground mb-1">MCP Servers</h2>
      <p class="text-sm text-muted-foreground mb-6">Model Context Protocol server configuration</p>

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
    <div class="mb-8">
      <h2 class="text-xl font-semibold text-foreground mb-1">Slash Commands</h2>
      <p class="text-sm text-muted-foreground mb-6">Built-in and custom commands</p>

      {/* Success/Error Messages */}
      <Show when={saveSuccess()}>
        <div class="rounded-lg border bg-card p-4 mb-3" style="background-color: hsl(var(--success) / 0.1); border-color: hsl(var(--success));">
          <div class="flex items-center gap-2 text-success text-sm">
            <Check class="w-4 h-4" />
            Command saved successfully
          </div>
        </div>
      </Show>

      <Show when={saveError()}>
        <div class="rounded-lg border bg-card p-4 mb-3" style="background-color: hsl(var(--destructive) / 0.1); border-color: hsl(var(--destructive));">
          <div class="flex items-center gap-2 text-destructive text-sm">
            <AlertCircle class="w-4 h-4" />
            {saveError()}
          </div>
        </div>
      </Show>

      {/* Add/Edit Form */}
      <Show when={isEditing()}>
        <div class="rounded-lg border bg-card p-4 mb-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-base font-medium text-foreground">
              {isAddingCommand() ? "Add Custom Command" : `Edit /${editingCommand()}`}
            </span>
          </div>
          <div class="flex flex-col gap-3 mt-3">
            <div class="mb-4">
              <label class="block text-sm font-medium text-foreground mb-1.5">Command Name *</label>
              <input
                type="text"
                class="w-full px-3 py-2.5 rounded-md bg-secondary border border-border text-foreground text-sm focus:outline-none focus:border-primary"
                placeholder="e.g., test, deploy, review"
                value={formName()}
                onInput={(e) => setFormName(e.currentTarget.value)}
                disabled={editingCommand() !== null}
              />
              <span class="text-xs text-muted-foreground">Used as /{formName() || "command"}</span>
            </div>

            <div class="mb-4">
              <label class="block text-sm font-medium text-foreground mb-1.5">Template *</label>
              <textarea
                class="w-full px-3 py-2.5 rounded-md bg-secondary border border-border text-foreground text-sm focus:outline-none focus:border-primary"
                placeholder="The prompt sent to the LLM. Use $ARGUMENTS for user input."
                value={formTemplate()}
                onInput={(e) => setFormTemplate(e.currentTarget.value)}
                rows={3}
                style="resize: vertical; min-height: 80px;"
              />
            </div>

            <div class="mb-4">
              <label class="block text-sm font-medium text-foreground mb-1.5">Description</label>
              <input
                type="text"
                class="w-full px-3 py-2.5 rounded-md bg-secondary border border-border text-foreground text-sm focus:outline-none focus:border-primary"
                placeholder="Brief explanation shown in the picker"
                value={formDescription()}
                onInput={(e) => setFormDescription(e.currentTarget.value)}
              />
            </div>

            <div class="flex gap-3">
              <div class="mb-4 flex-1">
                <label class="block text-sm font-medium text-foreground mb-1.5">Agent</label>
                <input
                  type="text"
                  class="w-full px-3 py-2.5 rounded-md bg-secondary border border-border text-foreground text-sm focus:outline-none focus:border-primary"
                  placeholder="e.g., build, code"
                  value={formAgent()}
                  onInput={(e) => setFormAgent(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4 flex-1">
                <label class="block text-sm font-medium text-foreground mb-1.5">Model</label>
                <input
                  type="text"
                  class="w-full px-3 py-2.5 rounded-md bg-secondary border border-border text-foreground text-sm focus:outline-none focus:border-primary"
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
              <button type="button" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-secondary border border-border text-foreground cursor-pointer transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed" onClick={cancelEdit}>
                Cancel
              </button>
              <button type="button" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground border-none cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed" onClick={saveCommand}>
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
        <div class="mb-6">
          <div class="flex items-center justify-between">
            <button
              type="button"
              class="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary"
              onClick={() => setShowCustom(!showCustom())}
            >
              {showCustom() ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
              <span>Custom Commands</span>
              <span class="text-xs text-muted-foreground">({customCommands().length})</span>
            </button>
            <Show when={props.instanceId}>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 p-1.5 rounded text-xs bg-transparent border-none text-muted-foreground cursor-pointer transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                onClick={startAddCommand}
              >
                <Plus class="w-3 h-3" />
                Add Command
              </button>
            </Show>
          </div>

          <Show when={showCustom()}>
            <Show when={!props.instanceId}>
              <div class="rounded-lg border bg-card p-4 mt-3">
                <div class="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertCircle class="w-4 h-4" />
                  Open a project to manage custom commands
                </div>
              </div>
            </Show>
            <Show when={props.instanceId && customCommands().length === 0}>
              <div class="rounded-lg border bg-card p-4 mt-3">
                <div class="text-sm text-muted-foreground">
                  No custom commands defined. Click "Add Command" to create one.
                </div>
              </div>
            </Show>
            <div class="flex flex-col gap-2 mt-2">
              <For each={customCommands()}>
                {(cmd) => (
                  <div class="flex items-center gap-3 p-3 rounded-lg border bg-secondary">
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium text-foreground">/{cmd.name}</div>
                      <Show when={cmd.description}>
                        <div class="text-xs text-muted-foreground">{cmd.description}</div>
                      </Show>
                      <div class="flex gap-2 mt-1">
                        <Show when={cmd.agent}>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-accent text-muted-foreground">agent: {cmd.agent}</span>
                        </Show>
                        <Show when={cmd.model}>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-accent text-muted-foreground">model: {cmd.model}</span>
                        </Show>
                        <Show when={cmd.subtask}>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-accent text-muted-foreground">subtask</span>
                        </Show>
                      </div>
                    </div>
                    <div class="flex gap-1">
                      <button
                        type="button"
                        class="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-primary"
                        onClick={() => startEditCommand(cmd)}
                        title="Edit command"
                      >
                        <Edit2 class="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        class="p-1.5 rounded hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive"
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

        <div class="h-px bg-border my-6" />

        {/* Built-in Commands Section */}
        <div class="mb-6">
          <button
            type="button"
            class="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary"
            onClick={() => setShowBuiltIn(!showBuiltIn())}
          >
            {showBuiltIn() ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
            <span>Built-in Commands</span>
            <span class="text-xs text-muted-foreground">({builtInCommands().length})</span>
          </button>

          <Show when={showBuiltIn()}>
            <div class="flex flex-col gap-2 mt-2">
              <For each={builtInCommands()}>
                {(cmd) => (
                  <div class="flex items-center gap-3 p-3 rounded-lg border bg-secondary">
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium text-foreground">/{cmd.name}</div>
                      <Show when={cmd.description}>
                        <div class="text-xs text-muted-foreground">{cmd.description}</div>
                      </Show>
                    </div>
                    <span class="text-xs px-1.5 py-0.5 rounded bg-info/10 text-info">built-in</span>
                  </div>
                )}
              </For>
              <Show when={builtInCommands().length === 0}>
                <div class="flex items-center gap-3 p-3 rounded-lg border bg-secondary">
                  <div class="text-sm text-muted-foreground">
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
    <div class="mb-8">
      <h2 class="text-xl font-semibold text-foreground mb-1">Governance</h2>
      <p class="text-sm text-muted-foreground mb-6">Era Code governance rules and enforcement</p>

      <Show when={!isEraInstalled()}>
        <div class="rounded-lg border bg-card p-4 mb-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-base font-medium text-foreground">Era Code Not Installed</span>
          </div>
          <div class="text-sm text-muted-foreground leading-relaxed">
            Install Era Code to enable governance rules and enforcement.
          </div>
        </div>
      </Show>

      <Show when={isEraInstalled()}>
        {/* Loading State */}
        <Show when={isGovernanceLoading()}>
          <div class="rounded-lg border bg-card p-4 mb-3">
            <div class="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw class="w-4 h-4 animate-spin" />
              Loading governance rules...
            </div>
          </div>
        </Show>

        {/* Error State */}
        <Show when={governanceError()}>
          <div class="rounded-lg border bg-card p-4 mb-3" style="background-color: hsl(var(--destructive) / 0.1); border-color: hsl(var(--destructive));">
            <div class="flex items-center gap-2 text-destructive text-sm">
              <AlertTriangle class="w-4 h-4" />
              {governanceError()}
            </div>
          </div>
        </Show>

        {/* Summary Card */}
        <Show when={!isGovernanceLoading() && governanceSummary()}>
          <div class="rounded-lg border bg-card p-4 mb-3">
            <div class="flex items-center justify-between">
              <div class="flex gap-6 text-sm">
                <div>
                  <span class="text-muted-foreground">Total Rules: </span>
                  <span class="font-medium">{governanceSummary()!.totalRules}</span>
                </div>
                <div>
                  <span class="text-muted-foreground">Active Overrides: </span>
                  <span class="font-medium">{activeOverridesCount()}</span>
                </div>
              </div>
              <Show when={isAuditMode()}>
                <span class="text-xs px-2 py-1 rounded bg-warning/10 text-warning">Audit Mode</span>
              </Show>
            </div>
          </div>
        </Show>

        {/* Hardcoded Rules Section */}
        <Show when={!isGovernanceLoading() && hardcodedRules().length > 0}>
          <div class="mb-6 mt-4">
            <button
              type="button"
              class="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary w-full"
              onClick={() => toggleSection("hardcoded")}
            >
              {expandedSections().hardcoded ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
              <ShieldAlert class="w-4 h-4 text-destructive" />
              <span>Hardcoded Rules</span>
              <span class="text-xs text-muted-foreground">({hardcodedRules().length})</span>
            </button>
            <p class="text-xs text-muted-foreground mt-1 ml-6">Safety rules that cannot be overridden</p>

            <Show when={expandedSections().hardcoded}>
              <div class="flex flex-col gap-2 mt-2">
                <For each={hardcodedRules()}>
                  {(rule) => (
                    <div class="flex flex-col items-start gap-1 p-3 rounded-lg border bg-secondary">
                      <div class="flex items-center gap-2">
                        <span class="font-mono text-xs text-primary">{rule.id}</span>
                        <span class="text-xs px-1.5 py-0.5 rounded bg-destructive/10 text-destructive">Deny</span>
                        <ShieldOff class="w-3 h-3 text-muted-foreground" title="Cannot be overridden" />
                      </div>
                      <code class="text-xs text-muted-foreground break-all">{rule.pattern}</code>
                      <span class="text-xs text-muted-foreground">{rule.reason}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        {/* Default Rules Section */}
        <Show when={!isGovernanceLoading() && defaultRules().length > 0}>
          <div class="mb-6 mt-4">
            <button
              type="button"
              class="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary w-full"
              onClick={() => toggleSection("default")}
            >
              {expandedSections().default ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
              <Shield class="w-4 h-4 text-warning" />
              <span>Default Rules</span>
              <span class="text-xs text-muted-foreground">({defaultRules().length})</span>
            </button>
            <p class="text-xs text-muted-foreground mt-1 ml-6">Can be overridden in project governance config</p>

            <Show when={expandedSections().default}>
              <div class="flex flex-col gap-2 mt-2">
                <For each={defaultRules()}>
                  {(rule) => {
                    const isOverridden = () => rule.action === "allow"
                    const isToggling = () => togglingRules().has(rule.id)

                    return (
                      <div class={cn("flex flex-col items-start gap-1 p-3 rounded-lg border bg-secondary", isOverridden() && "opacity-60")}>
                        <div class="flex items-center gap-2 w-full">
                          <span class="font-mono text-xs text-primary">{rule.id}</span>
                          <Show when={isOverridden()}>
                            <span class="text-xs px-1.5 py-0.5 rounded bg-success/10 text-success">Allow</span>
                          </Show>
                          <Show when={!isOverridden()}>
                            <span class="text-xs px-1.5 py-0.5 rounded bg-destructive/10 text-destructive">Deny</span>
                          </Show>
                          <div class="flex-1" />
                          <button
                            type="button"
                            class={`p-1 rounded transition-colors ${isOverridden() ? "text-success hover:text-success" : "text-muted-foreground hover:text-primary"}`}
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
                        <code class="text-xs text-muted-foreground break-all">{rule.pattern}</code>
                        <span class="text-xs text-muted-foreground">{rule.reason}</span>
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
          <div class="mb-6 mt-4">
            <button
              type="button"
              class="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary w-full"
              onClick={() => toggleSection("project")}
            >
              {expandedSections().project ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
              <ShieldCheck class="w-4 h-4 text-info" />
              <span>Project Rules</span>
              <span class="text-xs text-muted-foreground">({projectRules().length})</span>
            </button>
            <p class="text-xs text-muted-foreground mt-1 ml-6">Custom rules defined in this project</p>

            <Show when={expandedSections().project}>
              <div class="flex flex-col gap-2 mt-2">
                <For each={projectRules()}>
                  {(rule) => (
                    <div class="flex flex-col items-start gap-1 p-3 rounded-lg border bg-secondary">
                      <div class="flex items-center gap-2">
                        <span class="font-mono text-xs text-primary">{rule.id}</span>
                        <Show when={rule.action === "allow"}>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-success/10 text-success">Allow</span>
                        </Show>
                        <Show when={rule.action === "deny"}>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-destructive/10 text-destructive">Deny</span>
                        </Show>
                      </div>
                      <code class="text-xs text-muted-foreground break-all">{rule.pattern}</code>
                      <span class="text-xs text-muted-foreground">{rule.reason}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        {/* No Rules State */}
        <Show when={!isGovernanceLoading() && !governanceError() && governanceRules().length === 0}>
          <div class="rounded-lg border bg-card p-4 mt-4">
            <div class="flex items-center gap-2 text-sm text-muted-foreground">
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
    <div class="mb-8">
      <h2 class="text-xl font-semibold text-foreground mb-1">Directives</h2>
      <p class="text-sm text-muted-foreground mb-6">Project and global directives</p>

      {/* Success/Error Messages */}
      <Show when={saveSuccess()}>
        <div class="rounded-lg border bg-card p-4 mb-3" style="background-color: hsl(var(--success) / 0.1); border-color: hsl(var(--success));">
          <div class="flex items-center gap-2 text-success text-sm">
            <Check class="w-4 h-4" />
            Directives saved successfully
          </div>
        </div>
      </Show>

      <Show when={saveError()}>
        <div class="rounded-lg border bg-card p-4 mb-3" style="background-color: hsl(var(--destructive) / 0.1); border-color: hsl(var(--destructive));">
          <div class="flex items-center gap-2 text-destructive text-sm">
            <AlertCircle class="w-4 h-4" />
            {saveError()}
          </div>
        </div>
      </Show>

      {/* Loading State */}
      <Show when={isDirectivesLoading()}>
        <div class="rounded-lg border bg-card p-4 mb-3">
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw class="w-4 h-4 animate-spin" />
            Loading directives...
          </div>
        </div>
      </Show>

      {/* Project Directives Section */}
      <Show when={!isDirectivesLoading()}>
        <div class="mb-6">
          <div class="flex items-center justify-between">
            <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Project Directives</h3>
            <span class="text-xs text-muted-foreground font-mono">.era/memory/directives.md</span>
          </div>

          <Show when={!editingProject()}>
            <div class="rounded-lg border bg-card p-4 mt-2">
              <Show when={projectDirectives()?.exists && projectDirectives()?.content}>
                <pre class="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                  {projectDirectives()!.content.slice(0, 500)}
                  {projectDirectives()!.content.length > 500 ? "..." : ""}
                </pre>
                <div class="flex justify-end mt-3">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 p-1.5 rounded text-xs bg-transparent border-none text-muted-foreground cursor-pointer transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                    onClick={startEditProject}
                    disabled={!props.folder}
                  >
                    <Edit2 class="w-3 h-3" />
                    Edit
                  </button>
                </div>
              </Show>
              <Show when={!projectDirectives()?.exists}>
                <div class="text-sm text-muted-foreground">
                  No project directives configured.
                </div>
                <div class="flex justify-end mt-3">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground border-none cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={startEditProject}
                    disabled={!props.folder}
                  >
                    <Plus class="w-3 h-3" />
                    Create Directives
                  </button>
                </div>
              </Show>
              <Show when={!props.folder}>
                <div class="text-xs text-muted-foreground mt-2">
                  Open a project to edit project directives
                </div>
              </Show>
            </div>
          </Show>

          <Show when={editingProject()}>
            <div class="rounded-lg border bg-card p-4 mt-2">
              <textarea
                class="w-full px-3 py-2.5 rounded-md bg-secondary border border-border text-foreground text-sm font-mono text-xs focus:outline-none focus:border-primary"
                value={projectContent()}
                onInput={(e) => setProjectContent(e.currentTarget.value)}
                rows={12}
                style="resize: vertical; min-height: 200px;"
                placeholder="# Project Directives&#10;&#10;Enter your project-specific guidelines here..."
              />
              <div class="flex justify-end gap-2 mt-3">
                <button type="button" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-secondary border border-border text-foreground cursor-pointer transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed" onClick={cancelEdit}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground border-none cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
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

        <div class="h-px bg-border my-6" />

        {/* Global Directives Section */}
        <div class="mb-6">
          <div class="flex items-center justify-between">
            <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Global Directives</h3>
            <span class="text-xs text-muted-foreground font-mono">~/.era/memory/directives.md</span>
          </div>

          <Show when={!editingGlobal()}>
            <div class="rounded-lg border bg-card p-4 mt-2">
              <Show when={globalDirectives()?.exists && globalDirectives()?.content}>
                <pre class="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                  {globalDirectives()!.content.slice(0, 500)}
                  {globalDirectives()!.content.length > 500 ? "..." : ""}
                </pre>
                <div class="flex justify-end mt-3">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 p-1.5 rounded text-xs bg-transparent border-none text-muted-foreground cursor-pointer transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                    onClick={startEditGlobal}
                  >
                    <Edit2 class="w-3 h-3" />
                    Edit
                  </button>
                </div>
              </Show>
              <Show when={!globalDirectives()?.exists}>
                <div class="text-sm text-muted-foreground">
                  No global directives configured.
                </div>
                <div class="flex justify-end mt-3">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground border-none cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
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
            <div class="rounded-lg border bg-card p-4 mt-2">
              <textarea
                class="w-full px-3 py-2.5 rounded-md bg-secondary border border-border text-foreground text-sm font-mono text-xs focus:outline-none focus:border-primary"
                value={globalContent()}
                onInput={(e) => setGlobalContent(e.currentTarget.value)}
                rows={12}
                style="resize: vertical; min-height: 200px;"
                placeholder="# Global Directives&#10;&#10;Enter guidelines that apply to all projects..."
              />
              <div class="flex justify-end gap-2 mt-3">
                <button type="button" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-secondary border border-border text-foreground cursor-pointer transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed" onClick={cancelEdit}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground border-none cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
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

        <div class="h-px bg-border my-6" />

        {/* Constitution Section */}
        <div class="mb-6">
          <div class="flex items-center gap-2">
            <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Constitution</h3>
            <span class="text-xs px-1.5 py-0.5 rounded bg-info/10 text-info flex items-center gap-1">
              <Lock class="w-3 h-3" />
              Read-only
            </span>
          </div>
          <div class="rounded-lg border bg-card p-4 mt-2">
            <div class="text-sm text-muted-foreground">
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
    <div class="mb-8">
      <h2 class="text-xl font-semibold text-foreground mb-1">Environment</h2>
      <p class="text-sm text-muted-foreground mb-6">Environment variables and instance details</p>

      <EnvironmentVariablesEditor />

      <Show when={props.instance}>
        <div class="h-px bg-border my-6" />

        <div class="mb-6">
          <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Current Instance</h3>
          <div class="rounded-lg border bg-card p-4 mb-3">
            <table class="w-full text-sm">
              <tbody>
                <tr>
                  <td class="py-1 text-muted-foreground">ID</td>
                  <td class="py-1 font-mono">{props.instance?.id.slice(0, 8)}...</td>
                </tr>
                <tr>
                  <td class="py-1 text-muted-foreground">Folder</td>
                  <td class="py-1 font-mono truncate max-w-[300px]">{props.instance?.folder}</td>
                </tr>
                <tr>
                  <td class="py-1 text-muted-foreground">Port</td>
                  <td class="py-1 font-mono">{props.instance?.port}</td>
                </tr>
                <tr>
                  <td class="py-1 text-muted-foreground">Status</td>
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
    try {
      await initiateGitHubLogin()
    } catch (error) {
      setLoginMessage(error instanceof Error ? error.message : "Login failed")
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
    try {
      await installGhCli()
    } catch (error) {
      setGhInstallError(error instanceof Error ? error.message : "Installation failed")
    } finally {
      setGhInstalling(false)
    }
  }

  const isGCloudConnected = () => isGCloudAuthenticated() && !isGCloudExpired()
  const isGCloudExpiredStatus = () => isGCloudAuthenticated() && isGCloudExpired()

  return (
    <div class="mb-8">
      <h2 class="text-xl font-semibold text-foreground mb-1">Accounts</h2>
      <p class="text-sm text-muted-foreground mb-6">Connect accounts for enhanced integrations</p>

      {/* GitHub Section */}
      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">GitHub</h3>
        <div class="rounded-lg border bg-card p-4">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-10 h-10 rounded-lg bg-muted text-muted-foreground">
              <Github class="w-5 h-5" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-base font-medium text-foreground">GitHub</div>
              <div class={cn("text-sm text-muted-foreground", isGitHubAuthenticated() && "text-success")}>
                {isGitHubAuthenticated() ? `Connected as ${githubUsername()}` : "Not connected"}
              </div>
            </div>
            <Show when={isGitHubAuthenticated()}>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 p-1.5 rounded bg-transparent border-none text-muted-foreground cursor-pointer transition-colors hover:bg-accent hover:text-foreground ml-auto disabled:opacity-50"
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
            <div class="text-sm text-muted-foreground leading-relaxed mt-3">
              <RefreshCw class="w-4 h-4 animate-spin inline mr-2" />
              Checking GitHub CLI status...
            </div>
          </Show>

          {/* Show CLI not installed warning (only after check completes) */}
          <Show when={isGhCliChecked() && !isGhCliInstalled()}>
            <div class="flex items-center gap-2 px-3 py-2.5 rounded-md bg-warning/10 text-warning text-sm mt-3">
              <AlertCircle class="w-4 h-4" />
              <span>GitHub CLI (gh) is not installed. Install it to enable GitHub authentication.</span>
            </div>
            <Show when={ghInstallError()}>
              <div class="px-3 py-2 rounded-md bg-destructive/10 mt-2">
                <span class="text-status-error text-xs">{ghInstallError()}</span>
              </div>
            </Show>
            <div class="flex gap-2 mt-3">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground border-none cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
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
            <div class="text-sm text-muted-foreground leading-relaxed mt-3">
              Connected for PR creation, issue management, and GitHub Copilot integration.
            </div>
            <div class="flex gap-2 mt-3">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-transparent border border-destructive text-destructive cursor-pointer transition-colors hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                onClick={handleGitHubLogout}
              >
                <X class="w-4 h-4" />
                Disconnect
              </button>
            </div>
          </Show>

          {/* Show login state */}
          <Show when={isGhCliChecked() && isGhCliInstalled() && !isGitHubAuthenticated()}>
            <div class="text-sm text-muted-foreground leading-relaxed mt-3">
              Connect for PR creation, issue management, and GitHub Copilot integration.
            </div>
            <Show when={loginMessage()}>
              <div class="p-3 rounded-md bg-muted text-sm text-muted-foreground mt-2">
                <Info class="w-4 h-4" />
                <span>{loginMessage()}</span>
              </div>
            </Show>
            <Show when={githubError()}>
              <div class="px-3 py-2 rounded-md bg-destructive/10 mt-2">
                <AlertCircle class="w-4 h-4" />
                <span class="text-status-error text-xs">{githubError()}</span>
              </div>
            </Show>
            <div class="flex gap-2 mt-3">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground border-none cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
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

      <div class="h-px bg-border my-6" />

      {/* Google Cloud Section */}
      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Google Cloud</h3>
        <div class="rounded-lg border bg-card p-4">
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-10 h-10 rounded-lg bg-muted text-muted-foreground">
              <Globe class="w-5 h-5" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-base font-medium text-foreground">Google Cloud</div>
              <div class={cn("text-sm text-muted-foreground", isGCloudConnected() && "text-success", isGCloudExpiredStatus() && "text-warning")}>
                {isGCloudConnected() ? "Connected" : isGCloudExpiredStatus() ? "Session Expired" : "Not connected"}
              </div>
            </div>
            <Show when={isGCloudAuthenticated()}>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 p-1.5 rounded bg-transparent border-none text-muted-foreground cursor-pointer transition-colors hover:bg-accent hover:text-foreground ml-auto disabled:opacity-50"
                onClick={handleGCloudRefresh}
                disabled={isGCloudLoading()}
                title="Refresh status"
              >
                <RefreshCw class={`w-4 h-4 ${isGCloudLoading() ? "animate-spin" : ""}`} />
              </button>
            </Show>
          </div>

          <Show when={isGCloudConnected()}>
            <div class="flex flex-col gap-2 mt-3 pt-3 border-t border-border">
              <div class="flex justify-between items-center text-sm">
                <span class="text-muted-foreground">Account</span>
                <span class="text-foreground font-mono">{gcloudAccount()}</span>
              </div>
              <Show when={gcloudProject()}>
                <div class="flex justify-between items-center text-sm">
                  <span class="text-muted-foreground">Project</span>
                  <span class="text-foreground font-mono">{gcloudProject()}</span>
                </div>
              </Show>
              <div class="flex justify-between items-center text-sm">
                <span class="text-muted-foreground">Token expires</span>
                <span class="text-foreground font-mono">
                  {formatTokenExpiry(gcloudTokenExpiry())}
                </span>
              </div>
            </div>
            <div class="flex gap-2 mt-3">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-transparent border border-destructive text-destructive cursor-pointer transition-colors hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                onClick={handleGCloudLogout}
              >
                <X class="w-4 h-4" />
                Disconnect
              </button>
            </div>
          </Show>

          <Show when={isGCloudExpiredStatus()}>
            <div class="flex items-center gap-2 px-3 py-2.5 rounded-md bg-warning/10 text-warning text-sm mt-3">
              <AlertCircle class="w-4 h-4" />
              <span>Your session has expired. Please reauthenticate to continue using Google Cloud features.</span>
            </div>
            <div class="flex gap-2 mt-3">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground border-none cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => props.onOpenGCloudModal?.()}
              >
                <Globe class="w-4 h-4" />
                Reauthenticate
              </button>
            </div>
          </Show>

          <Show when={!isGCloudAuthenticated()}>
            <div class="text-sm text-muted-foreground leading-relaxed mt-3">
              Connect for cloud infrastructure, AI services, and Vertex AI integration.
            </div>
            <div class="flex gap-2 mt-3">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground border-none cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => props.onOpenGCloudModal?.()}
              >
                <Globe class="w-4 h-4" />
                Connect with Google
              </button>
            </div>
          </Show>
        </div>
      </div>

      <div class="h-px bg-border my-6" />

      {/* Coming Soon Section */}
      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Coming Soon</h3>
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-3 p-3 rounded-lg border bg-secondary">
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-foreground">Linear</div>
              <div class="text-xs text-muted-foreground">Project and issue tracking</div>
            </div>
            <span class="inline-block px-3 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium">Coming Soon</span>
          </div>
          <div class="flex items-center gap-3 p-3 rounded-lg border bg-secondary">
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-foreground">Notion</div>
              <div class="text-xs text-muted-foreground">Documentation and knowledge base</div>
            </div>
            <span class="inline-block px-3 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium">Coming Soon</span>
          </div>
          <div class="flex items-center gap-3 p-3 rounded-lg border bg-secondary">
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-foreground">Slack</div>
              <div class="text-xs text-muted-foreground">Team communication</div>
            </div>
            <span class="inline-block px-3 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium">Coming Soon</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const EraCodeSection: Component = () => {
  const counts = createMemo(() => eraAssetCounts())
  const { preferences: prefs, updatePreferences } = useConfig()
  const [selectedBinary, setSelectedBinary] = createSignal(prefs().lastUsedBinary || "opencode")

  const handleBinaryChange = (binary: string) => {
    setSelectedBinary(binary)
    updatePreferences({ lastUsedBinary: binary, binaryPreferenceSource: "user" })
  }

  return (
    <div class="mb-8">
      <h2 class="text-xl font-semibold text-foreground mb-1">Era Code</h2>
      <p class="text-sm text-muted-foreground mb-6">Era Code CLI status and installed assets</p>

      {/* OpenCode Binary Selector */}
      <div class="mb-6">
        <OpenCodeBinarySelector
          selectedBinary={selectedBinary()}
          onBinaryChange={handleBinaryChange}
          isVisible={true}
        />
      </div>

      <div class="h-px bg-border my-6" />

      {/* Version and status */}
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-3 p-4 rounded-lg mb-4">
          <Show
            when={isEraInstalled()}
            fallback={
              <span class="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border text-muted-foreground">
                <AlertCircle class="w-4 h-4" />
                Not Installed
              </span>
            }
          >
            <span class="flex items-center gap-2 px-3 py-2 rounded-lg bg-success/10 border border-success text-success">
              <Check class="w-4 h-4" />
              Installed
            </span>
          </Show>
        </div>
        <Show when={eraVersion()}>
          <div class="text-sm font-medium text-foreground font-mono">v{eraVersion()}</div>
        </Show>
      </div>

      <Show when={isEraInstalled()}>
        {/* Assets grid */}
        <Show when={areEraAssetsAvailable() && counts()}>
          <div class="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-3 mt-4">
            <div class="flex flex-col items-center p-4 rounded-lg bg-secondary border border-border">
              <div class="text-2xl font-bold text-foreground">{counts()!.agents}</div>
              <div class="text-xs text-muted-foreground uppercase">Agents</div>
            </div>
            <div class="flex flex-col items-center p-4 rounded-lg bg-secondary border border-border">
              <div class="text-2xl font-bold text-foreground">{counts()!.commands}</div>
              <div class="text-xs text-muted-foreground uppercase">Commands</div>
            </div>
            <div class="flex flex-col items-center p-4 rounded-lg bg-secondary border border-border">
              <div class="text-2xl font-bold text-foreground">{counts()!.skills}</div>
              <div class="text-xs text-muted-foreground uppercase">Skills</div>
            </div>
            <div class="flex flex-col items-center p-4 rounded-lg bg-secondary border border-border">
              <div class="text-2xl font-bold text-foreground">{counts()!.plugins}</div>
              <div class="text-xs text-muted-foreground uppercase">Plugins</div>
            </div>
          </div>
        </Show>

        <div class="h-px bg-border my-6" />

        {/* Agent Autonomy */}
        <div class="mb-6">
          <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Agent Autonomy</h3>
          <div class="text-xs text-muted-foreground" style={{ "margin-bottom": "8px" }}>
            Controls how aggressively the orchestrator delegates to sub-agents and parallelizes work.
          </div>
          <div class="flex flex-col gap-2">
            <button
              type="button"
              class={cn(
                "flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-border bg-secondary cursor-pointer transition-colors hover:bg-accent",
                prefs().agentAutonomy === "conservative" && "border-primary bg-primary/10"
              )}
              onClick={() => {
                const { setAgentAutonomy } = useConfig()
                setAgentAutonomy("conservative")
              }}
            >
              <div class={cn(
                "w-[18px] h-[18px] rounded-full border-2 border-border flex items-center justify-center shrink-0",
                prefs().agentAutonomy === "conservative" && "border-primary after:content-[''] after:w-2.5 after:h-2.5 after:rounded-full after:bg-primary"
              )} />
              <div>
                <span class="text-sm">Conservative</span>
                <div class="text-xs text-muted-foreground">Minimize sub-agent usage. Sequential execution. Lower token usage.</div>
              </div>
            </button>
            <button
              type="button"
              class={cn(
                "flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-border bg-secondary cursor-pointer transition-colors hover:bg-accent",
                prefs().agentAutonomy === "balanced" && "border-primary bg-primary/10"
              )}
              onClick={() => {
                const { setAgentAutonomy } = useConfig()
                setAgentAutonomy("balanced")
              }}
            >
              <div class={cn(
                "w-[18px] h-[18px] rounded-full border-2 border-border flex items-center justify-center shrink-0",
                prefs().agentAutonomy === "balanced" && "border-primary after:content-[''] after:w-2.5 after:h-2.5 after:rounded-full after:bg-primary"
              )} />
              <div>
                <span class="text-sm">Balanced</span>
                <div class="text-xs text-muted-foreground">Use sub-agents for non-trivial work. Some parallelization. Default.</div>
              </div>
            </button>
            <button
              type="button"
              class={cn(
                "flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-border bg-secondary cursor-pointer transition-colors hover:bg-accent",
                prefs().agentAutonomy === "aggressive" && "border-primary bg-primary/10"
              )}
              onClick={() => {
                const { setAgentAutonomy } = useConfig()
                setAgentAutonomy("aggressive")
              }}
            >
              <div class={cn(
                "w-[18px] h-[18px] rounded-full border-2 border-border flex items-center justify-center shrink-0",
                prefs().agentAutonomy === "aggressive" && "border-primary after:content-[''] after:w-2.5 after:h-2.5 after:rounded-full after:bg-primary"
              )} />
              <div>
                <span class="text-sm">Aggressive</span>
                <div class="text-xs text-muted-foreground">Maximize parallelization. Spawn sub-agents liberally. Fastest execution.</div>
              </div>
            </button>
          </div>
        </div>

        <div class="h-px bg-border my-6" />

        {/* Sub-Agent Configuration */}
        <div class="mb-6">
          <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Sub-Agent Configuration</h3>
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-3 p-3 rounded-lg border bg-secondary">
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-foreground">Max Iterations</div>
                <div class="text-xs text-muted-foreground">
                  Maximum retry cycles for sub-agent pipelines (1-10)
                </div>
              </div>
              <input
                type="number"
                min="1"
                max="10"
                step="1"
                value={prefs().maxSubagentIterations}
                onInput={(e) => {
                  const val = parseInt(e.currentTarget.value, 10)
                  if (!isNaN(val)) {
                    const { setMaxSubagentIterations } = useConfig()
                    setMaxSubagentIterations(val)
                  }
                }}
                class="w-16 px-2 py-1.5 rounded-md border border-border bg-secondary text-foreground text-sm font-mono text-center focus:outline-none focus:border-primary"
              />
            </div>
          </div>
        </div>

        <div class="h-px bg-border my-6" />

        {/* Installation paths */}
        <div class="mb-6">
          <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Installation</h3>
          <div class="rounded-lg border bg-card p-4 mb-3">
            <table class="w-full text-sm">
              <tbody>
                <tr>
                  <td class="py-1 text-muted-foreground">Binary Path</td>
                  <td class="py-1 font-mono text-xs">~/.era/era-code/bin/era-start.sh</td>
                </tr>
                <tr>
                  <td class="py-1 text-muted-foreground">Assets Path</td>
                  <td class="py-1 font-mono text-xs">~/.era/era-code/opencode/</td>
                </tr>
                <tr>
                  <td class="py-1 text-muted-foreground">Config Path</td>
                  <td class="py-1 font-mono text-xs">~/.era/credentials.json</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="flex gap-2 mt-4">
          <button type="button" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-secondary border border-border text-foreground cursor-pointer transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed">
            <RefreshCw class="w-4 h-4" />
            Check for Updates
          </button>
        </div>
      </Show>

      <Show when={!isEraInstalled()}>
        <div class="rounded-lg border bg-card p-4 mb-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-base font-medium text-foreground">Era Code Not Installed</span>
          </div>
          <div class="text-sm text-muted-foreground leading-relaxed">
            Install Era Code for governance enforcement, custom agents, and enhanced development workflows.
          </div>
          <div class="flex gap-2 mt-3">
            <button type="button" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground border-none cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
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
  const updateStatus = useUpdateStatus()
  const isCheckingUpdates = useIsCheckingUpdates()

  const openLink = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer")
  }

  const handleCheckForUpdates = async () => {
    await triggerUpdateCheck()
  }

  return (
    <div class="mb-8">
      <h2 class="text-xl font-semibold text-foreground mb-1">About</h2>
      <p class="text-sm text-muted-foreground mb-6">Version information and updates</p>

      <div class="flex items-center gap-2">
        <div class="text-sm text-muted-foreground">Era Code</div>
        <div class="text-sm font-medium text-foreground font-mono">v{APP_VERSION}</div>
      </div>

      <div class="h-px bg-border my-6" />

      {/* Updates Section */}
      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Updates</h3>
        <div class="rounded-lg border bg-card p-4 mb-3">
          <table class="w-full text-sm">
            <tbody>
              {/* Era Code CLI Row */}
              <Show when={isEraInstalled()}>
                <tr>
                  <td class="py-2 text-muted-foreground w-1/3">Era Code CLI</td>
                  <td class="py-2">
                    <div class="flex items-center gap-2">
                      <span>{eraVersion()}</span>
                      <Show
                        when={updateStatus()?.eraCode?.available}
                        fallback={
                          <span class="text-xs px-2 py-0.5 rounded-full bg-success/10 text-success">
                            Up to date
                          </span>
                        }
                      >
                        <span class="text-xs px-2 py-0.5 rounded-full bg-warning/10 text-warning">
                          {updateStatus()?.eraCode?.targetVersion} available
                        </span>
                        <button
                          type="button"
                          class="text-xs text-accent hover:underline"
                          onClick={() => openLink("https://github.com/neural-nomads/era-code/releases")}
                        >
                          Update
                        </button>
                      </Show>
                    </div>
                  </td>
                </tr>
              </Show>
              <Show when={!isEraInstalled()}>
                <tr>
                  <td class="py-2 text-muted-foreground w-1/3">Era Code CLI</td>
                  <td class="py-2 text-muted-foreground">Not installed</td>
                </tr>
              </Show>

              {/* OpenCode Row */}
              <tr>
                <td class="py-2 text-muted-foreground w-1/3">OpenCode</td>
                <td class="py-2">
                  <div class="flex items-center gap-2">
                    <span>{updateStatus()?.openCode?.currentVersion ?? "Unknown"}</span>
                    <Show
                      when={updateStatus()?.openCode?.available}
                      fallback={
                        <Show when={updateStatus()?.openCode?.currentVersion}>
                          <span class="text-xs px-2 py-0.5 rounded-full bg-success/10 text-success">
                            Up to date
                          </span>
                        </Show>
                      }
                    >
                      <span class="text-xs px-2 py-0.5 rounded-full bg-warning/10 text-warning">
                        {updateStatus()?.openCode?.latestVersion} available
                      </span>
                      <button
                        type="button"
                        class="text-xs text-accent hover:underline"
                        onClick={() => openLink("https://www.npmjs.com/package/opencode-ai")}
                      >
                        Update
                      </button>
                    </Show>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="mt-4 pt-4 border-t border-border flex items-center justify-between">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-secondary border border-border text-foreground cursor-pointer transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleCheckForUpdates}
              disabled={isCheckingUpdates()}
            >
              <RefreshCw class={`w-4 h-4 ${isCheckingUpdates() ? "animate-spin" : ""}`} />
              {isCheckingUpdates() ? "Checking..." : "Check for Updates"}
            </button>
            <Show when={formatLastChecked()}>
              <span class="text-xs text-muted-foreground">
                Last checked: {formatLastChecked()}
              </span>
            </Show>
          </div>
        </div>
      </div>

      <div class="h-px bg-border my-6" />

      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Components</h3>
        <div class="rounded-lg border bg-card p-4 mb-3">
          <table class="w-full text-sm">
            <tbody>
              <tr>
                <td class="py-1 text-muted-foreground">UI Version</td>
                <td class="py-1">{APP_VERSION}</td>
              </tr>
              <tr>
                <td class="py-1 text-muted-foreground">Server Version</td>
                <td class="py-1">{APP_VERSION}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="h-px bg-border my-6" />

      <div class="mb-6">
        <h3 class="text-base font-medium text-foreground mb-3 pb-2 border-b border-border">Links</h3>
        <div class="flex gap-2 flex-wrap">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-secondary border border-border text-foreground cursor-pointer transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => openLink("https://github.com/neural-nomads/era-code#readme")}
          >
            <ExternalLink class="w-4 h-4" />
            Documentation
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-secondary border border-border text-foreground cursor-pointer transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => openLink("https://github.com/neural-nomads/era-code")}
          >
            <Github class="w-4 h-4" />
            GitHub
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-secondary border border-border text-foreground cursor-pointer transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
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

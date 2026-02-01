import { Component, For, Show, createMemo, createEffect, createSignal, onMount, onCleanup } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Toaster } from "solid-toast"
import AlertDialog from "./components/alert-dialog"
import FolderSelectionCards from "./components/folder-selection-cards"
import { showConfirmDialog } from "./stores/alerts"
import InstanceTabs from "./components/instance-tabs"
import SessionTabs from "./components/session-tabs"
import SessionBreadcrumb from "./components/session-breadcrumb"
import SubagentBar from "./components/subagent-bar"
import SettingsPanel from "./components/settings-panel"
import CommandsSettingsPanel from "./components/commands-settings-panel"
import McpSettingsModal from "./components/mcp-settings-modal"
import LspSettingsModal from "./components/lsp-settings-modal"
import AddMcpServerModal, { type AddMcpServerResult } from "./components/add-mcp-server-modal"
import GovernancePanel from "./components/governance-panel"
import DirectivesEditorPanel from "./components/directives-editor-panel"
import FullSettingsPane from "./components/full-settings-pane"
import GCloudAuthModal from "./components/gcloud-auth-modal"
import CloseTabModal, { type CloseTabType } from "./components/close-tab-modal"
import PermissionWarningModal from "./components/permission-warning-modal"
import InstanceInfoModal from "./components/instance-info-modal"
import BottomStatusBar from "./components/bottom-status-bar"
import ModelSelectorModal from "./components/model-selector-modal"
import InstanceDisconnectedModal from "./components/instance-disconnected-modal"
import ToolCallModal from "./components/tool-call-modal"
import InstanceShell from "./components/instance/instance-shell2"
import { RemoteAccessOverlay } from "./components/remote-access-overlay"
import { InstanceMetadataProvider } from "./lib/contexts/instance-metadata-context"
import { initMarkdown } from "./lib/markdown"

import { useTheme } from "./lib/theme"
import { useCommands } from "./lib/hooks/use-commands"
import { useAppLifecycle } from "./lib/hooks/use-app-lifecycle"
import { getLogger } from "./lib/logger"
import { initReleaseNotifications } from "./stores/releases"
import { initUpdateChecker } from "./stores/update-checker"
import {
  checkGCloudAuth,
  isGCloudExpired,
  setExpiredModalShown,
  expiredModalShown,
} from "./stores/gcloud-auth"
import { runtimeEnv } from "./lib/runtime-env"
import {
  hasInstances,
  isSelectingFolder,
  setIsSelectingFolder,
  setHasInstances,
  showFolderSelection,
  setShowFolderSelection,
} from "./stores/ui"
import { instances as instanceStore } from "./stores/instances"
import { useConfig } from "./stores/preferences"
import {
  createInstance,
  instances,
  activeInstanceId,
  setActiveInstanceId,
  stopInstance,
  getActiveInstance,
  disconnectedInstance,
  acknowledgeDisconnectedInstance,
} from "./stores/instances"
import {
  getSessions,
  activeSessionId,
  activeParentSessionId,
  setActiveParentSession,
  clearActiveParentSession,
  createSession,
  deleteSession,
  forkSession,
  fetchSessions,
  updateSessionAgent,
  updateSessionModel,
  getActiveSession,
  getParentSessions,
  getChildSessions,
  getSessionInfo,
} from "./stores/sessions"
import { setActiveSession, sessionInfoByInstance } from "./stores/session-state"
import { getGitStatus } from "./stores/workspace-state"
import { getActiveMcpServerCount, setProjectMcpServer, fetchProjectMcpConfig } from "./stores/project-mcp"
import { setSessionMcpOverride } from "./stores/session-mcp"
import { instanceApi } from "./lib/instance-api"
import { loadInstanceMetadata } from "./lib/hooks/use-instance-metadata"
import { ensureInstanceConfigLoaded, getInstanceConfig, updateInstanceConfig } from "./stores/instance-config"
import { isSessionCompactionActive } from "./stores/session-compaction"
import { isSessionBusy as checkSessionBusy } from "./stores/session-status"
import { modelSelectorRequestedSignal, acknowledgeModelSelectorRequest, clearContinueFlag, shouldContinueAfterSwitch, instanceInfoRequestedSignal, acknowledgeInstanceInfoRequest } from "./stores/ui-actions"
import { sendMessage } from "./stores/session-actions"
import { sseManager } from "./lib/sse-manager"

const log = getLogger("actions")

const App: Component = () => {
  const { isDark } = useTheme()
  const {
    preferences,
    recordWorkspaceLaunch,
    toggleShowThinkingBlocks,
    toggleShowTimelineTools,
    toggleAutoCleanupBlankSessions,
    toggleUsageMetrics,
    setDiffViewMode,
    setToolOutputExpansion,
    setDiagnosticsExpansion,
    setThinkingBlocksExpansion,
  } = useConfig()
  const [escapeInDebounce, setEscapeInDebounce] = createSignal(false)
  const [launchErrorBinary, setLaunchErrorBinary] = createSignal<string | null>(null)
  const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = createSignal(false)
  const [remoteAccessOpen, setRemoteAccessOpen] = createSignal(false)
  const [settingsPanelOpen, setSettingsPanelOpen] = createSignal(false)
  const [commandsPanelOpen, setCommandsPanelOpen] = createSignal(false)
  const [mcpSettingsOpen, setMcpSettingsOpen] = createSignal(false)
  const [lspSettingsOpen, setLspSettingsOpen] = createSignal(false)
  const [addMcpServerOpen, setAddMcpServerOpen] = createSignal(false)
  const [governancePanelOpen, setGovernancePanelOpen] = createSignal(false)
  const [directivesEditorOpen, setDirectivesEditorOpen] = createSignal(false)
  const [fullSettingsOpen, setFullSettingsOpen] = createSignal(false)
  const [gcloudModalOpen, setGcloudModalOpen] = createSignal(false)
  const [gcloudModalMode, setGcloudModalMode] = createSignal<"login" | "expired">("login")
  const [instanceTabBarHeight, setInstanceTabBarHeight] = createSignal(0)

  // Close modal state
  const [closeModalOpen, setCloseModalOpen] = createSignal(false)
  const [closeModalType, setCloseModalType] = createSignal<CloseTabType>("session")
  const [closeModalName, setCloseModalName] = createSignal("")
  const [closeModalSessionCount, setCloseModalSessionCount] = createSignal(0)
  const [closeModalTargetId, setCloseModalTargetId] = createSignal<string | null>(null)

  // Permission warning modal state
  const [permissionModalOpen, setPermissionModalOpen] = createSignal(false)
  const [permissionModalInstanceId, setPermissionModalInstanceId] = createSignal<string | null>(null)
  const [permissionModalProjectName, setPermissionModalProjectName] = createSignal("")

  // Instance info modal state
  const [instanceInfoModalOpen, setInstanceInfoModalOpen] = createSignal(false)

  // Subagent bar expansion state - tracks which session has its subagents expanded
  const [expandedSubagents, setExpandedSubagents] = createSignal<string | null>(null)

  const updateInstanceTabBarHeight = () => {
    if (typeof document === "undefined") return
    const element = document.querySelector<HTMLElement>(".tab-bar-instance")
    setInstanceTabBarHeight(element?.offsetHeight ?? 0)
  }

  createEffect(() => {
    void initMarkdown(isDark()).catch((error) => log.error("Failed to initialize markdown", error))
  })

  createEffect(() => {
    initReleaseNotifications()
    initUpdateChecker()
  })

  createEffect(() => {
    instances()
    hasInstances()
    requestAnimationFrame(() => updateInstanceTabBarHeight())
  })

  // Listen for model selector requests from stalled tools
  // Use the signal accessor directly for proper dependency tracking
  createEffect(() => {
    const requested = modelSelectorRequestedSignal()
    console.log("[App] Model selector effect running, requested:", requested)
    if (requested) {
      console.log("[App] Opening model selector modal")
      acknowledgeModelSelectorRequest()
      setModelSelectorOpen(true)
    }
  })

  // Listen for instance info modal requests from stalled tools
  // Use the signal accessor directly for proper dependency tracking
  createEffect(() => {
    const requested = instanceInfoRequestedSignal()
    console.log("[App] Instance info effect running, requested:", requested)
    if (requested) {
      console.log("[App] Opening instance info modal")
      acknowledgeInstanceInfoRequest()
      setInstanceInfoModalOpen(true)
    }
  })

  onMount(() => {
    updateInstanceTabBarHeight()
    const handleResize = () => updateInstanceTabBarHeight()
    window.addEventListener("resize", handleResize)
    onCleanup(() => window.removeEventListener("resize", handleResize))
  })

  // Check gcloud auth on startup and show expired modal if needed
  // TODO: Enable once /api/system/exec endpoint is implemented
  // onMount(async () => {
  //   const authInfo = await checkGCloudAuth()
  //   if (authInfo?.isExpired && !expiredModalShown()) {
  //     setExpiredModalShown(true)
  //     setGcloudModalMode("expired")
  //     setGcloudModalOpen(true)
  //   }
  // })

  const activeInstance = createMemo(() => getActiveInstance())
  const activeSessionIdForInstance = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return null
    return activeSessionId().get(instance.id) || null
  })

  // Get parent sessions (user conversations, not agent sub-sessions) as a Map for SessionTabs
  const activeInstanceParentSessions = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return new Map()
    const parentSessions = getParentSessions(instance.id)
    return new Map(parentSessions.map(s => [s.id, s]))
  })

  // Get the active parent session ID for the active instance
  const activeParentSessionIdForInstance = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return null
    return activeParentSessionId().get(instance.id) || null
  })

  // Compute server status for the active instance
  const serverStatus = createMemo((): "healthy" | "warning" | "error" => {
    const instance = activeInstance()
    if (!instance) return "healthy"
    if (instance.status === "ready") return "healthy"
    if (instance.status === "starting" || instance.status === "connecting") return "warning"
    return "error"
  })

  // Model selector modal state
  const [modelSelectorOpen, setModelSelectorOpen] = createSignal(false)

  // Bottom status bar computed values
  const projectName = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return ""
    return instance.folder.split("/").pop() || instance.folder
  })

  const activeSessionInfo = createMemo(() => {
    const instance = activeInstance()
    const sessionId = activeParentSessionIdForInstance()
    if (!instance || !sessionId) return null
    return getSessionInfo(instance.id, sessionId)
  })

  // Aggregate total tokens (input + output) across ALL sessions for this project/instance
  const totalProjectTokens = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return { used: 0, input: 0, output: 0, cost: 0 }

    const sessionInfoMap = sessionInfoByInstance().get(instance.id)
    if (!sessionInfoMap) return { used: 0, input: 0, output: 0, cost: 0 }

    let totalUsed = 0
    let totalInput = 0
    let totalOutput = 0
    let totalCost = 0

    for (const info of sessionInfoMap.values()) {
      totalInput += info.inputTokens ?? 0
      totalOutput += info.outputTokens ?? 0
      totalUsed += (info.inputTokens ?? 0) + (info.outputTokens ?? 0)
      totalCost += info.cost ?? 0
    }

    return { used: totalUsed, input: totalInput, output: totalOutput, cost: totalCost }
  })

  const isCompacting = createMemo(() => {
    const instance = activeInstance()
    const sessionId = activeParentSessionIdForInstance()
    if (!instance || !sessionId) return false
    return isSessionCompactionActive(instance.id, sessionId)
  })

  const isSessionBusy = createMemo(() => {
    const instance = activeInstance()
    const sessionId = activeParentSessionIdForInstance()
    if (!instance || !sessionId) return false
    return checkSessionBusy(instance.id, sessionId)
  })

  const activeSessionModel = createMemo(() => {
    const instance = activeInstance()
    const sessionId = activeParentSessionIdForInstance()
    if (!instance || !sessionId) return { providerId: "", modelId: "" }
    const session = getSessions(instance.id).find(s => s.id === sessionId)
    return session?.model ?? { providerId: "", modelId: "" }
  })

  // LSP status for bottom status bar
  const lspConnected = createMemo(() => {
    const lspStatus = activeInstance()?.metadata?.lspStatus
    if (!lspStatus) return 0
    return lspStatus.filter(s => s.status === "connected").length
  })

  const lspTotal = createMemo(() => {
    return activeInstance()?.metadata?.lspStatus?.length ?? 0
  })

  // Git status for bottom status bar
  const gitStatus = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return null
    return getGitStatus(instance.id)
  })

  // MCP active count for bottom status bar (instance-specific)
  const mcpActiveCount = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return 0
    return getActiveMcpServerCount(instance.id, instance.folder)
  })

  // Connection status for bottom status bar
  const connectionStatus = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return null
    return sseManager.getStatus(instance.id)
  })

  // Check if we're viewing a child session (not the parent)
  const isViewingChildSession = createMemo(() => {
    const activeId = activeSessionIdForInstance()
    const parentId = activeParentSessionIdForInstance()
    return activeId !== null && parentId !== null && activeId !== parentId
  })

  // Get the currently viewed session (could be parent or child)
  const currentViewedSession = createMemo(() => {
    const instance = activeInstance()
    const sessionId = activeSessionIdForInstance()
    if (!instance || !sessionId) return null
    return getSessions(instance.id).find(s => s.id === sessionId) || null
  })

  // Get the parent session when viewing a child
  const parentSessionForBreadcrumb = createMemo(() => {
    const instance = activeInstance()
    const parentId = activeParentSessionIdForInstance()
    if (!instance || !parentId) return null
    return getSessions(instance.id).find(s => s.id === parentId) || null
  })

  // Get sibling sessions (other children of the same parent)
  const siblingSessionsForBreadcrumb = createMemo(() => {
    const instance = activeInstance()
    const parentId = activeParentSessionIdForInstance()
    if (!instance || !parentId) return []
    return getChildSessions(instance.id, parentId)
  })

  // Handler for selecting a child session
  function handleSelectChildSession(instanceId: string, parentId: string, childId: string) {
    // Keep the parent session context but view the child
    setActiveSession(instanceId, childId)
  }

  // Handler for returning to parent session
  function handleReturnToParent() {
    const instance = activeInstance()
    const parentId = activeParentSessionIdForInstance()
    if (instance && parentId) {
      setActiveSession(instance.id, parentId)
    }
  }

  const launchErrorPath = () => {
    const value = launchErrorBinary()
    if (!value) return "opencode"
    return value.trim() || "opencode"
  }

  const isMissingBinaryError = (error: unknown): boolean => {
    if (!error) return false
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error)
    const normalized = message.toLowerCase()
    return (
      normalized.includes("opencode binary not found") ||
      normalized.includes("binary not found") ||
      normalized.includes("no such file or directory") ||
      normalized.includes("binary is not executable") ||
      normalized.includes("enoent")
    )
  }

  const clearLaunchError = () => setLaunchErrorBinary(null)

  async function handleSelectFolder(folderPath: string, binaryPath?: string) {
    if (!folderPath) {
      return
    }
    setIsSelectingFolder(true)
    const selectedBinary = binaryPath || preferences().lastUsedBinary || "opencode"
    try {
      recordWorkspaceLaunch(folderPath, selectedBinary)
      clearLaunchError()
      const instanceId = await createInstance(folderPath, selectedBinary)
      // Set folder selection to false BEFORE hasInstances to avoid flash
      setShowFolderSelection(false)
      setIsAdvancedSettingsOpen(false)
      setHasInstances(true)

      log.info("Created instance", {
        instanceId,
        port: instances().get(instanceId)?.port,
      })

      // Check if we should show permission warning modal
      if (preferences().autoApprovePermissions) {
        await ensureInstanceConfigLoaded(instanceId)
        const instanceConfig = getInstanceConfig(instanceId)
        // Only show if no override is set (first time opening this project with auto-approve on)
        if (!instanceConfig.permissionOverride) {
          const projectName = folderPath.split("/").pop() || folderPath
          setPermissionModalInstanceId(instanceId)
          setPermissionModalProjectName(projectName)
          setPermissionModalOpen(true)
        }
      }
    } catch (error) {
      clearLaunchError()
      if (isMissingBinaryError(error)) {
        setLaunchErrorBinary(selectedBinary)
      }
      log.error("Failed to create instance", error)
    } finally {
      setIsSelectingFolder(false)
    }
  }

  function handleLaunchErrorClose() {
    clearLaunchError()
  }

  function handleLaunchErrorAdvanced() {
    clearLaunchError()
    setIsAdvancedSettingsOpen(true)
  }

  function handleNewInstanceRequest() {
    if (hasInstances()) {
      setShowFolderSelection(true)
    }
  }

  async function handleDisconnectedInstanceClose() {
    try {
      await acknowledgeDisconnectedInstance()
    } catch (error) {
      log.error("Failed to finalize disconnected instance", error)
    }
  }

  function handleCloseInstanceRequest(instanceId: string) {
    const instance = instances().get(instanceId)
    if (!instance) return

    const sessionCount = getParentSessions(instanceId).length
    const folderName = instance.folder.split("/").pop() || instance.folder

    setCloseModalType("project")
    setCloseModalName(folderName)
    setCloseModalSessionCount(sessionCount)
    setCloseModalTargetId(instanceId)
    setCloseModalOpen(true)
  }

  // Direct close instance (for keyboard shortcuts/commands - bypasses modal)
  async function handleCloseInstance(instanceId: string) {
    await stopInstance(instanceId)
    if (instances().size === 0) {
      setHasInstances(false)
    }
  }

  async function handleCloseModalConfirm(keepInBackground: boolean) {
    const targetId = closeModalTargetId()
    const type = closeModalType()

    setCloseModalOpen(false)

    if (!targetId) return

    if (type === "project") {
      // Close instance/project
      if (keepInBackground) {
        // TODO: Implement background mode for quick access later
        log.info("Keep in background not implemented yet")
      }
      await stopInstance(targetId)
      if (instances().size === 0) {
        setHasInstances(false)
      }
    } else if (type === "session") {
      // Close session
      const instance = activeInstance()
      if (instance) {
        await handleCloseSession(instance.id, targetId)
      }
    }
  }

  function handleCloseModalCancel() {
    setCloseModalOpen(false)
    setCloseModalTargetId(null)
  }

  async function handlePermissionModalProceed() {
    const instanceId = permissionModalInstanceId()
    if (instanceId) {
      // Set override to "enabled" so we don't show the modal again
      await updateInstanceConfig(instanceId, (draft) => {
        draft.permissionOverride = "enabled"
      })
    }
    setPermissionModalOpen(false)
    setPermissionModalInstanceId(null)
  }

  async function handlePermissionModalDisable() {
    const instanceId = permissionModalInstanceId()
    if (instanceId) {
      // Set override to "disabled" for this project
      await updateInstanceConfig(instanceId, (draft) => {
        draft.permissionOverride = "disabled"
      })
    }
    setPermissionModalOpen(false)
    setPermissionModalInstanceId(null)
  }

  function handleCloseSessionRequest(sessionId: string) {
    const instance = activeInstance()
    if (!instance) return

    const sessions = getSessions(instance.id)
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return

    const sessionName = session.title || "Untitled Session"

    setCloseModalType("session")
    setCloseModalName(sessionName)
    setCloseModalSessionCount(0)
    setCloseModalTargetId(sessionId)
    setCloseModalOpen(true)
  }

  async function handleNewSession(instanceId: string) {
    try {
      const session = await createSession(instanceId)
      setActiveParentSession(instanceId, session.id)
    } catch (error) {
      log.error("Failed to create session", error)
    }
  }

  async function handleCloseSession(instanceId: string, sessionId: string) {
    const sessions = getSessions(instanceId)
    const session = sessions.find((s) => s.id === sessionId)

    if (!session) {
      return
    }

    // Find the parent session (or use the session itself if it's a parent)
    const parentSessionId = session.parentId ?? session.id
    const parentSession = sessions.find((s) => s.id === parentSessionId)

    if (!parentSession || parentSession.parentId !== null) {
      return
    }

    // Clear active session before deletion
    clearActiveParentSession(instanceId)

    try {
      // Delete child sessions first to avoid orphaned sub-agent tabs
      const children = getChildSessions(instanceId, parentSessionId)
      for (const child of children) {
        try {
          await deleteSession(instanceId, child.id)
        } catch (childError) {
          log.warn("Failed to delete child session", { sessionId: child.id, error: childError })
        }
      }

      // Actually delete the parent session via API
      await deleteSession(instanceId, parentSessionId)
      log.info("Session deleted successfully", { instanceId, sessionId: parentSessionId })
    } catch (error) {
      log.error("Failed to delete session", error)
      // Refresh sessions to sync state even if delete failed
      try {
        await fetchSessions(instanceId)
      } catch (fetchError) {
        log.error("Failed to refresh sessions after delete error", fetchError)
      }
    }
  }

  async function handleModelSelect(providerId: string, modelId: string) {
    console.log("[App] handleModelSelect called with:", { providerId, modelId })
    const instance = activeInstance()
    const sessionId = activeParentSessionIdForInstance()
    console.log("[App] handleModelSelect - instance:", instance?.id, "sessionId:", sessionId)
    if (!instance || !sessionId) {
      console.log("[App] handleModelSelect - early return, missing instance or sessionId")
      return
    }

    // Check if we should continue session after model switch (from stalled tool)
    const shouldContinue = shouldContinueAfterSwitch()
    console.log("[App] handleModelSelect - shouldContinue:", shouldContinue)
    clearContinueFlag()

    try {
      await updateSessionModel(instance.id, sessionId, { providerId, modelId })
      log.info("Updated session model", { providerId, modelId })
      console.log("[App] handleModelSelect - model updated successfully")

      // If requested from stalled tool, send continue message to resume with new model
      if (shouldContinue) {
        console.log("[App] handleModelSelect - sending continue message")
        await sendMessage(instance.id, sessionId, "continue")
        log.info("Sent continue message after model switch")
      }
    } catch (error) {
      log.error("Failed to update session model", error)
      console.error("[App] handleModelSelect - error:", error)
    }
    setModelSelectorOpen(false)
  }

  const handleSidebarAgentChange = async (instanceId: string, sessionId: string, agent: string) => {
    if (!instanceId || !sessionId || sessionId === "info") return
    await updateSessionAgent(instanceId, sessionId, agent)
  }

  const handleSidebarModelChange = async (
    instanceId: string,
    sessionId: string,
    model: { providerId: string; modelId: string },
  ) => {
    if (!instanceId || !sessionId || sessionId === "info") return
    await updateSessionModel(instanceId, sessionId, model)
  }

  // Add Server modal handlers
  const handleOpenAddServer = () => {
    setMcpSettingsOpen(false)  // Close MCP settings modal first
    setAddMcpServerOpen(true)  // Then open Add Server modal
  }

  const handleAddServerApply = async (result: AddMcpServerResult) => {
    const { name, config, scopes } = result
    const instance = activeInstance()
    const { updatePreferences } = useConfig()

    // Add to global if selected
    if (scopes.global) {
      updatePreferences({
        mcpRegistry: { ...(preferences().mcpRegistry ?? {}), [name]: config },
        mcpDesiredState: { ...(preferences().mcpDesiredState ?? {}), [name]: true },
      })
    }

    // Add to project if selected
    if (scopes.project && instance?.folder) {
      await setProjectMcpServer(instance.folder, name, config)
      await fetchProjectMcpConfig(instance.folder)
    }

    // Add to session if selected (only affects current instance)
    if (scopes.session && instance?.id) {
      setSessionMcpOverride(instance.id, name, true)
      // For session-only, we also need the config registered somewhere
      // If not added to global or project, add to global as disabled
      if (!scopes.global && !scopes.project) {
        updatePreferences({
          mcpRegistry: { ...(preferences().mcpRegistry ?? {}), [name]: { ...config, enabled: false } },
          mcpDesiredState: { ...(preferences().mcpDesiredState ?? {}), [name]: false },
        })
      }
    }

    setAddMcpServerOpen(false)

    // Apply to current instance
    if (instance?.status === "ready" && instance.client) {
      try {
        await instanceApi.upsertMcp(instance, name, { ...config, enabled: true })
        await instanceApi.connectMcp(instance, name)
        await loadInstanceMetadata(instance, { force: true })
      } catch (error) {
        log.error("Failed to apply new MCP server", { instanceId: instance.id, name, error })
      }
    }
  }

  const handleAddServerApplyToAll = async (result: AddMcpServerResult) => {
    const { name, config, scopes } = result
    const { updatePreferences } = useConfig()
    const instance = activeInstance()

    // Add to global if selected
    if (scopes.global) {
      updatePreferences({
        mcpRegistry: { ...(preferences().mcpRegistry ?? {}), [name]: config },
        mcpDesiredState: { ...(preferences().mcpDesiredState ?? {}), [name]: true },
      })
    }

    // Add to project if selected
    if (scopes.project && instance?.folder) {
      await setProjectMcpServer(instance.folder, name, config)
      await fetchProjectMcpConfig(instance.folder)
    }

    setAddMcpServerOpen(false)

    // Apply to all running instances
    const activeInstances = Array.from(instances().values()).filter(
      (inst) => inst.status === "ready" && inst.client
    )
    for (const inst of activeInstances) {
      try {
        await instanceApi.upsertMcp(inst, name, { ...config, enabled: true })
        await instanceApi.connectMcp(inst, name)
        await loadInstanceMetadata(inst, { force: true })
      } catch (error) {
        log.error("Failed to apply new MCP server", { instanceId: inst.id, name, error })
      }
    }
  }

  const { commands: paletteCommands, executeCommand } = useCommands({
    preferences,
    toggleAutoCleanupBlankSessions,
    toggleShowThinkingBlocks,
    toggleShowTimelineTools,
    toggleUsageMetrics,
    setDiffViewMode,
    setToolOutputExpansion,
    setDiagnosticsExpansion,
    setThinkingBlocksExpansion,
    handleNewInstanceRequest,
    handleCloseInstance,
    handleNewSession,
    handleCloseSession,
    getActiveInstance: activeInstance,
    getActiveSessionIdForInstance: activeSessionIdForInstance,
  })

  useAppLifecycle({
    setEscapeInDebounce,
    handleNewInstanceRequest,
    handleCloseInstance,
    handleNewSession,
    handleCloseSession,
    showFolderSelection,
    setShowFolderSelection,
    getActiveInstance: activeInstance,
    getActiveSessionIdForInstance: activeSessionIdForInstance,
    openModelSelector: () => setModelSelectorOpen(true),
  })

  // Listen for Tauri menu events
  onMount(() => {
    if (runtimeEnv.host === "tauri") {
      const tauriBridge = (window as { __TAURI__?: { event?: { listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> } } }).__TAURI__
      if (tauriBridge?.event) {
        let unlistenMenu: (() => void) | null = null
        
        tauriBridge.event.listen("menu:newInstance", () => {
          handleNewInstanceRequest()
        }).then((unlisten) => {
          unlistenMenu = unlisten
        }).catch((error) => {
          log.error("Failed to listen for menu:newInstance event", error)
        })

        onCleanup(() => {
          unlistenMenu?.()
        })
      }
    }
  })

  return (
    <>
      <InstanceDisconnectedModal
        open={Boolean(disconnectedInstance())}
        folder={disconnectedInstance()?.folder}
        reason={disconnectedInstance()?.reason}
        onClose={handleDisconnectedInstanceClose}
      />

      <Dialog open={Boolean(launchErrorBinary())} modal>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Dialog.Content class="bg-background/95 backdrop-blur-sm rounded-xl border border-border shadow-xl w-full max-w-md p-6 flex flex-col gap-6">
              <div>
                <Dialog.Title class="text-xl font-semibold text-primary">Unable to launch OpenCode</Dialog.Title>
                <Dialog.Description class="text-sm text-muted-foreground mt-2 break-words">
                  Install the OpenCode CLI and make sure it is available in your PATH, or pick a custom binary from
                  Advanced Settings.
                </Dialog.Description>
              </div>

              <div class="rounded-lg border border-border bg-secondary p-4">
                <p class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Binary path</p>
                <p class="text-sm font-mono text-primary break-all">{launchErrorPath()}</p>
              </div>

              <div class="flex justify-end gap-2">
                <button type="button" class="inline-flex items-center justify-center px-4 py-2 rounded-md text-sm font-medium bg-secondary text-secondary-foreground border border-border hover:bg-accent transition-colors" onClick={handleLaunchErrorAdvanced}>
                  Open Advanced Settings
                </button>
                <button type="button" class="inline-flex items-center justify-center px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors" onClick={handleLaunchErrorClose}>
                  Close
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>
      <div class="h-screen w-screen flex flex-col">
        <Show
          when={!hasInstances()}
          fallback={
            <>
              <InstanceTabs
                instances={instances()}
                activeInstanceId={activeInstanceId()}
                onSelect={setActiveInstanceId}
                onClose={handleCloseInstanceRequest}
                onNew={handleNewInstanceRequest}
                onOpenRemoteAccess={() => setRemoteAccessOpen(true)}
                onOpenSettings={() => setSettingsPanelOpen(true)}
                showNewTab={showFolderSelection()}
                onCloseNewTab={() => {
                  setShowFolderSelection(false)
                  setIsAdvancedSettingsOpen(false)
                }}
                serverStatus={serverStatus()}
              />

              {/* Session tabs - shown when instance is active and has sessions */}
              <Show when={activeInstance() && !showFolderSelection() && activeInstanceParentSessions().size > 0}>
                <SessionTabs
                  instanceId={activeInstance()!.id}
                  sessions={activeInstanceParentSessions()}
                  activeSessionId={activeParentSessionIdForInstance()}
                  activeParentSessionId={activeParentSessionIdForInstance()}
                  expandedSubagents={expandedSubagents()}
                  onSelect={(sessionId) => setActiveParentSession(activeInstance()!.id, sessionId)}
                  onSelectChild={(parentId, childId) => handleSelectChildSession(activeInstance()!.id, parentId, childId)}
                  onToggleSubagents={(sessionId) => setExpandedSubagents(prev => prev === sessionId ? null : sessionId)}
                  onClose={(sessionId) => handleCloseSessionRequest(sessionId)}
                  onNew={() => handleNewSession(activeInstance()!.id)}
                />
              </Show>

              {/* Subagent bar - shown when a session has its subagents expanded */}
              <Show when={expandedSubagents() && !isViewingChildSession()}>
                {(() => {
                  const parentId = expandedSubagents()!
                  const parentSession = activeInstanceParentSessions().get(parentId)
                  const childSessions = getChildSessions(activeInstance()!.id, parentId)
                  return (
                    <Show when={parentSession && childSessions.length > 0}>
                      <SubagentBar
                        instanceId={activeInstance()!.id}
                        parentSession={parentSession!}
                        childSessions={childSessions}
                        activeSessionId={activeSessionIdForInstance()}
                        onSelectChild={(childId) => {
                          setExpandedSubagents(null)
                          handleSelectChildSession(activeInstance()!.id, parentId, childId)
                        }}
                        onSelectParent={() => {
                          setExpandedSubagents(null)
                          setActiveParentSession(activeInstance()!.id, parentId)
                        }}
                      />
                    </Show>
                  )
                })()}
              </Show>

              {/* Breadcrumb - shown when viewing a child session */}
              <Show when={isViewingChildSession() && parentSessionForBreadcrumb() && currentViewedSession()}>
                <SessionBreadcrumb
                  instanceId={activeInstance()!.id}
                  parentSession={parentSessionForBreadcrumb()!}
                  currentSession={currentViewedSession()!}
                  siblingsSessions={siblingSessionsForBreadcrumb()}
                  onReturnToParent={handleReturnToParent}
                  onSelectSibling={(sessionId) => setActiveSession(activeInstance()!.id, sessionId)}
                />
              </Show>

              {/* New Tab view or no active instance - show folder selection cards */}
              <Show when={(showFolderSelection() || !activeInstance()) && !isSelectingFolder()}>
                <div
                  class="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6"
                  style="background-color: var(--surface-secondary)"
                >
                  <div class="w-full max-w-3xl">
                    <FolderSelectionCards
                      onSelectFolder={handleSelectFolder}
                      isLoading={isSelectingFolder()}
                      advancedSettingsOpen={isAdvancedSettingsOpen()}
                      onAdvancedSettingsOpen={() => setIsAdvancedSettingsOpen(true)}
                      onAdvancedSettingsClose={() => setIsAdvancedSettingsOpen(false)}
                      onOpenFullSettings={() => setFullSettingsOpen(true)}
                    />
                  </div>
                </div>
              </Show>

              <For each={Array.from(instances().values())}>
                {(instance) => {
                  const isActiveInstance = () => activeInstanceId() === instance.id
                  const isVisible = () => isActiveInstance() && !showFolderSelection()
                    return (
                      <div class="flex-1 min-h-0 overflow-hidden" style={{ display: isVisible() ? "flex" : "none" }}>
                        <InstanceMetadataProvider instance={instance}>
                          <InstanceShell
                            instance={instance}
                            escapeInDebounce={escapeInDebounce()}
                            paletteCommands={paletteCommands}
                            onCloseSession={(sessionId) => handleCloseSession(instance.id, sessionId)}
                            onNewSession={() => handleNewSession(instance.id)}
                            handleSidebarAgentChange={(sessionId, agent) => handleSidebarAgentChange(instance.id, sessionId, agent)}
                            handleSidebarModelChange={(sessionId, model) => handleSidebarModelChange(instance.id, sessionId, model)}
                            onExecuteCommand={executeCommand}
                            tabBarOffset={instanceTabBarHeight()}
                          />
                        </InstanceMetadataProvider>

                      </div>
                    )

                }}
              </For>

            </>
          }
        >
          <div
            class="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6"
            style="background-color: var(--surface-secondary)"
          >
            <div class="w-full max-w-3xl">
              <FolderSelectionCards
                onSelectFolder={handleSelectFolder}
                isLoading={isSelectingFolder()}
                advancedSettingsOpen={isAdvancedSettingsOpen()}
                onAdvancedSettingsOpen={() => setIsAdvancedSettingsOpen(true)}
                onAdvancedSettingsClose={() => setIsAdvancedSettingsOpen(false)}
                onOpenFullSettings={() => setFullSettingsOpen(true)}
              />
            </div>
          </div>
        </Show>
 
        <RemoteAccessOverlay open={remoteAccessOpen()} onClose={() => setRemoteAccessOpen(false)} />

        <SettingsPanel
          open={settingsPanelOpen()}
          onClose={() => setSettingsPanelOpen(false)}
          instance={activeInstance() ?? null}
          serverStatus={serverStatus()}
          onOpenCommandsSettings={() => {
            setSettingsPanelOpen(false)
            setCommandsPanelOpen(true)
          }}
          onOpenMcpSettings={() => {
            setSettingsPanelOpen(false)
            setMcpSettingsOpen(true)
          }}
          onOpenLspSettings={() => {
            setSettingsPanelOpen(false)
            setLspSettingsOpen(true)
          }}
          onOpenAdvancedSettings={() => {
            setSettingsPanelOpen(false)
            setFullSettingsOpen(true)
          }}
          onOpenGovernancePanel={() => {
            setSettingsPanelOpen(false)
            setGovernancePanelOpen(true)
          }}
        />

        <FullSettingsPane
          open={fullSettingsOpen()}
          onClose={() => setFullSettingsOpen(false)}
          instance={activeInstance() ?? null}
          onOpenGCloudModal={() => {
            setGcloudModalMode("login")
            setGcloudModalOpen(true)
          }}
        />

        <GCloudAuthModal
          open={gcloudModalOpen()}
          onClose={() => {
            setGcloudModalOpen(false)
            // If closed from expired mode, open Full Settings to Accounts
            if (gcloudModalMode() === "expired") {
              setFullSettingsOpen(true)
            }
          }}
          mode={gcloudModalMode()}
        />

        <CommandsSettingsPanel
          open={commandsPanelOpen()}
          onClose={() => setCommandsPanelOpen(false)}
          instanceId={activeInstanceId()}
        />

        <McpSettingsModal
          open={mcpSettingsOpen()}
          onClose={() => setMcpSettingsOpen(false)}
          instance={activeInstance() ?? null}
        />

        <LspSettingsModal
          open={lspSettingsOpen()}
          onClose={() => setLspSettingsOpen(false)}
          instance={activeInstance() ?? null}
        />

        <AddMcpServerModal
          open={addMcpServerOpen()}
          onClose={() => setAddMcpServerOpen(false)}
          folder={activeInstance()?.folder}
          instanceId={activeInstance()?.id}
          onApply={handleAddServerApply}
          onApplyToAll={handleAddServerApplyToAll}
        />

        <GovernancePanel
          open={governancePanelOpen()}
          onClose={() => setGovernancePanelOpen(false)}
          folder={activeInstance()?.folder}
        />

        <DirectivesEditorPanel
          open={directivesEditorOpen()}
          onClose={() => setDirectivesEditorOpen(false)}
          folder={activeInstance()?.folder}
        />

        <CloseTabModal
          open={closeModalOpen()}
          type={closeModalType()}
          name={closeModalName()}
          sessionCount={closeModalSessionCount()}
          onConfirm={handleCloseModalConfirm}
          onCancel={handleCloseModalCancel}
        />

        <PermissionWarningModal
          open={permissionModalOpen()}
          projectName={permissionModalProjectName()}
          onProceed={handlePermissionModalProceed}
          onDisable={handlePermissionModalDisable}
        />

        {/* Instance Info Modal - shown when clicking the port button */}
        <InstanceInfoModal
          open={instanceInfoModalOpen()}
          onClose={() => setInstanceInfoModalOpen(false)}
          instance={activeInstance() ?? null}
          lspConnectedCount={lspConnected()}
          onRestart={async () => {
            const instance = activeInstance()
            if (instance) {
              setInstanceInfoModalOpen(false)
              await stopInstance(instance.id)
              await handleSelectFolder(instance.folder, instance.binaryPath)
            }
          }}
          onStop={async () => {
            const instance = activeInstance()
            if (instance) {
              setInstanceInfoModalOpen(false)
              await stopInstance(instance.id)
              if (instances().size === 0) {
                setHasInstances(false)
              }
            }
          }}
        />

        {/* Bottom Status Bar - shown when we have an active instance */}
        <Show when={activeInstance() && !showFolderSelection()}>
          <BottomStatusBar
            projectName={projectName()}
            usedTokens={totalProjectTokens().used}
            inputTokens={totalProjectTokens().input}
            outputTokens={totalProjectTokens().output}
            availableTokens={activeSessionInfo()?.contextAvailableTokens ?? null}
            contextWindow={activeSessionInfo()?.contextWindow ?? 0}
            isCompacting={isCompacting()}
            providerId={activeSessionModel().providerId}
            modelId={activeSessionModel().modelId}
            cost={totalProjectTokens().cost}
            mcpActiveCount={mcpActiveCount()}
            lspConnected={lspConnected()}
            lspTotal={lspTotal()}
            instancePort={activeInstance()?.port}
            gitBranch={gitStatus()?.branch}
            gitAhead={gitStatus()?.ahead}
            gitBehind={gitStatus()?.behind}
            connectionStatus={connectionStatus()}
            onModelClick={() => setModelSelectorOpen(true)}
            onContextClick={() => {
              // TODO: Open session summary modal
              log.info("Context clicked - session summary coming soon")
            }}
            onGovernanceClick={() => setGovernancePanelOpen(true)}
            onDirectivesClick={() => setDirectivesEditorOpen(true)}
            onMcpClick={() => setMcpSettingsOpen(true)}
            onLspClick={() => setLspSettingsOpen(true)}
            onInstanceClick={() => setInstanceInfoModalOpen(true)}
            onSettingsClick={() => setSettingsPanelOpen(true)}
          />
        </Show>

        {/* Model Selector Modal */}
        <ModelSelectorModal
          open={modelSelectorOpen()}
          currentProviderId={activeSessionModel().providerId}
          currentModelId={activeSessionModel().modelId}
          onSelect={handleModelSelect}
          onCancel={() => setModelSelectorOpen(false)}
        />

        <ToolCallModal />

        <AlertDialog />

        <Toaster
          position="top-right"
          gutter={16}
          toastOptions={{
            duration: 8000,
            className: "bg-transparent border-none shadow-none p-0",
          }}
        />
      </div>
    </>
  )
}


export default App

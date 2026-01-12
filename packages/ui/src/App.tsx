import { Component, For, Show, createMemo, createEffect, createSignal, onMount, onCleanup } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Toaster } from "solid-toast"
import AlertDialog from "./components/alert-dialog"
import FolderSelectionView from "./components/folder-selection-view"
import FolderSelectionCards from "./components/folder-selection-cards"
import { showConfirmDialog } from "./stores/alerts"
import InstanceTabs from "./components/instance-tabs"
import SessionTabs from "./components/session-tabs"
import SessionBreadcrumb from "./components/session-breadcrumb"
import SettingsPanel from "./components/settings-panel"
import CommandsSettingsPanel from "./components/commands-settings-panel"
import CloseTabModal, { type CloseTabType } from "./components/close-tab-modal"
import BottomStatusBar from "./components/bottom-status-bar"
import ModelSelectorModal from "./components/model-selector-modal"
import InstanceDisconnectedModal from "./components/instance-disconnected-modal"
import InstanceShell from "./components/instance/instance-shell2"
import { RemoteAccessOverlay } from "./components/remote-access-overlay"
import { InstanceMetadataProvider } from "./lib/contexts/instance-metadata-context"
import { initMarkdown } from "./lib/markdown"

import { useTheme } from "./lib/theme"
import { useCommands } from "./lib/hooks/use-commands"
import { useAppLifecycle } from "./lib/hooks/use-app-lifecycle"
import { getLogger } from "./lib/logger"
import { initReleaseNotifications } from "./stores/releases"
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
import { setActiveSession } from "./stores/session-state"
import { isSessionCompactionActive } from "./stores/session-compaction"
import { isSessionBusy as checkSessionBusy } from "./stores/session-status"

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
  const [instanceTabBarHeight, setInstanceTabBarHeight] = createSignal(0)

  // Close modal state
  const [closeModalOpen, setCloseModalOpen] = createSignal(false)
  const [closeModalType, setCloseModalType] = createSignal<CloseTabType>("session")
  const [closeModalName, setCloseModalName] = createSignal("")
  const [closeModalSessionCount, setCloseModalSessionCount] = createSignal(0)
  const [closeModalTargetId, setCloseModalTargetId] = createSignal<string | null>(null)

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
  })

  createEffect(() => {
    instances()
    hasInstances()
    requestAnimationFrame(() => updateInstanceTabBarHeight())
  })

  onMount(() => {
    updateInstanceTabBarHeight()
    const handleResize = () => updateInstanceTabBarHeight()
    window.addEventListener("resize", handleResize)
    onCleanup(() => window.removeEventListener("resize", handleResize))
  })

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
      setHasInstances(true)
      setShowFolderSelection(false)
      setIsAdvancedSettingsOpen(false)

      log.info("Created instance", {
        instanceId,
        port: instances().get(instanceId)?.port,
      })
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
      // Actually delete the session via API
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
    const instance = activeInstance()
    const sessionId = activeParentSessionIdForInstance()
    if (!instance || !sessionId) return

    try {
      await updateSessionModel(instance.id, sessionId, { providerId, modelId })
      log.info("Updated session model", { providerId, modelId })
    } catch (error) {
      log.error("Failed to update session model", error)
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
          <Dialog.Overlay class="modal-overlay" />
          <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Dialog.Content class="modal-surface w-full max-w-md p-6 flex flex-col gap-6">
              <div>
                <Dialog.Title class="text-xl font-semibold text-primary">Unable to launch OpenCode</Dialog.Title>
                <Dialog.Description class="text-sm text-secondary mt-2 break-words">
                  Install the OpenCode CLI and make sure it is available in your PATH, or pick a custom binary from
                  Advanced Settings.
                </Dialog.Description>
              </div>

              <div class="rounded-lg border border-base bg-surface-secondary p-4">
                <p class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Binary path</p>
                <p class="text-sm font-mono text-primary break-all">{launchErrorPath()}</p>
              </div>

              <div class="flex justify-end gap-2">
                <button type="button" class="selector-button selector-button-secondary" onClick={handleLaunchErrorAdvanced}>
                  Open Advanced Settings
                </button>
                <button type="button" class="selector-button selector-button-primary" onClick={handleLaunchErrorClose}>
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
                  onSelect={(sessionId) => setActiveParentSession(activeInstance()!.id, sessionId)}
                  onSelectChild={(parentId, childId) => handleSelectChildSession(activeInstance()!.id, parentId, childId)}
                  onClose={(sessionId) => handleCloseSessionRequest(sessionId)}
                  onNew={() => handleNewSession(activeInstance()!.id)}
                />
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

              {/* New Tab view - folder selection cards */}
              <Show when={showFolderSelection()}>
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
          <FolderSelectionView
            onSelectFolder={handleSelectFolder}
            isLoading={isSelectingFolder()}
            advancedSettingsOpen={isAdvancedSettingsOpen()}
            onAdvancedSettingsOpen={() => setIsAdvancedSettingsOpen(true)}
            onAdvancedSettingsClose={() => setIsAdvancedSettingsOpen(false)}
            onOpenRemoteAccess={() => setRemoteAccessOpen(true)}
          />
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
          onOpenAdvancedSettings={() => {
            setSettingsPanelOpen(false)
            setIsAdvancedSettingsOpen(true)
          }}
        />

        <CommandsSettingsPanel
          open={commandsPanelOpen()}
          onClose={() => setCommandsPanelOpen(false)}
          instanceId={activeInstanceId()}
        />

        <CloseTabModal
          open={closeModalOpen()}
          type={closeModalType()}
          name={closeModalName()}
          sessionCount={closeModalSessionCount()}
          onConfirm={handleCloseModalConfirm}
          onCancel={handleCloseModalCancel}
        />

        {/* Bottom Status Bar - shown when we have an active instance */}
        <Show when={activeInstance() && !showFolderSelection()}>
          <BottomStatusBar
            projectName={projectName()}
            usedTokens={activeSessionInfo()?.inputTokens ?? 0}
            availableTokens={activeSessionInfo()?.contextAvailableTokens ?? null}
            contextWindow={activeSessionInfo()?.contextWindow ?? 0}
            isCompacting={isCompacting()}
            providerId={activeSessionModel().providerId}
            modelId={activeSessionModel().modelId}
            cost={activeSessionInfo()?.cost ?? 0}
            onModelClick={() => setModelSelectorOpen(true)}
            onContextClick={() => {
              // TODO: Open session summary modal
              log.info("Context clicked - session summary coming soon")
            }}
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

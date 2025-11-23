import { Component, Show, createMemo, createEffect, createSignal } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Toaster } from "solid-toast"
import AlertDialog from "./components/alert-dialog"
import FolderSelectionView from "./components/folder-selection-view"
import { showConfirmDialog } from "./stores/alerts"
import InstanceTabs from "./components/instance-tabs"
import InstanceDisconnectedModal from "./components/instance-disconnected-modal"
import InstanceShell from "./components/instance/instance-shell"
import { initMarkdown } from "./lib/markdown"
import { useTheme } from "./lib/theme"
import { useCommands } from "./lib/hooks/use-commands"
import { useAppLifecycle } from "./lib/hooks/use-app-lifecycle"
import {
  hasInstances,
  isSelectingFolder,
  setIsSelectingFolder,
  setHasInstances,
  showFolderSelection,
  setShowFolderSelection,
} from "./stores/ui"
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
  setActiveParentSession,
  clearActiveParentSession,
  createSession,
  fetchSessions,
  updateSessionAgent,
  updateSessionModel,
} from "./stores/sessions"
import { deleteSession } from "./stores/session-api"

const App: Component = () => {
  const { isDark } = useTheme()
  const {
    preferences,
    recordWorkspaceLaunch,
    toggleShowThinkingBlocks,
    toggleUsageMetrics,
    setDiffViewMode,
    setToolOutputExpansion,
    setDiagnosticsExpansion,
    setThinkingBlocksExpansion,
  } = useConfig()
  const [escapeInDebounce, setEscapeInDebounce] = createSignal(false)
  const [launchErrorBinary, setLaunchErrorBinary] = createSignal<string | null>(null)
  const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = createSignal(false)

  createEffect(() => {
    void initMarkdown(isDark()).catch(console.error)
  })

  const activeInstance = createMemo(() => getActiveInstance())
  const activeSessionIdForInstance = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return null
    return activeSessionId().get(instance.id) || null
  })

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

      console.log("Created instance:", instanceId, "Port:", instances().get(instanceId)?.port)
    } catch (error) {
      clearLaunchError()
      if (isMissingBinaryError(error)) {
        setLaunchErrorBinary(selectedBinary)
      }
      console.error("Failed to create instance:", error)
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
      console.error("Failed to finalize disconnected instance:", error)
    }
  }

  async function handleCloseInstance(instanceId: string) {
    const confirmed = await showConfirmDialog(
      "Stop OpenCode instance? This will stop the server.",
      {
        title: "Stop instance",
        variant: "warning",
        confirmLabel: "Stop",
        cancelLabel: "Keep running",
      },
    )

    if (!confirmed) return

    await stopInstance(instanceId)
    if (instances().size === 0) {
      setHasInstances(false)
    }
  }

  async function handleNewSession(instanceId: string) {
    try {
      const session = await createSession(instanceId)
      setActiveParentSession(instanceId, session.id)
    } catch (error) {
      console.error("Failed to create session:", error)
    }
  }

  async function handleCloseSession(instanceId: string, sessionId: string) {
    const sessions = getSessions(instanceId)
    const session = sessions.find((s) => s.id === sessionId)

    if (!session) {
      return
    }

    const confirmed = await showConfirmDialog("Delete this session? This action cannot be undone.", {
      title: "Delete session",
      variant: "warning",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
    })

    if (!confirmed) {
      return
    }

    try {
      await deleteSession(instanceId, sessionId)
    } catch (error) {
      console.error("Failed to delete session:", error)
    }
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
    toggleShowThinkingBlocks,
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
                onClose={handleCloseInstance}
                onNew={handleNewInstanceRequest}
              />

              <Show when={activeInstance()} keyed>
                {(instance) => (
                  <InstanceShell
                    instance={instance}
                    escapeInDebounce={escapeInDebounce()}
                    paletteCommands={paletteCommands}
                    onCloseSession={(sessionId) => handleCloseSession(instance.id, sessionId)}
                    onNewSession={() => handleNewSession(instance.id)}
                    handleSidebarAgentChange={(sessionId, agent) => handleSidebarAgentChange(instance.id, sessionId, agent)}
                    handleSidebarModelChange={(sessionId, model) => handleSidebarModelChange(instance.id, sessionId, model)}
                    onExecuteCommand={executeCommand}
                  />
                )}
              </Show>
            </>
          }
        >
          <FolderSelectionView
            onSelectFolder={handleSelectFolder}
            isLoading={isSelectingFolder()}
            advancedSettingsOpen={isAdvancedSettingsOpen()}
            onAdvancedSettingsOpen={() => setIsAdvancedSettingsOpen(true)}
            onAdvancedSettingsClose={() => setIsAdvancedSettingsOpen(false)}
          />
        </Show>

        <Show when={showFolderSelection()}>
          <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
            <div class="w-full h-full relative">
              <button
                onClick={() => {
                  setShowFolderSelection(false)
                  setIsAdvancedSettingsOpen(false)
                  clearLaunchError()
                }}
                class="absolute top-4 right-4 z-10 p-2 bg-white dark:bg-gray-800 rounded-lg shadow-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title="Close (Esc)"
              >
                <svg class="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <FolderSelectionView
                onSelectFolder={handleSelectFolder}
                isLoading={isSelectingFolder()}
                advancedSettingsOpen={isAdvancedSettingsOpen()}
                onAdvancedSettingsOpen={() => setIsAdvancedSettingsOpen(true)}
                onAdvancedSettingsClose={() => setIsAdvancedSettingsOpen(false)}
              />
            </div>
          </div>
        </Show>

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

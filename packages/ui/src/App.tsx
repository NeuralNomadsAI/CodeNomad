import { Component, For, Show, createMemo, createEffect, createSignal, onMount, onCleanup } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Toaster } from "solid-toast"
import useMediaQuery from "@suid/material/useMediaQuery"
import { Minimize2 } from "lucide-solid"
import AlertDialog from "./components/alert-dialog"
import FolderSelectionView from "./components/folder-selection-view"
import { showConfirmDialog } from "./stores/alerts"
import InstanceTabs from "./components/instance-tabs"
import InstanceDisconnectedModal from "./components/instance-disconnected-modal"
import InstanceShell from "./components/instance/instance-shell2"
import { RemoteAccessOverlay } from "./components/remote-access-overlay"
import { InstanceMetadataProvider } from "./lib/contexts/instance-metadata-context"
import { initMarkdown } from "./lib/markdown"
import { initGithubStars } from "./stores/github-stars"

import { useTheme } from "./lib/theme"
import { useCommands } from "./lib/hooks/use-commands"
import { useAppLifecycle } from "./lib/hooks/use-app-lifecycle"
import { getLogger } from "./lib/logger"
import { launchError, showLaunchError, clearLaunchError } from "./stores/launch-errors"
import { formatLaunchErrorMessage, isMissingBinaryMessage } from "./lib/launch-errors"
import { initReleaseNotifications } from "./stores/releases"
import { runtimeEnv } from "./lib/runtime-env"
import { useI18n } from "./lib/i18n"
import { setWakeLockDesired } from "./lib/native/wake-lock"
import {
  hasInstances,
  isSelectingFolder,
  setIsSelectingFolder,
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

import { getInstanceSessionIndicatorStatus } from "./stores/session-status"

const log = getLogger("actions")

const App: Component = () => {
  const { isDark } = useTheme()
  const { t } = useI18n()
  const {
    preferences,
    serverSettings,
    recordWorkspaceLaunch,
    toggleShowThinkingBlocks,
    toggleKeyboardShortcutHints,
    toggleShowTimelineTools,
    toggleAutoCleanupBlankSessions,
    toggleUsageMetrics,
    togglePromptSubmitOnEnter,
    setDiffViewMode,
    setToolOutputExpansion,
    setDiagnosticsExpansion,
    setThinkingBlocksExpansion,
    setToolInputsVisibility,
  } = useConfig()
  const [escapeInDebounce, setEscapeInDebounce] = createSignal(false)
  const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = createSignal(false)
  const [remoteAccessOpen, setRemoteAccessOpen] = createSignal(false)
  const [instanceTabBarHeight, setInstanceTabBarHeight] = createSignal(0)

  const phoneQuery = useMediaQuery("(max-width: 767px)")
  const isPhoneLayout = createMemo(() => phoneQuery())

  // In-memory only: hides chrome on phone; may also request browser fullscreen.
  const [mobileFullscreenMode, setMobileFullscreenMode] = createSignal(false)
  const [browserFullscreenActive, setBrowserFullscreenActive] = createSignal(false)

  const fullscreenSupported = () => {
    if (typeof document === "undefined") return false
    const el = document.documentElement as any
    return Boolean(document.fullscreenEnabled) && typeof el?.requestFullscreen === "function"
  }

  const syncBrowserFullscreenState = () => {
    if (typeof document === "undefined") return
    setBrowserFullscreenActive(Boolean(document.fullscreenElement))
  }

  const enterMobileFullscreen = async () => {
    if (!isPhoneLayout()) return
    setMobileFullscreenMode(true)
    if (!fullscreenSupported()) return
    try {
      await document.documentElement.requestFullscreen()
    } catch {
      // Ignore: immersive mode still works without browser fullscreen.
    }
  }

  const exitMobileFullscreen = async () => {
    if (typeof document !== "undefined" && document.fullscreenElement && typeof document.exitFullscreen === "function") {
      try {
        await document.exitFullscreen()
      } catch {
        // Ignore
      }
    }
    setMobileFullscreenMode(false)
  }

  createEffect(() => {
    if (typeof document === "undefined") return
    const shouldShow =
      runtimeEnv.host !== "web" && runtimeEnv.platform !== "mobile" && (preferences().showKeyboardShortcutHints ?? true)
    document.documentElement.dataset.keyboardHints = shouldShow ? "show" : "hide"
  })

  const updateInstanceTabBarHeight = () => {
    if (typeof document === "undefined") return
    const element = document.querySelector<HTMLElement>(".tab-bar-instance")
    setInstanceTabBarHeight(element?.offsetHeight ?? 0)
  }

  onMount(() => {
    if (typeof document === "undefined") return
    syncBrowserFullscreenState()
    document.addEventListener("fullscreenchange", syncBrowserFullscreenState)
    onCleanup(() => document.removeEventListener("fullscreenchange", syncBrowserFullscreenState))
  })

  onMount(() => {
    if (typeof window === "undefined") return
    const vv = window.visualViewport
    if (!vv) return

    const updateKeyboardOffset = () => {
      // visualViewport shrinks when the OSK is visible. Use the delta as a bottom inset.
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty("--keyboard-offset", `${Math.floor(inset)}px`)
    }

    const schedule = () => requestAnimationFrame(updateKeyboardOffset)
    schedule()
    vv.addEventListener("resize", schedule)
    vv.addEventListener("scroll", schedule)
    window.addEventListener("orientationchange", schedule)

    onCleanup(() => {
      vv.removeEventListener("resize", schedule)
      vv.removeEventListener("scroll", schedule)
      window.removeEventListener("orientationchange", schedule)
      document.documentElement.style.removeProperty("--keyboard-offset")
    })
  })

  // If the user exits browser fullscreen via browser UI, restore chrome.
  let lastBrowserFullscreen = false
  createEffect(() => {
    const active = browserFullscreenActive()
    const mode = mobileFullscreenMode()
    if (mode && lastBrowserFullscreen && !active) {
      setMobileFullscreenMode(false)
    }
    lastBrowserFullscreen = active
  })

  // If we leave phone layout (rotation / resize), restore chrome.
  createEffect(() => {
    if (!isPhoneLayout() && mobileFullscreenMode()) {
      void exitMobileFullscreen()
    }
  })

  createEffect(() => {
    void initMarkdown(isDark()).catch((error) => log.error("Failed to initialize markdown", error))
  })

  createEffect(() => {
    initReleaseNotifications()
  })

  const shouldHoldWakeLock = createMemo(() => {
    const map = instances()
    for (const id of map.keys()) {
      const status = getInstanceSessionIndicatorStatus(id)
      if (status !== "idle") {
        return true
      }
    }
    return false
  })

  createEffect(() => {
    const hold = shouldHoldWakeLock()
    void setWakeLockDesired(hold)
  })

  onCleanup(() => {
    void setWakeLockDesired(false)
  })

  createEffect(() => {
    instances()
    hasInstances()
    requestAnimationFrame(() => updateInstanceTabBarHeight())
  })

  onMount(() => {
    void initGithubStars()
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

  const launchErrorPath = () => {
    const value = launchError()?.binaryPath
    if (!value) return "opencode"
    return value.trim() || "opencode"
  }

  const launchErrorMessage = () => launchError()?.message ?? ""

  async function handleSelectFolder(folderPath: string, binaryPath?: string) {
    if (!folderPath) {
      return
    }
    setIsSelectingFolder(true)
    const selectedBinary = binaryPath || serverSettings().opencodeBinary || "opencode"
    try {
      recordWorkspaceLaunch(folderPath, selectedBinary)
      clearLaunchError()
      const instanceId = await createInstance(folderPath, selectedBinary)
      setShowFolderSelection(false)
      setIsAdvancedSettingsOpen(false)

      log.info("Created instance", {
        instanceId,
        port: instances().get(instanceId)?.port,
      })
    } catch (error) {
      const message = formatLaunchErrorMessage(error, t("app.launchError.fallbackMessage"))
      const missingBinary = isMissingBinaryMessage(message)
      showLaunchError({ source: "create", message, binaryPath: selectedBinary, missingBinary })
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

  async function handleCloseInstance(instanceId: string) {
    const confirmed = await showConfirmDialog(
      t("app.stopInstance.confirmMessage"),
      {
        title: t("app.stopInstance.title"),
        variant: "warning",
        confirmLabel: t("app.stopInstance.confirmLabel"),
        cancelLabel: t("app.stopInstance.cancelLabel"),
      },
    )

    if (!confirmed) return

    await stopInstance(instanceId)
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

    const parentSessionId = session.parentId ?? session.id
    const parentSession = sessions.find((s) => s.id === parentSessionId)

    if (!parentSession || parentSession.parentId !== null) {
      return
    }

    clearActiveParentSession(instanceId)

    try {
      await fetchSessions(instanceId)
    } catch (error) {
      log.error("Failed to refresh sessions after closing", error)
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
    toggleAutoCleanupBlankSessions,
    toggleShowThinkingBlocks,
    toggleKeyboardShortcutHints,
    toggleShowTimelineTools,
    toggleUsageMetrics,
    togglePromptSubmitOnEnter,
    setDiffViewMode,
    setToolOutputExpansion,
    setDiagnosticsExpansion,
    setThinkingBlocksExpansion,
    setToolInputsVisibility,
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

      <Dialog open={Boolean(launchError())} modal>
        <Dialog.Portal>
          <Dialog.Overlay class="modal-overlay" />
           <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
             <Dialog.Content class="modal-surface w-full max-w-3xl p-6 flex flex-col gap-6 max-h-[80vh] min-h-0 overflow-hidden">
               <div>
                 <Dialog.Title class="text-xl font-semibold text-primary">{t("app.launchError.title")}</Dialog.Title>
                 <Dialog.Description class="text-sm text-secondary mt-2 break-words">
                   {t("app.launchError.description")}
                 </Dialog.Description>
               </div>

               <div class={`flex flex-col gap-4 ${launchErrorMessage() ? "flex-1 min-h-0" : ""}`}>
                 <div class="rounded-lg border border-base bg-surface-secondary p-4 flex-shrink-0">
                   <p class="text-xs font-medium text-muted uppercase tracking-wide mb-1">{t("app.launchError.binaryPathLabel")}</p>
                   <p class="text-sm font-mono text-primary break-all">{launchErrorPath()}</p>
                 </div>
 
                 <Show when={launchErrorMessage()}>
                   <div class="rounded-lg border border-base bg-surface-secondary p-4 flex flex-col gap-2 flex-1 min-h-0">
                     <p class="text-xs font-medium text-muted uppercase tracking-wide">{t("app.launchError.errorOutputLabel")}</p>
                     <pre class="text-sm font-mono text-primary whitespace-pre-wrap break-words overflow-auto flex-1 min-h-0">{launchErrorMessage()}</pre>
                   </div>
                 </Show>
               </div>

               <div class="flex justify-end gap-2">
                 <Show when={launchError()?.missingBinary}>
                   <button
                     type="button"
                     class="selector-button selector-button-secondary"
                    onClick={handleLaunchErrorAdvanced}
                  >
                    {t("app.launchError.openAdvancedSettings")}
                  </button>
                </Show>
                <button type="button" class="selector-button selector-button-primary" onClick={handleLaunchErrorClose}>
                  {t("app.launchError.close")}
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>
      <div class="h-screen w-screen flex flex-col" style={{ height: "100dvh", "padding-bottom": "var(--keyboard-offset, 0px)" }}>
        <Show when={isPhoneLayout() && mobileFullscreenMode()}>
          <div class="mobile-fullscreen-exit-wrapper">
            <button
              type="button"
              class="message-scroll-button mobile-fullscreen-exit-button"
              onClick={() => void exitMobileFullscreen()}
              aria-label={t("instanceShell.fullscreen.exit")}
              title={t("instanceShell.fullscreen.exit")}
            >
              <Minimize2 class="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </Show>
        <Show
          when={!hasInstances()}
          fallback={
            <>
              <Show when={!isPhoneLayout() || !mobileFullscreenMode()}>
                <InstanceTabs
                  instances={instances()}
                  activeInstanceId={activeInstanceId()}
                  onSelect={setActiveInstanceId}
                  onClose={handleCloseInstance}
                  onNew={handleNewInstanceRequest}
                  onOpenRemoteAccess={() => setRemoteAccessOpen(true)}
                />
              </Show>
 
              <For each={Array.from(instances().values())}>
                {(instance) => {
                  const isActiveInstance = () => activeInstanceId() === instance.id
                  const isVisible = () => isActiveInstance() && !showFolderSelection()
                    return (
                       <div
                         class="flex-1 min-h-0 overflow-hidden"
                         style={{ display: isVisible() ? "flex" : "none" }}
                         data-instance-id={instance.id}
                         data-instance-active={isActiveInstance() ? "true" : "false"}
                         data-instance-visible={isVisible() ? "true" : "false"}
                       >
                         <InstanceMetadataProvider instance={instance}>
                           <InstanceShell
                             instance={instance}
                             isActiveInstance={isActiveInstance()}
                             escapeInDebounce={escapeInDebounce()}
                             paletteCommands={paletteCommands}
                             onCloseSession={(sessionId) => handleCloseSession(instance.id, sessionId)}
                             onNewSession={() => handleNewSession(instance.id)}
                             handleSidebarAgentChange={(sessionId, agent) => handleSidebarAgentChange(instance.id, sessionId, agent)}
                             handleSidebarModelChange={(sessionId, model) => handleSidebarModelChange(instance.id, sessionId, model)}
                             onExecuteCommand={executeCommand}
                            tabBarOffset={isPhoneLayout() && mobileFullscreenMode() ? 0 : instanceTabBarHeight()}
                            mobileFullscreenMode={isPhoneLayout() && mobileFullscreenMode()}
                            onEnterMobileFullscreen={() => void enterMobileFullscreen()}
                            onExitMobileFullscreen={() => void exitMobileFullscreen()}
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

        <Show when={showFolderSelection()}>
          <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
            <div class="w-full h-full relative">
              <FolderSelectionView
                onSelectFolder={handleSelectFolder}
                isLoading={isSelectingFolder()}
                advancedSettingsOpen={isAdvancedSettingsOpen()}
                onAdvancedSettingsOpen={() => setIsAdvancedSettingsOpen(true)}
                onAdvancedSettingsClose={() => setIsAdvancedSettingsOpen(false)}
                onClose={() => {
                  setShowFolderSelection(false)
                  setIsAdvancedSettingsOpen(false)
                  clearLaunchError()
                }}
              />
            </div>
          </div>
        </Show>
 
        <RemoteAccessOverlay open={remoteAccessOpen()} onClose={() => setRemoteAccessOpen(false)} />
 
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

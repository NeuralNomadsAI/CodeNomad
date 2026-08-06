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
import { SettingsScreen } from "./components/settings-screen"
import { SideCarPickerDialog } from "./components/sidecar-picker-dialog"
import { SideCarView } from "./components/sidecar-view"
import { InstanceMetadataProvider } from "./lib/contexts/instance-metadata-context"
import { showAlertDialog } from "./stores/alerts"
import { initGithubStars } from "./stores/github-stars"

import { useCommands } from "./lib/hooks/use-commands"
import { useAppLifecycle } from "./lib/hooks/use-app-lifecycle"
import { useAppSessionRestore } from "./lib/hooks/use-app-session-restore"
import { loadedRestorableSession } from "./stores/client-state"
import { shouldShowAppHomeOverlay, shouldShowEmptyAppHome } from "./stores/app-session-restore-gate"
import { getLogger } from "./lib/logger"
import { launchError, showLaunchError, clearLaunchError } from "./stores/launch-errors"
import { formatLaunchErrorMessage, isMissingBinaryMessage } from "./lib/launch-errors"
import { initReleaseNotifications } from "./stores/releases"
import { isTauriHost, isWebHost, runtimeEnv } from "./lib/runtime-env"
import { useI18n } from "./lib/i18n"
import { setWakeLockDesired } from "./lib/native/wake-lock"
import {
  isSelectingFolder,
  setIsSelectingFolder,
  showFolderSelection,
  setShowFolderSelection,
} from "./stores/ui"
import { recentFolders, useConfig } from "./stores/preferences"
import {
  createInstance,
  instances,
  stopInstance,
  disconnectedInstance,
  acknowledgeDisconnectedInstance,
} from "./stores/instances"
import {
  getSessions,
  getSessionRoot,
  activeSessionId,
  setActiveParentSession,
  clearActiveParentSession,
  createSession,
  fetchSessions,
  updateSessionAgent,
  updateSessionModel,
} from "./stores/sessions"

import { hasWakeLockEligibleWork } from "./stores/session-status"
import { openSettings } from "./stores/settings-screen"
import {
  closeSidecarTab,
  ensureSidecarsLoaded,
  openSidecarTab,
} from "./stores/sidecars"
import {
  activeAppTab,
  activeAppTabId,
  appTabs,
  ensureActiveAppTab,
  getAdjacentAppTabId,
  getAppTabById,
  markAppTabUserInteraction,
  moveAppTab,
  selectAppTab,
  selectInstanceTab,
  selectSidecarTab,
} from "./stores/app-tabs"
const log = getLogger("actions")

const App: Component = () => {
  useAppSessionRestore()
  const { t } = useI18n()
  const {
    preferences,
    recentFolders,
    useTauriNativeEventTransport,
    setUseTauriNativeEventTransport,
    serverSettings,
    recordWorkspaceLaunch,
    toggleShowThinkingBlocks,
    toggleKeyboardShortcutHints,
    toggleShowMessageTimeline,
    toggleShowTimelineTools,
    toggleAutoCleanupBlankSessions,
    toggleUsageMetrics,
    togglePromptSubmitOnEnter,
    toggleShowPromptVoiceInput,
    setDiffViewMode,
    setToolOutputExpansion,
    setDiagnosticsExpansion,
    setThinkingBlocksExpansion,
    setToolInputsVisibility,
  } = useConfig()
  const [escapeInDebounce, setEscapeInDebounce] = createSignal(false)
  const [instanceTabBarHeight, setInstanceTabBarHeight] = createSignal(0)
  const [sidecarPickerOpen, setSidecarPickerOpen] = createSignal(false)
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
      !isWebHost() && runtimeEnv.platform !== "mobile" && (preferences().showKeyboardShortcutHints ?? true)
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
    initReleaseNotifications()
  })

  const shouldHoldWakeLock = createMemo(() => {
    const map = instances()
    for (const id of map.keys()) {
      if (hasWakeLockEligibleWork(id)) {
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
    appTabs()
    requestAnimationFrame(() => updateInstanceTabBarHeight())
  })

  onMount(() => {
    void initGithubStars()
    updateInstanceTabBarHeight()
    const handleResize = () => updateInstanceTabBarHeight()
    window.addEventListener("resize", handleResize)
    onCleanup(() => window.removeEventListener("resize", handleResize))
  })

  createEffect(() => {
    appTabs()
    ensureActiveAppTab()
  })

  const activeInstance = createMemo(() => {
    const tab = activeAppTab()
    return tab?.kind === "instance" ? tab.instance : null
  })
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

  function getPathBasename(path: string): string {
    const normalized = path.replace(/[\\/]+$/, "")
    return normalized.split(/[\\/]/).pop() || path
  }

  function getProjectNameForFolder(folderPath: string): string {
    const recent = recentFolders().find((folder) => folder.path === folderPath)
    return recent?.projectName?.trim() || getPathBasename(folderPath)
  }

  async function handleSelectFolder(folderPath: string, binaryPath?: string, options?: { forceNew?: boolean }) {
    if (!folderPath) {
      return
    }

    const selectedBinary = binaryPath || serverSettings().opencodeBinary || "opencode"
    const projectName = getProjectNameForFolder(folderPath)
    clearLaunchError()

    setIsSelectingFolder(true)
    try {
      const result = await createInstance(folderPath, selectedBinary, projectName, { forceNew: options?.forceNew })
      recordWorkspaceLaunch(instances().get(result.instanceId)?.folder ?? folderPath, selectedBinary, folderPath)
      if (result.reused) {
        selectInstanceTab(result.instanceId)
        setShowFolderSelection(false)
        log.info("Selected reused instance", { instanceId: result.instanceId, folderPath })
        return
      }

      selectInstanceTab(result.instanceId)
      setShowFolderSelection(false)

      log.info("Created instance", {
        instanceId: result.instanceId,
        port: instances().get(result.instanceId)?.port,
      })
    } catch (error) {
      const message = formatLaunchErrorMessage(
        error,
        t("app.launchError.fallbackMessage"),
        t("app.launchError.invalidConfig"),
      )
      const missingBinary = isMissingBinaryMessage(message)
      showLaunchError({ source: "create", message, binaryPath: selectedBinary, missingBinary })
      log.error("Failed to create instance", error)
    } finally {
      setIsSelectingFolder(false)
    }
  }

  function handleSelectExistingInstance(instanceId: string, recentPath: string, binaryPath: string) {
    const instance = instances().get(instanceId)
    if (!instance) return
    recordWorkspaceLaunch(instance.folder, binaryPath, recentPath)
    selectInstanceTab(instanceId)
    setShowFolderSelection(false)
    log.info("Selected existing instance", { instanceId, folderPath: instance.folder })
  }

  function handleLaunchErrorClose() {
    clearLaunchError()
  }

  function handleLaunchErrorAdvanced() {
    clearLaunchError()
    openSettings("opencode")
  }

  function handleNewInstanceRequest() {
    setShowFolderSelection(true)
  }

  function handleOpenSidecarPicker() {
    setSidecarPickerOpen(true)
    void ensureSidecarsLoaded()
  }

  async function handleOpenSidecar(sidecarId: string) {
    try {
      const tab = await openSidecarTab(sidecarId)
      selectSidecarTab(tab.token)
      setShowFolderSelection(false)
      setSidecarPickerOpen(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showAlertDialog(message, {
        variant: "error",
        title: t("sidecars.open.errorTitle"),
      })
      log.error("Failed to open SideCar", error)
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

    stopInstance(instanceId)
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

    const parentSession = getSessionRoot(instanceId, sessionId)
    if (!parentSession) return

    clearActiveParentSession(instanceId)

    try {
      await fetchSessions(instanceId, { reset: true })
    } catch (error) {
      log.error("Failed to refresh sessions after closing", error)
    }
  }

  async function handleCloseAppTab(tabId: string) {
    const tab = getAppTabById(tabId)
    if (!tab) return
    markAppTabUserInteraction()

    const fallbackTabId = activeAppTabId() === tabId ? getAdjacentAppTabId(tabId) : activeAppTabId()

    if (tab.kind === "instance") {
      await handleCloseInstance(tab.instance.id)
    } else {
      closeSidecarTab(tab.sidecarTab.token)
    }

    if (!getAppTabById(tabId)) {
      ensureActiveAppTab(fallbackTabId)
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
    useTauriNativeEventTransport,
    setUseTauriNativeEventTransport,
    toggleAutoCleanupBlankSessions,
    toggleShowThinkingBlocks,
    toggleKeyboardShortcutHints,
    toggleShowMessageTimeline,
    toggleShowTimelineTools,
    toggleUsageMetrics,
    togglePromptSubmitOnEnter,
    toggleShowPromptVoiceInput,
    setDiffViewMode,
    setToolOutputExpansion,
    setDiagnosticsExpansion,
    setThinkingBlocksExpansion,
    setToolInputsVisibility,
    handleNewInstanceRequest,
    handleCloseActiveTab: () => handleCloseAppTab(activeAppTabId() ?? ""),
    handleCloseInstance,
    handleNewSession,
    handleCloseSession,
    getActiveInstance: activeInstance,
    getActiveSessionIdForInstance: activeSessionIdForInstance,
  })

  useAppLifecycle({
    setEscapeInDebounce,
    handleNewInstanceRequest,
    handleCloseActiveTab: () => handleCloseAppTab(activeAppTabId() ?? ""),
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
    if (isTauriHost()) {
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
          when={appTabs().length === 0}
          fallback={
            <>
              <Show when={!isPhoneLayout() || !mobileFullscreenMode()}>
                <InstanceTabs
                  tabs={appTabs()}
                  activeTabId={activeAppTabId()}
                  onSelect={selectAppTab}
                  onClose={(tabId) => void handleCloseAppTab(tabId)}
                  onNew={handleNewInstanceRequest}
                  onMoveTab={moveAppTab}
                />
              </Show>

              <For each={appTabs().map(({ id }) => id)}>
                {(tabId) => {
                  const tab = createMemo(() => appTabs().find(({ id }) => id === tabId))
                  const instanceTab = createMemo(() => { const current = tab(); return current?.kind === "instance" ? current : undefined })
                  const sidecarTab = createMemo(() => { const current = tab(); return current?.kind === "sidecar" ? current : undefined })
                  const isVisible = () => activeAppTabId() === tabId && !showFolderSelection()
                  return (
                    <Show when={instanceTab()} fallback={
                      <Show when={sidecarTab()}>
                        {(currentTab) => (
                          <div
                            class="flex-1 min-h-0 overflow-hidden"
                            style={{ display: isVisible() ? "flex" : "none" }}
                            data-tab-id={tabId}
                            data-tab-kind={currentTab().kind}
                            data-tab-visible={isVisible() ? "true" : "false"}
                          >
                            <SideCarView tab={currentTab().sidecarTab} />
                          </div>
                        )}
                      </Show>
                    }>
                      {(currentTab) => (
                        <div
                          class="flex-1 min-h-0 overflow-hidden"
                          style={{ display: isVisible() ? "flex" : "none" }}
                          data-instance-id={currentTab().instance.id}
                          data-tab-id={tabId}
                          data-tab-kind={currentTab().kind}
                          data-tab-visible={isVisible() ? "true" : "false"}
                        >
                          <InstanceMetadataProvider instance={currentTab().instance}>
                            <InstanceShell
                              instance={currentTab().instance}
                              isActiveInstance={isVisible()}
                              escapeInDebounce={escapeInDebounce()}
                              paletteCommands={paletteCommands}
                              onCloseSession={(sessionId) => handleCloseSession(currentTab().instance.id, sessionId)}
                              onNewSession={() => handleNewSession(currentTab().instance.id)}
                              handleSidebarAgentChange={(sessionId, agent) => handleSidebarAgentChange(currentTab().instance.id, sessionId, agent)}
                              handleSidebarModelChange={(sessionId, model) => handleSidebarModelChange(currentTab().instance.id, sessionId, model)}
                              onExecuteCommand={executeCommand}
                              tabBarOffset={isPhoneLayout() && mobileFullscreenMode() ? 0 : instanceTabBarHeight()}
                              mobileFullscreenMode={isPhoneLayout() && mobileFullscreenMode()}
                              onEnterMobileFullscreen={() => void enterMobileFullscreen()}
                              onExitMobileFullscreen={() => void exitMobileFullscreen()}
                            />
                          </InstanceMetadataProvider>
                        </div>
                      )}
                    </Show>
                  )
                }}
              </For>

            </>
          }
        >
          <Show when={shouldShowEmptyAppHome(loadedRestorableSession())}>
            <FolderSelectionView
              onSelectFolder={handleSelectFolder}
              onSelectExistingInstance={handleSelectExistingInstance}
              isLoading={isSelectingFolder()}
              onOpenSidecar={handleOpenSidecarPicker}
            />
          </Show>
        </Show>

        <Show when={shouldShowAppHomeOverlay(showFolderSelection(), appTabs().length)}>
          <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
            <div class="w-full h-full relative">
              <FolderSelectionView
                onSelectFolder={handleSelectFolder}
                onSelectExistingInstance={handleSelectExistingInstance}
                isLoading={isSelectingFolder()}
                onOpenSidecar={handleOpenSidecarPicker}
                onClose={() => {
                  setShowFolderSelection(false)
                  clearLaunchError()
                }}
              />
            </div>
          </div>
        </Show>

        <SettingsScreen />
        <SideCarPickerDialog open={sidecarPickerOpen()} onClose={() => setSidecarPickerOpen(false)} onOpenSidecar={handleOpenSidecar} />
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

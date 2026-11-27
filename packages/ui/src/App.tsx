import { Component, For, Show, createMemo, createEffect, createSignal, onMount, onCleanup } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Toaster } from "solid-toast"
import useMediaQuery from "@suid/material/useMediaQuery"
import { Minimize2 } from "lucide-solid"
import AlertDialog from "./components/alert-dialog"
import AuthRecoveryDialog from "./components/auth-recovery-dialog"
import FolderSelectionView from "./components/folder-selection-view"
import { selectRemoteServer } from "./stores/remote-project-open"
import { normalizeServerSelection, sameServerSelection } from "./lib/native/server-selection-intent"
import { serversManageable } from "./lib/server-meta"
import NewInstanceLauncher from "./components/new-instance-launcher"
import { useDesktopFolderLaunch } from "./lib/hooks/use-electron-folder-launch"
import { useDesktopConnectionLaunch } from "./lib/hooks/use-desktop-connection-launch"
import { AppViewport } from "./components/app-viewport"
import { openTemporaryInstance } from "./stores/temporary-instances"
import InstanceTabs from "./components/instance-tabs"
import InstanceDisconnectedModal from "./components/instance-disconnected-modal"
import InstanceShell from "./components/instance/instance-shell2"
import { SettingsScreen } from "./components/settings-screen"
import { NativeTitlebar, hasNativeTitlebar } from "./components/native-titlebar"
import { SideCarView } from "./components/sidecar-view"
import { InstanceMetadataProvider } from "./lib/contexts/instance-metadata-context"
import { showAlertDialog } from "./stores/alerts"
import { initGithubStars } from "./stores/github-stars"
import { reloadWorktrees } from "./stores/worktrees"

import { useCommands } from "./lib/hooks/use-commands"
import { useAppLifecycle } from "./lib/hooks/use-app-lifecycle"
import { useAppSessionRestore } from "./lib/hooks/use-app-session-restore"
import { loadedRestorableSession } from "./stores/client-state"
import { appSessionRestoreGateActive } from "./stores/app-session-restore-gate"
import { getLogger } from "./lib/logger"
import { launchError, showLaunchError, clearLaunchError } from "./stores/launch-errors"
import OpenCodeSetup from "./components/opencode-setup"
import { openOpenCodeSetup } from "./stores/opencode-setup"
import { formatLaunchErrorMessage, isMissingBinaryMessage } from "./lib/launch-errors"
import { initReleaseNotifications } from "./stores/releases"
import { observeDesktopUpdates, requestDesktopUpdate } from "./stores/desktop-updates"
import { runtimeEnv } from "./lib/runtime-env"
import { listenMenuActions } from "./lib/native/menu-actions"
import { useI18n } from "./lib/i18n"
import { setWakeLockDesired } from "./lib/native/wake-lock"
import { startNotificationIconBadge } from "./lib/notification-icon-badge"
import RemoteRestoreView from "./components/remote-restore-view"
import {
  claimNativeBrowserOpen,
  changeBrowserPreviewOwnership,
  onBrowserPreviewOwnership,
  onNativeBrowserOpen,
  releaseNativeBrowserOpen,
  selectBrowserOpenOwner,
  type BrowserOpenDiscovery,
  type BrowserOpenRequest,
} from "./lib/native/browser"
import { useViewMenu } from "./lib/native/view-menu"
import {
  isSelectingFolder,
  setIsSelectingFolder,
} from "./stores/ui"
import { preferencesForBackend, recentFolders, useConfig } from "./stores/preferences"
import {
  createInstance,
  WorkspaceCreationDeparture,
  instances,
  disconnectedInstance,
  acknowledgeDisconnectedInstance,
  reconcilePendingSessionIndicators,
  needsPendingRequestLiveness,
  reconcilePendingRequestLiveness,
  refreshVolatileInstanceState,
  syncLoadedSessionInboxes,
  syncPendingRequests,
} from "./stores/instances"
import {
  getSessions,
  getSessionRoot,
  activeSessionId,
  clearSelectedSession,
  fetchSessions,
  hydrateRestoredSessionChain,
  loadMessages,
  setActiveSessionFromList,
  startNewSession,
  updateSessionAgent,
  updateSessionModel,
} from "./stores/sessions"
import { acceptPreviewOwnership, openSessionPreview, settleSessionPreviewOpen, showSessionPreview } from "./stores/session-previews"
import { isInstanceOccurrenceOpen } from "./stores/instance-lifecycle-authority"
import { SessionPreviewHost } from "./components/session-preview-view"
import { observeSurfaceGesture } from "./stores/session-surface"
import { useForegroundRefresh } from "./lib/hooks/use-foreground-refresh"
import { messagesLoaded, invalidateSessionMessageLoad } from "./stores/session-state"

import { hasWakeLockEligibleWork, getSessionStatus } from "./stores/session-status"
import { shouldAppHoldWakeLock } from "./stores/wake-lock-eligibility"
import { openSettings } from "./stores/settings-screen"
import { showCommandPalette } from "./stores/command-palette"
import { openSidecarTab } from "./stores/sidecars"
import { closeAppTab } from "./stores/app-tab-close"
import { parseInstanceKey, backendIdOf } from "./lib/backend-identity"
import { captureBackendOperation } from "./lib/backend-operation"
import {
  activeAppTab,
  activeAppTabId,
  allowsAutomaticLocalSetup,
  appTabSelectionRevision,
  appTabs,
  activeBlankTabId,
  closeBlankTab,
  openBlankTab,
  replaceBlankTab,
  getInstanceAppTabId,
  getSidecarAppTabId,
  detachInstanceTab,
  ensureActiveAppTab,
  moveAppTab,
  selectAppTab,
  selectInstanceTab,
  selectSidecarTab,
} from "./stores/app-tabs"
const log = getLogger("actions")
const FOREGROUND_REFRESH_TIMEOUT_MS = 10_000

async function withForegroundRefreshTimeout<T>(
  promise: Promise<T>,
  label: string,
  onTimeout?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => { onTimeout?.(); reject(signal?.reason) }
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) { abort(); return }
        timer = setTimeout(() => {
          onTimeout?.()
          reject(new Error(`${label} timed out`))
        }, FOREGROUND_REFRESH_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

const App: Component = () => {
  onMount(() => {
    window.__CODENOMAD_SELECT_SERVER__ = (intent, action) => {
      if (action !== "remove") return selectRemoteServer(intent)
      const target = normalizeServerSelection(intent)
      const host = preferencesForBackend("local")
      const relay = host.preferences().multiBackend
      const current = () => relay === host.preferences().multiBackend && (relay !== true || serversManageable())
      if (!target || !current() || !host.remoteServers().some(profile => sameServerSelection(target, profile))) {
        throw new Error("Server selection changed")
      }
      void host.removeRemoteServerProfile(target.id, current).catch(error => {
        if (error?.name !== "AbortError") showAlertDialog(t("settings.preferenceSaveFailed"), {
          title: t("folderSelection.servers.remove"), variant: "warning",
        })
      })
    }
    onCleanup(() => { delete window.__CODENOMAD_SELECT_SERVER__ })
  })
  onMount(() => onCleanup(startNotificationIconBadge()))
  useAppSessionRestore()
  const { t } = useI18n()
  const {
    preferences,
    recentFolders,
    serverSettings,
    recordWorkspaceLaunch,
    toggleShowThinkingBlocks,
    toggleShowMessageTimeline,
    toggleAutoCleanupBlankSessions,
    toggleUsageMetrics,
    toggleShowPromptVoiceInput,
    setDiffViewMode,
    setToolOutputExpansion,
    setDiagnosticsExpansion,
    setThinkingBlocksExpansion,
    setToolInputsVisibility,
  } = useConfig()
  const [escapeInDebounce, setEscapeInDebounce] = createSignal(false)
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
    if (runtimeEnv.platform !== "mobile") return
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

  createEffect(() => {
    initReleaseNotifications()
  })

  const shouldHoldWakeLock = createMemo(() => shouldAppHoldWakeLock(
    preferences().keepComputerAwake,
    [...instances().keys()].some(hasWakeLockEligibleWork),
    runtimeEnv.windowContext,
  ))

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
    let disposed = false
    let browserOpenUnsubscribe = () => {}
    let browserOwnershipUnsubscribe = () => {}
    const browserDeliveries = new Map<string, AbortController>()
    void initGithubStars()
    updateInstanceTabBarHeight()
    const handleResize = () => updateInstanceTabBarHeight()
    window.addEventListener("resize", handleResize)
    const livenessTimer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      for (const instance of instances().values()) {
        if (instance.status === "ready" && instance.client && needsPendingRequestLiveness(instance.id)) {
          void reconcilePendingRequestLiveness(instance.id).catch((error) => {
            log.warn("Failed to reconcile pending request liveness", { instanceId: instance.id, error })
          })
        }
      }
    }, 30_000)
    const localInstances = () => appTabs().flatMap(tab => tab.kind === "instance"
      && parseInstanceKey(tab.instance.id).backendId === "local" && isInstanceOccurrenceOpen(tab.instance.id)
      && tab.instance.status === "ready" && tab.instance.client ? [tab.instance] : [])
    const recentTabs = new Map<string, string[]>()
    let lastUsedTab: string | undefined, lastUsedSession: string | undefined
    const reportTabUse = () => {
      if (lastUsedTab && lastUsedSession) {
        void changeBrowserPreviewOwnership({ action: "used", instanceId: lastUsedTab, sessionId: lastUsedSession })?.catch(() => {})
      }
    }
    window.addEventListener("focus", reportTabUse)
    createEffect(() => {
      const tab = activeAppTab()
      const id = tab?.kind === "instance" && parseInstanceKey(tab.instance.id).backendId === "local" ? tab.instance.id : undefined
      const session = id ? activeSessionId().get(id) : undefined
      if (id && session && session !== "info") {
        const previous = recentTabs.get(session) ?? []
        recentTabs.delete(session)
        recentTabs.set(session, [id, ...previous.filter(other => other !== id)].slice(0, 32))
        if (recentTabs.size > 512) recentTabs.delete(recentTabs.keys().next().value!)
        if (lastUsedTab !== id || lastUsedSession !== session) {
          lastUsedTab = id
          lastUsedSession = session
          if (document.hasFocus()) reportTabUse()
        }
      } else { lastUsedTab = lastUsedSession = undefined }
    })
    const discoverPreviewOwner = ({ workspaceIDs, requestID, sessionID }: BrowserOpenDiscovery) => {
      if (disposed) return
      const eligible = new Set(workspaceIDs)
      const owners = localInstances().filter(instance => eligible.has(parseInstanceKey(instance.id).workspaceId))
      const activeTab = activeAppTab()
      const recent = recentTabs.get(sessionID)?.find(id => owners.some(owner => owner.id === id))
      const owner = selectBrowserOpenOwner(owners, recent ?? (activeTab?.kind === "instance" ? activeTab.instance.id : undefined))
      return claimNativeBrowserOpen(requestID, { kind: "discover", instanceId: owner?.id ?? owners[0]?.id ?? null })
    }
    const openRequestedPreview = async ({ sessionID, url, requestID, instanceId }: BrowserOpenRequest) => {
      const eligible = () => !disposed && localInstances().some(instance => instance.id === instanceId)
      const delivery = new AbortController()
      let published = false
      try {
        if (!eligible()) return
        browserDeliveries.set(requestID, delivery)
        const operation = captureBackendOperation(instanceId, undefined, eligible)
        const intent = observeSurfaceGesture({ instanceId, sessionId: sessionID })
        const selectionRevision = appTabSelectionRevision()
        const loaded = () => getSessions(instanceId).some(session => session.id === sessionID)
        const current = () => operation.current() && intent.current() && !delivery.signal.aborted
        if (!loaded()) await hydrateRestoredSessionChain(instanceId, [sessionID], operation.signal, current)
        if (!current() || !loaded()) return
        await openSessionPreview(sessionID, url, instanceId, intent, { requestID, instanceId }, delivery.signal, () =>
          changeBrowserPreviewOwnership({ action: "ready", sessionId: sessionID, instanceId, requestID }))
        if (!current()) return
        if (appTabSelectionRevision() === selectionRevision) {
          selectInstanceTab(instanceId)
          setActiveSessionFromList(instanceId, sessionID, intent)
        }
        published = true
      } finally {
        browserDeliveries.delete(requestID)
        if (!published) await releaseNativeBrowserOpen(requestID).catch((releaseError) => {
          log.warn("Failed to release agent-requested web preview", { sessionID, releaseError })
        })
      }
    }
    void onNativeBrowserOpen((request) => {
      void discoverPreviewOwner(request)?.catch(error => log.warn("Failed to discover the owning preview tab", { error }))
    }, (request) => {
      void openRequestedPreview(request).catch(error => log.warn("Failed to open agent-requested web preview", { sessionID: request.sessionID, error }))
    }, ({ requestID, sessionID, instanceId, committedUrl, keepGuest, successorUrl }) => {
      browserDeliveries.get(requestID)?.abort()
      settleSessionPreviewOpen(sessionID, instanceId, requestID, committedUrl, keepGuest, successorUrl)
    }).then((cleanup) => {
      if (disposed) cleanup()
      else browserOpenUnsubscribe = cleanup
    }).catch((error) => log.warn("Failed to listen for native browser open requests", { error }))
    void onBrowserPreviewOwnership(acceptPreviewOwnership, ({ sessionId, instanceId }) => {
      if (!localInstances().some(instance => instance.id === instanceId)) return
      selectInstanceTab(instanceId)
      setActiveSessionFromList(instanceId, sessionId)
      showSessionPreview(sessionId, instanceId)
    }).then(cleanup => {
      if (disposed) cleanup()
      else browserOwnershipUnsubscribe = cleanup
    }).catch(error => log.warn("Failed to listen for browser ownership changes", { error }))
    onCleanup(() => {
      disposed = true
      browserOpenUnsubscribe()
      browserOwnershipUnsubscribe()
      window.removeEventListener("focus", reportTabUse)
      window.removeEventListener("resize", handleResize)
      window.clearInterval(livenessTimer)
    })
  })

  createEffect(() => {
    if (appSessionRestoreGateActive()) return
    if (appTabs().length === 0) openBlankTab()
    else ensureActiveAppTab()
  })

  const activeInstance = createMemo(() => {
    const tab = activeAppTab()
    return tab?.kind === "instance" ? tab.instance : null
  })
  const automaticLocalSetup = () => {
    const tab = activeAppTab()
    if (tab) return allowsAutomaticLocalSetup(tab)
    const saved = loadedRestorableSession()
    const selected = saved?.tabs[saved.activeTabIndex]
    return selected?.kind !== "workspace" || backendIdOf(selected) === "local"
  }
  const activeSessionIdForInstance = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return null
    return activeSessionId().get(instance.id) || null
  })

  useForegroundRefresh({
    onRefresh: async (backendId, signal) => {
      signal.throwIfAborted()
      // A reconnect reconciles every loaded workspace/session of its backend:
      //  1. Re-fetch the session list for every instance (status/titles).
      //  2. Force-reload whatever session is active AFTER the fetch settles
      //     (so a session switch during the await still lands on the right
      //     one), since it's the one the user is looking at.
      //  3. Invalidate the loaded flag for every other loaded session so it
      //     re-fetches lazily on next activation instead of returning stale
      //     content (a non-forced load short-circuits once "loaded").
      const instanceIds = Array.from(instances().values())
        .filter((instance) => backendIdOf(instance) === backendId && instance.status === "ready" && Boolean(instance.client))
        .map((instance) => instance.id)
      const sessionListResults = await Promise.allSettled(
        instanceIds.map((id) => {
          signal.throwIfAborted()
          let invalidateSessions = () => {}
          let invalidatePendingRequests = () => {}
          return withForegroundRefreshTimeout(
            (async () => {
              let sessionError: unknown
              try {
                await fetchSessions(id, {
                  signal,
                  strictStatus: true,
                  registerInvalidation: (invalidate) => { invalidateSessions = invalidate },
                })
              } catch (error) {
                sessionError = error
              }
              signal.throwIfAborted()
              await Promise.all([
                reloadWorktrees(id, false, signal),
                syncPendingRequests(id, (invalidate) => { invalidatePendingRequests = invalidate }, undefined, signal),
                refreshVolatileInstanceState(id, undefined, signal),
                syncLoadedSessionInboxes(id, signal),
              ])
              signal.throwIfAborted()
              if (sessionError) throw sessionError
            })(),
            `Foreground refresh for ${id}`,
            () => {
              invalidateSessions()
              invalidatePendingRequests()
            },
            signal,
          )
        }),
      )
      signal.throwIfAborted()
      const failedInstanceIds: string[] = []
      sessionListResults.forEach((result, i) => {
        signal.throwIfAborted()
        reconcilePendingSessionIndicators(instanceIds[i])
        if (result.status === "rejected") {
          failedInstanceIds.push(instanceIds[i])
          log.error("Foreground refresh: fetchSessions failed", { instanceId: instanceIds[i], error: result.reason })
        }
      })

      const activeInst = activeInstance()
      const activeSession = activeSessionIdForInstance()
      const hasActive = Boolean(
        activeInst?.status === "ready" && backendIdOf(activeInst) === backendId && activeInst.client && activeSession && activeSession !== "info",
      )
      const canReloadActive = hasActive && !failedInstanceIds.includes(activeInst!.id)

      // Invalidate every loaded session except the active one (force-reloaded
      // below). Snapshot the map first; invalidate mutates it via setState.
      for (const [instId, sessionSet] of messagesLoaded().entries()) {
        signal.throwIfAborted()
        if (parseInstanceKey(instId).backendId !== backendId) continue
        for (const sId of sessionSet) {
          signal.throwIfAborted()
          if (canReloadActive && instId === activeInst!.id && sId === activeSession) continue
          invalidateSessionMessageLoad(instId, sId)
        }
      }

      let activeReloadFailed = false
      if (canReloadActive) {
        signal.throwIfAborted()
        const statusBefore = getSessionStatus(activeInst!.id, activeSession!)
        try {
          let invalidateMessages = () => {}
          await withForegroundRefreshTimeout(
            loadMessages(activeInst!.id, activeSession!, {
              signal,
              force: true,
              registerInvalidation: (invalidate) => { invalidateMessages = invalidate },
            }),
            `Active-session refresh for ${activeInst!.id}:${activeSession!}`,
            () => invalidateMessages(),
            signal,
          )
        } catch (error) {
          signal.throwIfAborted()
          activeReloadFailed = true
          log.error("Foreground refresh: active session reload failed", {
            instanceId: activeInst!.id,
            sessionId: activeSession,
            error,
          })
        }
        signal.throwIfAborted()
        const statusAfter = getSessionStatus(activeInst!.id, activeSession!)
        log.info("Foreground refresh: active session reloaded", {
          instanceId: activeInst!.id,
          sessionId: activeSession,
          statusBefore,
          statusAfter,
        })
      }

      // Report failure so the hook keeps its dirty latch and retries on the
      // next reconnect instead of treating a partial recovery as success.
      if (failedInstanceIds.length > 0 || activeReloadFailed) {
        throw new Error(
          `Foreground refresh incomplete: ${failedInstanceIds.length} session-list fetch(es) failed` +
            (activeReloadFailed ? ", active session reload failed" : ""),
        )
      }
    },
  })

  const launchErrorPath = () => {
    const value = launchError()?.binaryPath
    if (!value) return "opencode2"
    return value.trim() || "opencode2"
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

  async function handleSelectFolder(folderPath: string, blankId: string | null | undefined = activeBlankTabId()): Promise<boolean> {
    if (!folderPath) {
      return false
    }

    const selectedBinary = serverSettings().opencodeBinary || "opencode2"
    const projectName = getProjectNameForFolder(folderPath)
    clearLaunchError()

    setIsSelectingFolder(true)
    try {
      const result = await createInstance(folderPath, projectName)
      recordWorkspaceLaunch(instances().get(result.instanceId)?.folder ?? folderPath, folderPath)
      if (result.reused) {
        selectInstanceTab(result.instanceId)
        replaceBlankTab(blankId ?? undefined, getInstanceAppTabId(result.instanceId))
        log.info("Selected reused instance", { instanceId: result.instanceId, folderPath })
        return true
      }

      selectInstanceTab(result.instanceId)
      replaceBlankTab(blankId ?? undefined, getInstanceAppTabId(result.instanceId))

      log.info("Created instance", {
        instanceId: result.instanceId,
        port: instances().get(result.instanceId)?.port,
      })
      return true
    } catch (error) {
      if (error instanceof WorkspaceCreationDeparture) return false
      const message = formatLaunchErrorMessage(
        error,
        t("app.launchError.fallbackMessage"),
        t("app.launchError.invalidConfig"),
        t("opencodeBinarySelector.validation.v2Required"),
      )
      const missingBinary = isMissingBinaryMessage(message)
      if (missingBinary || message.includes("opencode_update_required")) {
        openOpenCodeSetup(() => handleSelectFolder(folderPath, blankId))
        return false
      }
      showLaunchError({ source: "create", message, binaryPath: selectedBinary, missingBinary })
      log.error("Failed to create instance", error)
      return false
    } finally {
      setIsSelectingFolder(false)
    }
  }

  useDesktopFolderLaunch(handleSelectFolder)
  useDesktopConnectionLaunch()

  async function handleNewTemporaryInstance(blankId: string | null | undefined = activeBlankTabId()): Promise<void> {
    clearLaunchError()
    setIsSelectingFolder(true)
    try {
      const id = await openTemporaryInstance()
      selectInstanceTab(id)
      replaceBlankTab(blankId ?? undefined, getInstanceAppTabId(id))
    } catch (error) {
      if (error instanceof WorkspaceCreationDeparture) return
      const message = formatLaunchErrorMessage(
        error,
        t("app.launchError.fallbackMessage"),
        t("app.launchError.invalidConfig"),
        t("opencodeBinarySelector.validation.v2Required"),
      )
      const missingBinary = isMissingBinaryMessage(message)
      if (missingBinary || message.includes("opencode_update_required")) {
        openOpenCodeSetup(() => handleNewTemporaryInstance(blankId))
        return
      }
      showLaunchError({ source: "create", message, binaryPath: serverSettings().opencodeBinary || "opencode2", missingBinary })
      log.error("Failed to create temporary instance", error)
    } finally {
      setIsSelectingFolder(false)
    }
  }

  function handleSelectExistingInstance(instanceId: string, recentPath: string, blankId: string | null | undefined = activeBlankTabId()) {
    const tab = appTabs().find(tab => tab.kind === "instance" && tab.instance.id === instanceId)
    if (tab?.kind !== "instance") return
    const { instance } = tab
    recordWorkspaceLaunch(instance.folder, recentPath)
    selectInstanceTab(instanceId)
    if (blankId) closeBlankTab(blankId)
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
    openBlankTab()
  }

  const [launcherOpen, setLauncherOpen] = createSignal(false)
  const [launcherAnchor, setLauncherAnchor] = createSignal<HTMLElement>()
  createEffect(() => {
    if (mobileFullscreenMode()) setLauncherOpen(false)
  })

  async function handleOpenSidecar(sidecarId: string, blankId: string | null | undefined = activeBlankTabId()) {
    try {
      const tab = await openSidecarTab(sidecarId)
      selectSidecarTab(tab.token)
      replaceBlankTab(blankId ?? undefined, getSidecarAppTabId(tab.token))
      preferencesForBackend("local").recordSidecarRecent(sidecarId)
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
    const instanceId = disconnectedInstance()?.id
    try {
      await acknowledgeDisconnectedInstance()
      if (instanceId) detachInstanceTab(instanceId)
    } catch (error) {
      log.error("Failed to finalize disconnected instance", error)
    }
  }

  async function handleNewSession(instanceId: string) {
    await startNewSession(instanceId)
  }

  async function handleCloseSession(instanceId: string, sessionId: string) {
    const sessions = getSessions(instanceId)
    const session = sessions.find((s) => s.id === sessionId)

    if (!session) {
      return
    }

    const parentSession = getSessionRoot(instanceId, sessionId)
    if (!parentSession) return

    clearSelectedSession(instanceId)

    try {
      await fetchSessions(instanceId, { reset: true })
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

  const { commands: paletteCommands, executeCommand, executeMenuCommand } = useCommands({
    preferences,
    toggleAutoCleanupBlankSessions,
    toggleShowThinkingBlocks,
    toggleShowMessageTimeline,
    toggleUsageMetrics,
    toggleShowPromptVoiceInput,
    setDiffViewMode,
    setToolOutputExpansion,
    setDiagnosticsExpansion,
    setThinkingBlocksExpansion,
    setToolInputsVisibility,
    handleNewInstanceRequest,
    handleNewTemporaryInstance: () => handleNewTemporaryInstance(),
    handleCloseActiveTab: () => closeAppTab(activeAppTabId() ?? ""),
    handleNewSession,
    handleCloseSession,
    getActiveInstance: activeInstance,
    getActiveSessionIdForInstance: activeSessionIdForInstance,
  })

  useAppLifecycle({
    commands: paletteCommands,
    executeCommand,
    setEscapeInDebounce,
    handleNewInstanceRequest,
    handleCloseActiveTab: () => closeAppTab(activeAppTabId() ?? ""),
    handleNewSession,
    handleCloseSession,
    getActiveInstance: activeInstance,
    getActiveSessionIdForInstance: activeSessionIdForInstance,
  })

  // Native visibility actions share the shell/preferences state; other actions use palette commands.
  const executeViewMenuAction = useViewMenu(() => activeInstance()?.id)
  onMount(() => {
    onCleanup(observeDesktopUpdates())
    const executeMenuAction = (action: unknown) => {
      if (typeof action !== "string" || document.documentElement.inert) return
      if (action === "get-updates") { void requestDesktopUpdate(); return }
      if (executeViewMenuAction(action)) return
      if (action === "open-command-palette") {
        const instance = activeInstance()
        if (instance) showCommandPalette(instance.id)
        return
      }
      executeMenuCommand(action)
    }

    onCleanup(listenMenuActions(executeMenuAction))
  })

  return (
    <>
      <OpenCodeSetup automatic={automaticLocalSetup()} />
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
                 <div class="border border-base bg-surface-secondary p-4 flex-shrink-0">
                   <p class="text-xs font-medium text-muted uppercase tracking-wide mb-1">{t("app.launchError.binaryPathLabel")}</p>
                   <p class="text-sm font-mono text-primary break-all">{launchErrorPath()}</p>
                 </div>

                 <Show when={launchErrorMessage()}>
                   <div class="border border-base bg-surface-secondary p-4 flex flex-col gap-2 flex-1 min-h-0">
                     <p class="text-xs font-medium text-muted uppercase tracking-wide">{t("app.launchError.errorOutputLabel")}</p>
                     <pre class="text-sm font-mono text-primary whitespace-pre-wrap break-words overflow-auto flex-1 min-h-0">{launchErrorMessage()}</pre>
                   </div>
                 </Show>
               </div>

               <div class="flex justify-end gap-2">
                 <button
                   type="button"
                   class="selector-button selector-button-secondary"
                   onClick={handleLaunchErrorAdvanced}
                 >
                   {t("app.launchError.openAdvancedSettings")}
                 </button>
                <button type="button" class="selector-button selector-button-primary" onClick={handleLaunchErrorClose}>
                  {t("app.launchError.close")}
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>
      <AppViewport>
        <Show when={hasNativeTitlebar}>
          <NativeTitlebar title={t("window.title.main")} logo menus />
        </Show>
        <Show when={mobileFullscreenMode()}>
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
          when={appTabs().length > 0}
          fallback={
            <div class="loading-state" role="status">
              <div class="spinner" aria-hidden="true" />
              <span>{t("loadingScreen.status.loading")}</span>
            </div>
          }
        >
          <Show when={!mobileFullscreenMode()}>
            <InstanceTabs
              tabs={appTabs()}
              activeTabId={activeAppTabId()}
              onSelect={selectAppTab}
              onClose={(tabId) => void closeAppTab(tabId)}
              onNew={handleNewInstanceRequest}
              onOpenLauncher={(anchor) => {
                setLauncherAnchor(anchor)
                setLauncherOpen(true)
              }}
              launcherOpen={launcherOpen()}
              onMoveTab={moveAppTab}
            />
          </Show>

          <For each={appTabs()}>
            {(tab) => {
              const isVisible = () => activeAppTabId() === tab.id
              return tab.kind === "instance" ? (
                <div
                  class="flex-1 min-h-0 overflow-hidden"
                  style={{ display: isVisible() ? "flex" : "none" }}
                  data-instance-id={tab.instance.id}
                  data-tab-id={tab.id}
                  data-tab-session-id={activeSessionId().get(tab.instance.id) ?? undefined}
                  data-tab-kind={tab.kind}
                  data-tab-visible={isVisible() ? "true" : "false"}
                >
                  <InstanceMetadataProvider instance={tab.instance}>
                    <InstanceShell
                      instance={tab.instance}
                      isActiveInstance={isVisible()}
                      escapeInDebounce={escapeInDebounce()}
                      paletteCommands={paletteCommands}
                      onCloseSession={(sessionId) => handleCloseSession(tab.instance.id, sessionId)}
                      onNewSession={() => handleNewSession(tab.instance.id)}
                      handleSidebarAgentChange={(sessionId, agent) => handleSidebarAgentChange(tab.instance.id, sessionId, agent)}
                      handleSidebarModelChange={(sessionId, model) => handleSidebarModelChange(tab.instance.id, sessionId, model)}
                      onExecuteCommand={executeCommand}
                      tabBarOffset={mobileFullscreenMode() ? 0 : instanceTabBarHeight()}
                      mobileFullscreenMode={mobileFullscreenMode()}
                      onEnterMobileFullscreen={() => void enterMobileFullscreen()}
                      onExitMobileFullscreen={() => void exitMobileFullscreen()}
                    />
                  </InstanceMetadataProvider>
                </div>
              ) : (
                <div
                  class="flex-1 min-h-0 overflow-hidden"
                  style={{ display: isVisible() ? "flex" : "none" }}
                  data-tab-id={tab.id}
                  data-tab-kind={tab.kind}
                  data-tab-visible={isVisible() ? "true" : "false"}
                >
                  {tab.kind === "sidecar" ? <SideCarView tab={tab.sidecarTab} /> : tab.kind === "remote-restore" ? <RemoteRestoreView tab={tab} /> :
                     <FolderSelectionView initialServer={tab.server} active={isVisible()} isLoading={isSelectingFolder()}
                      onSelectFolder={path => void handleSelectFolder(path, tab.id)}
                       onSelectExistingInstance={(id, path) => handleSelectExistingInstance(id, path, tab.id)}
                      onNewTemporaryInstance={() => void handleNewTemporaryInstance(tab.id)}
                      onOpenSidecar={id => void handleOpenSidecar(id, tab.id)}
                      onJoined={() => closeBlankTab(tab.id)}
                      onRemoteOpened={id => replaceBlankTab(tab.id, getInstanceAppTabId(id))} />}
                </div>
              )
            }}
          </For>
        </Show>

        <NewInstanceLauncher
          open={launcherOpen()}
          anchor={launcherAnchor()}
          isLoading={isSelectingFolder()}
          onOpenChange={setLauncherOpen}
          onSelectFolder={(path) => void handleSelectFolder(path, null)}
          onSelectExistingInstance={(id, path) => handleSelectExistingInstance(id, path, null)}
          onNewTemporary={() => void handleNewTemporaryInstance(null)}
          onOpenSidecar={id => void handleOpenSidecar(id, null)}
        />
        <SettingsScreen />
        <AlertDialog />
        <SessionPreviewHost />
        <AuthRecoveryDialog />

        <Toaster
          position="top-right"
          gutter={16}
          toastOptions={{
            duration: 8000,
            className: "bg-transparent border-none shadow-none p-0",
          }}
        />
      </AppViewport>
    </>
  )
}


export default App

import { Component, createSignal, Show, For, onMount, onCleanup, createEffect } from "solid-js"
import { Folder, Clock, Trash2, FolderPlus, Settings, ChevronRight, MonitorUp, Star, X, Globe, Loader2, GitBranch, Pencil, Hourglass } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import { isHotkeyRecording, matchesHotkey, withHotkey } from "../lib/hotkeys"
import ProjectRenameDialog from "./project-rename-dialog"
import { useFolderDrop } from "../lib/hooks/use-folder-drop"
import VersionPill from "./version-pill"
import { DiscordSymbolIcon, GitHubMarkIcon } from "./brand-icons"
import { BrandLogo } from "./brand-logo"
import { githubStars } from "../stores/github-stars"
import { formatCompactCount } from "../lib/formatters"
import { useI18n } from "../lib/i18n"
import { showAlertDialog } from "../stores/alerts"
import { openSettings, settingsOpen } from "../stores/settings-screen"
import { openExternalUrl } from "../lib/external-url"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { getExistingInstanceForFolder } from "../stores/instances"
import { renameProject } from "../stores/project-names"
import { LocaleSelector } from "./locale-selector"
import { createNewInstanceDialogs } from "./new-instance-dialogs"
import { useRemoteServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import { formatRelativeTime, getDisplayPath, getProjectDisplayName } from "../lib/recent-folder-display"

const GITHUB_URL = "https://github.com/NeuralNomadsAI/CodeNomad"
const DISCORD_URL = "https://discord.com/channels/1391832426048651334/1458412028325793887/1464701235683917945"

type HomeTab = "local" | "servers"


interface FolderSelectionViewProps {
  onSelectFolder: (folder: string) => void
  onSelectExistingInstance: (instanceId: string, recentPath: string) => void
  /** Creates a new temporary instance; open ones come back with the restored tabs. */
  onNewTemporaryInstance?: () => void
  onOpenSidecar?: () => void
  isLoading?: boolean
  onClose?: () => void
}

const FolderSelectionView: Component<FolderSelectionViewProps> = (props) => {
  const {
    recentFolders,
    removeRecentFolder,
  } = useConfig()
  const { remoteServers, connectingServerId, saveServer, connectSavedServer, removeRemoteServerProfile } = useRemoteServerProfiles()
  const { t } = useI18n()
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [hoveredRecentActionPath, setHoveredRecentActionPath] = createSignal<string | null>(null)
  const [focusedRecentActionPath, setFocusedRecentActionPath] = createSignal<string | null>(null)
  const [focusMode, setFocusMode] = createSignal<"recent" | "new" | null>("recent")
  const [renameProjectTarget, setRenameProjectTarget] = createSignal<{ path: string; name: string; label: string } | null>(null)
  const [isRenamingProject, setIsRenamingProject] = createSignal(false)
  const [activeTab, setActiveTab] = createSignal<HomeTab>("local")
  let homeRootRef: HTMLDivElement | undefined
  let actionsColumnRef: HTMLDivElement | undefined
  let recentListRef: HTMLDivElement | undefined

  const folders = () => recentFolders()
  const serverList = () => remoteServers()
  const isLoading = () => Boolean(props.isLoading)
  const canUseRemoteServerWindows = () => canOpenRemoteWindows()

  function getActiveListLength() {
    return activeTab() === "local" ? folders().length : serverList().length
  }

  function scrollToIndex(index: number) {
    const container = recentListRef
    if (!container) return
    const element = container.querySelector(`[data-list-index="${index}"]`) as HTMLElement | null
    if (!element) return

    const containerRect = container.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()

    if (elementRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - elementRect.top
    } else if (elementRect.bottom > containerRect.bottom) {
      container.scrollTop += elementRect.bottom - containerRect.bottom
    }
  }


  function handleKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing || isHotkeyRecording()) return
    let activeElement: HTMLElement | null = null
    if (typeof document !== "undefined") {
      activeElement = document.activeElement as HTMLElement | null
    }
    const insideModal = activeElement?.closest(".modal-surface") || activeElement?.closest("[role='dialog']")
    const isEditingField =
      activeElement &&
      (["INPUT", "TEXTAREA", "SELECT"].includes(activeElement.tagName) || activeElement.isContentEditable || Boolean(insideModal))
    const isInteractiveControl = activeElement && ["BUTTON", "A"].includes(activeElement.tagName)

    if (isEditingField) {
      return
    }

    const isBrowseShortcut = matchesHotkey("browse-folder", e)
    const blockedKeys = ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", "Enter"]

    if (isLoading()) {
      if (isBrowseShortcut || blockedKeys.includes(e.key)) {
        e.preventDefault()
      }
      return
    }

    if (isBrowseShortcut) {
      e.preventDefault()
      void handleBrowse()
      return
    }

    if (isInteractiveControl && (e.key === "Enter" || e.key === " ")) return

    const listLength = getActiveListLength()
    if (listLength === 0) return

    if (e.key === "ArrowDown") {
      e.preventDefault()
      const newIndex = Math.min(selectedIndex() + 1, listLength - 1)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      const newIndex = Math.max(selectedIndex() - 1, 0)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "PageDown") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.min(selectedIndex() + pageSize, listLength - 1)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "PageUp") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.max(selectedIndex() - pageSize, 0)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "Home") {
      e.preventDefault()
      setSelectedIndex(0)
      setFocusMode("recent")
      scrollToIndex(0)
    } else if (e.key === "End") {
      e.preventDefault()
      const newIndex = listLength - 1
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "Enter") {
      e.preventDefault()
      handleEnterKey()
    }
  }


  function handleEnterKey() {
    if (isLoading()) return
    const index = selectedIndex()

    if (activeTab() === "local") {
      const folder = folders()[index]
      if (folder) {
        handleFolderSelect(folder.path)
      }
      return
    }

    const server = serverList()[index]
    if (server) {
      void connectSavedServer(server.id)
    }
  }

  createEffect(() => {
    activeTab()
    if (!canUseRemoteServerWindows() && activeTab() !== "local") {
      setActiveTab("local")
      return
    }
    setSelectedIndex(0)
    setFocusMode("recent")
  })

  createEffect(() => {
    const length = getActiveListLength()
    if (length === 0) {
      setSelectedIndex(0)
      return
    }

    if (selectedIndex() >= length) {
      setSelectedIndex(length - 1)
    }
  })


  onMount(() => {
    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown)
    })
  })

  onMount(() => {
    const syncActionsHeight = () => {
      if (!homeRootRef || !actionsColumnRef) return
      const height = actionsColumnRef.getBoundingClientRect().height
      homeRootRef.style.setProperty("--folder-home-actions-height", `${Math.ceil(height)}px`)
    }

    syncActionsHeight()
    window.addEventListener("resize", syncActionsHeight)

    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined" && actionsColumnRef) {
      observer = new ResizeObserver(syncActionsHeight)
      observer.observe(actionsColumnRef)
    }

    onCleanup(() => {
      window.removeEventListener("resize", syncActionsHeight)
      observer?.disconnect()
    })
  })

  function dropTargetBlocked() {
    return isLoading() || dialogs.isFolderBrowserOpen() || settingsOpen()
  }

  function showInvalidFolderDropAlert() {
    showAlertDialog(t("folderSelection.drop.invalidMessage"), {
      title: t("folderSelection.drop.invalidTitle"),
      variant: "warning",
    })
  }


  const folderDrop = useFolderDrop({
    enabled: () => !dropTargetBlocked(),
    onInvalidDrop: showInvalidFolderDropAlert,
    onDrop: async (paths) => {
      const firstPath = paths[0]
      if (!firstPath) {
        showInvalidFolderDropAlert()
        return
      }
      handleFolderSelect(firstPath)
    },
  })

  function handleFolderSelect(path: string) {
    if (isLoading()) return
    props.onSelectFolder(path)
  }

  function handleExistingInstanceSelect(instanceId: string, recentPath: string) {
    if (isLoading()) return
    props.onSelectExistingInstance(instanceId, recentPath)
  }

  function setRecentActionHovered(path: string, active: boolean) {
    setHoveredRecentActionPath((current) => active ? path : current === path ? null : current)
  }

  function setRecentActionFocused(path: string, active: boolean) {
    setFocusedRecentActionPath((current) => active ? path : current === path ? null : current)
  }

  function clearRecentActionState(path: string) {
    setRecentActionHovered(path, false)
    setRecentActionFocused(path, false)
  }

  const dialogs = createNewInstanceDialogs({
    defaultPath: () => folders()[0]?.path,
    isLoading,
    onSelectFolder: handleFolderSelect,
    onSaveServer: saveServer,
  })

  const openCloneDialog = () => dialogs.clone()

  function openServerDialog() {
    if (canUseRemoteServerWindows()) dialogs.addServer()
  }

  async function handleBrowse() {
    if (isLoading()) return
    setFocusMode("new")
    await dialogs.browse()
  }

  function handleRemove(path: string, e?: Event) {
    if (isLoading()) return
    e?.stopPropagation()
    removeRecentFolder(path)

    const folderList = folders()
    if (selectedIndex() >= folderList.length && folderList.length > 0) {
      setSelectedIndex(folderList.length - 1)
    }
  }

  function openProjectRename(path: string, projectName?: string, e?: Event) {
    if (isLoading()) return
    e?.stopPropagation()
    const defaultName = getProjectDisplayName(path, projectName)
    setRenameProjectTarget({ path, name: defaultName, label: defaultName })
  }

  function closeProjectRenameDialog() {
    setRenameProjectTarget(null)
  }

  async function handleProjectRenameSubmit(nextName: string) {
    const target = renameProjectTarget()
    if (!target || !nextName.trim()) return
    setIsRenamingProject(true)
    try {
      await renameProject(target.path, nextName)
      setRenameProjectTarget(null)
    } finally {
      setIsRenamingProject(false)
    }
  }


  return (
    <>
      <div
        class="folder-home-root flex w-full items-start justify-center py-6 px-4 sm:px-6 relative"
        ref={(el) => (homeRootRef = el)}
        onDragEnter={folderDrop.bind.onDragEnter}
        onDragOver={folderDrop.bind.onDragOver}
        onDragLeave={folderDrop.bind.onDragLeave}
        onDrop={folderDrop.bind.onDrop}
      >
        <div
          class="folder-home-shell w-full max-w-5xl px-4 sm:px-8 pb-2 flex flex-col"
          aria-busy={isLoading() ? "true" : "false"}
        >
          <div class="absolute top-4" style="inset-inline-start: 1.5rem;">
            <LocaleSelector />
          </div>
          <div class="absolute top-4 flex items-center gap-2" style="inset-inline-end: 1.5rem;">
            <button
              type="button"
              class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
              onClick={() => openSettings()}
              aria-label={t("settings.open.title")}
              title={t("settings.open.title")}
            >
              <Settings class="w-4 h-4" />
            </button>
            <button
              type="button"
              class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
              onClick={() => openSettings("remote")}
              aria-label={t("instanceTabs.remote.ariaLabel")}
              title={t("instanceTabs.remote.title")}
            >
              <MonitorUp class="w-4 h-4" />
            </button>
            <Show when={props.onClose}>
              <button
                type="button"
                class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
                onClick={() => props.onClose?.()}
                aria-label={t("app.launchError.close")}
                title={t("app.launchError.closeTitle")}
              >
                <X class="w-4 h-4" />
              </button>
            </Show>
          </div>
          <div class="folder-home-hero text-center shrink-0">
            <div class="mb-3 flex justify-center">
              <BrandLogo alt={t("folderSelection.logoAlt")} class="folder-home-logo" />
            </div>
            <h1 class="mb-2 text-3xl font-semibold text-primary">CodeNomad</h1>
            <div class="mt-3 flex justify-center gap-2">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
                aria-label={t("folderSelection.links.github")}
                title={t("folderSelection.links.github")}
                onClick={(event) => {
                  event.preventDefault()
                  void openExternalUrl(GITHUB_URL, "folder-selection")
                }}
              >
                <GitHubMarkIcon class="w-4 h-4" />
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                class="selector-button selector-button-secondary w-auto px-3 py-1.5 inline-flex items-center justify-center gap-1.5"
                aria-label={t("folderSelection.links.githubStars")}
                title={githubStars() !== null ? `${t("folderSelection.links.githubStars")}: ${githubStars()!.toLocaleString()}` : t("folderSelection.links.githubStars")}
                onClick={(event) => {
                  event.preventDefault()
                  void openExternalUrl(GITHUB_URL, "folder-selection")
                }}
              >
                <Star class="w-4 h-4" />
                <Show when={githubStars() !== null}>
                  <span class="text-xs font-medium">{formatCompactCount(githubStars()!)}</span>
                </Show>
              </a>
              <a
                href={DISCORD_URL}
                target="_blank"
                rel="noreferrer"
                class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
                aria-label={t("folderSelection.links.discord")}
                title={t("folderSelection.links.discord")}
                onClick={(event) => {
                  event.preventDefault()
                  void openExternalUrl(DISCORD_URL, "folder-selection")
                }}
              >
                <DiscordSymbolIcon class="w-4 h-4" />
              </a>
            </div>
          </div>

          <div class="folder-home-content flex-1 min-h-0 flex flex-col gap-4">
            <div class="folder-home-main flex-1 gap-4">
              {/* Right column: recent folders */}
              <div class="folder-home-list-column order-1 lg:order-2 flex flex-col gap-4 flex-1 min-h-0">
                <div class="folder-home-list-panel panel flex flex-col flex-1">
                  <div class="panel-header !gap-0 !p-0">
                    <div class={`grid ${canUseRemoteServerWindows() ? "grid-cols-2" : "grid-cols-1"} gap-0 overflow-hidden border border-base`}>
                      <button
                        type="button"
                        class="border-r border-base px-4 py-3 text-left transition-colors"
                        classList={{
                          "text-primary": activeTab() === "local",
                          "text-muted hover:text-secondary": activeTab() !== "local",
                        }}
                        style={{
                          "background-color": "var(--surface-secondary)",
                        }}
                        onClick={() => setActiveTab("local")}
                      >
                        <div
                          class="panel-title text-base"
                          style={{
                            color: activeTab() === "local" ? "var(--text-primary)" : "var(--text-secondary)",
                          }}
                        >
                          {t("folderSelection.recent.title")}
                        </div>
                        <p
                          class="panel-subtitle mt-1"
                          style={{
                            color: activeTab() === "local" ? "var(--text-muted)" : "var(--text-secondary)",
                          }}
                        >
                          {t(
                            folders().length === 1
                              ? "folderSelection.recent.subtitle.one"
                              : "folderSelection.recent.subtitle.other",
                            { count: folders().length },
                          )}
                        </p>
                      </button>
                      <Show when={canUseRemoteServerWindows()}>
                        <button
                          type="button"
                          class="px-4 py-3 text-left transition-colors"
                          classList={{
                            "text-primary": activeTab() === "servers",
                            "text-muted hover:text-secondary": activeTab() !== "servers",
                          }}
                          style={{
                            "background-color": "var(--surface-secondary)",
                          }}
                          onClick={() => setActiveTab("servers")}
                        >
                          <div
                            class="panel-title text-base"
                            style={{
                              color: activeTab() === "servers" ? "var(--text-primary)" : "var(--text-secondary)",
                            }}
                          >
                            {t("folderSelection.tabs.servers")}
                          </div>
                          <p
                            class="panel-subtitle mt-1"
                            style={{
                              color: activeTab() === "servers" ? "var(--text-muted)" : "var(--text-secondary)",
                            }}
                          >
                            {t("folderSelection.servers.count", { count: remoteServers().length })}
                          </p>
                        </button>
                      </Show>
                    </div>
                  </div>

                  <Show
                    when={activeTab() === "local"}
                    fallback={
                      <Show
                        when={canUseRemoteServerWindows() && remoteServers().length > 0}
                        fallback={
                          <Show when={canUseRemoteServerWindows()}>
                            <div class="panel-empty-state flex-1">
                              <div class="panel-empty-state-icon">
                                <Globe class="w-12 h-12 mx-auto" />
                              </div>
                              <p class="panel-empty-state-title">{t("folderSelection.servers.empty.title")}</p>
                              <p class="panel-empty-state-description">{t("folderSelection.servers.empty.description")}</p>
                              <button
                                type="button"
                                class="button-primary mt-4 w-auto self-center inline-flex items-center justify-center gap-2 px-4"
                                onClick={openServerDialog}
                              >
                                <Globe class="w-4 h-4" />
                                <span>{t("folderSelection.actions.connectButton")}</span>
                              </button>
                            </div>
                          </Show>
                        }
                      >
                        <div
                          class="panel-list panel-list--fill flex-1 min-h-0 overflow-auto"
                          ref={(el) => (recentListRef = el)}
                        >
                          <For each={remoteServers()}>
                            {(server, index) => (
                              <div
                                class="panel-list-item"
                                classList={{
                                  "panel-list-item-highlight": focusMode() === "recent" && selectedIndex() === index(),
                                }}
                              >
                                <div class="flex items-center gap-2 w-full px-1">
                                  <button
                                    data-list-index={index()}
                                    class="panel-list-item-content flex-1"
                                    onClick={() => void connectSavedServer(server.id)}
                                    onMouseEnter={() => {
                                      setFocusMode("recent")
                                      setSelectedIndex(index())
                                    }}
                                  >
                                    <div class="flex items-center justify-between gap-3 w-full">
                                      <div class="flex-1 min-w-0 text-left">
                                        <div class="flex items-center gap-2 mb-1">
                                          <Globe class="w-4 h-4 flex-shrink-0 icon-muted" />
                                          <span class="text-sm font-medium truncate text-primary">{server.name}</span>
                                        </div>
                                        <div class="flex items-center gap-2 pl-6 text-xs text-muted min-w-0">
                                          <span class="font-mono truncate-start flex-1 min-w-0">{server.baseUrl}</span>
                                        </div>
                                      </div>
                                      <Show when={connectingServerId() === server.id}>
                                        <Loader2 class="w-4 h-4 animate-spin icon-muted" />
                                      </Show>
                                    </div>
                                  </button>
                                  <button
                                    onClick={() => removeRemoteServerProfile(server.id)}
                                    class="p-2 transition-all hover:bg-red-100 dark:hover:bg-red-900/30 opacity-70 hover:opacity-100"
                                    title={`${t("folderSelection.servers.remove")}: ${server.name}`}
                                    aria-label={`${t("folderSelection.servers.remove")}: ${server.name}`}
                                  >
                                    <Trash2 class="w-3.5 h-3.5 transition-colors icon-muted hover:text-red-600 dark:hover:text-red-400" />
                                  </button>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    }
                  >
                    <Show
                      when={folders().length > 0}
                      fallback={
                        <div class="panel-empty-state flex-1">
                          <div class="panel-empty-state-icon">
                            <Clock class="w-12 h-12 mx-auto" />
                          </div>
                          <p class="panel-empty-state-title">{t("folderSelection.empty.title")}</p>
                          <p class="panel-empty-state-description">{t("folderSelection.empty.description")}</p>
                        </div>
                      }
                    >
                      <div
                        class="panel-list panel-list--fill flex-1 min-h-0 overflow-auto"
                        ref={(el) => (recentListRef = el)}
                      >
                        <For each={folders()}>
                          {(folder, index) => {
                            const existingInstance = () => getExistingInstanceForFolder(folder.path)
                            const projectName = () => getProjectDisplayName(folder.path, folder.projectName)
                            const projectLabelId = () => `recent-folder-${index()}-name`
                            const openActionLabelId = () => `recent-folder-${index()}-open-action`

                            return <div
                              class="panel-list-item folder-home-recent-item"
                              classList={{
                                "panel-list-item-highlight": focusMode() === "recent" && selectedIndex() === index(),
                                "panel-list-item-disabled": isLoading(),
                                "folder-home-recent-item-action-active":
                                  hoveredRecentActionPath() === folder.path || focusedRecentActionPath() === folder.path,
                              }}
                              onMouseEnter={() => {
                                if (isLoading()) return
                                setFocusMode("recent")
                                setSelectedIndex(index())
                              }}
                            >
                              <div class="flex items-center gap-2 w-full px-1">
                                <div class="panel-list-item-content relative flex-1">
                                  <button
                                    data-list-index={index()}
                                    type="button"
                                    class="folder-home-recent-primary-action"
                                    disabled={isLoading()}
                                    aria-labelledby={projectLabelId()}
                                    onClick={() => handleFolderSelect(folder.path)}
                                    onFocus={() => {
                                      setFocusMode("recent")
                                      setSelectedIndex(index())
                                    }}
                                  />
                                  <div class="relative z-[1] pointer-events-none flex items-center justify-between gap-3 w-full">
                                    <div class="flex-1 min-w-0">
                                      <div class="flex items-center gap-2 mb-1">
                                        <Folder class="w-4 h-4 flex-shrink-0 icon-muted" />
                                        <span id={projectLabelId()} class="text-sm font-medium truncate text-primary">
                                          {projectName()}
                                        </span>
                                        <Show when={existingInstance()}>
                                          {(instance) => {
                                            let ownsHoverState = false
                                            let ownsFocusState = false
                                            onCleanup(() => {
                                              if (ownsHoverState) setRecentActionHovered(folder.path, false)
                                              if (ownsFocusState) setRecentActionFocused(folder.path, false)
                                            })
                                            return (
                                              <button
                                                type="button"
                                                class="folder-home-open-instance-button folder-home-row-action pointer-events-auto"
                                                disabled={isLoading()}
                                                aria-labelledby={`${openActionLabelId()} ${projectLabelId()}`}
                                                title={t("folderSelection.recent.switchToOpenProject")}
                                                onClick={() => handleExistingInstanceSelect(instance().id, folder.path)}
                                                onMouseEnter={() => {
                                                  ownsHoverState = true
                                                  setRecentActionHovered(folder.path, true)
                                                }}
                                                onMouseLeave={() => {
                                                  ownsHoverState = false
                                                  setRecentActionHovered(folder.path, false)
                                                }}
                                                onFocus={() => {
                                                  ownsFocusState = true
                                                  setRecentActionFocused(folder.path, true)
                                                }}
                                                onBlur={() => {
                                                  ownsFocusState = false
                                                  setRecentActionFocused(folder.path, false)
                                                }}
                                              >
                                                <span id={openActionLabelId()}>{t("folderSelection.recent.openBadge")}</span>
                                              </button>
                                            )
                                          }}
                                        </Show>
                                      </div>
                                      <div class="flex items-center gap-2 pl-6 text-xs text-muted min-w-0">
                                        <span class="font-mono truncate-start flex-1 min-w-0">
                                          {getDisplayPath(folder.path)}
                                        </span>
                                        <span class="flex-shrink-0">{formatRelativeTime(t, folder.lastAccessed)}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <button
                                  onClick={(e) => openProjectRename(folder.path, folder.projectName, e)}
                                  disabled={isLoading()}
                                  class="folder-home-row-action p-2 transition-all hover:bg-surface-hover opacity-70 hover:opacity-100"
                                  title={t("folderSelection.recent.rename")}
                                  onMouseEnter={() => setRecentActionHovered(folder.path, true)}
                                  onMouseLeave={() => setRecentActionHovered(folder.path, false)}
                                  onFocus={() => setRecentActionFocused(folder.path, true)}
                                  onBlur={() => setRecentActionFocused(folder.path, false)}
                                >
                                  <Pencil class="w-3.5 h-3.5 transition-colors icon-muted" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    clearRecentActionState(folder.path)
                                    handleRemove(folder.path, e)
                                  }}
                                  disabled={isLoading()}
                                  class="folder-home-row-action p-2 transition-all hover:bg-red-100 dark:hover:bg-red-900/30 opacity-70 hover:opacity-100"
                                  title={t("folderSelection.recent.remove")}
                                  onMouseEnter={() => setRecentActionHovered(folder.path, true)}
                                  onMouseLeave={() => setRecentActionHovered(folder.path, false)}
                                  onFocus={() => setRecentActionFocused(folder.path, true)}
                                  onBlur={() => setRecentActionFocused(folder.path, false)}
                                >
                                  <Trash2 class="w-3.5 h-3.5 transition-colors icon-muted hover:text-red-600 dark:hover:text-red-400" />
                                </button>
                              </div>
                            </div>
                          }}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </div>

              </div>

              {/* Left column: version + browse + advanced settings */}
              <div
                class="folder-home-actions-column order-2 lg:order-1 flex flex-col gap-4 flex-1"
                ref={(el) => (actionsColumnRef = el)}
              >
              <div class="panel shrink-0">
                <div class="panel-body flex flex-col gap-3">
                  <button
                    onClick={() => void handleBrowse()}
                    disabled={props.isLoading}
                    title={withHotkey(t("folderSelection.browse.button"), "browse-folder")}
                    class="button-primary w-full flex items-center justify-center text-sm disabled:cursor-not-allowed"
                    onMouseEnter={() => setFocusMode("new")}
                  >
                    <div class="flex items-center gap-2">
                      <FolderPlus class="w-4 h-4" />
                      <span>
                        {props.isLoading
                          ? t("folderSelection.browse.buttonOpening")
                          : t("folderSelection.browse.button")}
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={openCloneDialog}
                    disabled={props.isLoading}
                    class="button-primary w-full flex items-center justify-center text-sm disabled:cursor-not-allowed"
                  >
                    <div class="flex items-center gap-2">
                      <GitBranch class="w-4 h-4" />
                      <span>{t("folderSelection.clone.button")}</span>
                    </div>
                  </button>

                  <Show when={props.onNewTemporaryInstance}>
                    <button
                      type="button"
                      onClick={() => props.onNewTemporaryInstance?.()}
                      disabled={props.isLoading}
                      title={t("folderSelection.temporary.description")}
                      class="button-primary w-full flex items-center justify-center text-sm disabled:cursor-not-allowed"
                    >
                      <div class="flex items-center gap-2">
                        <Hourglass class="w-4 h-4" />
                        <span>{t("folderSelection.temporary.button")}</span>
                      </div>
                    </button>
                  </Show>

                  <button
                    type="button"
                    onClick={() => props.onOpenSidecar?.()}
                    class="button-primary w-full flex items-center justify-center text-sm"
                  >
                    <div class="flex items-center gap-2">
                      <MonitorUp class="w-4 h-4" />
                      <span>{t("folderSelection.sidecars.button")}</span>
                    </div>
                  </button>

                  <Show when={canUseRemoteServerWindows()}>
                    <button
                      onClick={openServerDialog}
                      class="button-primary w-full flex items-center justify-center text-sm"
                    >
                      <div class="flex items-center gap-2">
                        <Globe class="w-4 h-4" />
                        <span>{t("folderSelection.actions.connectButton")}</span>
                      </div>
                    </button>
                  </Show>
                </div>

                {/* OpenCode settings section */}
                <div class="panel-section w-full">
                  <button onClick={() => openSettings("opencode")} class="panel-section-header w-full justify-between">
                    <div class="flex items-center gap-2">
                      <Settings class="w-4 h-4 icon-muted" />
                      <span class="text-sm font-medium text-secondary">{t("folderSelection.opencode")}</span>
                    </div>
                    <ChevronRight class="w-4 h-4 icon-muted" />
                  </button>
                </div>
              </div>

              <div class="panel shrink-0">
                <div class="panel-body flex items-center justify-center">
                  <VersionPill />
                </div>
              </div>
            </div>

            </div>

          </div>
        </div>
        <Show when={isLoading()}>
          <div class="folder-loading-overlay">
            <div class="folder-loading-indicator">
              <div class="spinner" />
              <p class="folder-loading-text">{t("folderSelection.loading.title")}</p>
              <p class="folder-loading-subtext">{t("folderSelection.loading.subtitle")}</p>
            </div>
          </div>
        </Show>
        <Show when={folderDrop.isSupported && folderDrop.isActive() && !dropTargetBlocked()}>
          <div class="folder-drop-overlay" aria-hidden="true">
            <div class="folder-drop-card">
              <FolderPlus class="w-8 h-8 icon-muted" />
              <p class="folder-drop-title">{t("folderSelection.drop.title")}</p>
              <p class="folder-drop-subtext">{t("folderSelection.drop.subtitle")}</p>
            </div>
          </div>
        </Show>
      </div>

      <ProjectRenameDialog
        open={Boolean(renameProjectTarget())}
        currentName={renameProjectTarget()?.name ?? ""}
        projectLabel={renameProjectTarget()?.label}
        isSubmitting={isRenamingProject()}
        onRename={handleProjectRenameSubmit}
        onClose={closeProjectRenameDialog}
      />

      <dialogs.Dialogs />
    </>
  )
}

export default FolderSelectionView

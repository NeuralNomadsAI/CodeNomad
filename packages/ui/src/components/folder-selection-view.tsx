import { Component, createMemo, createSignal, createUniqueId, Show, For, onMount, onCleanup, createEffect, on } from "solid-js"
import { Trash2, FolderPlus, Settings, ChevronRight, MonitorUp, Star, X, Pencil } from "lucide-solid"
import { removeRemoteProjectRecent, removeSideCarRecent, useConfig } from "../stores/preferences"
import { launchableRecents, openRemoteProject, opensRemoteProjectTab } from "../stores/remote-project-open"
import type { RemoteServerProfile } from "../../../server/src/api-types"
import { useRemoteServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import { embeddedProjectUrl } from "../lib/embed-mode"
import { serverDisplayName } from "../lib/codenomad-link"
import { captureRequestFocus } from "../lib/request-focus"
import { recentKey, type LaunchableRecent } from "../lib/remote-project-recents"
import BrowseMenu, { browseEntryCount } from "./browse-menu"
import EntryCount from "./entry-count"
import RemoteRecentSession from "./remote-recent-session"
import ActionOverflowMenu from "./action-overflow-menu"
import { joinRecentOpenTarget, recentAccessibleName, recentOpenTarget } from "../lib/recent-open-target"
import { ensureSidecarsLoaded } from "../stores/sidecars"
import { helpUrl } from "../lib/help-url"
import { Heart } from "lucide-solid"
import NewTabActions from "./new-tab-actions"
import RecentTabIcon from "./recent-tab-icon"
import { openSidecar } from "../stores/sidecar-open"
import { isHotkeyRecording, matchesHotkey } from "../lib/hotkeys"
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
import { renameProject } from "../stores/project-names"
import { LocaleSelector } from "./locale-selector"
import { createNewInstanceDialogs } from "./new-instance-dialogs"
import { formatRelativeTime, getDisplayPath, getProjectDisplayName } from "../lib/recent-folder-display"

const GITHUB_URL = "https://github.com/NeuralNomadsAI/CodeNomad"
const DISCORD_URL = "https://discord.com/channels/1391832426048651334/1458412028325793887/1464701235683917945"

interface FolderSelectionViewProps {
  onSelectFolder: (folder: string) => void
  onSelectExistingInstance: (instanceId: string, recentPath: string) => void
  /** Creates a new temporary instance; open ones come back with the restored tabs. */
  onNewTemporaryInstance?: () => void
  isLoading?: boolean
  onClose?: () => void
  blank?: boolean
  active?: boolean
}

const FolderSelectionView: Component<FolderSelectionViewProps> = (props) => {
  const { removeRecentFolder } = useConfig()
  const { t, locale } = useI18n()
  const { openServer, remoteServers } = useRemoteServerProfiles()
  const [remoteSource, setRemoteSource] = createSignal<{ profile: RemoteServerProfile; recents: LaunchableRecent[]; available: boolean }>()
  const viewId = createUniqueId()
  const tabId = (tab: string) => `folder-home-tab-${viewId}-${tab}`
  const panelId = (tab: string) => `folder-home-panel-${viewId}-${tab}`
  onMount(() => void ensureSidecarsLoaded())
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [connectingRecent, setConnectingRecent] = createSignal<string>()
  createEffect(on([() => props.active, remoteSource], () => setConnectingRecent(undefined), { defer: true }))
  const [hoveredRecentActionPath, setHoveredRecentActionPath] = createSignal<string | null>(null)
  const [focusedRecentActionPath, setFocusedRecentActionPath] = createSignal<string | null>(null)
  const [focusMode, setFocusMode] = createSignal<"recent" | "new" | null>(null)
  const [renameProjectTarget, setRenameProjectTarget] = createSignal<{ path: string; name: string; label: string } | null>(null)
  const [isRenamingProject, setIsRenamingProject] = createSignal(false)
  // The canonical selector shared by Home and blank tabs.
  const [homeTab, setHomeTab] = createSignal<"recent" | "browse">("recent")
  let homeRootRef: HTMLDivElement | undefined
  let recentListRef: HTMLDivElement | undefined
  createEffect(on(() => props.blank && props.active !== false, (active) => {
    if (!active) return
    setHomeTab(allRecents().length ? "recent" : "browse")
    const focus = captureRequestFocus()
    let cancelled = false
    onCleanup(() => { cancelled = true; focus.dispose() })
    // The initial SideCar read can replace recent rows; focus their settled DOM.
    void ensureSidecarsLoaded().then(() => requestAnimationFrame(() => {
      if (!cancelled && props.active !== false && focus.retained()) homeRootRef?.querySelector<HTMLElement>('[data-list-index="0"], [data-browse-nav]')?.focus()
      focus.dispose()
    }))
  }))

  // This computer's folders, the remote projects this window reopens and SideCars, newest first.
  const allRecents = () => remoteSource()?.recents ?? launchableRecents()
  const recentsAvailable = () => !remoteSource() || remoteSource()!.available
  const folders = allRecents
  const isLoading = () => Boolean(props.isLoading)

  function getActiveListLength() {
    return props.blank || homeTab() === "recent" ? folders().length : 0
  }

  function scrollToIndex(index: number) {
    const container = recentListRef
    if (!container) return
    const element = container.querySelector(`[data-list-index="${index}"]`) as HTMLElement | null
    if (!element) return

    element.focus()
    element.scrollIntoView({ block: "nearest" })
  }


  function handleKeyDown(e: KeyboardEvent) {
    if (props.active === false || e.defaultPrevented || e.isComposing || isHotkeyRecording()) return
    let activeElement: HTMLElement | null = null
    if (typeof document !== "undefined") {
      activeElement = document.activeElement as HTMLElement | null
    }
    if (activeElement && activeElement !== document.body && !homeRootRef?.contains(activeElement)) return
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
      const newIndex = (selectedIndex() + 1) % listLength
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      const newIndex = (selectedIndex() - 1 + listLength) % listLength
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
    const folder = folders()[selectedIndex()]
    if (folder) openRecent(folder)
  }

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

  onMount(() => { if (!allRecents().length) setHomeTab("browse") })

  function dropTargetBlocked() {
    return props.active === false || isLoading() || dialogs.isFolderBrowserOpen() || settingsOpen()
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

  function openRecent(folder: LaunchableRecent) {
    if (isLoading()) return
    if (folder.sidecar) void openSidecar(folder.sidecar.sidecarId)
    else if (folder.remote) {
      const profile = remoteSource()?.profile
      if (profile && !opensRemoteProjectTab(profile)) openServer(profile, embeddedProjectUrl(profile.baseUrl, folder.path))
      else setConnectingRecent(recentKey(folder))
    }
    else handleFolderSelect(folder.path)
  }

  function handleTabKeyDown(event: KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    const next = homeTab() === "recent" ? "browse" : "recent"
    const target = event.key === "Home" ? "recent" : event.key === "End" ? "browse" : next
    setHomeTab(target)
    homeRootRef?.querySelector<HTMLElement>(`[data-home-tab="${target}"]`)?.focus()
  }

  function setRecentActionHovered(path: string, active: boolean) {
    setHoveredRecentActionPath((current) => active ? path : current === path ? null : current)
  }

  function setRecentActionFocused(path: string, active: boolean) {
    setFocusedRecentActionPath((current) => active ? path : current === path ? null : current)
  }

  const dialogs = createNewInstanceDialogs({
    defaultPath: () => launchableRecents().find((folder) => !folder.remote && !folder.sidecar)?.path,
    isLoading,
    onSelectFolder: handleFolderSelect,
  })

  const openCloneDialog = () => dialogs.clone()

  async function handleBrowse() {
    if (isLoading()) return
    setFocusMode("new")
    await dialogs.browse()
  }

  function handleRemove(folder: LaunchableRecent, e?: Event) {
    if (isLoading() || remoteSource()) return
    e?.stopPropagation()
    if (folder.sidecar) removeSideCarRecent(folder.sidecar.sidecarId)
    else if (folder.remote) removeRemoteProjectRecent(folder.remote.profileId, folder.path)
    else removeRecentFolder(folder.path)

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
        classList={{ "folder-home-root--blank": props.blank }}
        ref={(el) => (homeRootRef = el)}
        onDragEnter={folderDrop.bind.onDragEnter}
        onDragOver={folderDrop.bind.onDragOver}
        onDragLeave={folderDrop.bind.onDragLeave}
        onDrop={folderDrop.bind.onDrop}
        onPointerMove={() => setFocusMode(null)}
        onKeyDown={(event) => { if (event.key === "Tab") setFocusMode("recent") }}
      >
        <div
           class="folder-home-shell w-full pb-2 flex flex-col"
          aria-busy={isLoading() ? "true" : "false"}
        >
          <Show when={!props.blank}>
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
          </Show>
          <div class="folder-home-hero text-center shrink-0">
            <div class="folder-home-identity">
              <div class="mb-3 flex justify-center"><BrandLogo alt={t("folderSelection.logoAlt")} class={props.blank ? "folder-home-logo empty-state-logo" : "folder-home-logo"} /></div>
              <h1 class="mb-2 text-3xl font-semibold text-primary" classList={{ "empty-state-brand-title": props.blank }}>CodeNomad</h1>
            </div>
            <Show when={!props.blank}>
            <div class="mt-3 flex justify-center gap-2">
              <a href={helpUrl(locale(), "sponsor")} class="selector-button selector-button-secondary w-auto px-3 py-1.5 inline-flex items-center justify-center gap-1.5"
                onClick={(event) => { event.preventDefault(); void openExternalUrl(helpUrl(locale(), "sponsor"), "help").then((opened) => {
                  if (!opened) showAlertDialog(t("commands.openSponsor.failed", { url: helpUrl(locale(), "sponsor") }), { variant: "warning" })
                }) }}>
                <Heart class="w-4 h-4" aria-hidden="true" /><span>{t("newTab.sponsor")}</span>
              </a>
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
            </Show>
          </div>

          <div class="folder-home-content flex-1 min-h-0 flex flex-col gap-4">
            <Show when={props.blank}>
              <div class="folder-home-blank-actions">
                <NewTabActions blank isLoading={isLoading()} onClone={openCloneDialog} onNewTemporary={props.onNewTemporaryInstance} hideSidecar />
              </div>
            </Show>
            <div class="folder-home-main flex-1 gap-4">
              <Show when={!props.blank}>
                <div class="folder-home-create-column flex flex-col gap-4">
                  <div class="panel shrink-0">
                    <div class="folder-home-creation-actions panel-body flex flex-col gap-3">
                      <NewTabActions home isLoading={isLoading()} onClone={openCloneDialog} onNewTemporary={props.onNewTemporaryInstance} />
                    </div>
                    <div class="panel-section w-full">
                      <button type="button" onClick={() => openSettings("opencode")} class="panel-section-header w-full justify-between">
                        <div class="flex items-center gap-2"><Settings class="w-4 h-4 icon-muted" aria-hidden="true" /><span class="text-sm font-medium text-secondary">{t("folderSelection.opencode")}</span></div><ChevronRight class="w-4 h-4 icon-muted" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <div class="panel shrink-0"><div class="panel-body flex items-center justify-center"><VersionPill /></div></div>
                </div>
              </Show>
              <div class="folder-home-list-column flex flex-col gap-4 flex-1 min-h-0">
                <div class="folder-home-list-panel panel flex flex-col" classList={{ "window-shell": props.blank }}>
                  <div class="panel-header !gap-0 !p-0">
                    <Show when={props.blank}><div class="px-4 py-3"><h2 class="panel-title text-base">{t("newInstanceLauncher.recentTitle")}</h2><Show when={recentsAvailable()}><EntryCount count={allRecents().length} /></Show></div></Show>
                    <Show when={!props.blank}>
                    <div class="grid grid-cols-2 gap-0 overflow-hidden border border-base" role="tablist" onKeyDown={handleTabKeyDown}>
                      <For each={["recent", "browse"] as const}>
                        {(tab) => (
                          <button
                            type="button"
                            role="tab"
                            aria-label={t(tab === "recent" ? "newInstanceLauncher.recentTitle" : "folderSelection.browseMenu.title")}
                            aria-description={tab === "recent" && !recentsAvailable() ? undefined : t((tab === "recent" ? allRecents().length : browseEntryCount()) === 1 ? "newTab.items.one" : "newTab.items.other", { count: tab === "recent" ? allRecents().length : browseEntryCount() })}
                            id={tabId(tab)}
                            data-home-tab={tab}
                            aria-selected={homeTab() === tab}
                            aria-controls={panelId(tab)}
                            tabIndex={homeTab() === tab ? 0 : -1}
                            class="folder-home-header-tab px-4 py-3 text-left transition-colors"
                            classList={{ "border-r border-base": tab === "recent" }}
                            style={{ "background-color": homeTab() === tab ? "var(--surface-secondary)" : "var(--surface-control)" }}
                            onClick={() => setHomeTab(tab)}
                          >
                            <span class="panel-title text-base" style={{ color: homeTab() === tab ? "var(--text-primary)" : "var(--text-secondary)" }}>
                              {t(tab === "recent" ? "newInstanceLauncher.recentTitle" : "folderSelection.browseMenu.title")}
                            </span>
                            <Show when={tab !== "recent" || recentsAvailable()}><EntryCount count={tab === "recent" ? allRecents().length : browseEntryCount()} /></Show>
                          </button>
                        )}
                      </For>
                    </div>
                    </Show>
                  </div>

                  <Show when={!props.blank}>
                    <div id={panelId("browse")} role="tabpanel" aria-labelledby={tabId("browse")} class="flex flex-col flex-1 min-h-0" hidden={homeTab() !== "browse"} style={{ display: homeTab() === "browse" ? undefined : "none" }}>
                      <BrowseMenu isLoading={isLoading()} active={props.active !== false && homeTab() === "browse"} onSourceChange={setRemoteSource} onBrowseLocal={() => void handleBrowse()} />
                    </div>
                  </Show>

                  <Show when={props.blank || homeTab() === "recent"}>
                  <div id={panelId("recent")} role={props.blank ? "region" : "tabpanel"} aria-label={props.blank ? t("newInstanceLauncher.recentTitle") : undefined} aria-labelledby={props.blank ? undefined : tabId("recent")} class="flex flex-col flex-1 min-h-0">
                  <Show when={remoteSource()}>{(source) => <bdi class="px-4 py-2 text-sm text-secondary truncate" dir="auto">{serverDisplayName(source().profile, remoteServers())}</bdi>}</Show>
                  <Show
                      when={folders().length > 0}
                      fallback={
                        <Show when={!remoteSource()} fallback={<Show when={recentsAvailable()}><p class="new-instance-launcher-empty" role="status">{t("newInstanceLauncher.empty")}</p></Show>}>
                        <Show when={allRecents().length > 0} fallback={
                          <button type="button" class="window-text-button" onClick={() => setHomeTab("browse")}>{t("folderSelection.browseMenu.title")}</button>
                        }>
                          <p class="new-instance-launcher-empty" role="status">{t("newInstanceLauncher.noMatch")}</p>
                        </Show>
                        </Show>
                      }
                    >
                      <div
                         class="panel-list panel-list--fill flex-1 min-h-0 overflow-auto"
                         role="list"
                         id={`recent-folders-${viewId}`}
                        ref={(el) => (recentListRef = el)}
                      >
                        <For each={folders()}>
                          {(folder, index) => {
                            const key = recentKey(folder)
                            const existingInstance = () => recentOpenTarget(folder)
                            const projectName = () => getProjectDisplayName(folder.path, folder.projectName)
                            const projectLabelId = () => `recent-folder-${viewId}-${index()}-name`
                            const actions = createMemo(() => [
                              ...(!folder.remote && !folder.sidecar ? [{ key: "rename", label: t("folderSelection.recent.rename"),
                                icon: <Pencil class="w-3.5 h-3.5" />, disabled: isLoading(), onSelect: () => openProjectRename(folder.path, folder.projectName) }] : []),
                              { key: "remove", label: t("folderSelection.recent.remove"), icon: <Trash2 class="w-3.5 h-3.5" />,
                                disabled: isLoading(), onSelect: () => handleRemove(folder) },
                            ])

                            return <div
                              class="panel-list-item folder-home-recent-item"
                              role="listitem"
                              classList={{
                                "panel-list-item-highlight": focusMode() === "recent" && selectedIndex() === index(),
                                "panel-list-item-disabled": isLoading(),
                                "folder-home-recent-item-action-active":
                                  hoveredRecentActionPath() === key || focusedRecentActionPath() === key,
                              }}
                              data-remote-server={folder.remote?.profileId}
                              data-sidecar={folder.sidecar?.sidecarId}
                              onMouseEnter={() => {
                                if (isLoading()) return
                                setFocusMode(null)
                                setSelectedIndex(index())
                              }}
                            >
                              <Show when={connectingRecent() === key && folder.remote} fallback={
                              <div class="flex items-center gap-2 w-full px-1">
                                <div class="panel-list-item-content relative flex-1">
                                  <button
                                    data-list-index={index()}
                                    type="button"
                                    class="folder-home-recent-primary-action"
                                    disabled={isLoading()}
                                    aria-label={recentAccessibleName(folder)}
                                    title={recentAccessibleName(folder)}
                                    onClick={() => openRecent(folder)}
                                    onFocus={() => {
                                      setSelectedIndex(index())
                                    }}
                                  />
                                  <div class="relative z-[1] pointer-events-none flex items-center justify-between gap-3 w-full">
                                    <div class="flex-1 min-w-0">
                                      <div class="flex items-center gap-2 mb-1">
                                        <RecentTabIcon recent={folder} class="w-4 h-4 flex-shrink-0 icon-muted" />
                                        <span id={projectLabelId()} class="text-sm font-medium truncate text-primary">
                                          {projectName()}
                                        </span>
                                        <Show when={existingInstance()}>
                                          {(_target) => {
                                            let ownsHoverState = false
                                            let ownsFocusState = false
                                            onCleanup(() => {
                                              if (ownsHoverState) setRecentActionHovered(key, false)
                                              if (ownsFocusState) setRecentActionFocused(key, false)
                                            })
                                            return (
                                              <button
                                                type="button"
                                                class="folder-home-open-instance-button folder-home-row-action pointer-events-auto"
                                                disabled={isLoading()}
                                                aria-label={`${t("folderSelection.recent.switchToOpenProject")} · ${recentAccessibleName(folder)}`}
                                                title={t("folderSelection.recent.switchToOpenProject")}
                                                onClick={() => { if (!isLoading()) joinRecentOpenTarget(folder, props.onSelectExistingInstance) }}
                                                onMouseEnter={() => {
                                                  ownsHoverState = true
                                                  setRecentActionHovered(key, true)
                                                }}
                                                onMouseLeave={() => {
                                                  ownsHoverState = false
                                                  setRecentActionHovered(key, false)
                                                }}
                                                onFocus={() => {
                                                  ownsFocusState = true
                                                  setRecentActionFocused(key, true)
                                                }}
                                                onBlur={() => {
                                                  ownsFocusState = false
                                                  setRecentActionFocused(key, false)
                                                }}
                                              >
                                                <span>{t("folderSelection.recent.openBadge")}</span>
                                              </button>
                                            )
                                          }}
                                        </Show>
                                      </div>
                                      <div class="flex items-center gap-2 pl-6 text-xs text-muted min-w-0">
                                        <Show when={folder.remote}>
                                          {(remote) => <bdi class="flex-shrink-0 truncate" dir="auto" style={{ "max-width": "40%" }}>{remote().serverName}</bdi>}
                                        </Show>
                                        <Show when={remoteSource() && !opensRemoteProjectTab(remoteSource()!.profile)}><span>{t("remoteBrowse.openSeparateWindow")}</span></Show>
                                        <Show when={props.blank && !folder.remote && !folder.sidecar}><span class="truncate">{t("folderSelection.browseMenu.thisComputer")} ·</span></Show>
                                        <Show when={!folder.sidecar} fallback={<span class="flex-1 min-w-0 truncate">{t("folderSelection.recent.sidecar")}</span>}>
                                          <span class="font-mono truncate-start flex-1 min-w-0" dir="ltr">
                                            {getDisplayPath(folder.path)}
                                          </span>
                                        </Show>
                                        <span class="flex-shrink-0">{formatRelativeTime(t, folder.lastAccessed)}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <Show when={!remoteSource()}><Show when={props.blank} fallback={
                                  <>
                                    <Show when={!folder.remote && !folder.sidecar}>
                                      <button type="button" class="folder-home-row-action p-2 transition-all hover:bg-surface-hover opacity-70 hover:opacity-100"
                                        disabled={isLoading()} title={t("folderSelection.recent.rename")}
                                        onClick={(event) => openProjectRename(folder.path, folder.projectName, event)}
                                        onMouseEnter={() => setRecentActionHovered(key, true)} onMouseLeave={() => setRecentActionHovered(key, false)}
                                        onFocus={() => setRecentActionFocused(key, true)} onBlur={() => setRecentActionFocused(key, false)}>
                                        <Pencil class="w-3.5 h-3.5 icon-muted" />
                                      </button>
                                    </Show>
                                    <button type="button" class="folder-home-row-action p-2 transition-all hover:bg-surface-hover opacity-70 hover:opacity-100"
                                      disabled={isLoading()} title={t("folderSelection.recent.remove")}
                                      onClick={(event) => { setRecentActionHovered(key, false); setRecentActionFocused(key, false); handleRemove(folder, event) }}
                                      onMouseEnter={() => setRecentActionHovered(key, true)} onMouseLeave={() => setRecentActionHovered(key, false)}
                                      onFocus={() => setRecentActionFocused(key, true)} onBlur={() => setRecentActionFocused(key, false)}>
                                      <Trash2 class="w-3.5 h-3.5 icon-muted" />
                                    </button>
                                  </>
                                }>
                                  <ActionOverflowMenu items={actions()} label={`${t("folderSelection.recent.actions")} · ${recentAccessibleName(folder)}`}
                                    onOpenChange={(open) => setRecentActionFocused(key, open)} />
                                </Show>
                                </Show>
                              </div>}>
                                <RemoteRecentSession profileId={folder.remote!.profileId} active={props.active !== false}
                                  onBack={() => { setConnectingRecent(undefined); queueMicrotask(() => scrollToIndex(index())) }}
                                  onReady={() => { setConnectingRecent(undefined); openRemoteProject(folder.remote!.profileId, { folder: folder.path }) }} />
                              </Show>
                            </div>
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                  </Show>
                </div>

              </div>

              <Show when={props.blank}>
                <div class="folder-dashboard-servers panel window-shell flex flex-col min-w-0">
                  <header class="panel-header !px-4 !py-3"><h2 class="panel-title text-base">{t("folderSelection.browseMenu.title")}</h2><EntryCount count={browseEntryCount()} /></header>
                  <BrowseMenu isLoading={isLoading()} active={props.active !== false} onSourceChange={setRemoteSource} onBrowseLocal={() => void handleBrowse()} pinAddField />
                </div>
              </Show>
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

import { Component, createMemo, createSignal, Show, For, onMount, onCleanup, createEffect, on } from "solid-js"
import { Trash2, FolderPlus, Star, Pencil, Laptop, Server, Heart, Hourglass, GitBranch } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import type { RemoteServerBrowseResponse, RemoteServerProfile } from "../../../server/src/api-types"
import { sameServerSelection, type ServerSelectionIntent } from "../lib/native/server-selection-intent"
import { qualifiedServerDisplayName } from "../lib/codenomad-link"
import { captureRequestFocus } from "../lib/request-focus"
import BrowseMenu, { createBrowseEntryCount } from "./browse-menu"
import EntryCount from "./entry-count"
import RemoteRecentSession from "./remote-recent-session"
import ActionOverflowMenu from "./action-overflow-menu"
import { Tooltip } from "@kobalte/core/tooltip"
import { joinRecentOpenTarget, recentAccessibleName, recentOpenElsewhere, recentOpenTarget, launchableRecents, type LaunchableRecent } from "../lib/recent-open-target"
import RecentOpenElsewhere, { RecentOpenElsewhereTooltip } from "./recent-open-elsewhere"
import { helpUrl } from "../lib/help-url"
import RecentTabIcon from "./recent-tab-icon"
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
import { settingsOpen } from "../stores/settings-screen"
import { openExternalUrl } from "../lib/external-url"
import { browsedRemoteRecents, remoteRecentProjectsUsable, removeRecentProject, renameRecentProject, type RecentProject, type RemoteRecentProject } from "../stores/recent-projects"
import { renameProject } from "../stores/project-names"
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
  initialServer?: ServerSelectionIntent
  active?: boolean
  onOpenSidecar?: (id: string) => void
  onJoined?: () => void
  onRemoteOpened?: (instanceId: string) => void
}

const FolderSelectionView: Component<FolderSelectionViewProps> = (props) => {
  const { remoteServers } = useConfig()
  const { t, locale } = useI18n()
  const [remoteSource, setRemoteSource] = createSignal<{ profile: RemoteServerProfile; listing?: RemoteServerBrowseResponse }>()
  const browseEntryCount = createBrowseEntryCount()
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [connectingRecent, setConnectingRecent] = createSignal<RemoteRecentProject>()
  const [hoveredRecentActionPath, setHoveredRecentActionPath] = createSignal<string | null>(null)
  const [focusedRecentActionPath, setFocusedRecentActionPath] = createSignal<string | null>(null)
  const [highlightRecent, setHighlightRecent] = createSignal(false)
  const [renameProjectTarget, setRenameProjectTarget] = createSignal<{ recent: RecentProject; name: string } | null>(null)
  const [isRenamingProject, setIsRenamingProject] = createSignal(false)
  const sourcePolicy = createMemo(() => remoteSource()?.profile, undefined, {
    equals: (a, b) => a === b || !!a && !!b && sameServerSelection(a, b),
  })
  createEffect(on([() => props.active, sourcePolicy], () => setConnectingRecent(undefined), { defer: true }))
  createEffect(() => { if (!remoteRecentProjectsUsable()) setConnectingRecent(undefined) })
  let rootRef: HTMLDivElement | undefined
  let recentListRef: HTMLDivElement | undefined
  let releaseBrowseHeight: (() => void) | undefined
  onCleanup(() => releaseBrowseHeight?.())

  function holdBrowseHeight(event: PointerEvent & { currentTarget: HTMLElement }) {
    if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element)
      || !event.target.closest(".browse-menu-footer button[type=submit]:enabled")) return
    const panel = event.currentTarget
    const grid = panel.parentElement
    if (!grid || !matchMedia("(max-width: 639px)").matches) return
    releaseBrowseHeight?.()
    // Keep native hit testing stable while async rows change either stacked panel.
    grid.style.setProperty("--folder-home-pressed-browse-height", `${panel.getBoundingClientRect().height}px`)
    const listeners = new AbortController()
    const options = { capture: true, signal: listeners.signal }
    let clickDeadline: number | undefined
    const release = releaseBrowseHeight = () => {
      window.clearTimeout(clickDeadline)
      listeners.abort()
      grid.style.removeProperty("--folder-home-pressed-browse-height")
      releaseBrowseHeight = undefined
    }
    const finish = (end: PointerEvent) => {
      if (end.pointerId !== event.pointerId) return
      if (end.type === "pointercancel" || event.pointerType === "mouse") return release()
      // Touch hit-tests the synthesized click after pointerup. A non-clicking release still unpins.
      window.addEventListener("click", click => {
        if (click.isTrusted && click.detail > 0 && (!(click instanceof PointerEvent) || click.pointerId === event.pointerId)) release()
      }, options)
      clickDeadline = window.setTimeout(release, 400)
    }
    window.addEventListener("pointerup", finish, options)
    window.addEventListener("pointercancel", finish, options)
    window.addEventListener("blur", release, { signal: listeners.signal })
  }

  createEffect(on(() => props.active === true, (active) => {
    if (!active) return
    const focus = captureRequestFocus()
    let cancelled = false
    onCleanup(() => { cancelled = true; focus.dispose() })
    requestAnimationFrame(() => {
      if (!cancelled && props.active && focus.retained()) {
        const first = rootRef?.querySelector<HTMLElement>('[data-list-index="0"]') ?? rootRef?.querySelector<HTMLElement>("[data-browse-nav]")
        first?.focus({ preventScroll: true })
      }
      focus.dispose()
    })
  }))

  // This computer's folders, the remote projects this window reopens and SideCars, newest first.
  const allRecents = createMemo<readonly LaunchableRecent[]>(() => {
    const source = remoteSource()
    const rows = source ? browsedRemoteRecents(source.profile, source.listing?.recents ?? []) : launchableRecents()
    const opening = connectingRecent()
    // The row owns the request until selection; a refreshed timestamp must not replace it.
    return opening ? rows.map(row => row.kind === "remote" && row.key === opening.key && sameServerSelection(row.policy, opening.policy) ? opening : row) : rows
  })
  const recentsAvailable = () => !remoteSource() || !!remoteSource()?.listing
  const folders = allRecents
  const isLoading = () => Boolean(props.isLoading)

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
    if (activeElement && activeElement !== document.body && !rootRef?.contains(activeElement)) return
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
    if (activeElement?.closest(".browse-menu, [data-remote-view-session]")) return

    const listLength = folders().length
    if (listLength === 0) return

    if (e.key === "ArrowDown") {
      e.preventDefault()
      const newIndex = (selectedIndex() + 1) % listLength
      setSelectedIndex(newIndex)
      setHighlightRecent(true)
      scrollToIndex(newIndex)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      const newIndex = (selectedIndex() - 1 + listLength) % listLength
      setSelectedIndex(newIndex)
      setHighlightRecent(true)
      scrollToIndex(newIndex)
    } else if (e.key === "PageDown") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.min(selectedIndex() + pageSize, listLength - 1)
      setSelectedIndex(newIndex)
      setHighlightRecent(true)
      scrollToIndex(newIndex)
    } else if (e.key === "PageUp") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.max(selectedIndex() - pageSize, 0)
      setSelectedIndex(newIndex)
      setHighlightRecent(true)
      scrollToIndex(newIndex)
    } else if (e.key === "Home") {
      e.preventDefault()
      setSelectedIndex(0)
      setHighlightRecent(true)
      scrollToIndex(0)
    } else if (e.key === "End") {
      e.preventDefault()
      const newIndex = listLength - 1
      setSelectedIndex(newIndex)
      setHighlightRecent(true)
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
    const length = folders().length
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
    if (folder.kind === "sidecar") props.onOpenSidecar?.(folder.path)
    else if (folder.kind === "remote") setConnectingRecent(folder)
    else handleFolderSelect(folder.path)
  }

  function setRecentActionHovered(path: string, active: boolean) {
    setHoveredRecentActionPath((current) => active ? path : current === path ? null : current)
  }

  function setRecentActionFocused(path: string, active: boolean) {
    setFocusedRecentActionPath((current) => active ? path : current === path ? null : current)
  }

  const dialogs = createNewInstanceDialogs({
    defaultPath: () => launchableRecents().find(folder => folder.kind === "local")?.path,
    isLoading,
    onSelectFolder: handleFolderSelect,
  })

  const RecentSource = () => <span class="folder-home-recent-source flex items-center justify-end gap-2 min-w-0 text-sm text-secondary">
    <Show when={remoteSource()} fallback={
      <span role="img" aria-label={t("folderSelection.browseMenu.thisComputer")} title={t("folderSelection.browseMenu.thisComputer")}>
        <Laptop class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
      </span>
    }>{(source) => <>
      <Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
      <bdi class="truncate" dir="auto" title={qualifiedServerDisplayName(source().profile, remoteServers())}>{qualifiedServerDisplayName(source().profile, remoteServers())}</bdi>
    </>}</Show>
  </span>

  async function handleBrowse() {
    if (isLoading()) return
    setHighlightRecent(false)
    await dialogs.browse()
  }

  function handleRemove(folder: LaunchableRecent) {
    if (isLoading() || remoteSource() || folder.kind === "sidecar") return
    void removeRecentProject(folder).catch(() => showAlertDialog(t("settings.preferenceSaveFailed"), { variant: "warning" }))

    const folderList = folders()
    if (selectedIndex() >= folderList.length && folderList.length > 0) {
      setSelectedIndex(folderList.length - 1)
    }
  }

  function openProjectRename(recent: LaunchableRecent) {
    if (isLoading()) return
    if (recent.kind === "sidecar") return
    setRenameProjectTarget({ recent, name: getProjectDisplayName(recent.path, recent.projectName) })
  }

  function closeProjectRenameDialog() {
    setRenameProjectTarget(null)
  }

  async function handleProjectRenameSubmit(nextName: string) {
    const target = renameProjectTarget()
    if (!target || !nextName.trim()) return
    setIsRenamingProject(true)
    try {
      if (target.recent.kind === "remote") await renameRecentProject(target.recent, nextName)
      else await renameProject(target.recent.path, nextName)
      setRenameProjectTarget(null)
    } catch {
      showAlertDialog(t("settings.preferenceSaveFailed"), { variant: "warning" })
    } finally {
      setIsRenamingProject(false)
    }
  }


  return (
    <>
      <div
        class="folder-home-root w-full px-4 sm:px-6 relative"
        ref={(el) => (rootRef = el)}
        onDragEnter={folderDrop.bind.onDragEnter}
        onDragOver={folderDrop.bind.onDragOver}
        onDragLeave={folderDrop.bind.onDragLeave}
        onDrop={folderDrop.bind.onDrop}
        onPointerMove={() => setHighlightRecent(false)}
        onKeyDown={(event) => { if (event.key === "Tab") setHighlightRecent(true) }}
      >
        <div
          class="folder-home-shell w-full mx-auto flex flex-col"
          aria-busy={isLoading() ? "true" : "false"}
        >
          <div class="folder-home-actions window-shell flex justify-between gap-2">
            <Show when={props.onNewTemporaryInstance}>
              <button type="button" class="window-action" disabled={isLoading()}
                title={t("folderSelection.temporary.description")} onClick={() => props.onNewTemporaryInstance?.()}>
                <Hourglass class="w-4 h-4 shrink-0" aria-hidden="true" /><span>{t("newTab.temporary")}</span>
              </button>
            </Show>
            <button type="button" class="window-action" disabled={isLoading()} onClick={() => dialogs.clone()}>
              <GitBranch class="w-4 h-4 shrink-0" aria-hidden="true" /><span>{t("folderSelection.clone.button")}</span>
            </button>
          </div>
          <div class="folder-home-hero text-center shrink-0">
            <div class="mb-3 flex justify-center"><BrandLogo alt={t("folderSelection.logoAlt")} class="folder-home-logo" /></div>
            <h1 class="mb-2 text-3xl font-semibold text-primary">CodeNomad</h1>
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
          </div>

          <div class="folder-home-main flex-1 gap-4">
            <section class="folder-dashboard-servers panel window-shell flex flex-col min-w-0" aria-label={t("folderSelection.browseMenu.title")} onPointerDown={holdBrowseHeight}>
              <header class="panel-header !px-4 !py-3"><h2 class="panel-title text-base">{t("folderSelection.browseMenu.title")}</h2><EntryCount count={browseEntryCount()} /></header>
              <BrowseMenu initialServer={props.initialServer} isLoading={isLoading()} active={props.active !== false} onSourceChange={setRemoteSource} onBrowseLocal={() => void handleBrowse()}
                onOpenSidecar={id => props.onOpenSidecar?.(id)} onJoined={props.onJoined} onRemoteOpened={props.onRemoteOpened} />
            </section>
            <section class="panel window-shell flex flex-col min-w-0" aria-label={t("newInstanceLauncher.recentTitle")}>
              <header class="panel-header !gap-0 !p-0">
                <div class="flex items-center justify-between gap-2 min-w-0 w-full px-4 py-3">
                  <div class="shrink-0"><h2 class="panel-title text-base">{t("newInstanceLauncher.recentTitle")}</h2><Show when={recentsAvailable()}><EntryCount count={allRecents().length} /></Show></div>
                  <RecentSource />
                </div>
              </header>
              <Show
                  when={folders().length > 0}
                  fallback={
                    <Show when={recentsAvailable()}>
                      <p class="new-instance-launcher-empty" role="status">{t("newInstanceLauncher.empty")}</p>
                    </Show>
                  }
                >
                  <div
                     class="panel-list panel-list--fill flex-1 min-h-0 overflow-auto"
                     role="list"
                    ref={(el) => (recentListRef = el)}
                  >
                    <For each={folders()}>
                      {(folder, index) => {
                        const key = folder.key
                        const existingInstance = () => recentOpenTarget(folder)
                        const elsewhere = () => recentOpenElsewhere(folder) ? t("folderSelection.recent.openElsewhere") : undefined
                        const projectName = () => getProjectDisplayName(folder.path, folder.projectName)
                        const actions = createMemo(() => [
                          ...(folder.kind === "sidecar" ? [] : [
                            { key: "rename", label: t("folderSelection.recent.rename"), icon: <Pencil class="w-3.5 h-3.5" />, disabled: isLoading(), onSelect: () => openProjectRename(folder) },
                            { key: "remove", label: t("folderSelection.recent.remove"), icon: <Trash2 class="w-3.5 h-3.5" />, disabled: isLoading(), onSelect: () => handleRemove(folder) },
                          ]),
                        ])

                        return <div
                          class="panel-list-item folder-home-recent-item"
                          role="listitem"
                          classList={{
                            "panel-list-item-highlight": highlightRecent() && selectedIndex() === index(),
                            "panel-list-item-disabled": isLoading(),
                            "folder-home-recent-item-action-active":
                              hoveredRecentActionPath() === key || focusedRecentActionPath() === key,
                          }}
                          data-remote-server={folder.kind === "remote" ? folder.backendId : undefined}
                          data-sidecar={folder.kind === "sidecar" ? folder.path : undefined}
                          onMouseEnter={() => {
                            if (isLoading()) return
                            setHighlightRecent(false)
                            setSelectedIndex(index())
                          }}
                        >
                          <Show when={folder.kind === "remote" && connectingRecent() === folder ? folder : undefined} keyed fallback={
                          <div class="flex items-center gap-2 w-full px-1">
                            <div class="panel-list-item-content relative flex-1">
                              <RecentOpenElsewhereTooltip label={elsewhere()}>
                                <Tooltip.Trigger as="button"
                                  data-list-index={index()}
                                  type="button"
                                  class="folder-home-recent-primary-action"
                                  disabled={isLoading()}
                                  aria-label={recentAccessibleName(folder)}
                                  aria-description={elsewhere()}
                                  title={elsewhere() ? undefined : recentAccessibleName(folder)}
                                  onClick={() => openRecent(folder)}
                                  onFocus={() => {
                                    setSelectedIndex(index())
                                  }}
                                />
                              </RecentOpenElsewhereTooltip>
                              <div class="relative z-[1] pointer-events-none flex items-center justify-between gap-3 w-full">
                                <div class="flex-1 min-w-0">
                                  <div class="flex items-center gap-2 mb-1">
                                    <RecentTabIcon recent={folder} class="w-4 h-4 flex-shrink-0 icon-muted" />
                                    <span class="text-sm font-medium truncate text-primary">
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
                                            onClick={() => { if (!isLoading() && joinRecentOpenTarget(folder, props.onSelectExistingInstance)) props.onJoined?.() }}
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
                                    <Show when={folder.kind === "remote" ? folder.serverLabel : undefined}>
                                      {(name) => <bdi class="flex-shrink-0 truncate" dir="auto" style={{ "max-width": "40%" }}>{name()}</bdi>}
                                    </Show>
                                    <Show when={folder.kind === "local"}><span class="truncate">{t("folderSelection.browseMenu.thisComputer")} ·</span></Show>
                                    <Show when={folder.kind !== "sidecar"} fallback={<span class="flex-1 min-w-0 truncate">{t("folderSelection.recent.sidecar")}</span>}>
                                      <span class="font-mono truncate-start flex-1 min-w-0" dir="ltr">
                                        {getDisplayPath(folder.path)}
                                      </span>
                                    </Show>
                                    <span class="flex-shrink-0">{formatRelativeTime(t, folder.lastAccessed)}</span>
                                  </div>
                                </div>
                                <RecentOpenElsewhere label={elsewhere()} />
                              </div>
                            </div>
                            <Show when={!remoteSource() && folder.kind !== "sidecar"}>
                            <ActionOverflowMenu items={actions()} triggerClass="window-icon-button" label={`${t("folderSelection.recent.actions")} · ${recentAccessibleName(folder)}`}
                                onOpenChange={(open) => setRecentActionFocused(key, open)} />
                            </Show>
                          </div>}>
                            {target => <RemoteRecentSession recent={target} active={props.active !== false}
                              onBack={() => { setConnectingRecent(undefined); queueMicrotask(() => scrollToIndex(index())) }}
                              onOpened={id => { setConnectingRecent(undefined); props.onRemoteOpened?.(id) }} />}
                          </Show>
                        </div>
                      }}
                    </For>
                  </div>
                </Show>
            </section>
          </div>
          <div class="text-center shrink-0"><VersionPill /></div>
        </div>
        <Show when={isLoading()}>
          <div class="folder-loading-overlay">
            <div class="folder-loading-indicator">
              <div class="spinner" />
              <p class="folder-loading-text">{t("folderSelection.loading.title")}</p>
            </div>
          </div>
        </Show>
        <Show when={folderDrop.isSupported && folderDrop.isActive() && !dropTargetBlocked()}>
          <div class="folder-drop-overlay" aria-hidden="true">
            <div class="folder-drop-card">
              <FolderPlus class="w-8 h-8 icon-muted" />
              <p class="folder-drop-title">{t("folderSelection.drop.title")}</p>
            </div>
          </div>
        </Show>
      </div>

      <ProjectRenameDialog
        open={Boolean(renameProjectTarget())}
        currentName={renameProjectTarget()?.name ?? ""}
        projectLabel={renameProjectTarget()?.name}
        isSubmitting={isRenamingProject()}
        onRename={handleProjectRenameSubmit}
        onClose={closeProjectRenameDialog}
      />

      <dialogs.Dialogs />
    </>
  )
}

export default FolderSelectionView

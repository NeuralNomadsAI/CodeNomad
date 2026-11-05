import { Popover } from "@kobalte/core/popover"
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { Search } from "lucide-solid"
import { createNewInstanceDialogs } from "./new-instance-dialogs"
import BrowseMenu from "./browse-menu"
import NewTabActions from "./new-tab-actions"
import RecentTabIcon from "./recent-tab-icon"
import { useI18n } from "../lib/i18n"
import { filterRecents, formatRelativeTime, getDisplayPath, getProjectDisplayName } from "../lib/recent-folder-display"
import { openSidecar } from "../stores/sidecar-open"
import type { LaunchableRecent } from "../lib/remote-project-recents"
import { getExistingInstanceForFolder } from "../stores/instances"
import { launchableRecents, openRemoteProject, openRemoteProjectTabFor } from "../stores/remote-project-open"

interface NewInstanceLauncherProps {
  open: boolean
  /** The new-instance button the popup is anchored to. */
  anchor?: HTMLElement
  isLoading: boolean
  onOpenChange: (open: boolean) => void
  onSelectFolder: (path: string) => void
  onSelectExistingInstance: (instanceId: string, recentPath: string) => void
  onNewTemporaryInstance: () => void
}

/**
 * Compact launcher opened by a long press, right-click or Alt+Down on the
 * new-instance button, the home page's logic in short: recent tabs first
 * (projects, remote projects and SideCars; type to filter, Enter to open), the
 * folded Browse section, then the creation buttons. Managing recents stays on
 * the full home page, servers and SideCars in Settings.
 */
export default function NewInstanceLauncher(props: NewInstanceLauncherProps) {
  const { t } = useI18n()
  const [query, setQuery] = createSignal("")
  const [activeIndex, setActiveIndex] = createSignal(0)
  let listRef: HTMLDivElement | undefined
  const recentFolders = () => launchableRecents()

  const dialogs = createNewInstanceDialogs({
    defaultPath: () => recentFolders().find((folder) => !folder.remote && !folder.sidecar)?.path,
    isLoading: () => props.isLoading,
    onSelectFolder: (path) => props.onSelectFolder(path),
  })

  const matches = createMemo(() => filterRecents(recentFolders(), query()))

  // Only Escape returns focus to the button: actions, outside clicks, other
  // windows and the home page all hand it elsewhere.
  let returnFocus = false
  let contentRef: HTMLDivElement | undefined

  // Each opening starts from an empty filter on the most recent project.
  createEffect(on(() => props.open, (open) => {
    if (!open) return
    setQuery("")
    setActiveIndex(0)
    returnFocus = false
  }))
  createEffect(on(matches, () => setActiveIndex(0), { defer: true }))
  // Keep the highlighted project visible, including after the filter changes.
  createEffect(on([activeIndex, matches], ([index]) => {
    listRef?.querySelector(`[data-launcher-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
  }))

  const close = () => props.onOpenChange(false)
  // Close first so the launched flow (dialog, tab, home page) owns focus.
  const run = (action: () => void) => {
    if (props.isLoading) return
    close()
    action()
  }

  const isOpen = (folder: LaunchableRecent) =>
    folder.sidecar ? false
      : folder.remote ? Boolean(openRemoteProjectTabFor(folder)) : Boolean(getExistingInstanceForFolder(folder.path))

  function openRecent(folder: LaunchableRecent) {
    const sidecar = folder.sidecar
    if (sidecar) return run(() => void openSidecar(sidecar.sidecarId))
    const remote = folder.remote
    if (remote) return run(() => openRemoteProject(remote.profileId, { folder: folder.path }))
    const existing = getExistingInstanceForFolder(folder.path)
    run(() => existing ? props.onSelectExistingInstance(existing.id, folder.path) : props.onSelectFolder(folder.path))
  }

  function moveActive(delta: number) {
    const count = matches().length
    if (!count) return
    setActiveIndex((activeIndex() + delta + count) % count)
  }

  function handleSearchKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") { event.preventDefault(); moveActive(1) }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveActive(-1) }
    else if (event.key === "Enter") {
      const folder = matches()[activeIndex()]
      if (folder) { event.preventDefault(); openRecent(folder) }
    }
  }

  const optionId = (index: number) => `new-instance-launcher-option-${index}`

  return (
    <>
      <Popover
        open={props.open}
        onOpenChange={props.onOpenChange}
        anchorRef={() => props.anchor}
        placement="bottom-start"
        gutter={6}
      >
        <Popover.Portal>
          <Popover.Content class="window-shell new-instance-launcher" aria-busy={props.isLoading}
            ref={contentRef}
            onEscapeKeyDown={() => { returnFocus = true }}
            onCloseAutoFocus={(event) => {
              // The popup has an anchor, not a Kobalte trigger: restore focus ourselves,
              // unless another surface has taken it meanwhile.
              event.preventDefault()
              const active = document.activeElement
              const unclaimed = !active || active === document.body || Boolean(contentRef?.contains(active))
              if (returnFocus && unclaimed) props.anchor?.focus()
              returnFocus = false
            }}>
            <header class="window-header">
              <Popover.Title class="window-title">{t("newInstanceLauncher.title")}</Popover.Title>
            </header>
            <Popover.Description class="sr-only">{t("newInstanceLauncher.description")}</Popover.Description>

            <div class="window-toolbar new-instance-launcher-search">
              <Search class="w-4 h-4 icon-muted" aria-hidden="true" />
              <input
                type="text"
                class="new-instance-launcher-search-input"
                role="combobox"
                aria-expanded="true"
                aria-controls="new-instance-launcher-recents"
                aria-activedescendant={matches().length ? optionId(activeIndex()) : undefined}
                aria-label={t("newInstanceLauncher.searchLabel")}
                placeholder={t("newInstanceLauncher.searchPlaceholder")}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={handleSearchKeyDown}
              />
            </div>

            <div class="new-instance-launcher-section-title" id="new-instance-launcher-recents-title">
              {t("folderSelection.recentTabs.title")}
            </div>
            <div
              class="window-body new-instance-launcher-recents"
              id="new-instance-launcher-recents"
              role="listbox"
              aria-labelledby="new-instance-launcher-recents-title"
              ref={listRef}
            >
              <For
                each={matches()}
                fallback={<p class="new-instance-launcher-empty">
                  {t(recentFolders().length ? "newInstanceLauncher.noMatch" : "newInstanceLauncher.empty")}
                </p>}
              >
                {(folder, index) => {
                  const existing = () => isOpen(folder)
                  return (
                    <div
                      id={optionId(index())}
                      class="new-instance-launcher-recent"
                      role="option"
                      aria-selected={index() === activeIndex()}
                      aria-disabled={props.isLoading}
                      data-launcher-index={index()}
                      data-open={existing() ? "true" : undefined}
                      title={folder.path}
                      onMouseMove={() => setActiveIndex(index())}
                      onClick={() => openRecent(folder)}
                    >
                      <RecentTabIcon recent={folder} class="w-4 h-4 icon-muted shrink-0" />
                      <span class="new-instance-launcher-recent-name">{getProjectDisplayName(folder.path, folder.projectName)}</span>
                      <span class="new-instance-launcher-recent-path" dir="ltr">
                        {folder.sidecar ? t("folderSelection.recent.sidecar")
                          : folder.remote ? `${folder.remote.serverName} · ${getDisplayPath(folder.path)}` : getDisplayPath(folder.path)}
                      </span>
                      <Show
                        when={existing()}
                        fallback={<span class="new-instance-launcher-recent-meta">{formatRelativeTime(t, folder.lastAccessed)}</span>}
                      >
                        <span class="new-instance-launcher-recent-meta new-instance-launcher-recent-open">
                          <span class="status-dot" aria-hidden="true" />
                          {t("newInstanceLauncher.openBadge")}
                        </span>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>

            <BrowseMenu isLoading={props.isLoading} onRun={close} onBrowseLocal={() => void dialogs.browse()} />
            <div class="new-instance-launcher-actions">
              <NewTabActions variant="launcher" isLoading={props.isLoading} onRun={close}
                onClone={dialogs.clone} onNewTemporary={props.onNewTemporaryInstance} />
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
      <dialogs.Dialogs />
    </>
  )
}

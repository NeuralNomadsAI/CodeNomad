import { Popover } from "@kobalte/core/popover"
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { ChevronRight, Folder, FolderPlus, GitBranch, Globe, Home, Hourglass, MonitorUp, Plus, Search } from "lucide-solid"
import { createNewInstanceDialogs } from "./new-instance-dialogs"
import { useI18n } from "../lib/i18n"
import { useRemoteServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import { formatRelativeTime, getDisplayPath, getProjectDisplayName } from "../lib/recent-folder-display"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { getExistingInstanceForFolder } from "../stores/instances"
import { useConfig } from "../stores/preferences"

interface NewInstanceLauncherProps {
  open: boolean
  /** The new-instance button the popup is anchored to. */
  anchor?: HTMLElement
  isLoading: boolean
  onOpenChange: (open: boolean) => void
  onSelectFolder: (path: string) => void
  onSelectExistingInstance: (instanceId: string, recentPath: string) => void
  onNewTemporaryInstance: () => void
  onOpenSidecar?: () => void
  onOpenHome: () => void
}

/**
 * Compact launcher opened by a long press, right-click or Alt+Down on the
 * new-instance button: recent projects first (type to filter, Enter to open),
 * then creation actions, then secondary destinations. Management (rename,
 * remove, settings) stays on the full home page.
 */
export default function NewInstanceLauncher(props: NewInstanceLauncherProps) {
  const { t } = useI18n()
  const { recentFolders } = useConfig()
  const { remoteServers, saveServer, connectSavedServer } = useRemoteServerProfiles()
  const [query, setQuery] = createSignal("")
  const [activeIndex, setActiveIndex] = createSignal(0)
  const [serversExpanded, setServersExpanded] = createSignal(false)
  let listRef: HTMLDivElement | undefined

  const dialogs = createNewInstanceDialogs({
    defaultPath: () => recentFolders()[0]?.path,
    isLoading: () => props.isLoading,
    onSelectFolder: (path) => props.onSelectFolder(path),
    onSaveServer: saveServer,
  })

  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase()
    const folders = recentFolders()
    if (!needle) return folders
    return folders.filter((folder) =>
      getProjectDisplayName(folder.path, folder.projectName).toLowerCase().includes(needle)
      || folder.path.toLowerCase().includes(needle))
  })

  // Only Escape returns focus to the button: actions, outside clicks, other
  // windows and the home page all hand it elsewhere.
  let returnFocus = false
  let contentRef: HTMLDivElement | undefined

  // Each opening starts from an empty filter on the most recent project.
  createEffect(on(() => props.open, (open) => {
    if (!open) return
    setQuery("")
    setActiveIndex(0)
    setServersExpanded(false)
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

  function openRecent(path: string) {
    const existing = getExistingInstanceForFolder(path)
    run(() => existing ? props.onSelectExistingInstance(existing.id, path) : props.onSelectFolder(path))
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
      if (folder) { event.preventDefault(); openRecent(folder.path) }
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
              if (returnFocus && unclaimed) props.anchor?.focus({ preventScroll: true })
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
              {t("newInstanceLauncher.recentTitle")}
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
                  const existing = () => getExistingInstanceForFolder(folder.path)
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
                      onClick={() => openRecent(folder.path)}
                    >
                      <Folder class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                      <span class="new-instance-launcher-recent-name">{getProjectDisplayName(folder.path, folder.projectName)}</span>
                      <span class="new-instance-launcher-recent-path" dir="ltr">{getDisplayPath(folder.path)}</span>
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

            <div class="new-instance-launcher-actions">
              <button type="button" class="window-action" disabled={props.isLoading} onClick={() => run(() => void dialogs.browse())}>
                <FolderPlus class="w-4 h-4" aria-hidden="true" />
                <span>{t("newInstanceLauncher.browse")}</span>
              </button>
              <button type="button" class="window-action" disabled={props.isLoading} onClick={() => run(props.onNewTemporaryInstance)}>
                <Hourglass class="w-4 h-4" aria-hidden="true" />
                <span>{t("newInstanceLauncher.temporary")}</span>
              </button>
              <button type="button" class="window-action" disabled={props.isLoading} onClick={() => run(dialogs.clone)}>
                <GitBranch class="w-4 h-4" aria-hidden="true" />
                <span>{t("newInstanceLauncher.clone")}</span>
              </button>
            </div>

            <Show when={serversExpanded()}>
              <div class="new-instance-launcher-servers" role="group" aria-label={t("newInstanceLauncher.servers")}>
                <For each={remoteServers()}>
                  {(server) => (
                    <button type="button" class="new-instance-launcher-server" title={server.baseUrl} disabled={props.isLoading}
                      onClick={() => run(() => void connectSavedServer(server.id))}>
                      <Globe class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                      <span class="new-instance-launcher-recent-name">{server.name}</span>
                    </button>
                  )}
                </For>
                <button type="button" class="new-instance-launcher-server" disabled={props.isLoading} onClick={() => run(dialogs.addServer)}>
                  <Plus class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                  <span class="new-instance-launcher-recent-name">{t("newInstanceLauncher.addServer")}</span>
                </button>
              </div>
            </Show>

            <footer class="window-footer new-instance-launcher-footer">
              <Show when={canOpenRemoteWindows()}>
                <button type="button" class="window-action" disabled={props.isLoading} aria-expanded={serversExpanded()}
                  onClick={() => setServersExpanded((value) => !value)}>
                  <Globe class="w-4 h-4" aria-hidden="true" />
                  <span>{t("newInstanceLauncher.servers")}</span>
                  <ChevronRight class="disclosure-chevron w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </Show>
              <Show when={props.onOpenSidecar}>
                <button type="button" class="window-action" disabled={props.isLoading} onClick={() => run(() => props.onOpenSidecar?.())}>
                  <MonitorUp class="w-4 h-4" aria-hidden="true" />
                  <span>{t("newInstanceLauncher.sidecar")}</span>
                </button>
              </Show>
              <button type="button" class="window-action new-instance-launcher-home" disabled={props.isLoading} onClick={() => run(props.onOpenHome)}>
                <Home class="w-4 h-4" aria-hidden="true" />
                <span>{t("newInstanceLauncher.fullHome")}</span>
              </button>
            </footer>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
      <dialogs.Dialogs />
    </>
  )
}

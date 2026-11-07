import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on } from "solid-js"
import { Search } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { filterRecents, formatRelativeTime, getDisplayPath, getProjectDisplayName } from "../lib/recent-folder-display"
import { joinRecentOpenTarget, recentAccessibleName, recentOpenTarget } from "../lib/recent-open-target"
import type { LaunchableRecent } from "../lib/remote-project-recents"
import { launchableRecents, openRemoteProject } from "../stores/remote-project-open"
import { openSidecar } from "../stores/sidecar-open"
import { ensureSidecarsLoaded } from "../stores/sidecars"
import RecentTabIcon from "./recent-tab-icon"

/** The quick launcher's recent choices, with a separate action to join an open tab. */
export default function RecentTabsMenu(props: {
  isLoading: boolean
  active: boolean
  onSelectFolder: (path: string) => void
  onSelectExistingInstance: (id: string, path: string) => void
  onRun?: () => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = createSignal("")
  const listId = `recent-list-${createUniqueId()}`
  const [index, setIndex] = createSignal(0)
  const [keyboardNavigation, setKeyboardNavigation] = createSignal(false)
  const matches = createMemo(() => filterRecents(launchableRecents(), query()))
  let list: HTMLDivElement | undefined
  createEffect(on(() => props.active, (active) => {
    if (!active) return
    setQuery("")
    setIndex(0)
    setKeyboardNavigation(false)
    void ensureSidecarsLoaded()
  }))
  createEffect(on(matches, () => setIndex(0), { defer: true }))
  function open(recent: LaunchableRecent) {
    if (props.isLoading) return
    props.onRun?.()
    if (recent.sidecar) return void openSidecar(recent.sidecar.sidecarId)
    if (recent.remote) return openRemoteProject(recent.remote.profileId, { folder: recent.path })
    props.onSelectFolder(recent.path)
  }
  function navigate(event: KeyboardEvent, fromSearch = false) {
    if (props.isLoading || !matches().length) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || (!fromSearch && (event.key === "Home" || event.key === "End"))) {
      event.preventDefault()
      setKeyboardNavigation(true)
      const count = matches().length
      const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1
        : fromSearch ? (event.key === "ArrowDown" ? 0 : count - 1)
        : (index() + (event.key === "ArrowDown" ? 1 : -1) + count) % count
      setIndex(next)
      list?.querySelector<HTMLButtonElement>(`[data-launcher-index="${next}"]`)?.focus()
    } else if (fromSearch && event.key === "Enter" && matches()[index()]) {
      event.preventDefault()
      open(matches()[index()])
    }
  }
  return (
    <div class="recent-tabs-menu" data-keyboard-active={keyboardNavigation()}
      onPointerMove={() => setKeyboardNavigation(false)}
      onKeyDown={(event) => { if (event.key === "Tab") setKeyboardNavigation(true) }}>
      <div class="window-toolbar new-instance-launcher-search">
        <Search class="w-4 h-4 icon-muted" aria-hidden="true" />
        <input type="search" class="new-instance-launcher-search-input" aria-controls={listId}
          aria-label={t("newInstanceLauncher.searchLabel")} placeholder={t("newInstanceLauncher.searchPlaceholder")}
          value={query()} onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => navigate(event, true)} />
      </div>
      <div class="window-body new-instance-launcher-recents" id={listId} role="list"
        aria-label={t("newInstanceLauncher.recentTitle")} ref={list} onKeyDown={(event) => navigate(event)}>
        <For each={matches()} fallback={<p class="new-instance-launcher-empty" role="status">{t(launchableRecents().length ? "newInstanceLauncher.noMatch" : "newInstanceLauncher.empty")}</p>}>
          {(recent, position) => (
            <div class="new-instance-launcher-recent" role="listitem" data-open={recentOpenTarget(recent) ? "true" : undefined}
              data-remote-server={recent.remote?.profileId} data-sidecar={recent.sidecar?.sidecarId}>
              <button type="button" class="new-instance-launcher-recent-primary" disabled={props.isLoading}
                aria-label={recentAccessibleName(recent)} title={recentAccessibleName(recent)} data-launcher-index={position()}
                onFocus={() => setIndex(position())} onClick={() => open(recent)}>
                <RecentTabIcon recent={recent} class="w-4 h-4 icon-muted shrink-0" />
                <span class="new-instance-launcher-recent-details">
                  <span class="new-instance-launcher-recent-name">{getProjectDisplayName(recent.path, recent.projectName)}</span>
                  <span class="new-instance-launcher-recent-path">
                    <Show when={recent.remote}>{(remote) => <><bdi>{remote().serverName}</bdi><span aria-hidden="true"> · </span></>}</Show>
                    <Show when={!recent.remote && !recent.sidecar}><span>{t("folderSelection.browseMenu.thisComputer")} · </span></Show>
                    <Show when={!recent.sidecar} fallback={t("folderSelection.recent.sidecar")}><bdi dir="ltr">{getDisplayPath(recent.path)}</bdi></Show>
                  </span>
                </span>
              </button>
              <Show when={recentOpenTarget(recent)} fallback={<span class="new-instance-launcher-recent-meta">{formatRelativeTime(t, recent.lastAccessed)}</span>}>
                <button type="button" class="folder-home-open-instance-button" disabled={props.isLoading}
                  title={t("folderSelection.recent.switchToOpenProject")}
                  aria-label={`${t("folderSelection.recent.switchToOpenProject")} · ${recentAccessibleName(recent)}`}
                  onFocus={() => setIndex(position())}
                  onClick={() => { if (!props.isLoading) { props.onRun?.(); joinRecentOpenTarget(recent, props.onSelectExistingInstance) } }}>
                  {t("folderSelection.recent.openBadge")}
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

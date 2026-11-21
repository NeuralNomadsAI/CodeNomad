import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on } from "solid-js"
import { Tooltip } from "@kobalte/core/tooltip"
import { Search } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { filterRecents, formatRelativeTime, getDisplayPath, getProjectDisplayName } from "../lib/recent-folder-display"
import { joinRecentOpenTarget, recentAccessibleName, recentOpenElsewhere, recentOpenTarget, launchableRecents, type LaunchableRecent } from "../lib/recent-open-target"
import RemoteRecentSession from "./remote-recent-session"
import RecentTabIcon from "./recent-tab-icon"
import RecentOpenElsewhere, { RecentOpenElsewhereTooltip } from "./recent-open-elsewhere"
import { remoteRecentProjectsUsable, type RemoteRecentProject } from "../stores/recent-projects"
import { ensureSidecarsLoaded } from "../stores/sidecars"
import { sidecarsAllowed } from "../lib/server-meta"
import { sameServerSelection } from "../lib/native/server-selection-intent"
import { allowsPlainNavigation } from "../lib/hotkeys"

/** The quick launcher's recent choices, with a separate action to join an open tab. */
export default function RecentTabsMenu(props: {
  isLoading: boolean
  active: boolean
  onSelectFolder: (path: string) => void
  onSelectExistingInstance: (id: string, path: string) => void
  onRun?: () => void
  onOpenSidecar?: (id: string) => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = createSignal("")
  const [connectingRecent, setConnectingRecent] = createSignal<RemoteRecentProject>()
  const listId = `recent-list-${createUniqueId()}`
  const [index, setIndex] = createSignal(0)
  const matches = createMemo(() => {
    const rows = filterRecents(launchableRecents(), query())
    const opening = connectingRecent()
    return opening ? rows.map(row => row.kind === "remote" && row.key === opening.key && sameServerSelection(row.policy, opening.policy) ? opening : row) : rows
  })
  let list: HTMLDivElement | undefined
  createEffect(on(() => props.active, (active) => {
    setConnectingRecent(undefined)
    if (!active) return
    setQuery("")
    setIndex(0)
  }))
  createEffect(() => { if (props.active && sidecarsAllowed()) void ensureSidecarsLoaded() })
  createEffect(on(matches, () => setIndex(0), { defer: true }))
  createEffect(() => { if (!remoteRecentProjectsUsable()) setConnectingRecent(undefined) })
  function open(recent: LaunchableRecent) {
    if (props.isLoading) return
    if (recent.kind === "remote") { setConnectingRecent(recent); return }
    props.onRun?.()
    if (recent.kind === "sidecar") return props.onOpenSidecar?.(recent.path)
    props.onSelectFolder(recent.path)
  }
  function navigate(event: KeyboardEvent, fromSearch = false) {
    if (!allowsPlainNavigation(event)) return
    if ((event.target as HTMLElement).closest("[data-remote-view-session]")) return
    if (props.isLoading || !matches().length) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || (!fromSearch && (event.key === "Home" || event.key === "End"))) {
      event.preventDefault()
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
    <div class="recent-tabs-menu" tabindex="-1"
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) navigate(event, true)
      }}>
      <div class="window-toolbar new-instance-launcher-search">
        <Search class="w-4 h-4 icon-muted" aria-hidden="true" />
        <input type="search" class="new-instance-launcher-search-input" aria-controls={listId}
          aria-label={t("newInstanceLauncher.searchLabel")} placeholder={t("newInstanceLauncher.searchPlaceholder")}
        value={query()} onInput={(event) => { setConnectingRecent(undefined); setQuery(event.currentTarget.value) }} onKeyDown={(event) => navigate(event, true)} />
      </div>
      <div class="window-body new-instance-launcher-recents" id={listId} role="list"
        aria-label={t("newInstanceLauncher.recentTitle")} ref={list} onKeyDown={(event) => navigate(event)}>
        <For each={matches()} fallback={<p class="new-instance-launcher-empty" role="status">{t(launchableRecents().length ? "newInstanceLauncher.noMatch" : "newInstanceLauncher.empty")}</p>}>
          {(recent, position) => {
            const elsewhere = () => recentOpenElsewhere(recent) ? t("folderSelection.recent.openElsewhere") : undefined
            return (
            <div class="new-instance-launcher-recent" role="listitem" data-open={recentOpenTarget(recent) ? "true" : undefined}
              data-remote-server={recent.kind === "remote" ? recent.backendId : undefined} data-sidecar={recent.kind === "sidecar" ? recent.path : undefined}>
              <Show when={recent.kind === "remote" && connectingRecent() === recent ? recent : undefined} keyed fallback={<>
              <RecentOpenElsewhereTooltip label={elsewhere()}>
                <Tooltip.Trigger as="button" type="button" class="new-instance-launcher-recent-primary" disabled={props.isLoading}
                  aria-label={recentAccessibleName(recent)} aria-description={elsewhere()}
                  title={elsewhere() ? undefined : recentAccessibleName(recent)} data-launcher-index={position()}
                  onFocus={() => setIndex(position())} onClick={() => open(recent)}>
                  <RecentTabIcon recent={recent} class="w-4 h-4 icon-muted shrink-0" />
                  <span class="new-instance-launcher-recent-details">
                    <span class="new-instance-launcher-recent-name">{getProjectDisplayName(recent.path, recent.projectName)}</span>
                    <span class="new-instance-launcher-recent-path">
                      <Show when={recent.kind === "remote" ? recent.serverLabel : undefined}>{name => <><bdi>{name()}</bdi><span aria-hidden="true"> · </span></>}</Show>
                      <Show when={recent.kind === "local"}><span>{t("folderSelection.browseMenu.thisComputer")} · </span></Show>
                      <Show when={recent.kind !== "sidecar"} fallback={t("folderSelection.recent.sidecar")}><bdi dir="ltr">{getDisplayPath(recent.path)}</bdi></Show>
                    </span>
                  </span>
                </Tooltip.Trigger>
              </RecentOpenElsewhereTooltip>
              <Show when={recentOpenTarget(recent)} fallback={<span class="new-instance-launcher-recent-meta inline-flex items-center gap-2">
                {formatRelativeTime(t, recent.lastAccessed)}<RecentOpenElsewhere label={elsewhere()} />
              </span>}>
                <button type="button" class="folder-home-open-instance-button" disabled={props.isLoading}
                  title={t("folderSelection.recent.switchToOpenProject")}
                  aria-label={`${t("folderSelection.recent.switchToOpenProject")} · ${recentAccessibleName(recent)}`}
                  onFocus={() => setIndex(position())}
                  onClick={() => { if (!props.isLoading && joinRecentOpenTarget(recent, props.onSelectExistingInstance)) props.onRun?.() }}>
                  {t("folderSelection.recent.openBadge")}
                </button>
              </Show>
              </>}>
                {target => <RemoteRecentSession recent={target} active={props.active}
                  onBack={() => { setConnectingRecent(undefined); queueMicrotask(() => list?.querySelector<HTMLButtonElement>(`[data-launcher-index="${position()}"]`)?.focus()) }}
                  onOpened={() => props.onRun?.()} />}
              </Show>
            </div>
          )}}
        </For>
      </div>
    </div>
  )
}

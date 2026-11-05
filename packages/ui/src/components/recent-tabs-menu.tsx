import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on } from "solid-js"
import { ChevronRight, Search } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { filterRecents, formatRelativeTime, getDisplayPath, getProjectDisplayName } from "../lib/recent-folder-display"
import type { LaunchableRecent } from "../lib/remote-project-recents"
import { launchableRecents, openRemoteProject, openRemoteProjectTabFor } from "../stores/remote-project-open"
import { openSidecar } from "../stores/sidecar-open"
import { ensureSidecarsLoaded } from "../stores/sidecars"
import { getExistingInstanceForFolder } from "../stores/instances"
import RecentTabIcon from "./recent-tab-icon"
import EntryCount from "./entry-count"

const [expanded, setExpanded] = createSignal(true)

/** Search and recent choices shared by the compact launcher and a blank tab. */
export default function RecentTabsMenu(props: {
  isLoading: boolean
  active: boolean
  alwaysOpen?: boolean
  counts?: boolean
  onSelectFolder: (path: string) => void
  onSelectExistingInstance: (id: string, path: string) => void
  onRun?: () => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = createSignal("")
  const listId = `recent-list-${createUniqueId()}`
  const optionId = (position: number) => `${listId}-option-${position}`
  const [index, setIndex] = createSignal(0)
  const matches = createMemo(() => filterRecents(launchableRecents(), query()))
  const shown = () => props.alwaysOpen || expanded()
  let root: HTMLDivElement | undefined
  let list: HTMLDivElement | undefined
  createEffect(on(() => props.active, (active) => {
    if (!active) return
    setQuery("")
    setIndex(0)
    void ensureSidecarsLoaded()
    if (props.alwaysOpen) requestAnimationFrame(() => root?.querySelector<HTMLInputElement>("input")?.focus())
  }))
  createEffect(on(matches, () => setIndex(0), { defer: true }))
  createEffect(on([index, matches], ([value]) => {
    list?.querySelector(`[data-launcher-index="${value}"]`)?.scrollIntoView({ block: "nearest" })
  }))
  const existing = (recent: LaunchableRecent) => recent.sidecar ? false
    : recent.remote ? Boolean(openRemoteProjectTabFor(recent)) : Boolean(getExistingInstanceForFolder(recent.path))
  function open(recent: LaunchableRecent) {
    if (props.isLoading) return
    props.onRun?.()
    if (recent.sidecar) return void openSidecar(recent.sidecar.sidecarId)
    if (recent.remote) return openRemoteProject(recent.remote.profileId, { folder: recent.path })
    const instance = getExistingInstanceForFolder(recent.path)
    if (instance) props.onSelectExistingInstance(instance.id, recent.path)
    else props.onSelectFolder(recent.path)
  }
  function searchKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!shown()) setExpanded(true)
      else if (matches().length) setIndex((index() + (event.key === "ArrowDown" ? 1 : -1) + matches().length) % matches().length)
    } else if (event.key === "Enter" && shown() && matches()[index()]) {
      event.preventDefault()
      open(matches()[index()])
    }
  }
  return (
    <div ref={root} class="recent-tabs-menu">
      <div class="window-toolbar new-instance-launcher-search">
        <Search class="w-4 h-4 icon-muted" aria-hidden="true" />
        <input type="text" class="new-instance-launcher-search-input" role="combobox" aria-expanded={shown()}
          aria-controls={listId} aria-activedescendant={shown() && matches().length ? optionId(index()) : undefined}
          aria-label={t("newInstanceLauncher.searchLabel")} placeholder={t("newInstanceLauncher.searchPlaceholder")}
          value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setExpanded(true) }} onKeyDown={searchKey} />
      </div>
      <Show when={!props.alwaysOpen} fallback={
        <div class="panel-header"><div><h2 class="panel-title">{t("newInstanceLauncher.recentTitle")}</h2>
          <Show when={props.counts}><EntryCount count={launchableRecents().length} /></Show></div></div>
      }>
        <button type="button" class="browse-menu-toggle new-instance-launcher-recents-toggle"
          aria-expanded={shown()} aria-controls={listId} onClick={() => setExpanded(!expanded())}
          onKeyDown={(event) => {
            if (event.key === "Escape" && expanded()) { event.preventDefault(); setExpanded(false) }
            else if (event.key === "ArrowDown" && expanded()) { event.preventDefault(); root?.querySelector<HTMLInputElement>("input")?.focus() }
          }}>
          <ChevronRight class="disclosure-chevron w-3.5 h-3.5" aria-hidden="true" />
          <span>{t("newInstanceLauncher.recentTitle")}</span>
        </button>
      </Show>
      <Show when={shown()}>
        <div class="window-body new-instance-launcher-recents" id={listId} role="listbox"
          aria-label={t("newInstanceLauncher.recentTitle")} ref={list}>
          <For each={matches()} fallback={<p class="new-instance-launcher-empty">{t(launchableRecents().length ? "newInstanceLauncher.noMatch" : "newInstanceLauncher.empty")}</p>}>
            {(recent, position) => (
              <div id={optionId(position())} class="new-instance-launcher-recent" role="option"
                aria-selected={position() === index()} aria-disabled={props.isLoading} data-launcher-index={position()}
                data-open={existing(recent) ? "true" : undefined} title={recent.path}
                onMouseMove={() => setIndex(position())} onClick={() => open(recent)}>
                <RecentTabIcon recent={recent} class="w-4 h-4 icon-muted shrink-0" />
                <span class="new-instance-launcher-recent-name">{getProjectDisplayName(recent.path, recent.projectName)}</span>
                <span class="new-instance-launcher-recent-path" dir="ltr">{recent.sidecar ? t("folderSelection.recent.sidecar")
                  : recent.remote ? `${recent.remote.serverName} · ${getDisplayPath(recent.path)}` : getDisplayPath(recent.path)}</span>
                <span class="new-instance-launcher-recent-meta" classList={{ "new-instance-launcher-recent-open": existing(recent) }}>
                  <Show when={existing(recent)} fallback={formatRelativeTime(t, recent.lastAccessed)}>
                    <span class="status-dot" aria-hidden="true" />{t("newInstanceLauncher.openBadge")}
                  </Show>
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

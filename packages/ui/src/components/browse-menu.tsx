import { For, Show, createMemo, createSignal, createUniqueId, onMount } from "solid-js"
import { ChevronRight, Globe, Laptop, Plus, Server } from "lucide-solid"
import type { RemoteServerProfile, SideCar } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { serverDisplayName } from "../lib/codenomad-link"
import { withHotkey } from "../lib/hotkeys"
import { useRemoteServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { openRemoteServerEditor } from "../stores/remote-server-editor"
import { openSidecar } from "../stores/sidecar-open"
import { ensureSidecarsLoaded, sidecars } from "../stores/sidecars"

interface BrowseMenuProps {
  isLoading: boolean
  /** Browses this computer's folders (native dialog or folder browser). */
  onBrowseLocal: () => void
  /** Called before an entry runs, e.g. to dismiss the launcher. */
  onRun?: () => void
  /** The home page's Browse tab: the list without its disclosure. */
  alwaysOpen?: boolean
}

// One disclosure state per window for the launcher's section.
const [expanded, setExpanded] = createSignal(false)

/**
 * Browse, shared by the home page (a tab) and the new-instance launcher (a
 * folded section): this computer's folders, each saved CodeNomad server, whose
 * project tab picks the folder, each configured SideCar, then Add server….
 * Only host windows (never a web client, a Remote Control device or a remote
 * page) list or add servers.
 */
export default function BrowseMenu(props: BrowseMenuProps) {
  const { t } = useI18n()
  const { remoteServers, openServer } = useRemoteServerProfiles()
  const bodyId = createUniqueId()
  let toggleRef: HTMLButtonElement | undefined
  let bodyRef: HTMLDivElement | undefined

  onMount(() => void ensureSidecarsLoaded())

  const open = () => props.alwaysOpen || expanded()
  const navItems = () => [...(bodyRef?.querySelectorAll<HTMLElement>("[data-browse-nav]") ?? [])].filter((item) => !item.hasAttribute("disabled"))
  const focusFirst = () => queueMicrotask(() => navItems()[0]?.focus())
  const servers = () => (canOpenRemoteWindows() ? remoteServers() : [])
  const displayName = (profile: RemoteServerProfile) => serverDisplayName(profile, remoteServers())
  const orderedSidecars = createMemo(() => [...sidecars().values()].sort((left, right) => left.name.localeCompare(right.name)))

  // The launcher closes first, so the opened flow (dialog, tab, window) owns focus.
  function run(action: () => void) {
    if (props.isLoading) return
    props.onRun?.()
    action()
  }

  function handleToggleKeyDown(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" || !expanded()) return
    event.preventDefault()
    navItems()[0]?.focus()
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return
    const items = navItems()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const move = (next: number) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus() }
    if (event.key === "ArrowDown") move(index + 1)
    else if (event.key === "ArrowUp") move(index - 1)
    else if (event.key === "Home") move(0)
    else if (event.key === "End") move(items.length - 1)
    else if (event.key === "Escape" && !props.alwaysOpen) {
      event.preventDefault()
      setExpanded(false)
      toggleRef?.focus()
    }
  }

  const sidecarRunning = (sidecar: SideCar) => sidecar.status === "running"

  return (
    <div class="browse-menu" classList={{ "browse-menu--open": props.alwaysOpen }}>
      <Show when={!props.alwaysOpen}>
        <button type="button" class="browse-menu-toggle" ref={toggleRef} aria-expanded={expanded()} aria-controls={bodyId}
          disabled={props.isLoading} onKeyDown={handleToggleKeyDown}
          onClick={() => { setExpanded(!expanded()); if (expanded()) focusFirst() }}>
          <ChevronRight class="disclosure-chevron w-3.5 h-3.5" aria-hidden="true" />
          <span>{t("folderSelection.browseMenu.title")}</span>
        </button>
      </Show>
      <Show when={open()}>
        <div id={bodyId} class="browse-menu-body" ref={bodyRef} role="group" aria-label={t("folderSelection.browseMenu.title")}
          onKeyDown={handleKeyDown}>
          <button type="button" class="browse-menu-row" data-browse-nav disabled={props.isLoading}
            title={withHotkey(t("folderSelection.browseMenu.thisComputer"), "browse-folder")}
            onClick={() => run(props.onBrowseLocal)}>
            <Laptop class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
            <span class="browse-menu-name">{t("folderSelection.browseMenu.thisComputer")}</span>
          </button>
          <For each={servers()}>
            {(profile) => (
              <button type="button" class="browse-menu-row" data-browse-nav data-remote-server={profile.id}
                disabled={props.isLoading} title={profile.baseUrl} onClick={() => run(() => openServer(profile))}
                aria-label={t("folderSelection.remoteProject.openProject", { name: displayName(profile) })}>
                <Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                <bdi class="browse-menu-name" dir="auto">{displayName(profile)}</bdi>
              </button>
            )}
          </For>
          {/* A SideCar opens only while it runs; its state shows on the row. */}
          <For each={orderedSidecars()}>
            {(sidecar) => (
              <button type="button" class="browse-menu-row" data-browse-nav data-sidecar={sidecar.id}
                disabled={props.isLoading || !sidecarRunning(sidecar)} onClick={() => run(() => void openSidecar(sidecar.id))}>
                <Globe class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                <bdi class="browse-menu-name" dir="auto">{sidecar.name}</bdi>
                <span class="browse-menu-meta" data-status={sidecar.status}>{t(`sidecars.status.${sidecar.status}`)}</span>
              </button>
            )}
          </For>
          <Show when={canOpenRemoteWindows()}>
            <button type="button" class="browse-menu-row" data-browse-nav disabled={props.isLoading}
              onClick={() => run(() => openRemoteServerEditor())}>
              <Plus class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
              <span class="browse-menu-name">{t("folderSelection.browseMenu.addServer")}</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

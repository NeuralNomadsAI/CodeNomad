import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Globe, Laptop, Server } from "lucide-solid"
import type { RemoteServerProfile, SideCar } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { serverDisplayName } from "../lib/codenomad-link"
import { withHotkey } from "../lib/hotkeys"
import { useRemoteServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { openSidecar } from "../stores/sidecar-open"
import ServerAddField from "./server-add-field"
import RemoteServerBrowser from "./remote-server-browser"
import { openRemoteProject, opensRemoteProjectTab } from "../stores/remote-project-open"
import { embeddedProjectUrl } from "../lib/embed-mode"
import { remoteServers as savedServers } from "../stores/preferences"
import { ensureSidecarsLoaded, sidecars } from "../stores/sidecars"
import { joinRecentOpenTarget, recentAccessibleName, recentOpenTarget } from "../lib/recent-open-target"
import type { LaunchableRecent } from "../lib/remote-project-recents"

interface BrowseMenuProps {
  isLoading: boolean
  active?: boolean
  onSourceChange?: (source: { profile: RemoteServerProfile; recents: LaunchableRecent[]; available: boolean } | undefined) => void
  /** Browses this computer's folders (native dialog or folder browser). */
  onBrowseLocal: () => void
  pinAddField?: boolean
}

/** Choices only: this computer, available saved servers and configured SideCars (the add field is an action). */
export const browseEntryCount = () => 1 + (canOpenRemoteWindows() ? savedServers().length : 0) + sidecars().size

/**
 * Browse in the canonical project selector: this computer's folders, saved
 * CodeNomad servers, configured SideCars, then the inline server-add field.
 * Only host windows (never a web client, a Remote Control device or a remote
 * page) list or add servers.
 */
export default function BrowseMenu(props: BrowseMenuProps) {
  const { t } = useI18n()
  const { remoteServers, openServer } = useRemoteServerProfiles()
  const [selectedServer, setSelectedServer] = createSignal<RemoteServerProfile>()
  const [pairingFailures, setPairingFailures] = createSignal<string[]>([])
  createEffect(() => {
    const selected = selectedServer()
    if (selected && !remoteServers().some(profile => profile.id === selected.id && profile.name === selected.name
      && profile.baseUrl === selected.baseUrl && profile.skipTlsVerify === selected.skipTlsVerify)) selectServer(undefined)
  })
  onCleanup(() => props.onSourceChange?.(undefined))
  function selectServer(profile: RemoteServerProfile | undefined) {
    props.onSourceChange?.(profile ? { profile, recents: [], available: false } : undefined)
    setSelectedServer(profile)
  }
  let bodyRef: HTMLDivElement | undefined

  onMount(() => void ensureSidecarsLoaded())

  const navItems = () => [...(bodyRef?.querySelectorAll<HTMLElement>("[data-browse-nav]") ?? [])].filter((item) => !item.hasAttribute("disabled"))
  const servers = () => (canOpenRemoteWindows() ? remoteServers() : [])
  const displayName = (profile: RemoteServerProfile) => serverDisplayName(profile, remoteServers())
  const orderedSidecars = createMemo(() => [...sidecars().values()].sort((left, right) => left.name.localeCompare(right.name)))

  function run(action: () => void) {
    if (props.isLoading) return
    action()
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return
    const items = navItems()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const move = (next: number) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus() }
    // Home and End stay with the address field's text.
    const inField = event.target instanceof HTMLInputElement && event.target.type === "text"
    if (event.key === "ArrowDown") move(index + 1)
    else if (event.key === "ArrowUp") move(index - 1)
    else if (event.key === "Home" && !inField) move(0)
    else if (event.key === "End" && !inField) move(items.length - 1)
    else if (event.key === "Escape" && selectedServer()) {
      event.preventDefault()
      backToRoot()
    }
  }

  function backToRoot() {
    const id = selectedServer()?.id
    selectServer(undefined)
    queueMicrotask(() => { if (props.active !== false) bodyRef?.querySelector<HTMLElement>(`[data-remote-server="${CSS.escape(id ?? "")}"]`)?.focus() })
  }

  const sidecarRunning = (sidecar: SideCar) => sidecar.status === "running"
  const AddField = () => <Show when={canOpenRemoteWindows() && !selectedServer()}>
    <ServerAddField navAttribute="data-browse-nav" disabled={props.isLoading}
      onPairingFailure={(id) => setPairingFailures(ids => ids.includes(id) ? ids : [...ids, id])}
      onAdded={(id, mayFocus) => {
        setPairingFailures(ids => ids.filter(value => value !== id))
        queueMicrotask(() => { if (props.active !== false && (mayFocus?.() ?? true)) bodyRef?.querySelector<HTMLElement>(`[data-remote-server="${CSS.escape(id)}"]`)?.focus() })
      }} />
  </Show>

  return (
    <div class="browse-menu" classList={{ "browse-menu--footer": props.pinAddField }} ref={bodyRef} onKeyDown={handleKeyDown}>
        <div class="browse-menu-body" role="group" aria-label={t("folderSelection.browseMenu.title")}>
          <Show when={selectedServer()} keyed>{(profile) => <RemoteServerBrowser profile={profile} active={props.active} onBack={backToRoot}
            onRecents={(recents, available) => { if (selectedServer() === profile) props.onSourceChange?.({ profile, recents, available }) }}
            onConnected={() => setPairingFailures(ids => ids.filter(id => id !== profile.id))}
            onSelect={(folder) => run(() => {
              if (opensRemoteProjectTab(profile)) openRemoteProject(profile.id, { folder })
              else openServer(profile, embeddedProjectUrl(profile.baseUrl, folder))
            })} />}</Show>
          <Show when={!selectedServer()}>
          <button type="button" class="browse-menu-row" data-browse-nav disabled={props.isLoading}
            title={withHotkey(t("folderSelection.browseMenu.thisComputer"), "browse-folder")}
            onClick={() => run(props.onBrowseLocal)}>
            <Laptop class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
            <span class="browse-menu-name">{t("folderSelection.browseMenu.thisComputer")}</span>
          </button>
          <For each={servers()}>
            {(profile) => (
              <button type="button" class="browse-menu-row" data-browse-nav data-remote-server={profile.id}
                disabled={props.isLoading} title={profile.baseUrl} onClick={() => selectServer(profile)}
                aria-label={t("folderSelection.remoteProject.openProject", { name: displayName(profile) })}>
                <Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                <bdi class="browse-menu-name" dir="auto">{displayName(profile)}</bdi>
                <Show when={pairingFailures().includes(profile.id)}><span class="browse-menu-meta">{t("remoteBrowse.connectionRequired")}</span></Show>
                <Show when={!opensRemoteProjectTab(profile)}><span class="browse-menu-meta">{t("remoteBrowse.openSeparateWindow")}</span></Show>
              </button>
            )}
          </For>
          {/* A SideCar opens only while it runs; its state shows on the row. */}
          <For each={orderedSidecars()}>
            {(sidecar) => {
              const recent: LaunchableRecent = { path: sidecar.id, projectName: sidecar.name, lastAccessed: 0, sidecar: { sidecarId: sidecar.id } }
              return <div class="flex items-center min-w-0">
              <button type="button" class="browse-menu-row" data-browse-nav data-sidecar={sidecar.id}
                disabled={props.isLoading || !sidecarRunning(sidecar)} onClick={() => run(() => void openSidecar(sidecar.id))}>
                <Globe class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                <bdi class="browse-menu-name" dir="auto">{sidecar.name}</bdi>
                <span class="browse-menu-meta" data-status={sidecar.status}>{t(`sidecars.status.${sidecar.status}`)}</span>
              </button>
              <Show when={recentOpenTarget(recent)}>
                <button type="button" class="window-action shrink-0" data-browse-nav disabled={props.isLoading}
                  aria-label={`${t("folderSelection.recent.switchToOpenProject")} · ${recentAccessibleName(recent)}`}
                  onClick={() => run(() => joinRecentOpenTarget(recent, () => {}))}>
                  {t("folderSelection.recent.openBadge")}
                </button>
              </Show>
              </div>
            }}
          </For>
          <Show when={!props.pinAddField}><AddField /></Show>
          </Show>
        </div>
        <Show when={props.pinAddField}>
          <div class="browse-menu-footer"><AddField /></div>
        </Show>
    </div>
  )
}

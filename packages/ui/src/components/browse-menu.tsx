import { For, Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js"
import { Globe, Laptop, Plus, Server } from "lucide-solid"
import type { RemoteServerBrowseResponse, RemoteServerProfile, SideCar } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { qualifiedServerDisplayName } from "../lib/codenomad-link"
import { allowsPlainNavigation, withHotkey } from "../lib/hotkeys"
import { sameServerSelection, type ServerSelectionIntent } from "../lib/native/server-selection-intent"
import { getServerMeta, serversManageable, sidecarsAllowed } from "../lib/server-meta"
import ServerAddField from "./server-add-field"
import { RemoteServerBrowser } from "./remote-server-browser"
import { useConfig } from "../stores/preferences"
import { remoteRecentProjectsUsable, savedProjectProfile } from "../stores/recent-projects"
import { ensureSidecarsLoaded, sidecars } from "../stores/sidecars"
import { openSettingsRow } from "../stores/settings-screen"
import { joinRecentOpenTarget, recentAccessibleName, recentOpenTarget, type LaunchableRecent } from "../lib/recent-open-target"

interface BrowseMenuProps {
  isLoading: boolean
  active?: boolean
  initialServer?: ServerSelectionIntent
  onSourceChange: (source: { profile: RemoteServerProfile; listing?: RemoteServerBrowseResponse } | undefined) => void
  /** Browses this computer's folders (native dialog or folder browser). */
  onBrowseLocal: () => void
  onOpenSidecar: (id: string) => void
  onJoined?: () => void
  onRemoteOpened?: (instanceId: string) => void
}

/** Choices only: this computer, available saved servers and configured SideCars (the add field is an action). */
export function createBrowseEntryCount() {
  const { remoteServers } = useConfig()
  return () => 1 + (remoteRecentProjectsUsable() ? remoteServers().length : 0) + (sidecarsAllowed() ? sidecars().size : 0)
}

/**
 * Browse in the canonical project selector: this computer's folders, saved
 * CodeNomad servers, configured SideCars, then the inline server-add field.
 */
export default function BrowseMenu(props: BrowseMenuProps) {
  const { t } = useI18n()
  const { remoteServers } = useConfig()
  const [selectedServer, setSelectedServer] = createSignal<RemoteServerProfile>()
  const [connectionFailures, setConnectionFailures] = createSignal<string[]>([])
  onMount(() => { void getServerMeta().catch(() => {}) })
  // A delayed capability read must admit the native intent once, without replaying it after Back.
  let appliedIntent: ServerSelectionIntent | undefined
  createEffect(on([() => props.initialServer, remoteRecentProjectsUsable], ([intent, usable]) => {
    if (!usable || intent === appliedIntent) return
    appliedIntent = intent
    const profile = intent && savedProjectProfile(intent)
    const selected = selectedServer()
    if (profile && (!selected || !sameServerSelection(profile, selected))) selectServer(profile)
  }))
  createEffect(() => {
    const selected = selectedServer()
    if (selected && (!remoteRecentProjectsUsable() || !remoteServers().some(profile => sameServerSelection(profile, selected)))) selectServer(undefined)
  })
  function selectServer(profile: RemoteServerProfile | undefined) {
    props.onSourceChange(profile ? { profile } : undefined)
    setSelectedServer(profile)
  }
  let bodyRef: HTMLDivElement | undefined

  createEffect(() => { if (sidecarsAllowed()) void ensureSidecarsLoaded() })

  const navItems = () => [...(bodyRef?.querySelectorAll<HTMLElement>("[data-browse-nav]") ?? [])].filter((item) => !item.hasAttribute("disabled"))
  const servers = () => (remoteRecentProjectsUsable() ? remoteServers() : [])
  const displayName = (profile: RemoteServerProfile) => qualifiedServerDisplayName(profile, remoteServers())
  const orderedSidecars = createMemo(() => sidecarsAllowed() ? [...sidecars().values()].sort((left, right) => left.name.localeCompare(right.name)) : [])

  function run(action: () => void) {
    if (props.isLoading) return
    action()
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (!allowsPlainNavigation(event)) return
    const items = navItems()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const move = (next: number) => { if (items.length) { event.preventDefault(); items[(next + items.length) % items.length]?.focus() } }
    // Home and End stay with the address field's text.
    const inField = event.target instanceof HTMLInputElement
    if (inField && !event.target.hasAttribute("data-browse-nav") && event.key !== "Escape") return
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
  const AddField = () => <Show when={remoteRecentProjectsUsable() && serversManageable() && !selectedServer()}>
    <ServerAddField browseNav disabled={props.isLoading}
      onPairingFailure={(id) => setConnectionFailures(ids => ids.includes(id) ? ids : [...ids, id])}
      onAdded={(id, mayFocus) => {
        setConnectionFailures(ids => ids.filter(value => value !== id))
        queueMicrotask(() => { if (props.active !== false && (mayFocus?.() ?? true)) bodyRef?.querySelector<HTMLElement>(`[data-remote-server="${CSS.escape(id)}"]`)?.focus() })
      }} />
  </Show>

  return (
    <div class="browse-menu" ref={bodyRef} onKeyDown={handleKeyDown}>
        <div class="browse-menu-body" role="group" aria-label={t("folderSelection.browseMenu.title")}>
          <Show when={selectedServer()} keyed>{(profile) => <RemoteServerBrowser profile={profile} active={props.active} onBack={backToRoot}
            onListing={listing => {
              if (selectedServer() !== profile) return
              props.onSourceChange({ profile, listing })
              if (listing) setConnectionFailures(ids => ids.filter(id => id !== profile.id))
            }} onConnectionRequired={() => setConnectionFailures(ids => ids.includes(profile.id) ? ids : [...ids, profile.id])}
            onOpened={props.onRemoteOpened} />}</Show>
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
                <Show when={connectionFailures().includes(profile.id)}><span class="browse-menu-meta">{t("remoteBrowse.connectionRequired")}</span></Show>
              </button>
            )}
          </For>
          {/* A SideCar opens only while it runs; its state shows on the row. */}
          <For each={orderedSidecars()}>
            {(sidecar) => {
              const recent: LaunchableRecent = { kind: "sidecar", key: sidecar.id, path: sidecar.id, projectName: sidecar.name, lastAccessed: 0 }
              return <div class="flex items-center min-w-0">
              <button type="button" class="browse-menu-row" data-browse-nav data-sidecar={sidecar.id}
                disabled={props.isLoading || !sidecarRunning(sidecar)} onClick={() => run(() => props.onOpenSidecar(sidecar.id))}>
                <Globe class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                <bdi class="browse-menu-name" dir="auto">{sidecar.name}</bdi>
                <span class="browse-menu-meta" data-status={sidecar.status}>{t(`sidecars.status.${sidecar.status}`)}</span>
              </button>
              <Show when={recentOpenTarget(recent)}>
                <button type="button" class="folder-home-open-instance-button shrink-0" data-browse-nav disabled={props.isLoading}
                  aria-label={`${t("folderSelection.recent.switchToOpenProject")} · ${recentAccessibleName(recent)}`}
                  onClick={() => run(() => { if (joinRecentOpenTarget(recent, () => {})) props.onJoined?.() })}>
                  {t("folderSelection.recent.openBadge")}
                </button>
              </Show>
              </div>
            }}
          </For>
          <button type="button" class="browse-menu-row" data-browse-nav disabled={props.isLoading}
            onClick={() => void openSettingsRow("sidecars", "sidecar-add")}>
            <Plus class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
            <span class="browse-menu-name">{t("folderSelection.newSidecar")}</span>
          </button>
          </Show>
        </div>
        <div class="browse-menu-footer"><AddField /></div>
    </div>
  )
}

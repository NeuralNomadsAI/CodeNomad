import { ContextMenu } from "@kobalte/core/context-menu"
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup } from "solid-js"
import { ArrowLeft, ArrowUpLeft, ChevronRight, Folder, Plus, Server, Trash2 } from "lucide-solid"
import type { FileSystemListResponse, RemoteServerProfile } from "../../../server/src/api-types"
import { WINDOWS_DRIVES_ROOT } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { qualifiedServerDisplayName } from "../lib/codenomad-link"
import { remoteServerErrorKey, RemoteServerProbeError, useRelayServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import { useI18n } from "../lib/i18n"
import { captureRequestFocus } from "../lib/request-focus"
import { supportsPairingLink } from "../lib/remote-pairing-link"
import { sameServerSelection, type ServerSelectionIntent } from "../lib/native/server-selection-intent"
import { getServerMeta, secretEntryAllowed, serversManageable, serversUsable } from "../lib/server-meta"
import { backends } from "../lib/backend-client"
import { showConfirmDialog } from "../stores/alerts"
import { backendRegistry } from "../stores/remote-backends"
import { openRemoteProjectForProfile } from "../stores/remote-project-open"
import { latestRemoteProjectPath } from "../stores/recent-projects"
import RemoteServerSignin from "./remote-server-signin"
import ServerAddField from "./server-add-field"

export interface RemoteRecentRequest {
  profile: ServerSelectionIntent
  path: string
  projectName?: string
}

const NAV = "[data-remote-nav]"
const BACK = "[data-remote-back]"

export default function RemoteProjectMenu(props: {
  isLoading: boolean
  recent?: RemoteRecentRequest
  focusExisting?: boolean
  onOpened: () => void
}) {
  const { t } = useI18n()
  const { remoteServers, enabled, capture, removeServer } = useRelayServerProfiles()
  const usable = () => enabled() && serversUsable()
  const manageable = () => usable() && serversManageable()
  const [expanded, setExpanded] = createSignal(false)
  const [target, setTarget] = createSignal<ServerSelectionIntent>()
  const [listing, setListing] = createSignal<FileSystemListResponse>()
  const [requestedPath, setRequestedPath] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [manageError, setManageError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [openingRecent, setOpeningRecent] = createSignal(false)
  const groupId = createUniqueId()
  let toggleRef: HTMLButtonElement | undefined
  let bodyRef: HTMLDivElement | undefined
  let controller: AbortController | undefined
  let focusEpoch = 0
  const active = createMemo(() => {
    const owner = target()
    return owner && usable() ? remoteServers().find(p => sameServerSelection(p, owner)) : undefined
  })
  const displayName = (server: RemoteServerProfile) => qualifiedServerDisplayName(server, remoteServers())

  createEffect(() => { if (enabled()) void getServerMeta().catch(() => {}) })
  createEffect(() => {
    if (!usable()) {
      collapse(false)
    } else if (target() && !active()) showServers()
    else if (props.isLoading && controller) abort()
  })
  onCleanup(() => { ++focusEpoch; controller?.abort() })

  const navItems = () => [...(bodyRef?.querySelectorAll<HTMLElement>(NAV) ?? [])].filter(item => !item.hasAttribute("disabled"))
  function focusNav(selector?: string, retained = () => true) {
    const epoch = ++focusEpoch
    queueMicrotask(() => {
      if (epoch !== focusEpoch || !retained()) return
      const item = selector ? bodyRef?.querySelector<HTMLElement>(selector) : undefined
      ;(item && !item.hasAttribute("disabled") ? item : navItems()[0])?.focus()
    })
  }
  function abort() {
    ++focusEpoch
    controller?.abort()
    controller = undefined
    setBusy(false)
    setOpeningRecent(false)
  }
  function resetListing() {
    setListing(undefined)
    setRequestedPath(undefined)
    setError(undefined)
  }
  function showServers() {
    const previous = target()
    abort()
    setTarget(undefined)
    resetListing()
    focusNav(previous ? `[data-remote-server="${CSS.escape(previous.id)}"]` : undefined)
  }
  function collapse(focus = true) {
    abort()
    setExpanded(false)
    setTarget(undefined)
    resetListing()
    setManageError(undefined)
    if (focus) toggleRef?.focus()
  }
  function setFailure(failure: unknown) {
    const code = failure instanceof Error ? failure.message : ""
    setError(code === "refused" || code.endsWith(": 426") ? "refused" : code || "unreachable")
  }
  function beginOperation(profile: ServerSelectionIntent, clearError = true, focusBack = false) {
    controller?.abort()
    const own = new AbortController()
    controller = own
    const focus = captureRequestFocus(node => focusBack && node === bodyRef?.querySelector(BACK))
    setBusy(true)
    if (clearError) setError(undefined)
    if (focusBack) focusNav(BACK, focus.retained)
    const current = () => {
      const owner = active()
      return !own.signal.aborted && !!owner && sameServerSelection(owner, profile)
    }
    return {
      signal: own.signal, current, retained: focus.retained,
      finish: () => {
        focus.dispose()
        if (controller === own) { controller = undefined; setBusy(false); setOpeningRecent(false) }
      },
    }
  }
  async function browse(path?: string, focusPath?: string, mayFocus = true) {
    const profile = active()
    if (!profile) return
    setRequestedPath(path)
    const op = beginOperation(profile, true, mayFocus)
    try {
      const response = await serverApi.browseRemoteServer(profile.id, path, op.signal, { foldersOnly: true })
      if (!op.current()) return
      setListing(response.listing)
      setRequestedPath(response.listing.metadata.currentPath)
      if (mayFocus) focusNav(focusPath ? `[data-remote-folder="${CSS.escape(focusPath)}"]` : "[data-remote-folder]", op.retained)
    } catch (failure) {
      if (op.current()) {
        setFailure(failure)
        if (mayFocus) focusNav(BACK, op.retained)
      }
    } finally { op.finish() }
  }
  function openServer(profile: RemoteServerProfile, mayFocus = () => true) {
    if (!usable() || props.isLoading || !remoteServers().some(p => sameServerSelection(p, profile))) return
    const takeFocus = mayFocus()
    abort()
    resetListing()
    setTarget(profile)
    void browse(latestRemoteProjectPath(profile), undefined, takeFocus)
  }
  async function open(path: string, targetProfile: ServerSelectionIntent | undefined = active(), recent = false, projectName?: string) {
    if (!targetProfile || props.isLoading || (!recent && busy()) || !usable()) return
    if (recent) {
      abort()
      resetListing()
      setTarget(targetProfile)
      if (!active()) return
      setRequestedPath(path)
      setOpeningRecent(true)
      setExpanded(true)
    }
    const op = beginOperation(targetProfile, true, true)
    try {
      if (await openRemoteProjectForProfile(targetProfile, path, op.signal, { focusExisting: recent && props.focusExisting, projectName })) {
        props.onOpened()
        return
      }
    } catch (failure) {
      if (op.current()) {
        setFailure(failure)
        focusNav(BACK, op.retained)
      }
    } finally { op.finish() }
  }
  createEffect(on(() => props.recent, request => {
    if (request) void open(request.path, request.profile, true, request.projectName)
  }))
  function goUp() {
    const meta = listing()?.metadata
    if (!meta?.parentPath) { showServers(); return }
    if (!busy()) void browse(meta.parentPath, meta.currentPath)
  }
  const needsCredentials = () => ["needs_credentials", "auth", "pairing_unavailable", "unauthorized"].includes(error() ?? "")
  const pairing = () => {
    const profile = active()
    return needsCredentials() && !!profile && supportsPairingLink(profile.baseUrl)
  }
  async function connect(credentials?: { username: string; password: string }) {
    const profile = active()
    if (!profile || busy() || !secretEntryAllowed()) return
    // Keep the recovery form mounted while credentials are in flight.
    const op = beginOperation(profile, false)
    try {
      if (credentials) await serverApi.connectRemoteServer(profile.id, credentials, op.signal)
      if (!op.current()) return
      if (backends.has(profile.id)) await backendRegistry.retryWorkspaces(profile.id).catch(() => undefined)
      if (op.current()) await browse(requestedPath(), undefined, op.retained())
    } catch (failure) { if (op.current()) setFailure(failure) }
    finally { op.finish() }
  }
  async function remove(profile: RemoteServerProfile) {
    if (!manageable() || props.isLoading) return
    const op = capture(profile)
    try {
      const confirmed = await showConfirmDialog(t("folderSelection.remoteProject.removeConfirm", { name: displayName(profile) }), {
        title: t("folderSelection.servers.remove"), variant: "warning", confirmLabel: t("folderSelection.servers.remove"),
      }, op.signal)
      if (!confirmed || !op.current() || !manageable()) return
      setManageError(undefined)
      try { await removeServer(profile) }
      catch (failure) { if (op.current()) setManageError(remoteServerErrorKey(failure)) }
    } finally { op.dispose() }
  }
  function handleKeyDown(event: KeyboardEvent) {
    if (!expanded() || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    const items = navItems()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const inField = (event.target as HTMLElement).matches("input, textarea, select, [contenteditable=true]")
    const move = (next: number) => {
      if (!items.length) return
      event.preventDefault()
      items[(next + items.length) % items.length]?.focus()
    }
    if (event.key === "ArrowDown") move(index + 1)
    else if (event.key === "ArrowUp") move(index < 0 ? items.length - 1 : index - 1)
    else if (event.key === "Home" && !inField) move(0)
    else if (event.key === "End" && !inField) move(items.length - 1)
    else if (event.key === "Escape") { event.preventDefault(); active() ? showServers() : collapse() }
    else if (active() && !inField && (event.key === "Backspace" || event.key === "ArrowLeft")) { event.preventDefault(); goUp() }
    else if (event.key === "ArrowRight" && !inField) {
      const data = (document.activeElement as HTMLElement | null)?.dataset
      const profile = remoteServers().find(p => p.id === data?.remoteServer)
      if (active() && data?.remoteFolder && !busy()) { event.preventDefault(); void browse(data.remoteFolder) }
      else if (!active() && profile) { event.preventDefault(); openServer(profile) }
    }
  }
  function handleToggleKeyDown(event: KeyboardEvent) {
    if (!expanded() || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === "ArrowDown") { event.preventDefault(); focusNav() }
    else if (event.key === "Escape") handleKeyDown(event)
  }
  const backLabel = () => t(openingRecent() ? "folderSelection.servers.dialog.cancel" : "folderSelection.remoteProject.back")
  const canOpen = () => {
    const meta = listing()?.metadata
    return !!meta && meta.currentPath !== WINDOWS_DRIVES_ROOT && meta.pathKind !== "drives" && !busy() && !error() && !props.isLoading
  }

  return <Show when={usable()}>
    <button type="button" class="remote-project-toggle" ref={toggleRef} aria-expanded={expanded()}
      aria-controls={expanded() ? groupId : undefined} disabled={props.isLoading}
      onClick={() => { if (expanded()) collapse(); else { setExpanded(true); focusNav() } }} on:keydown={handleToggleKeyDown}>
      <ChevronRight class="disclosure-chevron w-3.5 h-3.5" aria-hidden="true" />
      <span>{t("folderSelection.remoteProject.title")}</span>
    </button>
    <Show when={expanded()}>
      <div id={groupId} class="remote-project-menu" ref={bodyRef} role="group" aria-label={t("folderSelection.remoteProject.title")}
        aria-busy={busy()} on:keydown={handleKeyDown}>
        <Show when={active()} fallback={<>
          <For each={remoteServers()}>{profile => {
            const row = {
              type: "button" as const, class: "remote-project-row", "data-remote-nav": "", "data-remote-server": profile.id,
              get disabled() { return props.isLoading }, onClick: () => openServer(profile),
              get "aria-label"() { return t("folderSelection.remoteProject.openProject", { name: displayName(profile) }) },
            }
            const content = () => <>
              <Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
              <bdi class="remote-project-name" dir="auto" title={displayName(profile)}>{displayName(profile)}</bdi>
              <span class="window-action shrink-0" aria-hidden="true">
                <Plus class="w-3.5 h-3.5" /><span>{t("folderSelection.remoteProject.project")}</span>
              </span>
            </>
            return <Show when={manageable()} fallback={<button {...row}>{content()}</button>}>
              <ContextMenu>
                <ContextMenu.Trigger as="button" {...row}>{content()}</ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content class="action-overflow-content">
                    <ContextMenu.Item class="action-overflow-item" onSelect={() => void remove(profile)}>
                      <span class="action-overflow-item-icon" aria-hidden="true"><Trash2 class="w-3.5 h-3.5" /></span>
                      <span class="action-overflow-item-label">{t("folderSelection.servers.remove")}</span>
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu>
            </Show>
          }}</For>
          <Show when={manageable()}>
            <ServerAddField compact disabled={props.isLoading} navAttribute="data-remote-nav"
              onAdded={(id, mayFocus) => {
                const profile = remoteServers().find(p => p.id === id)
                if (profile) openServer(profile, mayFocus)
              }} />
          </Show>
          <Show when={!manageable() && remoteServers().length === 0}>
            <p class="remote-project-empty">{t("folderSelection.servers.empty.title")}</p>
          </Show>
          <Show when={manageError()}>{key => <p class="remote-project-error" role="alert">{t(key())}</p>}</Show>
        </>}>{profile => <>
          <div class="remote-project-header">
            <button type="button" class={openingRecent() ? "window-action shrink-0" : "window-icon-button"} data-remote-nav data-remote-back onClick={showServers}
              aria-label={backLabel()} title={backLabel()}>
              <ArrowLeft class="w-4 h-4" aria-hidden="true" />
              <Show when={openingRecent()}>{backLabel()}</Show>
            </button>
            <bdi class="remote-project-name" dir="auto" title={displayName(profile())}>{displayName(profile())}</bdi>
            <span class="remote-project-path truncate-start" title={listing()?.metadata.displayPath ?? requestedPath()}>
              {listing()?.metadata.displayPath ?? requestedPath()}
            </span>
            <button type="button" class="window-action" data-remote-nav disabled={!canOpen()}
              onClick={() => void open(listing()!.metadata.currentPath)}>{t("directoryBrowser.openCurrent")}</button>
          </div>
          <div class="remote-project-folders">
            <Show when={error()} fallback={<>
              <Show when={listing()?.metadata.parentPath}>
                <button type="button" class="remote-project-row" data-remote-nav disabled={busy()} onClick={goUp}>
                  <ArrowUpLeft class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                  <span class="remote-project-name">{t("directoryBrowser.goToParent")}</span>
                </button>
              </Show>
              <For each={listing()?.entries.filter(entry => entry.type === "directory")}>{entry => {
                const path = entry.absolutePath ?? entry.path
                return <button type="button" class="remote-project-row" data-remote-nav data-remote-folder={path} disabled={busy()}
                  title={path} onClick={() => void browse(path)}>
                  <Folder class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                  <span class="remote-project-name">{entry.name}</span>
                </button>
              }}</For>
              <Show when={!openingRecent() && (busy() || listing()?.entries.every(entry => entry.type !== "directory"))}>
                <p class="remote-project-empty">{t(busy() ? "directoryBrowser.loadingFolders" : "directoryBrowser.noFolders")}</p>
              </Show>
            </>}>{code => <>
              <p class="remote-project-error" role="alert">{t(code() === "refused"
                ? "remoteBrowse.incompatible" : code() === "path_unavailable" ? "directoryBrowser.load.errorFallback"
                  : remoteServerErrorKey(new RemoteServerProbeError(code())))}</p>
              <Show when={needsCredentials()} fallback={<>
                <button type="button" class="window-action remote-project-retry" data-remote-nav disabled={busy()}
                  onClick={() => void browse(requestedPath())}>{t("filesystemBrowser.actions.retry")}</button>
                <Show when={requestedPath() && code() === "path_unavailable"}>
                  <button type="button" class="window-action remote-project-retry" data-remote-nav disabled={busy()}
                    onClick={() => void browse()}>{t("folderSelection.remoteProject.serverRoot")}</button>
                </Show>
              </>}>
                <Show when={pairing()}>
                  <ServerAddField compact pairingProfile={profile()} disabled={busy()} onAdded={() => void connect()} />
                </Show>
                <Show when={!new URL(profile().baseUrl).hostname.endsWith(".opentunnel.xyz")}>
                  <RemoteServerSignin busy={busy()} onConnect={credentials => void connect(credentials)} />
                </Show>
              </Show>
            </>}</Show>
          </div>
        </>}</Show>
      </div>
    </Show>
  </Show>
}

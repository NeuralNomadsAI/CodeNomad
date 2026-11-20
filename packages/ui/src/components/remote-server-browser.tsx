import { Dialog } from "@kobalte/core/dialog"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { ArrowLeft, ArrowRight, ArrowUp, Folder, Loader2, Server } from "lucide-solid"
import type { RemoteServerBrowseResponse, RemoteServerProfile } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { qualifiedServerDisplayName } from "../lib/codenomad-link"
import { useConfig } from "../stores/preferences"
import { closeRemoteServer, openRemoteProject, openRemoteProjectForProfile, remoteServerSelection, selectedRemoteProfile } from "../stores/remote-project-open"
import { backendRegistry } from "../stores/remote-backends"
import { backends } from "../lib/backend-client"
import { remoteServerErrorKey, RemoteServerProbeError } from "../lib/hooks/use-remote-server-profiles"
import { captureRequestFocus } from "../lib/request-focus"
import ServerAddField from "./server-add-field"
import RemoteServerSignin from "./remote-server-signin"
import WindowCloseButton from "./window-close-button"
import { secretEntryAllowed } from "../lib/server-meta"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { latestRemoteProjectPath, type RemoteRecentProject } from "../stores/recent-projects"

/** Saved-server folder navigation with ordinary project tabs (#1236). */
export function RemoteServerBrowser(props: {
  profile: RemoteServerProfile
  recent?: RemoteRecentProject
  active?: boolean
  onBack?: () => void
  onOpened?: () => void
  onListing?: (listing: RemoteServerBrowseResponse) => void
}) {
  const { t } = useI18n()
  const { remoteServers } = useConfig()
  const [result, setResult] = createSignal<RemoteServerBrowseResponse>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [path, setPath] = createSignal("")
  let root!: HTMLDivElement
  let controller: AbortController | undefined
  const opening = new AbortController()
  let generation = 0
  const name = () => qualifiedServerDisplayName(props.profile, remoteServers())
  const [requestedPath, setRequestedPath] = createSignal<string>()
  const [pendingOpen, setPendingOpen] = createSignal(props.recent?.path)
  const needsCredentials = () => ["needs_credentials", "auth", "pairing_unavailable", "unauthorized"].includes(error())
  const pairing = () => needsCredentials() && new URL(props.profile.baseUrl).hostname.endsWith(".opentunnel.xyz")
  const canOpen = () => !!path().trim() && !(result()?.listing.metadata.pathKind === "drives" && path().trim() === result()?.listing.metadata.currentPath)
  async function browse(folder?: string) {
    setRequestedPath(folder)
    setPendingOpen(undefined)
    const focus = captureRequestFocus()
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal, current = ++generation
    setBusy(true); setError("")
    try {
      const value = await serverApi.browseRemoteServer(props.profile.id, folder, signal)
      if (signal.aborted || current !== generation) return
      setResult(value); setPath(value.listing.metadata.currentPath)
      props.onListing?.(value)
      queueMicrotask(() => { if (!signal.aborted && current === generation && props.active !== false && focus.retained()) root.querySelector<HTMLElement>("[data-remote-folder], [data-remote-open]")?.focus() })
    } catch (failure) { if (!signal.aborted && current === generation) showFailure(failure, () => !signal.aborted && current === generation && focus.retained()) }
    finally { focus.dispose(); if (current === generation) setBusy(false) }
  }
  function showFailure(failure: unknown, mayFocus?: () => boolean) {
    setError(failure instanceof Error ? failure.message : "unreachable")
    if (needsCredentials()) queueMicrotask(() => {
      if (!opening.signal.aborted && props.active !== false && (mayFocus?.() ?? true)) {
        root.querySelector<HTMLElement>(pairing() ? "[data-server-add-field]" : 'input[type="password"]')?.focus()
      }
    })
  }
  async function connect(credentials: { username: string; password: string }) {
    if (busy()) return
    setBusy(true)
    try {
      if (!secretEntryAllowed()) { setError("secret_entry_forbidden"); return }
      await serverApi.connectRemoteServer(props.profile.id, credentials, opening.signal)
      await connected()
    } catch (failure) { if (!opening.signal.aborted) setError(failure instanceof Error ? failure.message : "unreachable") }
    finally { if (!opening.signal.aborted) setBusy(false) }
  }
  async function connected() {
    if (opening.signal.aborted) return
    // A new credential proof can revoke the old admitted client; browsing uses the saved profile.
    if (backends.has(props.profile.id)) await backendRegistry.retryWorkspaces(props.profile.id).catch(() => undefined)
    if (opening.signal.aborted) return
    if (pendingOpen()) {
      setBusy(false)
      await open(pendingOpen())
    } else await browse(requestedPath())
  }
  async function open(folder = path()) {
    if (busy() || !folder.trim()) return
    const focus = captureRequestFocus()
    setPendingOpen(folder)
    setBusy(true); setError("")
    try {
      const opened = props.onBack
        ? await openRemoteProjectForProfile(props.profile, folder.trim(), opening.signal, { projectName: props.recent?.projectName })
        : await openRemoteProject(folder.trim(), opening.signal)
      if (opened) props.onOpened?.()
    }
    catch (failure) { if (!opening.signal.aborted) showFailure(failure, focus.retained) }
    finally { focus.dispose(); if (!opening.signal.aborted) setBusy(false) }
  }
  async function retry() {
    if (busy()) return
    setBusy(true)
    try {
      if (backends.has(props.profile.id)) await backendRegistry.retryWorkspaces(props.profile.id)
      if (opening.signal.aborted) return
      if (pendingOpen()) { setBusy(false); await open(pendingOpen()) }
      else await browse(requestedPath())
    } catch (failure) { if (!opening.signal.aborted) setError(failure instanceof Error ? failure.message : "unreachable") }
    finally { if (!opening.signal.aborted) setBusy(false) }
  }
  onMount(() => {
    if (props.onBack && props.active !== false) root.querySelector<HTMLElement>("[data-remote-back]")?.focus()
    if (props.recent) void open(props.recent.path)
    else void browse(props.onBack ? latestRemoteProjectPath(props.profile) : undefined)
  })
  onCleanup(() => { ++generation; controller?.abort(); opening.abort() })
  return <div ref={root} class="remote-server-browser" aria-busy={busy()}>
    <Show when={props.onBack} fallback={<header class="window-header">
      <Server class="w-4 h-4 shrink-0" aria-hidden="true" />
      <Dialog.Title class="window-title flex-1 min-w-0 truncate"><bdi>{name()}</bdi></Dialog.Title>
      <WindowCloseButton onClose={closeRemoteServer} />
    </header>}>
      <div class="remote-server-navigation">
        <button type="button" class="window-icon-button" data-browse-nav data-remote-back onClick={props.onBack} aria-label={t("remoteBrowse.back")} title={t("remoteBrowse.back")}>
          <ArrowLeft class="w-4 h-4" aria-hidden="true" />
        </button>
        <Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
        <bdi class="browse-menu-name" dir="auto">{name()}</bdi>
        <SettingsInfoTip text={`${name()} — ${props.profile.baseUrl}`} />
      </div>
    </Show>
    <div class={props.onBack ? undefined : "window-body"}>
      <Show when={pairing()}>
        <p role="alert" class="server-add-field-error">{t("remoteBrowse.pairAgain", { name: name() })}</p>
        <ServerAddField pairingProfile={props.profile} navAttribute="data-browse-nav" onAdded={() => void connected()} />
      </Show>
      <Show when={needsCredentials() && !pairing()}>
        <RemoteServerSignin busy={busy()} onConnect={credentials => void connect(credentials)} />
      </Show>
      <Show when={error() && error() !== "needs_credentials" && !pairing()}><p role="alert" class="server-add-field-error">{t(error() === "refused" || error().endsWith(": 426")
        ? "remoteBrowse.incompatible" : error() === "unauthorized" ? "authRecovery.credentials"
          : remoteServerErrorKey(new RemoteServerProbeError(error())))}</p>
        <Show when={!needsCredentials()}><button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => void retry()}>{t("filesystemBrowser.actions.retry")}</button>
          <Show when={error() === "path_unavailable"}><button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => void browse()}>{t("remoteBrowse.serverRoot")}</button></Show>
        </Show>
      </Show>
      <Show when={busy()}><Loader2 class="w-4 h-4 animate-spin" aria-label={t("authRecovery.pending")} /></Show>
      <Show when={result() && !error()}>
        <div class="remote-server-path directory-browser-address-field">
          <input type="text" class="selector-input directory-browser-current-path" data-can-go data-browse-nav dir="ltr" spellcheck={false} disabled={busy()}
            aria-label={t("directoryBrowser.currentFolder.inputAriaLabel")} value={path()} onInput={event => setPath(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.isComposing && canOpen()) { event.preventDefault(); void open() } }} />
          <button type="button" class="directory-browser-go" data-browse-nav data-remote-open disabled={busy() || !canOpen()} aria-label={t("directoryBrowser.openCurrent")} title={t("directoryBrowser.openCurrent")} onClick={() => void open()}>
            <ArrowRight class="w-4 h-4" />
          </button>
        </div>
        <Show when={result()?.listing.metadata.parentPath !== undefined}>
          <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => void browse(result()?.listing.metadata.parentPath)}>
            <ArrowUp class="w-4 h-4" />{t("directoryBrowser.goToParent")}
          </button>
        </Show>
        <For each={result()?.listing.entries}>{entry =>
          <button type="button" class="browse-menu-row" data-browse-nav data-remote-folder disabled={busy()} title={entry.path} onClick={() => { setPendingOpen(undefined); void browse(entry.path) }}>
            <Folder class="w-4 h-4 shrink-0" /><bdi class="browse-menu-name">{entry.name}</bdi>
          </button>
        }</For>
        <Show when={!props.onBack}><h3 class="window-title">{t("folderSelection.recent.title")}</h3>
        <For each={result()?.recents}>{recent =>
          <button type="button" class="browse-menu-row" disabled={busy()} title={recent.path} onClick={() => void open(recent.path)}>
            <ArrowLeft class="w-4 h-4 shrink-0" /><bdi class="truncate">{recent.projectName || recent.path}</bdi>
          </button>
        }</For></Show>
      </Show>
    </div>
  </div>
}

export default function RemoteServerProjectDialog(props: { onOpened?: () => void }) {
  createEffect(() => { if (remoteServerSelection() && !selectedRemoteProfile()) closeRemoteServer() })
  return <Show when={selectedRemoteProfile()} keyed>{profile =>
    <Dialog open onOpenChange={open => { if (!open) closeRemoteServer() }}>
      <Dialog.Portal><Dialog.Overlay class="modal-overlay" />
        <Dialog.Content class="modal-surface window-shell remote-server-project-window">
          <RemoteServerBrowser profile={profile} onOpened={props.onOpened} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  }</Show>
}

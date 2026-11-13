import { Dialog } from "@kobalte/core/dialog"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { ArrowLeft, ArrowRight, ArrowUp, Folder, Loader2, Server } from "lucide-solid"
import type { RemoteServerBrowseResponse, RemoteServerProfile } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { serverDisplayName } from "../lib/codenomad-link"
import { useConfig } from "../stores/preferences"
import { closeRemoteServer, openRemoteProject, remoteServerSelection, selectedRemoteProfile } from "../stores/remote-project-open"
import { backendRegistry } from "../stores/remote-backends"
import { backends } from "../lib/backend-client"
import { remoteServerErrorKey, RemoteServerProbeError } from "../lib/hooks/use-remote-server-profiles"
import { captureRequestFocus } from "../lib/request-focus"
import ServerAddField from "./server-add-field"
import RemoteServerSignin from "./remote-server-signin"
import WindowCloseButton from "./window-close-button"

/** Saved-server folder navigation with ordinary project tabs (#1236). */
function RemoteServerBrowser(props: { profile: RemoteServerProfile; onOpened?: () => void }) {
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
  const name = () => serverDisplayName(props.profile, remoteServers())
  const needsCredentials = () => ["needs_credentials", "auth", "pairing_unavailable", "unauthorized"].includes(error())
  const pairing = () => needsCredentials() && new URL(props.profile.baseUrl).hostname.endsWith(".opentunnel.xyz")
  const canOpen = () => !!path().trim() && !(result()?.listing.metadata.pathKind === "drives" && path() === result()?.listing.metadata.currentPath)
  async function browse(folder?: string) {
    const focus = captureRequestFocus()
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal, current = ++generation
    setBusy(true); setError("")
    try {
      const value = await serverApi.browseRemoteServer(props.profile.id, folder, signal)
      if (signal.aborted || current !== generation) return
      setResult(value); setPath(value.listing.metadata.currentPath)
      queueMicrotask(() => { if (!signal.aborted && current === generation && focus.retained()) root.querySelector<HTMLElement>("[data-remote-folder]")?.focus() })
    } catch (failure) { if (!signal.aborted && current === generation) setError(failure instanceof Error ? failure.message : "unreachable") }
    finally { focus.dispose(); if (current === generation) setBusy(false) }
  }
  async function connect(credentials: { username: string; password: string }) {
    if (busy()) return
    setBusy(true)
    try {
      await serverApi.connectRemoteServer(props.profile.id, credentials, opening.signal)
      await connected()
    } catch (failure) { if (!opening.signal.aborted) setError(failure instanceof Error ? failure.message : "unreachable") }
    finally { if (!opening.signal.aborted) setBusy(false) }
  }
  async function connected() {
    if (opening.signal.aborted) return
    // A new credential proof can revoke the old admitted client; browsing uses the saved profile.
    if (backends.has(props.profile.id)) await backendRegistry.retryWorkspaces(props.profile.id).catch(() => undefined)
    if (!opening.signal.aborted) await browse(result()?.listing.metadata.currentPath)
  }
  async function open(folder = path()) {
    if (busy() || !folder.trim()) return
    setBusy(true); setError("")
    try { if (await openRemoteProject(folder.trim(), opening.signal)) props.onOpened?.() }
    catch (failure) { if (!opening.signal.aborted) setError(failure instanceof Error ? failure.message : "unreachable") }
    finally { if (!opening.signal.aborted) setBusy(false) }
  }
  async function retry() {
    if (busy()) return
    setBusy(true)
    try {
      if (backends.has(props.profile.id)) await backendRegistry.retryWorkspaces(props.profile.id)
      await browse()
    } catch (failure) { if (!opening.signal.aborted) setError(failure instanceof Error ? failure.message : "unreachable") }
    finally { if (!opening.signal.aborted) setBusy(false) }
  }
  onMount(() => void browse())
  onCleanup(() => { ++generation; controller?.abort(); opening.abort() })
  return <div ref={root} class="remote-server-browser" aria-busy={busy()}>
    <header class="window-header">
      <Server class="w-4 h-4 shrink-0" aria-hidden="true" />
      <Dialog.Title class="window-title flex-1 min-w-0 truncate"><bdi>{name()}</bdi></Dialog.Title>
      <WindowCloseButton onClose={closeRemoteServer} />
    </header>
    <div class="window-body">
      <Show when={pairing()}>
        <ServerAddField pairingProfile={props.profile} onAdded={() => void connected()} />
      </Show>
      <Show when={needsCredentials() && !pairing()}>
        <RemoteServerSignin busy={busy()} onConnect={credentials => void connect(credentials)} />
      </Show>
      <Show when={error()}><p role="alert" class="server-add-field-error">{t(error() === "refused" || error().includes("426")
        ? "remoteBrowse.incompatible" : remoteServerErrorKey(new RemoteServerProbeError(error())))}</p>
        <Show when={!needsCredentials()}><button type="button" class="window-action" disabled={busy()} onClick={() => void retry()}>{t("filesystemBrowser.actions.retry")}</button></Show>
      </Show>
      <Show when={busy()}><Loader2 class="w-4 h-4 animate-spin" aria-label={t("authRecovery.pending")} /></Show>
      <Show when={result() && !needsCredentials()}>
        <div class="directory-browser-address-field">
          <input class="selector-input directory-browser-current-path" dir="ltr" spellcheck={false} disabled={busy()}
            aria-label={t("directoryBrowser.currentFolder.inputAriaLabel")} value={path()} onInput={event => setPath(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === "Enter" && canOpen()) { event.preventDefault(); void open() } }} />
          <button type="button" class="directory-browser-go" disabled={busy() || !canOpen()} aria-label={t("directoryBrowser.openCurrent")} onClick={() => void open()}>
            <ArrowRight class="w-4 h-4" />
          </button>
        </div>
        <Show when={result()?.listing.metadata.parentPath !== undefined}>
          <button type="button" class="remote-server-row" disabled={busy()} onClick={() => void browse(result()?.listing.metadata.parentPath)}>
            <ArrowUp class="w-4 h-4" />{t("directoryBrowser.goToParent")}
          </button>
        </Show>
        <For each={result()?.listing.entries}>{entry =>
          <button type="button" class="remote-server-row" data-remote-folder disabled={busy()} title={entry.path} onClick={() => void browse(entry.path)}>
            <Folder class="w-4 h-4 shrink-0" /><bdi class="truncate">{entry.name}</bdi>
          </button>
        }</For>
        <h3 class="window-title">{t("folderSelection.recent.title")}</h3>
        <For each={result()?.recents}>{recent =>
          <button type="button" class="remote-server-row" disabled={busy()} title={recent.path} onClick={() => void open(recent.path)}>
            <ArrowLeft class="w-4 h-4 shrink-0" /><bdi class="truncate">{recent.projectName || recent.path}</bdi>
          </button>
        }</For>
      </Show>
    </div>
  </div>
}

export default function RemoteServerProjectDialog(props: { onOpened?: () => void }) {
  createEffect(() => { if (remoteServerSelection() && !selectedRemoteProfile()) closeRemoteServer() })
  return <Dialog open={!!selectedRemoteProfile()} onOpenChange={open => { if (!open) closeRemoteServer() }}>
    <Dialog.Portal><Dialog.Overlay class="modal-overlay" />
      <Dialog.Content class="modal-surface window-shell remote-server-project-window">
        <Show when={selectedRemoteProfile()} keyed>{profile => <RemoteServerBrowser profile={profile} onOpened={props.onOpened} />}</Show>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog>
}

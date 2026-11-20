import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { ArrowLeft, ArrowRight, ArrowUp, Folder, Loader2, Server } from "lucide-solid"
import type { RemoteServerBrowseResponse, RemoteServerProfile } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { qualifiedServerDisplayName } from "../lib/codenomad-link"
import { supportsPairingLink } from "../lib/remote-pairing-link"
import { useConfig } from "../stores/preferences"
import { openRemoteProjectForProfile } from "../stores/remote-project-open"
import { backendRegistry } from "../stores/remote-backends"
import { backends } from "../lib/backend-client"
import { remoteServerErrorKey, RemoteServerProbeError } from "../lib/hooks/use-remote-server-profiles"
import { captureRequestFocus } from "../lib/request-focus"
import ServerAddField from "./server-add-field"
import RemoteServerSignin from "./remote-server-signin"
import { secretEntryAllowed } from "../lib/server-meta"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { latestRemoteProjectPath, type RemoteRecentProject } from "../stores/recent-projects"
import { appTabSelectionRevision } from "../stores/app-tabs"

/** Saved-server folder navigation with ordinary project tabs (#1236). */
export function RemoteServerBrowser(props: {
  profile: RemoteServerProfile
  recent?: RemoteRecentProject
  active?: boolean
  onBack: () => void
  onOpened?: (instanceId: string) => void
  onListing?: (listing: RemoteServerBrowseResponse | undefined) => void
  onConnectionRequired?: () => void
}) {
  const { t } = useI18n()
  const { remoteServers } = useConfig()
  const [result, setResult] = createSignal<RemoteServerBrowseResponse>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [signInError, setSignInError] = createSignal("")
  const [path, setPath] = createSignal("")
  let root!: HTMLDivElement
  let controller: AbortController | undefined
  const opening = new AbortController()
  let generation = 0
  const name = () => qualifiedServerDisplayName(props.profile, remoteServers())
  const [requestedPath, setRequestedPath] = createSignal<string>()
  const [pendingOpen, setPendingOpen] = createSignal<string>()
  const needsCredentials = () => ["needs_credentials", "auth", "pairing_unavailable", "unauthorized"].includes(error())
  const pairing = () => needsCredentials() && supportsPairingLink(props.profile.baseUrl)
  const password = () => needsCredentials() && !new URL(props.profile.baseUrl).hostname.endsWith(".opentunnel.xyz")
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
    if (needsCredentials()) {
      props.onListing?.(undefined)
      props.onConnectionRequired?.()
      queueMicrotask(() => {
        if (!opening.signal.aborted && props.active !== false && (mayFocus?.() ?? true)) {
          root.querySelector<HTMLElement>(password() ? "[data-remote-password]" : "[data-server-add-field]")?.focus()
        }
      })
    } else if (error() !== "path_unavailable") props.onListing?.(undefined)
  }
  async function connect(credentials: { username: string; password: string }) {
    if (busy()) return
    setBusy(true)
    setSignInError("")
    try {
      if (!secretEntryAllowed()) { setSignInError("remoteBrowse.secretEntryForbidden"); return }
      await serverApi.connectRemoteServer(props.profile.id, credentials, opening.signal)
      await connected()
    } catch (failure) { if (!opening.signal.aborted) setSignInError(remoteServerErrorKey(failure)) }
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
    const revision = appTabSelectionRevision()
    setPendingOpen(folder)
    setBusy(true); setError("")
    try {
      await openRemoteProjectForProfile(props.profile, folder.trim(), opening.signal, {
        projectName: props.recent?.projectName, current: () => props.active !== false && revision === appTabSelectionRevision(),
        onOpened: props.onOpened,
      })
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
    } catch (failure) { if (!opening.signal.aborted) showFailure(failure) }
    finally { if (!opening.signal.aborted) setBusy(false) }
  }
  onMount(() => {
    if (props.active !== false) root.querySelector<HTMLElement>("[data-remote-back]")?.focus()
    if (props.recent) void open(props.recent.path)
    else void browse(latestRemoteProjectPath(props.profile))
  })
  onCleanup(() => { ++generation; controller?.abort(); opening.abort() })
  return <div ref={root} class="remote-server-browser" aria-busy={busy()}>
      <div class="remote-server-navigation">
        <button type="button" class="window-icon-button" data-browse-nav data-remote-back onClick={props.onBack} aria-label={t("remoteBrowse.back")} title={t("remoteBrowse.back")}>
          <ArrowLeft class="w-4 h-4" aria-hidden="true" />
        </button>
        <Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
        <bdi class="browse-menu-name" dir="auto" title={name()}>{name()}</bdi>
        <SettingsInfoTip text={`${name()} — ${props.profile.baseUrl}`} />
      </div>
      <Show when={pairing()}>
        <ServerAddField pairingProfile={props.profile} browseNav onAdded={() => void connected()} />
      </Show>
      <Show when={password()}>
        <RemoteServerSignin busy={busy()} error={signInError()} onConnect={credentials => void connect(credentials)} />
      </Show>
      <Show when={error() && !needsCredentials()}><p role="alert" class="server-add-field-error">{t(error() === "refused"
        ? "remoteBrowse.incompatible"
          : remoteServerErrorKey(new RemoteServerProbeError(error())))}</p>
        <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => void retry()}>{t("filesystemBrowser.actions.retry")}</button>
          <Show when={error() === "path_unavailable"}><button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => void browse()}>{t("remoteBrowse.serverRoot")}</button></Show>
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
          <button type="button" class="browse-menu-row" data-browse-nav data-remote-folder disabled={busy()} title={entry.path} onClick={() => void browse(entry.path)}>
            <Folder class="w-4 h-4 shrink-0" /><bdi class="browse-menu-name">{entry.name}</bdi>
          </button>
        }</For>
      </Show>
  </div>
}

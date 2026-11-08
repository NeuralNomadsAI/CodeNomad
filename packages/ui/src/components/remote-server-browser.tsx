import { For, Show, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { ArrowLeft, ArrowRight, ArrowUp, Folder, Loader2, Server } from "lucide-solid"
import type { RemoteServerBrowseResponse, RemoteServerProfile } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { serverDisplayName } from "../lib/codenomad-link"
import { remoteServers } from "../stores/preferences"
import { opensRemoteProjectTab } from "../stores/remote-project-open"
import ServerAddField from "./server-add-field"
import { captureRequestFocus } from "../lib/request-focus"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import type { LaunchableRecent } from "../lib/remote-project-recents"
import RemoteServerSignin from "./remote-server-signin"

/** Remote metadata is read by the local backend; only this component's password input holds entered text. */
export default function RemoteServerBrowser(props: {
  profile: RemoteServerProfile
  active?: boolean
  onRecents?: (recents: LaunchableRecent[], available: boolean) => void
  onBack: () => void
  onSelect: (folder: string) => void
  onConnected?: () => void
}) {
  const { t } = useI18n()
  const [result, setResult] = createSignal<RemoteServerBrowseResponse>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [diagnostic, setDiagnostic] = createSignal("")
  const [typedPath, setTypedPath] = createSignal("")
  const openLabel = () => t(opensRemoteProjectTab(props.profile) ? "directoryBrowser.openCurrent" : "remoteBrowse.openSeparateWindow")
  // The drive list itself is not a folder to open.
  const canOpenTyped = () => Boolean(typedPath().trim())
    && !(result()?.listing.metadata.pathKind === "drives" && typedPath() === result()?.listing.metadata.currentPath)
  function openTyped() {
    if (busy() || !canOpenTyped()) return
    props.onSelect(typedPath().trim())
  }
  const errorId = createUniqueId()
  const name = () => serverDisplayName(props.profile, remoteServers())
  const needsPairing = () => needsCredentials() && new URL(props.profile.baseUrl).hostname.endsWith(".opentunnel.xyz")
  let password: HTMLInputElement | undefined
  let root: HTMLDivElement | undefined
  let controller: AbortController | undefined
  let generation = 0
  let disposed = false
  const needsCredentials = () => error() === "needs_credentials" || error() === "auth" || error() === "pairing_unavailable"
  function failure(value: unknown, mayFocus: () => boolean) {
    props.onRecents?.([], false)
    const code = value instanceof Error ? value.message : "unreachable"
    setDiagnostic(code)
    setError(["needs_credentials", "auth", "pairing_unavailable", "tls_error"].includes(code) ? code : "unreachable")
    if (needsCredentials()) queueMicrotask(() => {
      if (props.active === false || !mayFocus()) return
      if (needsPairing()) root?.querySelector<HTMLInputElement>("[data-server-add-field]")?.focus()
      else password?.focus()
    })
  }
  async function browse(path?: string, mayFocus?: () => boolean) {
    if (disposed) return
    const focus = captureRequestFocus()
    const retained = () => current === generation && props.active !== false && focus.retained() && (mayFocus?.() ?? true)
    controller?.abort()
    controller = new AbortController()
    const current = ++generation
    setBusy(true)
    setError("")
    props.onRecents?.([], false)
    try {
      const value = await serverApi.browseRemoteServer(props.profile.id, path, controller.signal)
      if (current !== generation) return
      setResult(value)
      setTypedPath(value.listing.metadata.currentPath)
      props.onRecents?.(value.recents.map(recent => ({ ...recent, remote: { profileId: props.profile.id, serverName: name() } })), true)
      props.onConnected?.()
      queueMicrotask(() => { if (retained()) root?.querySelector<HTMLElement>("[data-remote-folder]")?.focus() })
    } catch (error) { if (current === generation) failure(error, retained) }
    finally { focus.dispose(); if (current === generation) setBusy(false) }
  }
  async function connect(credentials: { username: string; password: string }) {
    if (busy()) return
    const focus = captureRequestFocus()
    setBusy(true)
    const current = ++generation
    try {
      await serverApi.connectRemoteServer(props.profile.id, credentials)
      if (current === generation) await browse(result()?.listing.metadata.currentPath, focus.retained)
    } catch (error) { if (current === generation) failure(error, () => current === generation && focus.retained()) }
    finally { focus.dispose(); if (current === generation) setBusy(false) }
  }
  onMount(() => void browse())
  onCleanup(() => { disposed = true; ++generation; controller?.abort(); if (password) password.value = "" })
  return (
    <div class="remote-server-browser" ref={root} aria-busy={busy()}>
      <div class="remote-server-navigation">
        <button type="button" class="window-icon-button" data-browse-nav onClick={props.onBack} aria-label={t("remoteBrowse.back")} title={t("remoteBrowse.back")}>
          <ArrowLeft class="w-4 h-4" aria-hidden="true" />
        </button>
        <Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
        <bdi class="browse-menu-name" dir="auto" tabindex="0" aria-label={name()}>{name()}</bdi>
        <SettingsInfoTip text={`${name()} — ${props.profile.baseUrl}`} />
      </div>
      <Show when={needsPairing()}>
        <p class="server-add-field-error" role="alert">{t("remoteBrowse.pairAgain", { name: name() })}</p>
        <ServerAddField navAttribute="data-browse-nav" pairingProfile={props.profile} onAdded={(_id, mayFocus) => void browse(undefined, mayFocus)} />
      </Show>
      <Show when={needsCredentials() && !needsPairing()}>
        <RemoteServerSignin busy={busy()} error={error()} errorId={errorId} passwordRef={(input) => { password = input }} onConnect={(credentials) => void connect(credentials)} />
      </Show>
      <Show when={error() && error() !== "needs_credentials" && !needsPairing()}>
        <p id={errorId} class="server-add-field-error" role="alert">{t(error() === "auth" ? "authRecovery.credentials"
          : error() === "pairing_unavailable" ? "remoteBrowse.pairingUnavailable"
          : error() === "tls_error" ? "remoteBrowse.tlsError" : "remoteBrowse.unreachable")}
          <Show when={error() === "unreachable"}><SettingsInfoTip text={diagnostic()} /></Show></p>
      </Show>
      <Show when={busy()}><Loader2 class="w-4 h-4 animate-spin" aria-label={t("authRecovery.pending")} /></Show>
      <Show when={!needsCredentials() && error()}>
        <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => void browse()}>{t("filesystemBrowser.actions.retry")}</button>
      </Show>
      <Show when={!error() && result()}>
        {(value) => {
          const listing = () => value().listing
          return <>
            {/* The current folder, editable: Enter or the arrow opens it; folder rows below only navigate. */}
            <div class="remote-server-path directory-browser-address-field">
              <input type="text" class="selector-input directory-browser-current-path" data-can-go data-browse-nav dir="ltr" spellcheck={false}
                aria-label={t("directoryBrowser.currentFolder.inputAriaLabel")} value={typedPath()} disabled={busy()}
                onInput={(event) => setTypedPath(event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); openTyped() } }} />
              <button type="button" class="directory-browser-go" data-browse-nav disabled={busy() || !canOpenTyped()}
                aria-label={openLabel()} title={openLabel()} onClick={openTyped}>
                <ArrowRight class="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
            <Show when={listing().metadata.parentPath !== undefined}>
              <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => void browse(listing().metadata.parentPath)}>
                <ArrowUp class="w-4 h-4 icon-muted" aria-hidden="true" /><span>{t("directoryBrowser.goToParent")}</span>
              </button>
            </Show>
            <For each={listing().entries}>{(entry) =>
              <button type="button" class="browse-menu-row" data-browse-nav data-remote-folder disabled={busy()} title={entry.path} aria-description={entry.path} onClick={() => void browse(entry.path)}>
                <Folder class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" /><bdi class="browse-menu-name">{entry.name}</bdi>
              </button>
            }</For>
          </>
        }}
      </Show>
    </div>
  )
}

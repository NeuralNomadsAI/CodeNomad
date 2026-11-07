import { For, Show, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { ArrowLeft, ArrowUp, ChevronRight, Folder, FolderOpen, Loader2, Server } from "lucide-solid"
import type { RemoteServerBrowseResponse, RemoteServerProfile } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { getProjectDisplayName } from "../lib/recent-folder-display"
import { serverDisplayName } from "../lib/codenomad-link"
import { remoteServers } from "../stores/preferences"
import { opensRemoteProjectTab } from "../stores/remote-project-open"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import ServerAddField from "./server-add-field"
import { captureRequestFocus } from "../lib/request-focus"
import { joinRecentOpenTarget, recentAccessibleName, recentOpenTarget } from "../lib/recent-open-target"
import type { LaunchableRecent } from "../lib/remote-project-recents"

/** Remote metadata is read by the local backend; only this component's password input holds entered text. */
export default function RemoteServerBrowser(props: {
  profile: RemoteServerProfile
  onBack: () => void
  onSelect: (folder: string) => void
  onConnected?: () => void
}) {
  const { t } = useI18n()
  const [result, setResult] = createSignal<RemoteServerBrowseResponse>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [username, setUsername] = createSignal("codenomad")
  const [diagnostic, setDiagnostic] = createSignal("")
  const errorId = createUniqueId()
  const name = () => serverDisplayName(props.profile, remoteServers())
  const needsPairing = () => needsCredentials() && new URL(props.profile.baseUrl).hostname.endsWith(".opentunnel.xyz")
  let password: HTMLInputElement | undefined
  let root: HTMLDivElement | undefined
  let controller: AbortController | undefined
  let generation = 0
  const needsCredentials = () => error() === "needs_credentials" || error() === "auth" || error() === "pairing_unavailable"
  function failure(value: unknown, mayFocus: () => boolean) {
    const code = value instanceof Error ? value.message : "unreachable"
    setDiagnostic(code)
    setError(["needs_credentials", "auth", "pairing_unavailable", "tls_error"].includes(code) ? code : "unreachable")
    if (needsCredentials()) queueMicrotask(() => {
      if (!mayFocus()) return
      if (needsPairing()) root?.querySelector<HTMLInputElement>("[data-server-add-field]")?.focus()
      else password?.focus()
    })
  }
  async function browse(path?: string, mayFocus?: () => boolean) {
    const focus = captureRequestFocus()
    const retained = () => focus.retained() && (mayFocus?.() ?? true)
    controller?.abort()
    controller = new AbortController()
    const current = ++generation
    setBusy(true)
    setError("")
    try {
      const value = await serverApi.browseRemoteServer(props.profile.id, path, controller.signal)
      if (current !== generation) return
      setResult(value)
      props.onConnected?.()
      queueMicrotask(() => { if (retained()) root?.querySelector<HTMLElement>("[data-remote-folder]")?.focus() })
    } catch (error) { if (current === generation) failure(error, retained) }
    finally { focus.dispose(); if (current === generation) setBusy(false) }
  }
  async function connect(event: SubmitEvent) {
    event.preventDefault()
    if (busy() || !password?.value) return
    const focus = captureRequestFocus()
    setBusy(true)
    const current = generation
    const entered = password.value
    password.value = ""
    try {
      await serverApi.connectRemoteServer(props.profile.id, { username: username(), password: entered })
      if (current === generation) await browse(result()?.listing.metadata.currentPath, focus.retained)
    } catch (error) { if (current === generation) failure(error, focus.retained) }
    finally { focus.dispose(); if (current === generation) setBusy(false) }
  }
  onMount(() => void browse())
  onCleanup(() => { ++generation; controller?.abort(); if (password) password.value = "" })
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
        <form class="remote-server-signin" onSubmit={(event) => void connect(event)}>
          <label class="remote-server-label"><span>{t("authRecovery.username")}</span>
          <input class="selector-input" data-browse-nav aria-label={t("authRecovery.username")} autocomplete="username"
            value={username()} onInput={(event) => setUsername(event.currentTarget.value)} disabled={busy()} />
          </label>
          <label class="remote-server-label"><span>{t("authRecovery.password")}</span>
          <input class="selector-input" data-browse-nav ref={password} type="password" autocomplete="current-password"
            aria-label={t("authRecovery.password")} aria-invalid={error() === "auth" ? true : undefined}
            aria-describedby={error() === "auth" ? errorId : undefined} disabled={busy()} />
          </label>
          <button type="submit" class="selector-button selector-button-primary" data-browse-nav disabled={busy()}>{t("authRecovery.signIn")}</button>
        </form>
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
            <div class="remote-server-path"><span dir="ltr" tabindex="0" aria-label={listing().metadata.displayPath}>{listing().metadata.displayPath}</span><SettingsInfoTip text={listing().metadata.displayPath} /></div>
            <Show when={listing().metadata.pathKind !== "drives"}>
              <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => props.onSelect(listing().metadata.currentPath)}>
                <FolderOpen class="w-4 h-4 icon-muted" aria-hidden="true" /><span>{t(opensRemoteProjectTab(props.profile) ? "remoteBrowse.openFolder" : "remoteBrowse.openSeparateWindow")}</span>
              </button>
            </Show>
            <Show when={listing().metadata.parentPath !== undefined}>
              <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => void browse(listing().metadata.parentPath)}>
                <ArrowUp class="w-4 h-4 icon-muted" aria-hidden="true" /><span>{t("directoryBrowser.goToParent")}</span>
              </button>
            </Show>
            <Show when={value().recents.length}><h3 class="remote-server-section">{t("remoteBrowse.recents")}</h3></Show>
            <For each={value().recents}>{(recent) => {
              const target: LaunchableRecent = { ...recent, remote: { profileId: props.profile.id, serverName: name() } }
              return <div class="flex items-center min-w-0">
              <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} title={recent.path}
                onClick={() => props.onSelect(recent.path)}>
                <FolderOpen class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" /><bdi class="browse-menu-name">{getProjectDisplayName(recent.path, recent.projectName)}</bdi>
                <span class="browse-menu-meta" dir="ltr">{recent.path}</span>
                <Show when={!opensRemoteProjectTab(props.profile)}><span class="browse-menu-meta">{t("remoteBrowse.openSeparateWindow")}</span></Show>
              </button>
              <Show when={recentOpenTarget(target)}>
                <button type="button" class="window-action shrink-0" data-browse-nav disabled={busy()}
                  aria-label={`${t("folderSelection.recent.switchToOpenProject")} · ${recentAccessibleName(target)}`}
                  onClick={() => { if (!busy()) joinRecentOpenTarget(target, () => {}) }}>
                  {t("folderSelection.recent.openBadge")}
                </button>
              </Show>
              </div>
            }}</For>
            <h3 class="remote-server-section">{t("remoteBrowse.folders")}</h3>
            <For each={listing().entries}>{(entry) =>
              <button type="button" class="browse-menu-row" data-browse-nav data-remote-folder disabled={busy()} title={entry.path} aria-description={entry.path} onClick={() => void browse(entry.path)}>
                <Folder class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" /><bdi class="browse-menu-name">{entry.name}</bdi><ChevronRight class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
              </button>
            }</For>
          </>
        }}
      </Show>
    </div>
  )
}

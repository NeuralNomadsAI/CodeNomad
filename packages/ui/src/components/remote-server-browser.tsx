import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { ArrowLeft, ArrowUp, Folder, Loader2 } from "lucide-solid"
import type { RemoteServerBrowseResponse, RemoteServerProfile } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { getProjectDisplayName } from "../lib/recent-folder-display"

/** Remote metadata is read by the local backend; only this component's password input holds entered text. */
export default function RemoteServerBrowser(props: {
  profile: RemoteServerProfile
  onBack: () => void
  onSelect: (folder: string) => void
}) {
  const { t } = useI18n()
  const [result, setResult] = createSignal<RemoteServerBrowseResponse>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [username, setUsername] = createSignal("codenomad")
  let password: HTMLInputElement | undefined
  let root: HTMLDivElement | undefined
  let controller: AbortController | undefined
  let generation = 0
  const needsCredentials = () => error() === "needs_credentials" || error() === "auth" || error() === "pairing_unavailable"
  function failure(value: unknown) {
    const code = value instanceof Error ? value.message : "unreachable"
    setError(["needs_credentials", "auth", "pairing_unavailable", "tls_error"].includes(code) ? code : "unreachable")
    if (needsCredentials()) queueMicrotask(() => password?.focus())
  }
  async function browse(path?: string) {
    controller?.abort()
    controller = new AbortController()
    const current = ++generation
    setBusy(true)
    setError("")
    try {
      const value = await serverApi.browseRemoteServer(props.profile.id, path, controller.signal)
      if (current !== generation) return
      setResult(value)
      queueMicrotask(() => root?.querySelector<HTMLElement>("[data-remote-folder]")?.focus())
    } catch (error) { if (current === generation) failure(error) }
    finally { if (current === generation) setBusy(false) }
  }
  async function connect(event: SubmitEvent) {
    event.preventDefault()
    if (busy() || !password?.value) return
    setBusy(true)
    const current = generation
    const entered = password.value
    password.value = ""
    try {
      await serverApi.connectRemoteServer(props.profile.id, { username: username(), password: entered })
      if (current === generation) await browse(result()?.listing.metadata.currentPath)
    } catch (error) { if (current === generation) failure(error) }
    finally { if (current === generation) setBusy(false) }
  }
  onMount(() => void browse())
  onCleanup(() => { ++generation; controller?.abort(); if (password) password.value = "" })
  return (
    <div class="remote-server-browser" ref={root} aria-busy={busy()}>
      <button type="button" class="browse-menu-row" data-browse-nav onClick={props.onBack}>
        <ArrowLeft class="w-4 h-4 icon-muted" aria-hidden="true" /><span>{t("remoteBrowse.back")}</span>
      </button>
      <Show when={needsCredentials()}>
        <form class="remote-server-signin" onSubmit={(event) => void connect(event)}>
          <input class="selector-input" data-browse-nav aria-label={t("authRecovery.username")} autocomplete="username"
            value={username()} onInput={(event) => setUsername(event.currentTarget.value)} disabled={busy()} />
          <input class="selector-input" data-browse-nav ref={password} type="password" autocomplete="current-password"
            aria-label={t("authRecovery.password")} disabled={busy()} />
          <button type="submit" class="selector-button selector-button-primary" data-browse-nav disabled={busy()}>{t("authRecovery.signIn")}</button>
        </form>
      </Show>
      <Show when={error() && error() !== "needs_credentials"}>
        <p class="server-add-field-error" role="alert">{t(error() === "auth" ? "authRecovery.credentials"
          : error() === "pairing_unavailable" ? "remoteBrowse.pairingUnavailable"
          : error() === "tls_error" ? "remoteBrowse.tlsError" : "folderSelection.servers.dialog.errorConnect")}</p>
      </Show>
      <Show when={busy()}><Loader2 class="w-4 h-4 animate-spin" aria-label={t("authRecovery.pending")} /></Show>
      <Show when={!needsCredentials() && error()}>
        <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => void browse()}>{t("filesystemBrowser.actions.retry")}</button>
      </Show>
      <Show when={!error() && result()}>
        {(value) => {
          const listing = () => value().listing
          return <>
            <div class="remote-server-path" dir="ltr">{listing().metadata.displayPath}</div>
            <Show when={listing().metadata.pathKind !== "drives"}>
              <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => props.onSelect(listing().metadata.currentPath)}>
                <Folder class="w-4 h-4 icon-muted" aria-hidden="true" /><span>{t("filesystemBrowser.currentFolder.selectCurrent")}</span>
              </button>
            </Show>
            <Show when={listing().metadata.parentPath !== undefined}>
              <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} onClick={() => void browse(listing().metadata.parentPath)}>
                <ArrowUp class="w-4 h-4 icon-muted" aria-hidden="true" /><span>{t("directoryBrowser.goToParent")}</span>
              </button>
            </Show>
            <For each={value().recents}>{(recent) =>
              <button type="button" class="browse-menu-row" data-browse-nav disabled={busy()} title={recent.path} onClick={() => props.onSelect(recent.path)}>
                <Folder class="w-4 h-4 icon-muted" aria-hidden="true" /><span class="browse-menu-name">{getProjectDisplayName(recent.path, recent.projectName)}</span>
                <span class="browse-menu-meta">{recent.path}</span>
              </button>
            }</For>
            <For each={listing().entries}>{(entry) =>
              <button type="button" class="browse-menu-row" data-browse-nav data-remote-folder disabled={busy()} title={entry.path} onClick={() => void browse(entry.path)}>
                <Folder class="w-4 h-4 icon-muted" aria-hidden="true" /><span class="browse-menu-name">{entry.name}</span>
              </button>
            }</For>
          </>
        }}
      </Show>
    </div>
  )
}

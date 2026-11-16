import { createSignal, onCleanup, Show } from "solid-js"
import { useI18n } from "../lib/i18n"
import { serverApi } from "../lib/api-client"
import { backendRegistry } from "../stores/remote-backends"
import { preferencesForBackend } from "../stores/preferences"
import type { RemoteRestoreTab } from "../stores/remote-restore-tabs"
import { secretEntryAllowed } from "../lib/server-meta"
import { backendIdOf, LOCAL_BACKEND_ID } from "../lib/backend-identity"

export default function RemoteRestoreView(props: { tab: RemoteRestoreTab }) {
  const { t } = useI18n()
  const id = () => backendIdOf(props.tab.snapshot)
  const local = () => id() === LOCAL_BACKEND_ID
  const available = () => local() || !!profile()
  const profile = () => preferencesForBackend("local").remoteServers().find(profile => profile.id === id())
  const [busy, setBusy] = createSignal(false)
  const [connecting, setConnecting] = createSignal(false)
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [pairingLink, setPairingLink] = createSignal("")
  const [error, setError] = createSignal("")
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const run = async (connect: boolean, open = false) => {
    if (busy()) return
    setBusy(true)
    setError("")
    try {
      if (connect) {
        if (!secretEntryAllowed()) {
          setError("remoteBrowse.secretEntryForbidden"); return
        }
        await serverApi.connectRemoteBackend(id(), pairingLink().trim()
          ? { pairingLink: pairingLink().trim() } : { username: username(), password: password() }, controller.signal)
        if (controller.signal.aborted) return
        backendRegistry.detach(id())
        setConnecting(false)
      }
      if (open) await props.tab.open?.()
      else await props.tab.retry()
    } catch { if (!controller.signal.aborted) setError("folderSelection.servers.dialog.errorConnect") }
    finally { setPassword(""); setPairingLink(""); setBusy(false) }
  }
  return <section class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-4" data-remote-restore={id()}>
    <h2 class="text-primary">{local() ? props.tab.snapshot.projectName ?? props.tab.snapshot.folder : profile()?.name ?? id()}</h2>
    <Show when={!local()}><span class="text-secondary">{props.tab.snapshot.folder}</span></Show>
    <span role="status">{t(`remoteRestore.${local() ? "compatible" : !profile() ? "absent" : backendRegistry.state(id())}`)}</span>
    <Show when={error()}><span role="alert">{t(error())}</span></Show>
    <Show when={!local() && connecting()}>
      <form class="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void run(true) }}>
        <label>{t("authRecovery.username")}<input class="selector-input" autocomplete="username" value={username()} onInput={event => setUsername(event.currentTarget.value)} /></label>
        <label>{t("authRecovery.password")}<input class="selector-input" type="password" autocomplete="current-password" disabled={!secretEntryAllowed()} value={password()} onInput={event => setPassword(event.currentTarget.value)} /></label>
        <label>{t("remoteRestore.pairingLink")}<input class="selector-input" type="password" autocomplete="off" disabled={!secretEntryAllowed()} value={pairingLink()} onInput={event => setPairingLink(event.currentTarget.value)} /></label>
        <button class="selector-button" disabled={busy() || !secretEntryAllowed()}>{t("folderSelection.servers.dialog.connect")}</button>
        <Show when={!secretEntryAllowed() && !error()}><span role="alert">{t("remoteBrowse.secretEntryForbidden")}</span></Show>
      </form>
    </Show>
    <div class="flex gap-3">
      <Show when={props.tab.open && (local() || backendRegistry.state(id()) === "compatible")}>
        <button class="selector-button" disabled={busy() || !available()} onClick={() => void run(false, true)}>{t("directoryBrowser.openCurrent")}</button>
      </Show>
      <button class="selector-button" disabled={busy() || !available()} onClick={() => void run(false)}>{t("filesystemBrowser.actions.retry")}</button>
      <Show when={!local()}><button class="selector-button" disabled={busy() || !profile()} onClick={() => setConnecting(value => !value)}>{t("folderSelection.servers.dialog.connect")}</button></Show>
    </div>
  </section>
}

import { createSignal, onCleanup, Show } from "solid-js"
import { useI18n } from "../lib/i18n"
import { serverApi } from "../lib/api-client"
import { backendRegistry } from "../stores/remote-backends"
import { preferencesForBackend } from "../stores/preferences"
import type { RemoteRestoreTab } from "../stores/remote-restore-tabs"

export default function RemoteRestoreView(props: { tab: RemoteRestoreTab }) {
  const { t } = useI18n()
  const id = () => props.tab.snapshot.backendId!
  const profile = () => preferencesForBackend("local").remoteServers().find(profile => profile.id === id())
  const [busy, setBusy] = createSignal(false)
  const [connecting, setConnecting] = createSignal(false)
  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [pairingLink, setPairingLink] = createSignal("")
  const [error, setError] = createSignal(false)
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const run = async (connect: boolean) => {
    if (busy()) return
    setBusy(true)
    setError(false)
    try {
      if (connect) {
        await serverApi.connectRemoteBackend(id(), pairingLink().trim()
          ? { pairingLink: pairingLink().trim() } : { username: username(), password: password() }, controller.signal)
        if (controller.signal.aborted) return
        backendRegistry.detach(id())
        setConnecting(false)
      }
      await props.tab.retry()
    } catch { if (!controller.signal.aborted) setError(true) }
    finally { setPassword(""); setPairingLink(""); setBusy(false) }
  }
  return <section class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-4" data-remote-restore={id()}>
    <h2 class="text-primary">{profile()?.name ?? id()}</h2>
    <span class="text-secondary">{props.tab.snapshot.folder}</span>
    <span role="status">{t(`remoteRestore.${!profile() ? "absent" : backendRegistry.state(id())}`)}</span>
    <Show when={error()}><span role="alert">{t("folderSelection.servers.dialog.errorConnect")}</span></Show>
    <Show when={connecting()}>
      <form class="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void run(true) }}>
        <label>{t("authRecovery.username")}<input class="selector-input" autocomplete="username" value={username()} onInput={event => setUsername(event.currentTarget.value)} /></label>
        <label>{t("authRecovery.password")}<input class="selector-input" type="password" autocomplete="current-password" value={password()} onInput={event => setPassword(event.currentTarget.value)} /></label>
        <label>{t("remoteRestore.pairingLink")}<input class="selector-input" type="password" autocomplete="off" value={pairingLink()} onInput={event => setPairingLink(event.currentTarget.value)} /></label>
        <button class="selector-button" disabled={busy()}>{t("folderSelection.servers.dialog.connect")}</button>
      </form>
    </Show>
    <div class="flex gap-3">
      <button class="selector-button" disabled={busy() || !profile()} onClick={() => void run(false)}>{t("filesystemBrowser.actions.retry")}</button>
      <button class="selector-button" disabled={busy() || !profile()} onClick={() => setConnecting(value => !value)}>{t("folderSelection.servers.dialog.connect")}</button>
    </div>
  </section>
}

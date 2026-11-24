import { createSignal, onCleanup, Show } from "solid-js"
import { useI18n } from "../lib/i18n"
import { serverApi } from "../lib/api-client"
import { backendRegistry } from "../stores/remote-backends"
import { preferencesForBackend } from "../stores/preferences"
import type { RemoteRestoreTab } from "../stores/remote-restore-tabs"
import { backendIdOf, LOCAL_BACKEND_ID } from "../lib/backend-identity"
import { matchesRestoredServer } from "../stores/app-session-reconciliation"
import { supportsPairingLink } from "../lib/remote-pairing-link"
import { captureRequestFocus } from "../lib/request-focus"
import { remoteServerErrorKey } from "../lib/hooks/use-remote-server-profiles"
import RemoteServerSignin from "./remote-server-signin"
import ServerAddField from "./server-add-field"

export default function RemoteRestoreView(props: { tab: RemoteRestoreTab }) {
  const { t } = useI18n()
  const id = () => backendIdOf(props.tab.snapshot)
  const local = () => id() === LOCAL_BACKEND_ID
  const profile = () => preferencesForBackend("local").remoteServers().find(profile => profile.id === id())
  const available = () => local() || !!profile()
  const pairing = () => !!profile() && supportsPairingLink(profile()!.baseUrl)
  const password = () => !!profile() && !new URL(profile()!.baseUrl).hostname.endsWith(".opentunnel.xyz")
  const status = () => {
    if (local()) return "compatible"
    if (!profile()) return "absent"
    const state = backendRegistry.state(id())
    return state === "compatible" && !matchesRestoredServer(props.tab.snapshot, backendRegistry.serverId(id())) ? "refused" : state
  }
  const [busy, setBusy] = createSignal(false)
  const [connecting, setConnecting] = createSignal(false)
  const [error, setError] = createSignal("")
  let view!: HTMLElement
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const showConnect = () => {
    const show = !connecting()
    setError("")
    setConnecting(show)
    if (show) queueMicrotask(() => view.querySelector<HTMLElement>("[data-remote-password], [data-server-add-field]")?.focus())
  }
  const run = async (connect?: { username: string; password: string } | "paired") => {
    if (busy()) return
    const focus = captureRequestFocus()
    setBusy(true)
    setError("")
    try {
      if (connect) {
        if (connect !== "paired") await serverApi.connectRemoteServer(id(), connect, controller.signal)
        if (controller.signal.aborted) return
        backendRegistry.detach(id())
        setConnecting(false)
      }
      await props.tab.retry()
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(connect && connect !== "paired" ? remoteServerErrorKey(failure) : "folderSelection.servers.dialog.errorConnect")
        if (connect && focus.retained()) view.querySelector<HTMLElement>("[data-remote-password]")?.focus()
      }
    } finally { setBusy(false); focus.dispose() }
  }
  return <section ref={view} class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-4" data-remote-restore={id()}>
    <h2 class="text-primary">{local() ? props.tab.snapshot.projectName ?? props.tab.snapshot.folder : profile()?.name ?? id()}</h2>
    <Show when={!local()}><span class="text-secondary">{props.tab.snapshot.folder}</span></Show>
    <span role="status">{t(status() === "unauthorized" ? "remoteBrowse.connectionRequired" : `remoteRestore.${status()}`)}</span>
    <Show when={error() && !(connecting() && password())}><span role="alert">{t(error())}</span></Show>
    <Show when={!local() && connecting() && profile()} keyed>{server => <>
      <Show when={password()}><RemoteServerSignin busy={busy()} error={error()} onConnect={credentials => void run(credentials)} /></Show>
      <Show when={pairing()}><ServerAddField pairingProfile={server} disabled={busy()} onAdded={() => void run("paired")} /></Show>
    </>}</Show>
    <div class="flex gap-3">
      <button class="selector-button" disabled={busy() || !available()} onClick={() => void run()}>{t("filesystemBrowser.actions.retry")}</button>
      <Show when={!local()}><button class="selector-button" disabled={busy() || !profile()} aria-expanded={connecting()} onClick={showConnect}>{t("folderSelection.servers.dialog.connect")}</button></Show>
    </div>
  </section>
}

import { Show, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { ArrowLeft, Loader2 } from "lucide-solid"
import type { RemoteServerProfile } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { captureRequestFocus } from "../lib/request-focus"
import { serverDisplayName } from "../lib/codenomad-link"
import type { RemoteViewOpenPayload } from "../lib/native/remote-view"
import RemoteServerSignin from "./remote-server-signin"
import ServerAddField from "./server-add-field"

/** A mounted, disposable session handshake. The cookie goes straight to its caller. */
export default function RemoteViewSession(props: {
  profile: RemoteServerProfile
  active?: boolean
  onReady: (cookie: RemoteViewOpenPayload["cookie"]) => void
  onBack?: () => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const errorId = createUniqueId()
  const credentials = () => ["needs_credentials", "auth", "pairing_unavailable"].includes(error())
  const pairing = () => credentials() && new URL(props.profile.baseUrl).hostname.endsWith(".opentunnel.xyz")
  let root!: HTMLDivElement
  let password: HTMLInputElement | undefined
  const controller = new AbortController()
  let disposed = false
  async function request(login?: { username: string; password: string }, mayFocus?: () => boolean) {
    if (disposed || busy()) return
    const focus = captureRequestFocus()
    setBusy(true)
    try {
      if (login) await serverApi.connectRemoteServer(props.profile.id, login)
      if (disposed) return
      const { cookie } = await serverApi.remoteViewSession(props.profile.id, controller.signal)
      if (!disposed) props.onReady(cookie)
    } catch (cause) {
      if (disposed) return
      const code = cause instanceof Error ? cause.message : "unreachable"
      setError(["needs_credentials", "auth", "pairing_unavailable", "tls_error"].includes(code) ? code : "unreachable")
      queueMicrotask(() => {
        if (disposed || props.active === false || !focus.retained() || mayFocus?.() === false) return
        if (pairing()) root.querySelector<HTMLInputElement>("[data-server-add-field]")?.focus()
        else if (credentials()) password?.focus()
      })
    } finally { if (!disposed) setBusy(false); queueMicrotask(() => focus.dispose()) }
  }
  onMount(() => void request())
  onCleanup(() => { disposed = true; controller.abort() })
  return <div ref={root} class="remote-server-browser" aria-busy={busy()} data-remote-view-session
    onKeyDown={(event) => {
      if (event.key === "Escape" && props.onBack) { event.preventDefault(); event.stopPropagation(); props.onBack() }
    }}>
    <div class="remote-server-navigation">
      <Show when={props.onBack}><button type="button" class="window-icon-button" data-browse-nav onClick={() => props.onBack?.()}
        aria-label={t("remoteBrowse.back")} title={t("remoteBrowse.back")}><ArrowLeft class="w-4 h-4" /></button></Show>
      <bdi class="browse-menu-name" dir="auto">{serverDisplayName(props.profile)}</bdi>
    </div>
    <Show when={pairing()}>
      <p class="server-add-field-error" role="alert">{t("remoteBrowse.pairAgain", { name: serverDisplayName(props.profile) })}</p>
      <ServerAddField navAttribute="data-browse-nav" pairingProfile={props.profile} onAdded={(_id, mayFocus) => void request(undefined, mayFocus)} />
    </Show>
    <Show when={credentials() && !pairing()}>
      <RemoteServerSignin busy={busy()} error={error()} errorId={errorId} passwordRef={(input) => { password = input }} onConnect={(login) => void request(login)} />
    </Show>
    <Show when={error() && error() !== "needs_credentials" && !pairing()}>
      <p id={errorId} class="server-add-field-error" role="alert">{t(error() === "auth" ? "authRecovery.credentials"
        : error() === "pairing_unavailable" ? "remoteBrowse.pairingUnavailable"
        : error() === "tls_error" ? "remoteBrowse.tlsError" : "remoteBrowse.unreachable")}</p>
    </Show>
    <Show when={busy()}><Loader2 class="w-4 h-4 animate-spin" aria-label={t("authRecovery.pending")} /></Show>
    <Show when={error() && !credentials()}><button type="button" class="browse-menu-row" data-browse-nav disabled={busy()}
      onClick={() => void request()}>{t("filesystemBrowser.actions.retry")}</button></Show>
  </div>
}

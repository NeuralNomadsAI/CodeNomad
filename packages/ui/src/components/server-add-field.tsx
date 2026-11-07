import { Show, createSignal, createUniqueId } from "solid-js"
import { Loader2, Plus } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { classifyCodeNomadLink, codeNomadLinkName, serverDisplayName } from "../lib/codenomad-link"
import { RemoteServerProbeError, useRemoteServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import type { RemoteServerProfile } from "../../../server/src/api-types"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { captureRequestFocus } from "../lib/request-focus"

interface ServerAddFieldProps {
  disabled?: boolean
  /** Called with the saved row's ID, e.g. to focus it in Browse. */
  onAdded?: (id: string, mayFocus?: () => boolean) => void
  onPairingFailure?: (id: string) => void
  /** Marks the field as a Browse row for its arrow-key navigation. */
  navAttribute?: string
  pairingProfile?: RemoteServerProfile
}

const carriesCredentials = (value: string) => /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(value.trim())

/**
 * Adds a CodeNomad server from a pasted address or Remote Control pairing link,
 * inline: the server is saved under its host name. Only a
 * certificate that fails the check offers skipping it, confirmed through the
 * same field.
 */
export default function ServerAddField(props: ServerAddFieldProps) {
  const { t } = useI18n()
  const { remoteServers, submitServer } = useRemoteServerProfiles()
  const [address, setAddress] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [diagnostic, setDiagnostic] = createSignal<string>()
  const [errorServer, setErrorServer] = createSignal("")
  // The certificate check failed for this address: the field offers skipping it.
  const [tlsFailedFor, setTlsFailedFor] = createSignal<string>()
  const [skipTls, setSkipTls] = createSignal(false)
  const errorId = createUniqueId()

  function reset() {
    setAddress("")
    setError(undefined)
    setDiagnostic(undefined)
    setErrorServer("")
    setTlsFailedFor(undefined)
    setSkipTls(false)
  }

  async function add(text: string) {
    const value = text.trim()
    if (!value || busy() || props.disabled) return
    setError(undefined)
    setDiagnostic(undefined)
    setErrorServer("")
    const link = classifyCodeNomadLink(value)
    if (!link) {
      setError(carriesCredentials(value) ? "folderSelection.browseMenu.errorCredentials" : "folderSelection.browseMenu.errorInvalid")
      return
    }
    if (props.pairingProfile && (link.kind !== "pairing" || link.baseUrl !== props.pairingProfile.baseUrl)) {
      setAddress("")
      setErrorServer(serverDisplayName(props.pairingProfile, remoteServers()))
      setError("remoteBrowse.pairAgain")
      return
    }
    const existing = remoteServers().find((server) => server.baseUrl === link.baseUrl)
    const skipping = tlsFailedFor() === link.baseUrl && skipTls()
    const input = {
      id: existing?.id, name: existing?.name ?? "", baseUrl: value,
      skipTlsVerify: skipping || (existing?.skipTlsVerify ?? false),
    }
    const focus = captureRequestFocus()
    setBusy(true)
    try {
      const profile = await submitServer(input, false)
      reset()
      props.onAdded?.(profile.id, focus.retained)
    } catch (failure) {
      if (link.kind === "pairing") {
        const code = failure instanceof RemoteServerProbeError ? failure.code : failure instanceof Error ? failure.message : "unreachable"
        reset()
        const saved = remoteServers().find(server => server.baseUrl === link.baseUrl)
        const name = saved ? serverDisplayName(saved, remoteServers()) : codeNomadLinkName(link.baseUrl)
        const reason = code === "pairing_unavailable" ? "remoteBrowse.pairingUnavailable"
          : code === "pairing_expired" ? "remoteBrowse.pairingExpired"
          : code === "pairing_rate_limited" ? "remoteBrowse.pairingRateLimited"
          : code === "tls_error" ? "remoteBrowse.tlsError" : "remoteBrowse.unreachable"
        setErrorServer(name)
        setError(reason)
        if (saved && !props.pairingProfile) {
          props.onAdded?.(saved.id, focus.retained)
          props.onPairingFailure?.(saved.id)
        }
        return
      }
      const tls = failure instanceof RemoteServerProbeError && failure.code === "tls_error" && link.kind === "address"
      setError(tls ? "remoteBrowse.tlsError" : "remoteBrowse.unreachable")
      setDiagnostic(failure instanceof Error ? failure.message : undefined)
      setTlsFailedFor(tls ? link.baseUrl : undefined)
      if (!tls) setSkipTls(false)
    } finally {
      focus.dispose()
      setBusy(false)
    }
  }

  const nav = () => (props.navAttribute ? { [props.navAttribute]: "" } : {})

  return (
    <div class="server-add-field">
      <form class="server-add-field-row" onSubmit={(event) => { event.preventDefault(); void add(address()) }}>
        <input type="text" class="server-add-field-input" autocomplete="off" spellcheck={false} {...nav()}
          data-server-add-field
          aria-label={t(props.pairingProfile ? "remoteBrowse.pairingLink" : "folderSelection.browseMenu.addField")}
          placeholder={t(props.pairingProfile ? "remoteBrowse.pairingLink" : "folderSelection.browseMenu.addField")}
          aria-describedby={error() ? errorId : undefined}
          aria-invalid={error() ? "true" : undefined}
          value={address()} disabled={busy() || props.disabled}
          onInput={(event) => {
            setAddress(event.currentTarget.value)
            setError(undefined)
            setDiagnostic(undefined)
            setErrorServer("")
          }}
          onPaste={(event) => {
            // A pasted link or address is added at once.
            const pasted = event.clipboardData?.getData("text") ?? ""
            if (!classifyCodeNomadLink(pasted)) return
            event.preventDefault()
            setAddress(pasted.trim())
            void add(pasted)
          }} />
        <button type="submit" class="window-icon-button" disabled={busy() || props.disabled || !address().trim()}
          aria-label={t("folderSelection.browseMenu.add")} title={t("folderSelection.browseMenu.add")}>
          <Show when={busy()} fallback={<Plus class="w-4 h-4" aria-hidden="true" />}>
            <Loader2 class="w-4 h-4 animate-spin" aria-hidden="true" />
          </Show>
        </button>
      </form>
      <Show when={error()}>
        {(message) => <p id={errorId} class="server-add-field-error" role="alert"><Show when={errorServer() && message() !== "remoteBrowse.pairAgain"}><bdi>{errorServer()}</bdi>{" — "}</Show><span>{t(message(), { name: errorServer() })}</span> <Show when={diagnostic()}>{(detail) => <SettingsInfoTip text={detail()} />}</Show></p>}
      </Show>
      <Show when={tlsFailedFor()}>
        <label class="server-add-field-option">
          <input type="checkbox" checked={skipTls()} disabled={busy()} onChange={(event) => setSkipTls(event.currentTarget.checked)} />
          <span>{t("folderSelection.browseMenu.skipTls")}</span>
        </label>
      </Show>
    </div>
  )
}

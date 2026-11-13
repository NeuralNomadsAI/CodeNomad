import { Show, createSignal, createUniqueId, createEffect, on, onCleanup } from "solid-js"
import { Loader2, Plus } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { carriesCredentials, classifyCodeNomadLink, codeNomadLinkName, serverDisplayName } from "../lib/codenomad-link"
import { RemoteServerProbeError, remoteServerErrorKey, useRelayServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import type { RemoteServerProfile } from "../../../server/src/api-types"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { captureRequestFocus } from "../lib/request-focus"

interface ServerAddFieldProps {
  disabled?: boolean
  onAdded?: (id: string, mayFocus?: () => boolean) => void
  onPairingFailure?: (id: string) => void
  navAttribute?: string
  pairingProfile?: RemoteServerProfile
}

export default function ServerAddField(props: ServerAddFieldProps) {
  const { t } = useI18n()
  const { remoteServers, submitServer, enabled } = useRelayServerProfiles()
  const [address, setAddress] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [diagnostic, setDiagnostic] = createSignal<string>()
  const [errorServer, setErrorServer] = createSignal("")
  const [tlsFailedFor, setTlsFailedFor] = createSignal<string>()
  const [skipTls, setSkipTls] = createSignal(false)
  const errorId = createUniqueId()
  let generation = 0, alive = true
  let releaseFocus = () => {}
  const invalidate = () => { generation++; releaseFocus(); setBusy(false) }
  createEffect(() => { props.pairingProfile; if (!enabled() || props.disabled) { invalidate(); reset() } })
  createEffect(on(() => props.pairingProfile && `${props.pairingProfile.id}|${props.pairingProfile.baseUrl}|${props.pairingProfile.skipTlsVerify}|${props.pairingProfile.ssh?.host}`, () => { invalidate(); reset() }, { defer: true }))
  onCleanup(() => { alive = false; generation++; releaseFocus(); setAddress("") })

  function reset() {
    setAddress(""); setError(undefined); setDiagnostic(undefined); setErrorServer(""); setTlsFailedFor(undefined); setSkipTls(false)
  }
  function changed(value: string) {
    invalidate()
    setAddress(value); setError(undefined); setDiagnostic(undefined); setErrorServer("")
    if (classifyCodeNomadLink(value)?.baseUrl !== tlsFailedFor()) { setTlsFailedFor(undefined); setSkipTls(false) }
  }
  async function add(text: string) {
    const value = text.trim()
    if (!value || busy() || props.disabled || !enabled()) return
    setError(undefined); setDiagnostic(undefined); setErrorServer("")
    const link = classifyCodeNomadLink(value)
    if (!link) {
      setError(carriesCredentials(value) ? "folderSelection.browseMenu.errorCredentials" : "folderSelection.browseMenu.errorInvalid")
      if (carriesCredentials(value)) setAddress("")
      return
    }
    const target = props.pairingProfile && { ...props.pairingProfile, ssh: props.pairingProfile.ssh && { ...props.pairingProfile.ssh } }
    if (target && (link.kind !== "pairing" || link.baseUrl !== target.baseUrl)) {
      setAddress(""); setErrorServer(serverDisplayName(target, remoteServers())); setError("remoteBrowse.pairAgain"); return
    }
    const existing = remoteServers().find(server => server.baseUrl === link.baseUrl && server.ssh === undefined)
    const input = { id: target?.id ?? existing?.id, name: target?.name ?? existing?.name ?? "", baseUrl: value,
      skipTlsVerify: tlsFailedFor() === link.baseUrl && skipTls() || (target?.skipTlsVerify ?? existing?.skipTlsVerify ?? false),
      ...(target?.ssh ? { ssh: { ...target.ssh } } : {}) }
    const flight = ++generation, focus = captureRequestFocus()
    releaseFocus = focus.dispose
    const current = () => alive && flight === generation && enabled() && !props.disabled
      && (!target || props.pairingProfile?.id === target.id && props.pairingProfile.baseUrl === target.baseUrl && props.pairingProfile.skipTlsVerify === target.skipTlsVerify && props.pairingProfile.ssh?.host === target.ssh?.host)
    if (link.kind === "pairing") setAddress("")
    setBusy(true)
    try {
      const profile = await submitServer(input, false, current)
      if (!current()) return
      reset()
      props.onAdded?.(profile.id, () => current() && focus.retained())
    } catch (failure) {
      if (!current() || failure instanceof DOMException && failure.name === "AbortError") return
      if (link.kind === "pairing") {
        reset()
        const saved = remoteServers().find(server => target ? server.id === target.id : server.baseUrl === link.baseUrl && server.ssh === undefined)
        setErrorServer(saved ? serverDisplayName(saved, remoteServers()) : codeNomadLinkName(link.baseUrl))
        setError(remoteServerErrorKey(failure))
        if (saved && !target) { props.onAdded?.(saved.id, () => current() && focus.retained()); props.onPairingFailure?.(saved.id) }
        return
      }
      const tls = failure instanceof RemoteServerProbeError && failure.code === "tls_error"
      setError(remoteServerErrorKey(failure))
      // Diagnostics use reviewed localized reasons, never exception text or remote bodies.
      setDiagnostic(t(remoteServerErrorKey(failure)))
      setTlsFailedFor(tls ? link.baseUrl : undefined)
      if (!tls) setSkipTls(false)
    } finally {
      focus.dispose()
      if (current()) { setBusy(false); if (link.kind === "pairing") setAddress("") }
    }
  }
  const nav = () => props.navAttribute ? { [props.navAttribute]: "" } : {}
  return (
    <div class="server-add-field">
      <form class="server-add-field-row" onSubmit={event => { event.preventDefault(); void add(address()) }}>
        <input type="text" class="server-add-field-input" autocomplete="off" spellcheck={false} {...nav()} data-server-add-field
          aria-label={t(props.pairingProfile ? "remoteBrowse.pairingLink" : "folderSelection.browseMenu.addField")}
          placeholder={t(props.pairingProfile ? "remoteBrowse.pairingLink" : "folderSelection.browseMenu.addField")}
          aria-describedby={error() ? errorId : undefined} aria-invalid={error() ? "true" : undefined}
          value={address()} disabled={busy() || props.disabled}
          onKeyDown={event => { if (event.isComposing && event.key === "Enter") event.preventDefault() }}
          onInput={event => changed(event.currentTarget.value)}
          onPaste={event => {
            const pasted = event.clipboardData?.getData("text") ?? ""
            if (!classifyCodeNomadLink(pasted)) return
            event.preventDefault(); changed(pasted.trim()); void add(pasted)
          }} />
        <button type="submit" class="window-icon-button" disabled={busy() || props.disabled || !address().trim()}
          aria-label={t("folderSelection.browseMenu.add")} title={t("folderSelection.browseMenu.add")}>
          <Show when={busy()} fallback={<Plus class="w-4 h-4" aria-hidden="true" />}><Loader2 class="w-4 h-4 animate-spin" aria-hidden="true" /></Show>
        </button>
      </form>
      <Show when={error()}>{message => <p id={errorId} class="server-add-field-error" role="alert"><Show when={errorServer() && message() !== "remoteBrowse.pairAgain"}><bdi>{errorServer()}</bdi>{" — "}</Show><span>{t(message(), { name: errorServer() })}</span> <Show when={diagnostic()}>{detail => <SettingsInfoTip text={detail()} />}</Show></p>}</Show>
      <Show when={tlsFailedFor()}><label class="server-add-field-option">
        <input type="checkbox" checked={skipTls()} disabled={busy()} onChange={event => setSkipTls(event.currentTarget.checked)} />
        <span>{t("folderSelection.browseMenu.skipTls")}</span>
      </label></Show>
    </div>
  )
}

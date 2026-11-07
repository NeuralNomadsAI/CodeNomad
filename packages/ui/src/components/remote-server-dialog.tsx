import { Dialog } from "@kobalte/core/dialog"
import { createEffect, createSignal, Show, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { RemoteServerProbeError, type RemoteServerInput } from "../lib/hooks/use-remote-server-profiles"
import { SettingsInfoTip } from "./settings/settings-info-tip"

interface RemoteServerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: RemoteServerInput, openWindow: boolean) => Promise<unknown>
  /** The saved server to edit (same id, so its storage and sign-in stay). */
  initial?: RemoteServerInput
}

/** Edits a saved server in Settings → Servers: its address, name and certificate check. Servers are added inline. */
export const RemoteServerDialog: Component<RemoteServerDialogProps> = (props) => {
  const { t } = useI18n()
  const [name, setName] = createSignal("")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [skipTlsVerify, setSkipTlsVerify] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [diagnostic, setDiagnostic] = createSignal("")

  createEffect(() => {
    if (!props.open) return
    setName(props.initial?.name ?? "")
    setBaseUrl(props.initial?.baseUrl ?? "")
    setSkipTlsVerify(props.initial?.skipTlsVerify ?? false)
    setError(null)
    setDiagnostic("")
  })

  const submit = async () => {
    if (busy()) return
    setDiagnostic("")
    if (!baseUrl().trim()) {
      setError("folderSelection.servers.dialog.errorRequired")
      return
    }
    if (/^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(baseUrl().trim())) {
      setError("folderSelection.browseMenu.errorCredentials")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await props.onSubmit({ id: props.initial?.id, name: name(), baseUrl: baseUrl(), skipTlsVerify: skipTlsVerify() }, false)
      props.onOpenChange(false)
    } catch (submitError) {
      setError(submitError instanceof RemoteServerProbeError && submitError.code === "tls_error" ? "remoteBrowse.tlsError"
        : submitError instanceof RemoteServerProbeError && submitError.code === "auth" ? "authRecovery.credentials" : "remoteBrowse.unreachable")
      setDiagnostic(submitError instanceof Error ? submitError.message : "")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-[1300] flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-lg flex flex-col max-h-[90dvh]" tabIndex={-1}>
            <div class="window-header"><Dialog.Title class="window-title">{t("folderSelection.remoteProject.edit")}</Dialog.Title></div>
            <div class="window-body flex flex-col gap-4">
            <div class="flex flex-col gap-2 text-sm text-secondary">
              <label class="flex flex-col gap-2">
                <span class="flex items-center gap-2">{t("folderSelection.servers.dialog.url")}<SettingsInfoTip text={t("folderSelection.servers.dialog.urlHint")} /></span>
                <input class="selector-input w-full" aria-label={t("folderSelection.servers.dialog.url")} value={baseUrl()} onInput={(event) => setBaseUrl(event.currentTarget.value)} placeholder={t("folderSelection.servers.dialog.urlPlaceholder")} />
              </label>
            </div>
            {/* Optional: a server without a name reads as its host name. */}
            <label class="flex flex-col gap-2 text-sm text-secondary">
              <span>{t("folderSelection.servers.dialog.name")}</span>
              <input class="selector-input w-full" value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder={t("folderSelection.servers.dialog.namePlaceholder")} />
            </label>
            <label class="flex items-start gap-3 text-sm text-secondary">
              <input type="checkbox" aria-label={t("folderSelection.browseMenu.skipTls")} checked={skipTlsVerify()} onChange={(event) => setSkipTlsVerify(event.currentTarget.checked)} />
              <span>{t("folderSelection.browseMenu.skipTls")}</span><SettingsInfoTip text={t("folderSelection.servers.dialog.skipTls")} />
            </label>
            <Show when={error()}>{(message) => <p class="server-add-field-error" role="alert">{t(message())}<Show when={diagnostic()}><SettingsInfoTip text={diagnostic()} /></Show></p>}</Show>
            </div>
            <div class="window-footer">
              <button type="button" class="selector-button selector-button-secondary w-auto px-4" onClick={() => props.onOpenChange(false)}>{t("folderSelection.servers.dialog.cancel")}</button>
              <button type="button" class="selector-button selector-button-secondary w-auto px-4" disabled={busy()} onClick={() => void submit()}>{t("folderSelection.servers.dialog.save")}</button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

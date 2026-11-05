import { Dialog } from "@kobalte/core/dialog"
import { Loader2 } from "lucide-solid"
import { createEffect, createSignal, createUniqueId, Show, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { defaultServerName, type RemoteServerInput } from "../lib/hooks/use-remote-server-profiles"
import { isOpenCodeServerAddress } from "../lib/opencode-pairing-link"
import { splitPairingLink } from "../lib/remote-pairing-link"

interface RemoteServerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: RemoteServerInput, openWindow: boolean) => Promise<unknown>
}

export const RemoteServerDialog: Component<RemoteServerDialogProps> = (props) => {
  const { t } = useI18n()
  const [name, setName] = createSignal("")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [skipTlsVerify, setSkipTlsVerify] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const urlHintId = createUniqueId()
  // prototype-1236: an OpenCode address has one action and no TLS override (verified HTTPS only).
  const openCode = () => isOpenCodeServerAddress(baseUrl())
  const defaultName = () => defaultServerName(splitPairingLink(baseUrl())?.baseUrl ?? baseUrl())

  createEffect(() => {
    if (!props.open) return
    setName("")
    setBaseUrl("")
    setSkipTlsVerify(false)
    setError(null)
  })

  const submit = async (openWindow: boolean) => {
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      await props.onSubmit({ name: name(), baseUrl: baseUrl(), skipTlsVerify: skipTlsVerify() }, openWindow)
      props.onOpenChange(false)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-[1300] flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-lg p-6 flex flex-col gap-5" tabIndex={-1}>
            <Dialog.Title class="text-xl font-semibold text-primary">{t("folderSelection.servers.dialog.title")}</Dialog.Title>
            <label class="flex flex-col gap-2 text-sm text-secondary">
              <span>{t("folderSelection.servers.dialog.name")}</span>
              <input class="selector-input w-full" value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder={defaultName()} />
            </label>
            <div class="flex flex-col gap-2 text-sm text-secondary">
              <label class="flex flex-col gap-2">
                <span>{t("folderSelection.servers.dialog.url")}</span>
                <input class="selector-input w-full" value={baseUrl()} onInput={(event) => setBaseUrl(event.currentTarget.value)} placeholder={t("folderSelection.servers.dialog.urlPlaceholder")} aria-describedby={urlHintId} />
              </label>
              <span id={urlHintId} class="text-xs">{t("folderSelection.servers.dialog.urlHint")}</span>
            </div>
            <Show when={!openCode()}>
              <label class="flex items-start gap-3 text-sm text-secondary">
                <input type="checkbox" checked={skipTlsVerify()} onChange={(event) => setSkipTlsVerify(event.currentTarget.checked)} />
                <span>{t("folderSelection.servers.dialog.skipTls")}</span>
              </label>
            </Show>
            <Show when={error()}>{(message) => <p class="text-sm text-red-500 break-words">{message()}</p>}</Show>
            <div class="flex items-center justify-end gap-3">
              <button type="button" class="selector-button selector-button-secondary w-auto px-4" onClick={() => props.onOpenChange(false)}>{t("folderSelection.servers.dialog.cancel")}</button>
              <Show when={!openCode()}>
                <button type="button" class="selector-button selector-button-secondary w-auto px-4" disabled={busy()} onClick={() => void submit(false)}>{t("folderSelection.servers.dialog.save")}</button>
              </Show>
              <button type="button" class="selector-button selector-button-secondary w-auto px-4" disabled={busy()} onClick={() => void submit(true)}>
                <Show when={busy()} fallback={<span>{t("folderSelection.servers.dialog.connect")}</span>}>
                  <span class="inline-flex items-center gap-2"><Loader2 class="w-4 h-4 animate-spin" />{t("folderSelection.servers.dialog.connecting")}</span>
                </Show>
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

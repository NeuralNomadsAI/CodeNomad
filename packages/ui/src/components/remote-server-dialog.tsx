import { Dialog } from "@kobalte/core/dialog"
import { Loader2 } from "lucide-solid"
import { createEffect, createSignal, createUniqueId, For, onCleanup, Show, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import type { RemoteServerInput } from "../lib/hooks/use-remote-server-profiles"
import { remoteServerErrorKey } from "../lib/hooks/use-remote-server-profiles"
import { classifyCodeNomadLink, carriesCredentials } from "../lib/codenomad-link"
import { captureRequestFocus } from "../lib/request-focus"
import { useConfig } from "../stores/preferences"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { serverApi } from "../lib/api-client"

interface RemoteServerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: RemoteServerInput, openWindow: boolean) => Promise<unknown>
  onEditSubmit?: (input: RemoteServerInput, current: () => boolean) => Promise<unknown>
  initial?: RemoteServerInput
}

export const RemoteServerDialog: Component<RemoteServerDialogProps> = (props) => {
  const config = useConfig()
  return <Show when={config.preferences().multiBackend === true && props.onEditSubmit} fallback={<LegacyRemoteServerDialog {...props} />}><ServerEditor {...props} /></Show>
}

const ServerEditor: Component<RemoteServerDialogProps> = (props) => {
  const { t } = useI18n()
  const config = useConfig()
  const [sshHost, setSshHost] = createSignal("")
  const [sshHosts, setSshHosts] = createSignal<string[]>([])
  const sshListId = createUniqueId()
  createEffect(() => {
    if (!props.open || config.preferences().multiBackend !== true) return
    let current = true
    const controller = new AbortController()
    onCleanup(() => { current = false; controller.abort() })
    setSshHosts([])
    void serverApi.listSshHosts(controller.signal).then(result => { if (current) setSshHosts(result.hosts) }).catch(() => {})
  })
  const [name, setName] = createSignal("")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [skipTlsVerify, setSkipTlsVerify] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const errorId = createUniqueId()
  let generation = 0, alive = true, returnFocus = true
  let opener: HTMLElement | undefined
  let releaseFocus = () => {}
  createEffect(() => {
    const initial = props.initial
    generation++
    releaseFocus()
    setBusy(false); setError(undefined)
    setName(props.open ? initial?.name ?? "" : "")
    setBaseUrl(props.open ? initial?.baseUrl ?? "" : "")
    setSkipTlsVerify(props.open ? initial?.skipTlsVerify ?? false : false)
    setSshHost(props.open ? initial?.ssh?.host ?? "" : "")
  })
  onCleanup(() => { alive = false; generation++; releaseFocus(); setBaseUrl("") })
  const submit = async () => {
    if (busy() || !props.open || config.preferences().multiBackend !== true) return
    if (!baseUrl().trim()) { setError("settings.servers.dialog.errorRequired"); return }
    if (carriesCredentials(baseUrl())) { setBaseUrl(""); setError("folderSelection.browseMenu.errorCredentials"); return }
    const link = classifyCodeNomadLink(baseUrl())
    if (!link) { setError("folderSelection.browseMenu.errorInvalid"); return }
    const flight = ++generation, initial = props.initial, focus = captureRequestFocus()
    releaseFocus = focus.dispose
    const current = () => alive && props.open && flight === generation && props.initial === initial && config.preferences().multiBackend === true
    const input = { id: initial?.id, name: name(), baseUrl: baseUrl(), skipTlsVerify: skipTlsVerify(),
      ...(sshHost().trim() ? { ssh: { host: sshHost().trim() } } : {}) }
    if (link.kind === "pairing") setBaseUrl("")
    setBusy(true); setError(undefined)
    try {
      if (props.onEditSubmit) await props.onEditSubmit(input, current)
      else await props.onSubmit(input, false)
      if (current()) { returnFocus = focus.retained(); props.onOpenChange(false) }
    } catch (failure) { if (current() && !(failure instanceof DOMException && failure.name === "AbortError")) setError(remoteServerErrorKey(failure)) }
    finally { focus.dispose(); if (current()) setBusy(false) }
  }
  const enter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing && event.target instanceof HTMLInputElement && event.target.type === "text") { event.preventDefault(); void submit() }
  }
  const close = (open: boolean) => { if (!open) { generation++; releaseFocus(); setBaseUrl(""); setBusy(false) }; props.onOpenChange(open) }
  const changed = () => { generation++; releaseFocus(); setBusy(false); setError(undefined) }
  return (
    <Dialog open={props.open} onOpenChange={close}>
      <Dialog.Portal><Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-[1300] flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-lg flex flex-col max-h-[90dvh]" tabIndex={-1}
            onOpenAutoFocus={event => {
              opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
              event.preventDefault()
              if (event.target instanceof Element) event.target.querySelector<HTMLInputElement>('input[type="text"]')?.focus({ preventScroll: true })
            }}
            onCloseAutoFocus={event => {
              event.preventDefault()
              if (returnFocus && opener?.isConnected && (document.activeElement === document.body || event.target instanceof Node && event.target.contains(document.activeElement))) opener.focus()
              returnFocus = true
            }} onKeyDown={enter}>
            <div class="window-header"><Dialog.Title class="window-title">{t(props.initial?.id ? "folderSelection.remoteProject.edit" : "folderSelection.browseMenu.add")}</Dialog.Title></div>
            <div class="window-body flex flex-col gap-4">
              <div class="flex flex-col gap-2 text-sm text-secondary"><label class="flex flex-col gap-2">
                <span class="flex items-center gap-2">{t("settings.servers.dialog.url")}<SettingsInfoTip text={t("folderSelection.servers.dialog.urlHint")} /></span>
                <input type="text" class="selector-input w-full" dir="ltr" aria-label={t("settings.servers.dialog.url")}
                  aria-invalid={error() ? "true" : undefined} aria-describedby={error() ? errorId : undefined}
                  value={baseUrl()} onInput={event => {
                    changed()
                    const value = event.currentTarget.value
                    if (classifyCodeNomadLink(value)?.baseUrl !== classifyCodeNomadLink(baseUrl())?.baseUrl) setSkipTlsVerify(false)
                    setBaseUrl(value); setError(undefined)
                  }} placeholder={t("folderSelection.servers.dialog.urlPlaceholder")} />
              </label></div>
              <label class="flex flex-col gap-2 text-sm text-secondary"><span>{t("settings.servers.dialog.name")}</span>
                <input type="text" class="selector-input w-full" value={name()} onInput={event => { changed(); setName(event.currentTarget.value) }} placeholder={t("folderSelection.servers.dialog.namePlaceholder")} />
              </label>
              <label class="flex flex-col gap-2 text-sm text-secondary">
                <span class="flex items-center gap-2">{t("folderSelection.servers.dialog.sshHost")}<SettingsInfoTip text={t("folderSelection.servers.dialog.sshHint")} /></span>
                <input type="text" class="selector-input w-full" dir="ltr" aria-label={t("folderSelection.servers.dialog.sshHost")} value={sshHost()} list={sshListId}
                  onInput={event => { changed(); setSshHost(event.currentTarget.value); setSkipTlsVerify(false) }} />
                <datalist id={sshListId}><For each={sshHosts()}>{host => <option value={host} />}</For></datalist>
              </label>
              <label class="flex items-start gap-3 text-sm text-secondary">
                <input type="checkbox" aria-label={t("folderSelection.browseMenu.skipTls")} checked={skipTlsVerify()} onChange={event => { changed(); setSkipTlsVerify(event.currentTarget.checked) }} />
                <span>{t("folderSelection.browseMenu.skipTls")}</span><SettingsInfoTip text={t("settings.servers.dialog.skipTls")} />
              </label>
              <Show when={error()}>{key => <p id={errorId} class="server-add-field-error" role="alert">{t(key())}</p>}</Show>
            </div>
            <div class="window-footer">
              <button type="button" class="selector-button selector-button-secondary w-auto px-4" onClick={() => close(false)}>{t("folderSelection.servers.dialog.cancel")}</button>
              <button type="button" class="selector-button selector-button-secondary w-auto px-4" disabled={busy()} onClick={() => void submit()}>{t("folderSelection.servers.dialog.save")}</button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

const LegacyRemoteServerDialog: Component<RemoteServerDialogProps> = (props) => {
  const { t } = useI18n()
  const { preferences } = useConfig()
  const [sshHost, setSshHost] = createSignal("")
  const [sshHosts, setSshHosts] = createSignal<string[]>([])
  const sshListId = createUniqueId()
  const sshHintId = createUniqueId()
  const usesSsh = () => preferences().multiBackend && Boolean(sshHost().trim())
  const [name, setName] = createSignal("")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [skipTlsVerify, setSkipTlsVerify] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const urlHintId = createUniqueId()

  createEffect(() => {
    if (!props.open) return
    setName("")
    setBaseUrl("")
    setSkipTlsVerify(false)
    setSshHost("")
    setError(null)
  })

  createEffect(() => {
    if (!props.open || !preferences().multiBackend) return
    let current = true
    onCleanup(() => { current = false })
    setSshHosts([])
    void serverApi.listSshHosts().then(result => { if (current) setSshHosts(result.hosts) }).catch(() => {})
  })

  const submit = async (openWindow: boolean) => {
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      await props.onSubmit({ name: name(), baseUrl: baseUrl(), skipTlsVerify: skipTlsVerify(),
        ...(usesSsh() ? { ssh: { host: sshHost().trim() } } : {}) }, openWindow)
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
            <div>
              <Dialog.Title class="text-xl font-semibold text-primary">{t("folderSelection.servers.dialog.title")}</Dialog.Title>
              <Dialog.Description class="text-sm text-secondary mt-2">{t("folderSelection.servers.dialog.description")}</Dialog.Description>
            </div>
            <label class="flex flex-col gap-2 text-sm text-secondary">
              <span>{t("folderSelection.servers.dialog.name")}</span>
              <input class="selector-input w-full" value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder={t("folderSelection.servers.dialog.namePlaceholder")} />
            </label>
            <div class="flex flex-col gap-2 text-sm text-secondary">
              <label class="flex flex-col gap-2">
                <span>{t("folderSelection.servers.dialog.url")}</span>
                <input class="selector-input w-full" value={baseUrl()} onInput={(event) => setBaseUrl(event.currentTarget.value)} placeholder={t("folderSelection.servers.dialog.urlPlaceholder")} aria-describedby={urlHintId} />
              </label>
              <span id={urlHintId} class="text-xs">{t("folderSelection.servers.dialog.urlHint")}</span>
            </div>
            <Show when={preferences().multiBackend}>
              <label class="flex flex-col gap-2 text-sm text-secondary">
                <span>{t("folderSelection.servers.dialog.sshHost")}</span>
                <input class="selector-input w-full" value={sshHost()} onInput={event => setSshHost(event.currentTarget.value)} list={sshListId} aria-describedby={sshHintId} />
                <datalist id={sshListId}><For each={sshHosts()}>{host => <option value={host} />}</For></datalist>
                <span id={sshHintId} class="text-xs">{t("folderSelection.servers.dialog.sshHint")}</span>
              </label>
            </Show>
            <label class="flex items-start gap-3 text-sm text-secondary">
              <input type="checkbox" checked={skipTlsVerify()} onChange={(event) => setSkipTlsVerify(event.currentTarget.checked)} />
              <span>{t("folderSelection.servers.dialog.skipTls")}</span>
            </label>
            <Show when={error()}>{(message) => <p class="text-sm text-red-500 break-words">{message()}</p>}</Show>
            <div class="flex items-center justify-end gap-3">
              <button type="button" class="selector-button selector-button-secondary w-auto px-4" onClick={() => props.onOpenChange(false)}>{t("folderSelection.servers.dialog.cancel")}</button>
              <button type="button" class="selector-button selector-button-secondary w-auto px-4" disabled={busy()} onClick={() => void submit(false)}>{t("folderSelection.servers.dialog.save")}</button>
              <button type="button" class="selector-button selector-button-secondary w-auto px-4" disabled={busy() || usesSsh()} onClick={() => void submit(true)}>
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

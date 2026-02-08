import { Dialog } from "@kobalte/core/dialog"
import { Switch } from "@kobalte/core/switch"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { toDataURL } from "qrcode"
import { ExternalLink, Link2, Loader2, RefreshCw, Shield, Wifi } from "lucide-solid"
import type { NetworkAddress, ServerMeta } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { restartCli } from "../lib/native/cli"
import { preferences, setListeningMode } from "../stores/preferences"
import { showConfirmDialog } from "../stores/alerts"
import { getLogger } from "../lib/logger"
import { useI18n } from "../lib/i18n"
const log = getLogger("actions")


interface RemoteAccessOverlayProps {
  open: boolean
  onClose: () => void
}

export function RemoteAccessOverlay(props: RemoteAccessOverlayProps) {
  const { t } = useI18n()
  const [meta, setMeta] = createSignal<ServerMeta | null>(null)
  const [authStatus, setAuthStatus] = createSignal<{ authenticated: boolean; username?: string; passwordUserProvided?: boolean } | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [qrCodes, setQrCodes] = createSignal<Record<string, string>>({})
  const [expandedUrl, setExpandedUrl] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [passwordFormOpen, setPasswordFormOpen] = createSignal(false)
  const [passwordValue, setPasswordValue] = createSignal("")
  const [passwordConfirm, setPasswordConfirm] = createSignal("")
  const [passwordError, setPasswordError] = createSignal<string | null>(null)
  const [savingPassword, setSavingPassword] = createSignal(false)

  const addresses = createMemo<NetworkAddress[]>(() => meta()?.addresses ?? [])
  const currentMode = createMemo(() => meta()?.listeningMode ?? preferences().listeningMode)
  const allowExternalConnections = createMemo(() => currentMode() === "all")
  const displayAddresses = createMemo(() => {
    const list = addresses()
    if (!allowExternalConnections()) {
      return []
    }
    // Local URL is displayed separately; list only remote-friendly addresses.
    return list.filter((address) => address.scope !== "loopback")
  })

  const refreshMeta = async () => {
    setLoading(true)
    setError(null)
    setPasswordError(null)
    try {
      const [metaResult, authResult] = await Promise.all([serverApi.fetchServerMeta(), serverApi.fetchAuthStatus()])
      setMeta(metaResult)
      setAuthStatus(authResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    if (props.open) {
      void refreshMeta()
    }
  })

  const toggleExpanded = async (url: string) => {
    if (expandedUrl() === url) {
      setExpandedUrl(null)
      return
    }
    setExpandedUrl(url)
    if (!qrCodes()[url]) {
      try {
        const dataUrl = await toDataURL(url, { margin: 1, scale: 4 })
        setQrCodes((prev) => ({ ...prev, [url]: dataUrl }))
      } catch (err) {
        log.error("Failed to generate QR code", err)
      }
    }
  }

  const handleAllowConnectionsChange = async (checked: boolean) => {
    const allow = Boolean(checked)
    const targetMode: "local" | "all" = allow ? "all" : "local"
    if (targetMode === currentMode()) {
      return
    }

    const confirmed = await showConfirmDialog(t("remoteAccess.listeningMode.restartConfirm.message"), {
      title: allow ? t("remoteAccess.listeningMode.restartConfirm.title.all") : t("remoteAccess.listeningMode.restartConfirm.title.local"),
      variant: "warning",
      confirmLabel: t("remoteAccess.listeningMode.restartConfirm.confirmLabel"),
      cancelLabel: t("remoteAccess.listeningMode.restartConfirm.cancelLabel"),
    })

    if (!confirmed) {
      // Switch will revert automatically since `checked` is derived from store state
      return
    }

    setListeningMode(targetMode)
    const restarted = await restartCli()
    if (!restarted) {
      setError(t("remoteAccess.restart.errorManual"))
    } else {
      setMeta((prev) => (prev ? { ...prev, listeningMode: targetMode } : prev))
    }

    void refreshMeta()
  }

  const handleOpenUrl = (url: string) => {
    try {
      window.open(url, "_blank", "noopener,noreferrer")
    } catch (err) {
      log.error("Failed to open URL", err)
    }
  }

  const handleSubmitPassword = async () => {
    setPasswordError(null)

    const next = passwordValue()
    const confirm = passwordConfirm()

    if (next.trim().length < 8) {
      setPasswordError(t("remoteAccess.password.error.tooShort"))
      return
    }

    if (next !== confirm) {
      setPasswordError(t("remoteAccess.password.error.mismatch"))
      return
    }

    setSavingPassword(true)
    try {
      const result = await serverApi.setServerPassword(next)
      setAuthStatus({ authenticated: true, username: result.username, passwordUserProvided: result.passwordUserProvided })
      setPasswordValue("")
      setPasswordConfirm("")
      setPasswordFormOpen(false)
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingPassword(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      modal
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          props.onClose()
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay remote-overlay-backdrop" />
        <div class="remote-overlay">
          <Dialog.Content class="modal-surface remote-panel" tabIndex={-1}>
            <header class="remote-header">
              <div>
                <p class="remote-eyebrow">{t("remoteAccess.eyebrow")}</p>
                <h2 class="remote-title">{t("remoteAccess.title")}</h2>
                <p class="remote-subtitle">{t("remoteAccess.subtitle")}</p>
              </div>
              <button type="button" class="remote-close" onClick={props.onClose} aria-label={t("remoteAccess.close")}>
                ×
              </button>
            </header>

            <div class="remote-body">
              <section class="remote-section">
                <div class="remote-section-heading">
                  <div class="remote-section-title">
                    <Shield class="remote-icon" />
                    <div>
                      <p class="remote-label">{t("remoteAccess.sections.listeningMode.label")}</p>
                      <p class="remote-help">{t("remoteAccess.sections.listeningMode.help")}</p>
                    </div>
                  </div>
                  <button class="remote-refresh" type="button" onClick={() => void refreshMeta()} disabled={loading()}>
                    <RefreshCw class={`remote-icon ${loading() ? "remote-spin" : ""}`} />
                    <span class="remote-refresh-label">{t("remoteAccess.refresh")}</span>
                  </button>
                </div>

                <Switch
                  class="remote-toggle"
                  checked={allowExternalConnections()}
                  onChange={(nextChecked) => {
                    void handleAllowConnectionsChange(nextChecked)
                  }}
                >
                  <Switch.Input />
                  <Switch.Control class="remote-toggle-switch" data-checked={allowExternalConnections()}>
                    <span class="remote-toggle-state">{allowExternalConnections() ? t("remoteAccess.toggle.on") : t("remoteAccess.toggle.off")}</span>
                    <Switch.Thumb class="remote-toggle-thumb" />
                  </Switch.Control>
                  <div class="remote-toggle-copy">
                    <span class="remote-toggle-title">{t("remoteAccess.toggle.title")}</span>
                    <span class="remote-toggle-caption">
                      {allowExternalConnections() ? t("remoteAccess.toggle.caption.all") : t("remoteAccess.toggle.caption.local")}
                    </span>
                  </div>
                </Switch>
                <p class="remote-toggle-note">
                  {t("remoteAccess.toggle.note")}
                </p>
              </section>

              <section class="remote-section">
                <div class="remote-section-heading">
                  <div class="remote-section-title">
                    <Shield class="remote-icon" />
                    <div>
                      <p class="remote-label">{t("remoteAccess.sections.serverPassword.label")}</p>
                      <p class="remote-help">{t("remoteAccess.sections.serverPassword.help")}</p>
                    </div>
                  </div>
                </div>

                <Show
                  when={authStatus() && authStatus()!.authenticated}
                  fallback={<div class="remote-card">{t("remoteAccess.authStatus.unavailable")}</div>}
                >
                  <div class="remote-card">
                    <p class="remote-help">
                      {t("remoteAccess.username", { username: authStatus()!.username ?? "codenomad" })}
                    </p>
                    <p class="remote-help">
                      {authStatus()!.passwordUserProvided
                        ? t("remoteAccess.password.status.set")
                        : t("remoteAccess.password.status.unset")}
                    </p>

                    <div class="remote-actions" style={{ "justify-content": "flex-start", "margin-top": "12px" }}>
                      <button
                        class="remote-pill"
                        type="button"
                        onClick={() => {
                          setPasswordFormOpen(!passwordFormOpen())
                          setPasswordError(null)
                        }}
                      >
                        {passwordFormOpen()
                          ? t("remoteAccess.password.actions.cancel")
                          : authStatus()!.passwordUserProvided
                            ? t("remoteAccess.password.actions.change")
                            : t("remoteAccess.password.actions.set")}
                      </button>
                    </div>

                    <Show when={passwordFormOpen()}>
                      <div class="selector-input-group" style={{ "margin-top": "12px" }}>
                        <label class="text-sm font-medium text-secondary">{t("remoteAccess.password.form.newPassword")}</label>
                        <input
                          class="selector-input w-full"
                          type="password"
                          value={passwordValue()}
                          onInput={(event) => setPasswordValue(event.currentTarget.value)}
                          placeholder={t("remoteAccess.password.form.placeholder")}
                        />
                      </div>
                      <div class="selector-input-group" style={{ "margin-top": "10px" }}>
                        <label class="text-sm font-medium text-secondary">{t("remoteAccess.password.form.confirmPassword")}</label>
                        <input
                          class="selector-input w-full"
                          type="password"
                          value={passwordConfirm()}
                          onInput={(event) => setPasswordConfirm(event.currentTarget.value)}
                        />
                      </div>

                      <Show when={passwordError()}>
                        {(message) => <div class="remote-error" style={{ "margin-top": "10px" }}>{message()}</div>}
                      </Show>

                      <div class="remote-actions" style={{ "justify-content": "flex-start", "margin-top": "12px" }}>
                        <button
                          class="remote-pill"
                          type="button"
                          disabled={savingPassword()}
                          onClick={() => void handleSubmitPassword()}
                        >
                          {savingPassword() ? t("remoteAccess.password.save.saving") : t("remoteAccess.password.save.label")}
                        </button>
                      </div>
                    </Show>
                  </div>
                </Show>
              </section>

              <section class="remote-section">

                <div class="remote-section-heading">
                  <div class="remote-section-title">
                    <Wifi class="remote-icon" />
                    <div>
                      <p class="remote-label">{t("remoteAccess.sections.addresses.label")}</p>
                      <p class="remote-help">{t("remoteAccess.sections.addresses.help")}</p>
                    </div>
                  </div>
                </div>

                <Show when={!loading()} fallback={<div class="remote-card">{t("remoteAccess.addresses.loading")}</div>}>
                  <Show when={!error()} fallback={<div class="remote-error">{error()}</div>}>
                    <Show when={displayAddresses().length > 0} fallback={<div class="remote-card">{t("remoteAccess.addresses.none")}</div>}>
                      <div class="remote-address-list">
                        <Show when={meta()?.localUrl}>
                          {(url) => {
                            const value = () => url()
                            const expandedState = () => expandedUrl() === value()
                            const qr = () => qrCodes()[value()]
                            return (
                              <div class="remote-address">
                                <div class="remote-address-main">
                                  <div>
                                    <p class="remote-address-url">{value()}</p>
                                    <p class="remote-address-meta">{t("remoteAccess.address.scope.loopback")}</p>
                                  </div>
                                  <div class="remote-actions">
                                    <button class="remote-pill" type="button" onClick={() => handleOpenUrl(value())}>
                                      <ExternalLink class="remote-icon" />
                                      {t("remoteAccess.address.open")}
                                    </button>
                                    <button
                                      class="remote-pill"
                                      type="button"
                                      onClick={() => void toggleExpanded(value())}
                                      aria-expanded={expandedState()}
                                    >
                                      <Link2 class="remote-icon" />
                                      {expandedState() ? t("remoteAccess.address.hideQr") : t("remoteAccess.address.showQr")}
                                    </button>
                                  </div>
                                </div>
                                <Show when={expandedState()}>
                                  <div class="remote-qr">
                                    <Show when={qr()} fallback={<Loader2 class="remote-icon remote-spin" aria-hidden="true" />}>
                                      {(dataUrl) => (
                                        <img
                                          src={dataUrl()}
                                          alt={t("remoteAccess.address.qrAlt", { url: value() })}
                                          class="remote-qr-img"
                                        />
                                      )}
                                    </Show>
                                  </div>
                                </Show>
                              </div>
                            )
                          }}
                        </Show>
                        <For each={displayAddresses()}>
                          {(address) => {
                            const url = address.remoteUrl
                            const expandedState = () => expandedUrl() === url
                            const qr = () => qrCodes()[url]
                            const scopeLabel = () =>
                              address.scope === "external"
                                ? t("remoteAccess.address.scope.network")
                                : address.scope === "loopback"
                                  ? t("remoteAccess.address.scope.loopback")
                                  : t("remoteAccess.address.scope.internal")
                            return (
                              <div class="remote-address">
                                <div class="remote-address-main">
                                  <div>
                                    <p class="remote-address-url">{url}</p>
                                    <p class="remote-address-meta">
                                      {address.family.toUpperCase()} • {scopeLabel()} • {address.ip}
                                    </p>
                                  </div>
                                  <div class="remote-actions">
                                    <button class="remote-pill" type="button" onClick={() => handleOpenUrl(url)}>
                                      <ExternalLink class="remote-icon" />
                                      {t("remoteAccess.address.open")}
                                    </button>
                                    <button
                                      class="remote-pill"
                                      type="button"
                                      onClick={() => void toggleExpanded(url)}
                                      aria-expanded={expandedState()}
                                    >
                                      <Link2 class="remote-icon" />
                                      {expandedState() ? t("remoteAccess.address.hideQr") : t("remoteAccess.address.showQr")}
                                    </button>
                                  </div>
                                </div>
                                <Show when={expandedState()}>
                                  <div class="remote-qr">
                                    <Show when={qr()} fallback={<Loader2 class="remote-icon remote-spin" aria-hidden="true" />}>
                                      {(dataUrl) => (
                                        <img
                                          src={dataUrl()}
                                          alt={t("remoteAccess.address.qrAlt", { url })}
                                          class="remote-qr-img"
                                        />
                                      )}
                                    </Show>
                                  </div>
                                </Show>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </section>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

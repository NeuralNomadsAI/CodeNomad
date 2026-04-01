import { Switch } from "@kobalte/core/switch"
import { For, Show, createMemo, createSignal, type Component, onMount } from "solid-js"
import { toDataURL } from "qrcode"
import { ChevronDown, ExternalLink, Link2, Loader2, RefreshCw, Shield, Wifi } from "lucide-solid"
import type { NetworkAddress, ServerMeta } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { restartCli } from "../../lib/native/cli"
import { serverSettings, setListeningMode } from "../../stores/preferences"
import { showConfirmDialog } from "../../stores/alerts"
import { getLogger } from "../../lib/logger"
import { useI18n } from "../../lib/i18n"
import { splitRemoteAddresses, type RemoteAddressGroups } from "../../lib/remote-access-addresses"

const log = getLogger("actions")

export const RemoteAccessSettingsSection: Component = () => {
  const { t } = useI18n()
  const [meta, setMeta] = createSignal<ServerMeta | null>(null)
  const [authStatus, setAuthStatus] = createSignal<{
    authenticated: boolean
    username?: string
    passwordUserProvided?: boolean
  } | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [applyingListeningMode, setApplyingListeningMode] = createSignal(false)
  const [qrCodes, setQrCodes] = createSignal<Record<string, string>>({})
  const [expandedUrl, setExpandedUrl] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [passwordFormOpen, setPasswordFormOpen] = createSignal(false)
  const [passwordValue, setPasswordValue] = createSignal("")
  const [passwordConfirm, setPasswordConfirm] = createSignal("")
  const [passwordError, setPasswordError] = createSignal<string | null>(null)
  const [savingPassword, setSavingPassword] = createSignal(false)
  const [showAllAddresses, setShowAllAddresses] = createSignal(false)

  const addresses = createMemo<NetworkAddress[]>(() => meta()?.addresses ?? [])
  const currentMode = createMemo(() => meta()?.listeningMode ?? serverSettings().listeningMode)
  const allowExternalConnections = createMemo(() => currentMode() === "all")
  const displayAddresses = createMemo<RemoteAddressGroups>(() => {
    const list = addresses()
    if (!allowExternalConnections()) return { recommended: null, hidden: [] }
    return splitRemoteAddresses(list)
  })

  const refreshMeta = async () => {
    setLoading(true)
    setError(null)
    setPasswordError(null)
    try {
      const [metaResult, authResult] = await Promise.all([serverApi.fetchServerMeta(), serverApi.fetchAuthStatus()])
      setMeta(metaResult)
      setAuthStatus(authResult)
      setShowAllAddresses(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void refreshMeta()
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
    const targetMode: "local" | "all" = checked ? "all" : "local"
    if (targetMode === currentMode() || applyingListeningMode()) return

    const confirmed = await showConfirmDialog(t("remoteAccess.listeningMode.restartConfirm.message"), {
      title: checked
        ? t("remoteAccess.listeningMode.restartConfirm.title.all")
        : t("remoteAccess.listeningMode.restartConfirm.title.local"),
      variant: "warning",
      confirmLabel: t("remoteAccess.listeningMode.restartConfirm.confirmLabel"),
      cancelLabel: t("remoteAccess.listeningMode.restartConfirm.cancelLabel"),
    })

    if (!confirmed) return

    setApplyingListeningMode(true)
    setError(null)
    try {
      await setListeningMode(targetMode)
      const restarted = await restartCli()
      if (!restarted) {
        setError(t("remoteAccess.restart.errorManual"))
      } else {
        setMeta((prev) => (prev ? { ...prev, listeningMode: targetMode } : prev))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplyingListeningMode(false)
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
      setAuthStatus({
        authenticated: true,
        username: result.username,
        passwordUserProvided: result.passwordUserProvided,
      })
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
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Shield class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("remoteAccess.sections.listeningMode.label")}</h3>
              <p class="settings-card-subtitle">{t("remoteAccess.sections.listeningMode.help")}</p>
            </div>
          </div>
          <div class="settings-toolbar-inline">
            <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
            <button
              class="selector-button selector-button-secondary w-auto"
              type="button"
              onClick={() => void refreshMeta()}
              disabled={loading()}
            >
              <RefreshCw class={`w-4 h-4 ${loading() ? "remote-spin" : ""}`} />
              <span>{t("remoteAccess.refresh")}</span>
            </button>
          </div>
        </div>

        <Switch
          class="remote-toggle"
          checked={allowExternalConnections()}
          onChange={(nextChecked) => void handleAllowConnectionsChange(nextChecked)}
          disabled={loading() || applyingListeningMode()}
        >
          <Switch.Input />
          <Switch.Control class="remote-toggle-switch" data-checked={allowExternalConnections()}>
            <span class="remote-toggle-state">
              {allowExternalConnections() ? t("remoteAccess.toggle.on") : t("remoteAccess.toggle.off")}
            </span>
            <Switch.Thumb class="remote-toggle-thumb" />
          </Switch.Control>
          <div class="remote-toggle-copy">
            <span class="remote-toggle-title">{t("remoteAccess.toggle.title")}</span>
            <span class="remote-toggle-caption">
              {allowExternalConnections()
                ? t("remoteAccess.toggle.caption.all")
                : t("remoteAccess.toggle.caption.local")}
            </span>
          </div>
        </Switch>

        <p class="remote-toggle-note">{t("remoteAccess.toggle.note")}</p>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Shield class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("remoteAccess.sections.serverPassword.label")}</h3>
              <p class="settings-card-subtitle">{t("remoteAccess.sections.serverPassword.help")}</p>
            </div>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>

        <Show
          when={authStatus() && authStatus()!.authenticated}
          fallback={<div class="settings-card-message">{t("remoteAccess.authStatus.unavailable")}</div>}
        >
          <div class="settings-card-content">
                <p class="settings-help-text">{t("remoteAccess.username", { username: authStatus()!.username ?? "codenomad" })}</p>
                <p class="settings-help-text">
                  {authStatus()!.passwordUserProvided
                    ? t("remoteAccess.password.status.set")
                    : t("remoteAccess.password.status.unset")}
                </p>

                <div class="settings-password-actions">
                  <button
                    class="settings-pill-button"
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
                  <div class="settings-form-group">
                    <label class="settings-form-label">{t("remoteAccess.password.form.newPassword")}</label>
                    <input
                      class="selector-input w-full"
                      type="password"
                      value={passwordValue()}
                      onInput={(event) => setPasswordValue(event.currentTarget.value)}
                      placeholder={t("remoteAccess.password.form.placeholder")}
                    />
                  </div>
                  <div class="settings-form-group">
                    <label class="settings-form-label">{t("remoteAccess.password.form.confirmPassword")}</label>
                    <input
                      class="selector-input w-full"
                      type="password"
                      value={passwordConfirm()}
                      onInput={(event) => setPasswordConfirm(event.currentTarget.value)}
                    />
                  </div>

                  <Show when={passwordError()}>
                    {(message) => <div class="settings-error-message">{message()}</div>}
                  </Show>

                  <div class="settings-password-actions">
                    <button class="settings-pill-button" type="button" disabled={savingPassword()} onClick={() => void handleSubmitPassword()}>
                      {savingPassword() ? t("remoteAccess.password.save.saving") : t("remoteAccess.password.save.label")}
                    </button>
                  </div>
                </Show>
          </div>
        </Show>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Wifi class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("remoteAccess.sections.addresses.label")}</h3>
              <p class="settings-card-subtitle">{t("remoteAccess.sections.addresses.help")}</p>
            </div>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>

        <Show when={!loading()} fallback={<div class="remote-card">{t("remoteAccess.addresses.loading")}</div>}>
          <Show when={!error()} fallback={<div class="remote-error">{error()}</div>}>
            <Show
              when={Boolean(displayAddresses().recommended) || meta()?.localUrl}
              fallback={<div class="remote-card">{t("remoteAccess.addresses.none")}</div>}
            >
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

                <Show when={displayAddresses().recommended}>
                  {(addressAccessor) => {
                    const address = addressAccessor()
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
                              {address.family.toUpperCase()} - {scopeLabel()} - {address.ip}
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
                </Show>

                <Show when={displayAddresses().hidden.length > 0}>
                  <div class="remote-address-disclosure" data-expanded={showAllAddresses()}>
                    <button
                      class="remote-address-disclosure-trigger"
                      type="button"
                      onClick={() => setShowAllAddresses(!showAllAddresses())}
                      aria-expanded={showAllAddresses()}
                    >
                      <span class="remote-address-disclosure-label">
                        {showAllAddresses()
                          ? t("remoteAccess.addresses.actions.hideOther")
                          : t("remoteAccess.addresses.actions.showOther", { count: String(displayAddresses().hidden.length) })}
                      </span>
                      <ChevronDown class={`remote-address-disclosure-chevron ${showAllAddresses() ? "is-expanded" : ""}`} />
                    </button>

                    <Show when={showAllAddresses()}>
                      <div class="remote-address-disclosure-content">
                        <For each={displayAddresses().hidden}>
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
                                    {address.family.toUpperCase()} - {scopeLabel()} - {address.ip}
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
                                      <img src={dataUrl()} alt={t("remoteAccess.address.qrAlt", { url })} class="remote-qr-img" />
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
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

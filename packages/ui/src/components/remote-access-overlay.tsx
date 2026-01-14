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
const log = getLogger("actions")


interface RemoteAccessOverlayProps {
  open: boolean
  onClose: () => void
}

export function RemoteAccessOverlay(props: RemoteAccessOverlayProps) {
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
    if (allowExternalConnections()) {
      return list.filter((address) => address.scope !== "loopback")
    }
    return list.filter((address) => address.scope === "loopback")
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

    const confirmed = await showConfirmDialog("Restart to apply listening mode? This will stop all running instances.", {
      title: allow ? "Open to other devices" : "Limit to this device",
      variant: "warning",
      confirmLabel: "Restart now",
      cancelLabel: "Cancel",
    })

    if (!confirmed) {
      // Switch will revert automatically since `checked` is derived from store state
      return
    }

    setListeningMode(targetMode)
    const restarted = await restartCli()
    if (!restarted) {
      setError("Unable to restart automatically. Please restart the app to apply the change.")
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
      setPasswordError("Password must be at least 8 characters.")
      return
    }

    if (next !== confirm) {
      setPasswordError("Passwords do not match.")
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
                <p class="remote-eyebrow">Remote handover</p>
                <h2 class="remote-title">Connect to CodeNomad remotely</h2>
                <p class="remote-subtitle">Use the addresses below to open CodeNomad from another device.</p>
              </div>
              <button type="button" class="remote-close" onClick={props.onClose} aria-label="Close remote access">
                ×
              </button>
            </header>

            <div class="remote-body">
              <section class="remote-section">
                <div class="remote-section-heading">
                  <div class="remote-section-title">
                    <Shield class="remote-icon" />
                    <div>
                      <p class="remote-label">Listening mode</p>
                      <p class="remote-help">Allow or limit remote handovers by binding to all interfaces or just localhost.</p>
                    </div>
                  </div>
                  <button class="remote-refresh" type="button" onClick={() => void refreshMeta()} disabled={loading()}>
                    <RefreshCw class={`remote-icon ${loading() ? "remote-spin" : ""}`} />
                    <span class="remote-refresh-label">Refresh</span>
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
                    <span class="remote-toggle-state">{allowExternalConnections() ? "On" : "Off"}</span>
                    <Switch.Thumb class="remote-toggle-thumb" />
                  </Switch.Control>
                  <div class="remote-toggle-copy">
                    <span class="remote-toggle-title">Allow connections from other IPs</span>
                    <span class="remote-toggle-caption">
                      {allowExternalConnections() ? "Binding to 0.0.0.0" : "Binding to 127.0.0.1"}
                    </span>
                  </div>
                </Switch>
                <p class="remote-toggle-note">
                  Changing this requires a restart and temporarily stops all active instances. Share the addresses below once the
                  server restarts.
                </p>
              </section>

              <section class="remote-section">
                <div class="remote-section-heading">
                  <div class="remote-section-title">
                    <Shield class="remote-icon" />
                    <div>
                      <p class="remote-label">Server password</p>
                      <p class="remote-help">Remote handovers require a password. Set a memorable one to enable logins from other devices.</p>
                    </div>
                  </div>
                </div>

                <Show
                  when={authStatus() && authStatus()!.authenticated}
                  fallback={<div class="remote-card">Authentication status unavailable.</div>}
                >
                  <div class="remote-card">
                    <p class="remote-help">Username: {authStatus()!.username ?? "codenomad"}</p>
                    <p class="remote-help">
                      {authStatus()!.passwordUserProvided
                        ? "A password is set for remote access."
                        : "No memorable password is set yet. Set one to allow remote handover logins."}
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
                          ? "Cancel"
                          : authStatus()!.passwordUserProvided
                            ? "Change password"
                            : "Set password"}
                      </button>
                    </div>

                    <Show when={passwordFormOpen()}>
                      <div class="selector-input-group" style={{ "margin-top": "12px" }}>
                        <label class="text-sm font-medium text-secondary">New password</label>
                        <input
                          class="selector-input w-full"
                          type="password"
                          value={passwordValue()}
                          onInput={(event) => setPasswordValue(event.currentTarget.value)}
                          placeholder="At least 8 characters"
                        />
                      </div>
                      <div class="selector-input-group" style={{ "margin-top": "10px" }}>
                        <label class="text-sm font-medium text-secondary">Confirm password</label>
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
                          {savingPassword() ? "Saving…" : "Save password"}
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
                      <p class="remote-label">Reachable addresses</p>
                      <p class="remote-help">Launch or scan from another machine to hand over control.</p>
                    </div>
                  </div>
                </div>

                <Show when={!loading()} fallback={<div class="remote-card">Loading addresses…</div>}>
                  <Show when={!error()} fallback={<div class="remote-error">{error()}</div>}>
                    <Show when={displayAddresses().length > 0} fallback={<div class="remote-card">No addresses available yet.</div>}>
                      <div class="remote-address-list">
                        <For each={displayAddresses()}>
                          {(address) => {
                            const expandedState = () => expandedUrl() === address.url
                            const qr = () => qrCodes()[address.url]
                            return (
                              <div class="remote-address">
                                <div class="remote-address-main">
                                  <div>
                                    <p class="remote-address-url">{address.url}</p>
                                    <p class="remote-address-meta">
                                      {address.family.toUpperCase()} • {address.scope === "external" ? "Network" : address.scope === "loopback" ? "Loopback" : "Internal"} • {address.ip}
                                    </p>
                                  </div>
                                  <div class="remote-actions">
                                    <button class="remote-pill" type="button" onClick={() => handleOpenUrl(address.url)}>
                                      <ExternalLink class="remote-icon" />
                                      Open
                                    </button>
                                    <button
                                      class="remote-pill"
                                      type="button"
                                      onClick={() => void toggleExpanded(address.url)}
                                      aria-expanded={expandedState()}
                                    >
                                      <Link2 class="remote-icon" />
                                      {expandedState() ? "Hide QR" : "Show QR"}
                                    </button>
                                  </div>
                                </div>
                                <Show when={expandedState()}>
                                  <div class="remote-qr">
                                    <Show when={qr()} fallback={<Loader2 class="remote-icon remote-spin" aria-hidden="true" />}>
                                      {(dataUrl) => <img src={dataUrl()} alt={`QR for ${address.url}`} class="remote-qr-img" />}
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

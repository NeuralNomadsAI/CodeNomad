import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { toDataURL } from "qrcode"
import { Copy, Link2, Loader2, MonitorUp, RefreshCw, ShieldCheck, Unplug } from "lucide-solid"
import type { RemoteControlDevice, RemoteControlPairing, RemoteControlStatus } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { getLogger } from "../../lib/logger"
import { SettingsSwitch } from "./settings-switch"

const log = getLogger("actions")
// Only while the tunnel is (re)connecting, e.g. when it resumes at launch.
const CONNECTING_POLL_MS = 3_000

export const RemoteControlSettingsSection: Component = () => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<RemoteControlStatus | null>(null)
  const [pairing, setPairing] = createSignal<RemoteControlPairing | null>(null)
  const [qrCode, setQrCode] = createSignal<string | null>(null)
  const [devices, setDevices] = createSignal<RemoteControlDevice[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal(false)
  let pairingExpiry: ReturnType<typeof setTimeout> | undefined

  const clearPairing = () => {
    clearTimeout(pairingExpiry)
    setPairing(null)
    setQrCode(null)
  }

  const load = async () => {
    const next = await serverApi.fetchRemoteControlStatus()
    setStatus(next)
    // The server cancels the code when Remote Control turns off; a reconnect keeps it valid.
    if (!next.enabled) clearPairing()
    // Paired devices stay listed, and revocable, while Remote Control is off.
    setDevices(next.manageable ? (await serverApi.fetchRemoteControlDevices()).devices : [])
  }

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      await load()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setLoading(false)
    }
  }

  const connecting = createMemo(() => status()?.state === "connecting" || status()?.state === "reconnecting")
  createEffect(() => {
    if (!connecting()) return
    const timer = setInterval(() => void load().catch(() => undefined), CONNECTING_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(() => clearTimeout(pairingExpiry))

  const showPairing = async (next: RemoteControlPairing) => {
    clearTimeout(pairingExpiry)
    pairingExpiry = setTimeout(clearPairing, Math.max(0, Date.parse(next.expiresAt) - Date.now()))
    setPairing(next)
    setQrCode(null)
    try {
      setQrCode(await toDataURL(next.url, { margin: 1, scale: 5 }))
    } catch (cause) {
      log.warn("Failed to generate Remote Control QR code", cause)
    }
  }

  const start = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await serverApi.startRemoteControl()
      setStatus(result.status)
      await showPairing(result.pairing)
      const deviceResult = await serverApi.fetchRemoteControlDevices()
      setDevices(deviceResult.devices)
    } catch (cause) {
      const failure = message(cause)
      await refresh()
      setError(failure)
    } finally {
      setLoading(false)
    }
  }

  const stop = async () => {
    setLoading(true)
    setError(null)
    try {
      setStatus(await serverApi.stopRemoteControl())
      clearPairing()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setLoading(false)
    }
  }

  const stopButton = () => (
    <button class="selector-button selector-button-secondary w-auto" type="button" onClick={() => void stop()} disabled={loading()}>
      <Unplug class="w-4 h-4" />
      {t("remoteControl.stop")}
    </button>
  )

  const setPreviews = async (enabled: boolean) => {
    setError(null)
    try {
      setStatus(await serverApi.setRemoteControlPreviews(enabled))
    } catch (cause) {
      setError(message(cause))
    }
  }

  const createPairing = async () => {
    setLoading(true)
    setError(null)
    try {
      await showPairing(await serverApi.createRemoteControlPairing())
    } catch (cause) {
      setError(message(cause))
    } finally {
      setLoading(false)
    }
  }

  const copyPairing = async () => {
    const url = pairing()?.url
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2_000)
    } catch (cause) {
      setError(message(cause))
    }
  }

  const revoke = async (id: string) => {
    setError(null)
    try {
      await serverApi.revokeRemoteControlDevice(id)
      setDevices((current) => current.filter((device) => device.id !== id))
    } catch (cause) {
      setError(message(cause))
    }
  }

  onMount(() => void refresh())

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <MonitorUp class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("remoteControl.title")}</h3>
              <p class="settings-card-subtitle">{t("remoteControl.description")}</p>
            </div>
          </div>
          <div class="settings-toolbar-inline remote-control-toolbar">
            <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
            <button class="window-icon-button disabled:opacity-50 disabled:cursor-not-allowed" type="button"
              aria-label={t("remoteControl.refresh")} title={t("remoteControl.refresh")} onClick={() => void refresh()} disabled={loading()}>
              <RefreshCw class={`w-4 h-4 ${loading() ? "remote-spin" : ""}`} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div class="remote-control-status" data-state={status()?.state ?? "stopped"}>
          <span class="remote-control-status-dot" aria-hidden="true" />
          <div>
            <strong>{t(`remoteControl.state.${status()?.state ?? "stopped"}`)}</strong>
            <p>
              {status()?.manageable === false
                ? t("remoteControl.status.hostOnly")
                : status()?.remoteUrl ?? t("remoteControl.status.localOnly")}
            </p>
          </div>
        </div>

        <Show when={status()?.manageable !== false}>
          <div class="remote-control-actions">
            <Show
              when={status()?.enabled}
              fallback={
                <>
                  <button class="selector-button selector-button-primary w-auto" type="button" onClick={() => void start()} disabled={loading()}>
                    <Link2 class="w-4 h-4" />
                    {t("remoteControl.start")}
                  </button>
                  {/* A failed resume stays on for the next launch until it is stopped. */}
                  <Show when={status()?.startsOnLaunch && status()?.state === "error"}>{stopButton()}</Show>
                </>
              }
            >
              <button class="selector-button selector-button-primary w-auto" type="button" onClick={() => void createPairing()} disabled={loading() || status()?.state !== "connected"}>
                <Link2 class="w-4 h-4" />
                {t("remoteControl.newLink")}
              </button>
              {stopButton()}
            </Show>
          </div>
        </Show>

        <Show when={status()?.manageable ? status() : null}>
          {(current) => (
            <div class="settings-toggle-row">
              <div>
                <div class="settings-toggle-title">{t("remoteControl.previews.title")}</div>
                <div class="settings-toggle-caption">{t("remoteControl.previews.caption")}</div>
              </div>
              <SettingsSwitch
                checked={current().previews}
                label={t("remoteControl.previews.title")}
                disabled={loading()}
                onChange={(enabled) => void setPreviews(enabled)}
              />
            </div>
          )}
        </Show>

        <Show when={error()}>{(value) => <div class="settings-error-message">{value()}</div>}</Show>
      </div>

      <Show when={pairing()}>
        {(value) => (
          <div class="settings-card remote-control-pairing">
            <div>
              <h3 class="settings-card-title">{t("remoteControl.pairing.title")}</h3>
              <p class="settings-card-subtitle">{t("remoteControl.pairing.description")}</p>
            </div>
            <Show when={qrCode()} fallback={<Loader2 class="remote-control-qr-loading remote-spin" />}>
              {(source) => <img class="remote-control-qr" src={source()} alt={t("remoteControl.pairing.qrAlt")} />}
            </Show>
            <code class="remote-control-link">{value().url}</code>
            <button class="selector-button selector-button-secondary w-auto" type="button" onClick={() => void copyPairing()}>
              <Copy class="w-4 h-4" />
              {copied() ? t("remoteControl.pairing.copied") : t("remoteControl.pairing.copy")}
            </button>
            <p class="settings-help-text">{t("remoteControl.pairing.expires", { time: new Date(value().expiresAt).toLocaleTimeString() })}</p>
          </div>
        )}
      </Show>

      <Show when={status()?.manageable}>
        <div class="settings-card">
          <div class="settings-card-header">
            <div class="settings-card-heading-with-icon">
              <ShieldCheck class="settings-card-heading-icon" />
              <div>
                <h3 class="settings-card-title">{t("remoteControl.devices.title")}</h3>
                <p class="settings-card-subtitle">{t("remoteControl.devices.description")}</p>
              </div>
            </div>
          </div>
          <Show when={devices().length > 0} fallback={<div class="settings-card-message">{t("remoteControl.devices.empty")}</div>}>
            <div class="remote-control-devices">
              <For each={devices()}>
                {(device) => (
                  <div class="remote-control-device">
                    <div>
                      <strong>{device.name}</strong>
                      <p>{t("remoteControl.devices.lastSeen", { time: new Date(device.lastSeenAt).toLocaleString() })}</p>
                    </div>
                    <button class="selector-button selector-button-secondary w-auto" type="button" onClick={() => void revoke(device.id)}>
                      {t("remoteControl.devices.revoke")}
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

import { For, Show, createSignal, onMount, type Component } from "solid-js"
import { toDataURL } from "qrcode"
import { Copy, Link2, Loader2, MonitorUp, RefreshCw, ShieldCheck, Unplug } from "lucide-solid"
import type { RemoteControlDevice, RemoteControlPairing, RemoteControlStatus } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { getLogger } from "../../lib/logger"

const log = getLogger("actions")

export const RemoteControlSettingsSection: Component = () => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<RemoteControlStatus | null>(null)
  const [pairing, setPairing] = createSignal<RemoteControlPairing | null>(null)
  const [qrCode, setQrCode] = createSignal<string | null>(null)
  const [devices, setDevices] = createSignal<RemoteControlDevice[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal(false)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await serverApi.fetchRemoteControlStatus()
      setStatus(next)
      if (next.manageable && next.enabled && next.state === "connected") {
        const result = await serverApi.fetchRemoteControlDevices()
        setDevices(result.devices)
      } else {
        setDevices([])
      }
    } catch (cause) {
      setError(message(cause))
    } finally {
      setLoading(false)
    }
  }

  const showPairing = async (next: RemoteControlPairing) => {
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
      setPairing(null)
      setQrCode(null)
      setDevices([])
    } catch (cause) {
      setError(message(cause))
    } finally {
      setLoading(false)
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
          <button class="selector-button selector-button-secondary w-auto" type="button" onClick={() => void refresh()} disabled={loading()}>
            <RefreshCw class={`w-4 h-4 ${loading() ? "remote-spin" : ""}`} />
            <span>{t("remoteControl.refresh")}</span>
          </button>
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
                <button class="selector-button w-auto" type="button" onClick={() => void start()} disabled={loading()}>
                  <Link2 class="w-4 h-4" />
                  {t("remoteControl.start")}
                </button>
              }
            >
              <button class="selector-button w-auto" type="button" onClick={() => void createPairing()} disabled={loading() || status()?.state !== "connected"}>
                <Link2 class="w-4 h-4" />
                {t("remoteControl.newLink")}
              </button>
              <button class="selector-button selector-button-secondary w-auto" type="button" onClick={() => void stop()} disabled={loading()}>
                <Unplug class="w-4 h-4" />
                {t("remoteControl.stop")}
              </button>
            </Show>
          </div>
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

      <Show when={status()?.manageable !== false && status()?.enabled}>
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

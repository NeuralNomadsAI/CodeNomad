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
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
const log = getLogger("actions")


interface RemoteAccessOverlayProps {
  open: boolean
  onClose: () => void
}

export function RemoteAccessOverlay(props: RemoteAccessOverlayProps) {
  const [meta, setMeta] = createSignal<ServerMeta | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [qrCodes, setQrCodes] = createSignal<Record<string, string>>({})
  const [expandedUrl, setExpandedUrl] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

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
    try {
      const result = await serverApi.fetchServerMeta()
      setMeta(result)
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
        <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 backdrop-blur-md" />
        <div class="fixed inset-0 z-[41] flex items-center justify-center p-6">
          <Dialog.Content class="rounded-lg shadow-2xl flex flex-col bg-background text-foreground w-full max-w-[960px] max-h-[90vh] overflow-hidden" tabIndex={-1}>
            <header class="flex items-start justify-between gap-3 px-6 py-5 border-b border-border">
              <div>
                <p class="uppercase tracking-widest text-xs text-muted-foreground mb-1">Remote handover</p>
                <h2 class="text-xl font-semibold text-foreground">Connect to Era Code remotely</h2>
                <p class="mt-1 text-sm text-muted-foreground">Use the addresses below to open Era Code from another device.</p>
              </div>
              <button
                type="button"
                class="border border-border bg-secondary text-foreground rounded-full px-2.5 py-1.5 cursor-pointer text-lg leading-none"
                onClick={props.onClose}
                aria-label="Close remote access"
              >
                x
              </button>
            </header>

            <div class="px-6 py-4 overflow-y-auto flex flex-col gap-4">
              <section class="border border-border rounded-xl bg-secondary p-4">
                <div class="flex items-center justify-between gap-3 mb-3">
                  <div class="flex items-center gap-2.5">
                    <Shield class="w-[18px] h-[18px]" />
                    <div>
                      <p class="font-semibold text-foreground">Listening mode</p>
                      <p class="text-[13px] text-muted-foreground">Allow or limit remote handovers by binding to all interfaces or just localhost.</p>
                    </div>
                  </div>
                  <button
                    class="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-border bg-background text-foreground cursor-pointer"
                    type="button"
                    onClick={() => void refreshMeta()}
                    disabled={loading()}
                  >
                    <RefreshCw class={cn("w-[18px] h-[18px]", loading() && "animate-spin")} />
                    <span class="hidden sm:inline">Refresh</span>
                  </button>
                </div>

                <Switch
                  class="relative flex items-center gap-3 p-3 rounded-xl border border-border bg-background cursor-pointer"
                  checked={allowExternalConnections()}
                  onChange={(nextChecked) => {
                    void handleAllowConnectionsChange(nextChecked)
                  }}
                >
                  <Switch.Input />
                  <Switch.Control
                    class={cn(
                      "w-[58px] h-7 rounded-full border inline-flex items-center justify-between px-2 transition-colors text-xs font-semibold uppercase tracking-wide",
                      allowExternalConnections()
                        ? "bg-info border-info text-primary-foreground"
                        : "bg-secondary border-border text-muted-foreground",
                    )}
                    data-checked={allowExternalConnections()}
                  >
                    <span class="pointer-events-none whitespace-nowrap">{allowExternalConnections() ? "On" : "Off"}</span>
                    <Switch.Thumb class="w-[18px] h-[18px] rounded-full bg-background transition-transform" />
                  </Switch.Control>
                  <div class="flex flex-col gap-0.5">
                    <span class="font-semibold text-foreground">Allow connections from other IPs</span>
                    <span class="text-[13px] text-muted-foreground">
                      {allowExternalConnections() ? "Binding to 0.0.0.0" : "Binding to 127.0.0.1"}
                    </span>
                  </div>
                </Switch>
                <p class="mt-3 text-[13px] text-muted-foreground">
                  Changing this requires a restart and temporarily stops all active instances. Share the addresses below once the
                  server restarts.
                </p>
              </section>

              <section class="border border-border rounded-xl bg-secondary p-4">
                <div class="flex items-center justify-between gap-3 mb-3">
                  <div class="flex items-center gap-2.5">
                    <Wifi class="w-[18px] h-[18px]" />
                    <div>
                      <p class="font-semibold text-foreground">Reachable addresses</p>
                      <p class="text-[13px] text-muted-foreground">Launch or scan from another machine to hand over control.</p>
                    </div>
                  </div>
                </div>

                <Show when={!loading()} fallback={<div class="border border-dashed border-border rounded-lg p-3 text-muted-foreground">Loading addresses...</div>}>
                  <Show when={!error()} fallback={<div class="border border-destructive rounded-lg p-3 bg-destructive/10 text-foreground">{error()}</div>}>
                    <Show when={displayAddresses().length > 0} fallback={<div class="border border-dashed border-border rounded-lg p-3 text-muted-foreground">No addresses available yet.</div>}>
                      <div class="flex flex-col gap-2.5">
                        <For each={displayAddresses()}>
                          {(address) => {
                            const expandedState = () => expandedUrl() === address.url
                            const qr = () => qrCodes()[address.url]
                            return (
                              <div class="border border-border rounded-xl p-3 bg-background">
                                <div class="flex items-center justify-between gap-3 flex-wrap">
                                  <div>
                                    <p class="font-semibold text-foreground">{address.url}</p>
                                    <p class="mt-1 text-xs text-muted-foreground">
                                      {address.family.toUpperCase()} -- {address.scope === "external" ? "Network" : address.scope === "loopback" ? "Loopback" : "Internal"} -- {address.ip}
                                    </p>
                                  </div>
                                  <div class="flex gap-2">
                                    <button
                                      class="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-full border border-border bg-secondary text-foreground cursor-pointer"
                                      type="button"
                                      onClick={() => handleOpenUrl(address.url)}
                                    >
                                      <ExternalLink class="w-[18px] h-[18px]" />
                                      Open
                                    </button>
                                    <button
                                      class="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-full border border-border bg-secondary text-foreground cursor-pointer"
                                      type="button"
                                      onClick={() => void toggleExpanded(address.url)}
                                      aria-expanded={expandedState()}
                                    >
                                      <Link2 class="w-[18px] h-[18px]" />
                                      {expandedState() ? "Hide QR" : "Show QR"}
                                    </button>
                                  </div>
                                </div>
                                <Show when={expandedState()}>
                                  <div class="mt-3 flex items-center justify-center p-3 border border-dashed border-border rounded-lg bg-secondary">
                                    <Show when={qr()} fallback={<Loader2 class="w-[18px] h-[18px] animate-spin" aria-hidden="true" />}>
                                      {(dataUrl) => <img src={dataUrl()} alt={`QR for ${address.url}`} class="w-40 h-40" style={{ "image-rendering": "pixelated" }} />}
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

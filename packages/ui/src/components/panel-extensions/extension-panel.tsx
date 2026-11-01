import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { PanelExtensionContext, PanelExtensionSummary } from "../../../../server/src/api-types"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { useI18n } from "../../lib/i18n"
import { PANEL_EXTENSION_SANDBOX, panelExtensionDocument } from "./frame-document"
import { useAssetsChannel } from "./assets-channel"
import { useWorkItemsChannel } from "./work-items-channel"
import { useApi4Channel, type Api4Host } from "./api4-channel"
import { resolveCssColor } from "../../lib/css-color"

export function ExtensionPanel(props: {
  entry: PanelExtensionSummary; instanceId: string; active: boolean; context: PanelExtensionContext; host: Api4Host
}) {
  const identity = createMemo(() => props.active ? JSON.stringify([props.instanceId, props.entry.digest, props.context.sessionId]) : null)
  return <Show keyed when={identity()}>{_identity => <PanelFrame entry={props.entry} instanceId={props.instanceId} context={props.context} host={props.host} />}</Show>
}

function PanelFrame(props: { entry: PanelExtensionSummary; instanceId: string; context: PanelExtensionContext; host: Api4Host }) {
  const { t } = useI18n()
  const [document, setDocument] = createSignal<string>()
  const [failed, setFailed] = createSignal(false)
  let frame: HTMLIFrameElement | undefined, port: MessagePort | undefined, disposed = false, initialized = false
  let authenticated = false
  const handshake = crypto.randomUUID()
  const controller = new AbortController()
  const send = (value: unknown) => { if (!disposed && authenticated) port?.postMessage(value) }
  const authority = { instanceId: props.instanceId, id: props.entry.manifest.id, digest: props.entry.digest, send }
  // Each API version carries exactly its own capabilities; API 4 only those its manifest declares.
  const manifest = props.entry.manifest
  const api4 = manifest.apiVersion === 4 ? useApi4Channel({ ...authority, permissions: manifest.permissions,
    sessionId: props.context.sessionId, host: props.host, mounted: () => !disposed && authenticated && props.entry.digest === authority.digest }) : undefined
  const receive = manifest.apiVersion === 2 ? useAssetsChannel({ ...authority, sessionId: () => props.context.sessionId })
    : manifest.apiVersion === 3 ? useWorkItemsChannel(authority)
      : api4 ?? (() => {})
  void panelExtensionsApi.panel(props.instanceId, manifest.id, props.entry.digest, controller.signal).then(result => {
    if (!disposed) setDocument(panelExtensionDocument(result.html, handshake, manifest.apiVersion, manifest.permissions))
  }).catch(() => { if (!disposed) setFailed(true) })
  const publish = () => {
    const style = getComputedStyle(globalThis.document.documentElement)
    const colors = Object.fromEntries(Object.entries({ background: "--surface-secondary", text: "--text-primary",
      muted: "--text-muted", border: "--border-base", focus: "--focus-ring-color" }).map(([key, token]) => [key, style.getPropertyValue(token).trim()]))
    // The canvas role is a color-mix(); frames receive a concrete colour.
    colors.surface = resolveCssColor("--surface-canvas")
    const context = { ...props.context, apiVersion: props.entry.manifest.apiVersion,
      ...(props.entry.manifest.apiVersion >= 2 ? { colors } : {}) }
    if (authenticated) port?.postMessage({ type: "context", context })
  }
  createEffect(publish)
  const palette = new MutationObserver(publish)
  palette.observe(globalThis.document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "data-color-scheme"] })
  onCleanup(() => palette.disconnect())
  onCleanup(() => { disposed = true; api4?.dispose(); controller.abort(); port?.close() })
  const loaded = () => {
    // Never reconnect the capability channel after self-navigation/reload.
    if (initialized) { authenticated = false; api4?.dispose(); port?.close(); setDocument(undefined); setFailed(true); return }
    initialized = true
    const channel = new MessageChannel()
    port = channel.port1
    port.onmessage = event => {
      if (!disposed && !authenticated && event.data?.type === "ready" && event.data.handshake === handshake) { authenticated = true; publish() }
      else if (!disposed && authenticated) void receive(event.data)
    }
    frame?.contentWindow?.postMessage({ type: "codenomad:init" }, "*", [channel.port2])
  }
  return <div class="panel-extension-surface">
    <Show when={failed()}><p role="status">{t("panelExtensions.error")}</p></Show>
    <Show when={document()}>{source => <iframe ref={frame} title={props.entry.manifest.name} srcdoc={source()}
      sandbox={PANEL_EXTENSION_SANDBOX} referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      onLoad={loaded} />}</Show>
  </div>
}

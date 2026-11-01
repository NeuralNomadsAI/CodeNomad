import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { PanelExtensionContext, PanelExtensionSummary } from "../../../../server/src/api-types"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { useI18n } from "../../lib/i18n"
import { PANEL_EXTENSION_SANDBOX, panelExtensionDocument } from "./frame-document"
import { useAssetsChannel } from "./assets-channel"
import { useWorkItemsChannel } from "./work-items-channel"
import { useApi4Channel, type Api4Host } from "./api4-channel"
import { resolveCssColor } from "../../lib/css-color"
import { createBundlesManagement } from "./bundles-management"
import { BundlesConfirmationView } from "./bundles-confirmation"
import type { BundlesConfirmation } from "../../lib/bundles-private-events"

export function ExtensionPanel(props: {
  entry: PanelExtensionSummary; instanceId: string; active: boolean; context: PanelExtensionContext; host: Api4Host
  registerReload?: (reload: (() => void) | undefined) => void
}) {
  const [generation, setGeneration] = createSignal(0)
  const identity = createMemo(() => props.active ? JSON.stringify([props.instanceId, props.entry.digest, props.context.sessionId, generation()]) : null)
  return <Show keyed when={identity()}>{_identity => <PanelFrame entry={props.entry} instanceId={props.instanceId} context={props.context} host={props.host}
    registerReload={props.registerReload} remount={() => setGeneration(value => value + 1)} />}</Show>
}

function PanelFrame(props: { entry: PanelExtensionSummary; instanceId: string; context: PanelExtensionContext; host: Api4Host
  registerReload?: (reload: (() => void) | undefined) => void; remount(): void }) {
  const { t } = useI18n()
  const [document, setDocument] = createSignal<string>()
  const [failed, setFailed] = createSignal(false)
  const [confirmation, setConfirmation] = createSignal<BundlesConfirmation>()
  let frame: HTMLIFrameElement | undefined, port: MessagePort | undefined, disposed = false, initialized = false
  let authenticated = false
  const handshake = crypto.randomUUID()
  const controller = new AbortController()
  const send = (value: unknown) => { if (!disposed && authenticated) port?.postMessage(value) }
  const authority = { instanceId: props.instanceId, id: props.entry.manifest.id, digest: props.entry.digest, send }
  // Each API version carries exactly its own capabilities; API 4 only those its manifest declares.
  const manifest = props.entry.manifest
  const management = manifest.apiVersion === 4 && manifest.permissions.includes("bundles.manage") ? createBundlesManagement({
    ...authority, sessionID: props.context.sessionId, current: () => !disposed && authenticated && (props.host.activeSessionId() ?? null) === props.context.sessionId,
    show: setConfirmation,
  }) : undefined
  const api4 = manifest.apiVersion === 4 ? useApi4Channel({ ...authority, permissions: manifest.permissions,
    sessionId: props.context.sessionId, host: props.host, management, mounted: () => !disposed && authenticated && props.entry.digest === authority.digest }) : undefined
  if (management) {
    let reloading = false
    props.registerReload?.(() => {
      if (reloading) return
      reloading = true; setFailed(false)
      void management.userRemount(() => api4?.current() === true).then(() => { if (!disposed) props.remount() })
        .catch(() => { if (!disposed) setFailed(true) }).finally(() => { reloading = false })
    })
    onCleanup(() => props.registerReload?.(undefined))
  }
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
      if (!disposed && !authenticated && event.data?.type === "ready" && event.data.handshake === handshake) {
        authenticated = true; publish(); void management?.mount().catch(() => {})
      }
      else if (!disposed && authenticated) void receive(event.data)
    }
    frame?.contentWindow?.postMessage({ type: "codenomad:init" }, "*", [channel.port2])
  }
  return <div class="panel-extension-surface">
    <Show when={confirmation()} keyed>{view => <BundlesConfirmationView view={view}
      displayed={management!.displayed} confirm={management!.confirm} cancel={management!.cancel} />}</Show>
    <Show when={failed()}><p role="status">{t("panelExtensions.error")}</p></Show>
    <Show when={document()}>{source => <iframe ref={frame} title={props.entry.manifest.name} srcdoc={source()}
      sandbox={PANEL_EXTENSION_SANDBOX} referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      onLoad={loaded} />}</Show>
  </div>
}

import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { PanelExtensionContext, PanelExtensionSummary } from "../../../../server/src/api-types"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { useI18n } from "../../lib/i18n"
import { PANEL_EXTENSION_SANDBOX, panelExtensionDocument } from "./frame-document"

export function ExtensionPanel(props: {
  entry: PanelExtensionSummary; instanceId: string; active: boolean; context: PanelExtensionContext
}) {
  const identity = createMemo(() => props.active ? JSON.stringify([props.instanceId, props.entry.digest, props.context.sessionId]) : null)
  return <Show keyed when={identity()}>{_identity => <PanelFrame entry={props.entry} instanceId={props.instanceId} context={props.context} />}</Show>
}

function PanelFrame(props: { entry: PanelExtensionSummary; instanceId: string; context: PanelExtensionContext }) {
  const { t } = useI18n()
  const [document, setDocument] = createSignal<string>()
  const [failed, setFailed] = createSignal(false)
  let frame: HTMLIFrameElement | undefined, port: MessagePort | undefined, disposed = false, initialized = false
  let authenticated = false
  const handshake = crypto.randomUUID()
  const controller = new AbortController()
  void panelExtensionsApi.panel(props.instanceId, props.entry.manifest.id, props.entry.digest, controller.signal).then(result => {
    if (!disposed) setDocument(panelExtensionDocument(result.html, handshake))
  }).catch(() => { if (!disposed) setFailed(true) })
  const publish = () => { const context = { ...props.context }; if (authenticated) port?.postMessage({ type: "context", context }) }
  createEffect(publish)
  onCleanup(() => { disposed = true; controller.abort(); port?.close() })
  const loaded = () => {
    // Never reconnect the capability channel after self-navigation/reload.
    if (initialized) { authenticated = false; port?.close(); setDocument(undefined); setFailed(true); return }
    initialized = true
    const channel = new MessageChannel()
    port = channel.port1
    port.onmessage = event => {
      if (!disposed && !authenticated && event.data?.type === "ready" && event.data.handshake === handshake) { authenticated = true; publish() }
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

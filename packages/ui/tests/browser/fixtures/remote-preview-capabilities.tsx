import { For, Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { SessionPreviewView } from "../../../src/components/session-preview-view"
import { I18nProvider } from "../../../src/lib/i18n"
import { ConfigProvider } from "../../../src/stores/preferences"
import { createRemoteBackendClient, registerBackendClient, localBackend } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import { openSessionPreview, getSessionPreview, restoreSessionPreview, showSessionPreview } from "../../../src/stores/session-previews"
import { attachInstanceTabMembership, detachInstanceTabMembership } from "../../../src/stores/app-tab-membership"
import "../../../src/index.css"

localBackend.api.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
localBackend.api.fetchStateOwner = async () => ({}) as any
const [ready, setReady] = createSignal(false)
const clients = ["a", "b"].map(id => createRemoteBackendClient(id, { bindRelayAuthority: true }))
const detach = new Map<string, () => void>()
async function open(id: string) {
  const restored = await restoreSessionPreview("same-session", `${id}~/same`, `${id}~same-workspace`)
  if (restored) showSessionPreview(restored.storageKey)
  else await openSessionPreview("same-session", "http://app.invalid/start", `${id}~/same`, `${id}~same-workspace`)
}
async function start() {
  for (const client of clients) {
    const response = await client.fetch(client.url("/api/meta"))
    if (!client.admitRelayAuthority?.(response.headers.get("x-codenomad-backend-authority"))) throw new Error("Missing proof")
    registerBackendClient(client)
    detach.set(client.id, backendEvents.attach(client.id, client.events))
    attachInstanceTabMembership(`${client.id}~same-workspace`)
    await open(client.id)
  }
  setReady(true)
}
render(() => <ConfigProvider><I18nProvider>
  <Show when={ready()}><For each={["a", "b"]}>{id =>
    <section data-owner={id} style={{ height: "420px", display: "flex", "flex-direction": "column" }}>
      <Show when={getSessionPreview("same-session", `${id}~/same`)}>{preview =>
        <SessionPreviewView preview={preview()} onInsertComment={() => {}} />
      }</Show>
    </section>
  }</For></Show>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).remotePreviews = {
  open,
  detach: (id: string) => detach.get(id)?.(),
  closeTab: (id: string) => detachInstanceTabMembership(`${id}~same-workspace`),
  history: (id: string) => getSessionPreview("same-session", `${id}~/same`)?.history,
  source: (id: string) => getSessionPreview("same-session", `${id}~/same`)?.contentUrl,
}
void start()

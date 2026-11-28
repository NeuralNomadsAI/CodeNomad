import { For, Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { SessionPreviewHost, SessionPreviewSlot } from "../../../src/components/session-preview-view"
import { I18nProvider } from "../../../src/lib/i18n"
import { ConfigProvider } from "../../../src/stores/preferences"
import { createRemoteBackendClient, registerBackendClient, localBackend } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import { openSessionPreview, getSessionPreview, restoreSessionPreview, showSessionPreview } from "../../../src/stores/session-previews"
import { attachInstanceTabMembership, detachInstanceTabMembership } from "../../../src/stores/app-tab-membership"
import { addInstance } from "../../../src/stores/instances"
import { publishInstanceLifecycleAuthority } from "../../../src/stores/instance-lifecycle-authority"
import { getSessionSurface } from "../../../src/stores/session-surface"
import { alertDialogState } from "../../../src/stores/alerts"
import "../../../src/index.css"

localBackend.api.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
localBackend.api.fetchStateOwner = async () => ({}) as any
const [ready, setReady] = createSignal(false)
const [active, setActive] = createSignal("a")
const clients = ["a", "b"].map(id => createRemoteBackendClient(id, { bindRelayAuthority: true }))
const detach = new Map<string, () => void>()
async function open(id: string) {
  const restored = await restoreSessionPreview("same-session", `${id}~same-workspace`)
  if (restored) showSessionPreview("same-session", `${id}~same-workspace`)
  else await openSessionPreview("same-session", "http://app.invalid/start", `${id}~same-workspace`)
}
async function start() {
  for (const client of clients) {
    const response = await client.fetch(client.url("/api/meta"))
    if (!client.admitRelayAuthority?.(response.headers.get("x-codenomad-backend-authority"))) throw new Error("Missing proof")
    registerBackendClient(client)
    detach.set(client.id, backendEvents.attach(client.id, client.events))
    addInstance({ id: `${client.id}~same-workspace`, backendId: client.id, folder: "/same",
      status: "ready", client: null, proxyPath: "", port: 0, pid: 0 })
    attachInstanceTabMembership(`${client.id}~same-workspace`)
    publishInstanceLifecycleAuthority({ type: "opened", instanceId: `${client.id}~same-workspace`,
      backendId: client.id, folder: "/same", occurrence: 0 })
    await open(client.id)
  }
  setReady(true)
}
render(() => <ConfigProvider><I18nProvider>
  <Show when={ready()}><For each={["a", "b"]}>{id =>
    <section class="session-shell-frame" style={{ height: "420px", display: "flex", "flex-direction": "column" }}>
      <SessionPreviewSlot sessionId="same-session" instanceId={`${id}~same-workspace`}
        active={active() === id && getSessionSurface({ instanceId: `${id}~same-workspace`, sessionId: "same-session" }).kind === "web"}
        onInsertComment={() => {}} />
    </section>
  }</For></Show>
  <SessionPreviewHost />
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).remotePreviews = {
  open,
  select: setActive,
  detach: (id: string) => detach.get(id)?.(),
  closeTab: (id: string) => {
    detachInstanceTabMembership(`${id}~same-workspace`)
    publishInstanceLifecycleAuthority({ type: "removed", instanceId: `${id}~same-workspace`, backendId: id, folder: "/same", occurrence: 0 })
  },
  history: (id: string) => getSessionPreview("same-session", `${id}~same-workspace`)?.history,
  source: (id: string) => getSessionPreview("same-session", `${id}~same-workspace`)?.contentUrl,
  alert: () => alertDialogState()?.detail ?? null,
}
void start()

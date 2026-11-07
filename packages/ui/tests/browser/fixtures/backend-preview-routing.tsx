import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { Markdown } from "../../../src/components/markdown"
import { SessionPreviewView } from "../../../src/components/session-preview-view"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { backends, createBackendClient, localBackend, type BackendClient } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import { addInstance } from "../../../src/stores/instances"
import { getServerMeta } from "../../../src/lib/server-meta"
import { getSessionPreview } from "../../../src/stores/session-previews"
import "../../../src/index.css"

const calls: { owner: string; url: string; method: string; body?: any }[] = []
let token = 0, generation = 1, held: "meta" | "preview" | undefined
const pending: (() => void)[] = []
const wait = async (phase: typeof held) => { if (held === phase) await new Promise<void>(resolve => pending.push(resolve)) }
localBackend.api.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
localBackend.api.fetchStateOwner = async () => ({}) as any
localBackend.api.fetchServerMeta = async () => {
  calls.push({ owner: "local", url: "/api/meta", method: "GET" })
  return { serverVersion: "host-version", previewsUnavailable: false } as any
}
localBackend.api.createPreview = async body => {
  calls.push({ owner: "local", url: "/api/previews", method: "POST", body })
  return { token: `local-${++token}`, sessionId: body.sessionId, targetUrl: body.url, proxyUrl: `/previews/local-${token}/app?q=1#hash`, createdAt: "" }
}
localBackend.api.deletePreview = async token => { calls.push({ owner: "local", url: `/api/previews/${token}`, method: "DELETE" }) }
const remote = createBackendClient({ id: "preview_remote", baseUrl: "https://preview.example.invalid/tenant/", fetcher: async (input, init) => {
  const url = String(input), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined
  calls.push({ owner: "remote", url, method, body })
  if (url.endsWith("/api/meta")) {
    const admitted = generation
    await wait("meta")
    return Response.json({ serverVersion: `remote-${admitted}`, previewsUnavailable: admitted === 1 })
  }
  if (method === "DELETE") return Response.json({})
  const number = ++token
  await wait("preview")
  return Response.json({ token: `remote-${number}`, sessionId: body.sessionId, targetUrl: body.url,
    proxyUrl: `/previews/remote-${number}/app?q=1#hash`, createdAt: "" })
} })
const registry = backends as Map<string, BackendClient>
registry.set(remote.id, remote)
let detach = backendEvents.attach(remote.id, remote.events)
const [remoteId, setRemoteId] = createSignal("preview_remote~same")
for (const [id, backendId] of [["same", undefined], [remoteId(), remote.id]] as const) {
  addInstance({ id, backendId, folder: "/same", port: 0, pid: 0, proxyPath: "/workspaces/same/instance", status: "ready" } as any)
}
const [hostVersion, setHostVersion] = createSignal("")
function Consumer(props: { id: string; scope: string }) {
  const preview = () => getSessionPreview("session", props.scope)
  return <>
    <Markdown instanceId={props.id} sessionId="session" disableHighlight part={{ id: "link", type: "text", text: "[App](http://localhost:3000/app?q=1#hash)" } as any} />
    <Show when={preview()}>{value => <SessionPreviewView preview={value()} onInsertComment={() => {}} />}</Show>
  </>
}
render(() => <ConfigProvider><I18nProvider>
  <output data-host-version>{hostVersion()}</output>
  <section data-owner="local" style={{ height: "500px", display: "flex", "flex-direction": "column" }}><Consumer id="same" scope="/same" /></section>
  <section data-owner="remote" style={{ height: "500px", display: "flex", "flex-direction": "column" }}><Consumer id={remoteId()} scope="preview_remote~/same" /></section>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).previewRouting = {
  calls,
  get pending() { return pending.length },
  hold: (phase: typeof held) => { held = phase },
  release: () => { held = undefined; pending.splice(0).forEach(resolve => resolve()) },
  releaseOne: () => pending.shift()?.(),
  detach: () => detach(),
  reattach: () => { generation++; detach = backendEvents.attach(remote.id, remote.events) },
  missing: () => { detach(); registry.delete(remote.id); setRemoteId("preview_remote~missing") },
  hostMeta: async () => setHostVersion((await getServerMeta()).serverVersion),
}

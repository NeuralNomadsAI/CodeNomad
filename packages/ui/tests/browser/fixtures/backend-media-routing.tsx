import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { ToolOutputImages } from "../../../src/components/tool-call/output-images"
import { Markdown } from "../../../src/components/markdown"
import MessageItem from "../../../src/components/message-item"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { backends, createBackendClient, createRemoteBackendClient, localBackend, type BackendClient } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import "../../../src/index.css"

const canvas = document.createElement("canvas")
canvas.width = 8; canvas.height = 8
canvas.getContext("2d")!.fillRect(0, 0, 8, 8)
const data = canvas.toDataURL("image/png")
const bytes = Uint8Array.from(atob(data.split(",")[1]), char => char.charCodeAt(0))
const calls: { url: string; credentials?: RequestCredentials; signal?: AbortSignal }[] = []
const plainCalls: { url: string; credentials?: RequestCredentials }[] = []
const plainFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => { plainCalls.push({ url: String(input), credentials: init?.credentials }); return plainFetch(input, init) }
const created: string[] = [], revoked: string[] = [], downloads: string[] = []
const createdTypes: string[] = []
const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = blob => { const url = create(blob); created.push(url); createdTypes.push(blob instanceof Blob ? blob.type : ""); return url }
URL.revokeObjectURL = url => { revoked.push(url); revoke(url) }
HTMLAnchorElement.prototype.click = function () { downloads.push(this.href) }
let held: "fetch" | "blob" | undefined
const pending: (() => void)[] = []
const wait = async (phase: typeof held) => { if (held === phase) await new Promise<void>(resolve => pending.push(resolve)) }
const relay = new URLSearchParams(location.search).has("relay")
const fetcher: typeof fetch = async (input, init) => {
  calls.push({ url: String(input), credentials: init?.credentials, signal: init?.signal ?? undefined })
  await wait("fetch")
  const response = new Response(bytes, { headers: { "Content-Type": "image/png" } })
  response.blob = async () => { await wait("blob"); return new Blob([bytes], { type: "image/png" }) }
  return response
}
const remote = relay ? createRemoteBackendClient("lab", { fetcher }) : createBackendClient({ id: "lab", baseUrl: "https://media.example.invalid", fetcher })
const registry = backends as Map<string, BackendClient>
registry.set("lab", remote)
remote.api.fetchServerMeta = async () => ({}) as any
let detach = backendEvents.attach("lab", remote.events)
localBackend.api.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
localBackend.api.fetchStateOwner = async () => ({}) as any
const [remoteId, setRemoteId] = createSignal("lab~same")
const [version, setVersion] = createSignal("a")
const [visible, setVisible] = createSignal(true)
const [external, setExternal] = createSignal<string>()
const [localSource, setLocalSource] = createSignal<string>()
const [localHtml, setLocalHtml] = createSignal(false)
const raw = '<img src="/api/media-probe.png" alt="root"><img src="./media-probe.png" alt="dot"><img src="../media-probe.png" alt="parent">'
const path = (kind: string) => `/api/workspaces/same/session-media/session/message/0/${["tool", "markdown", "attachment"].indexOf(kind)}/${version().repeat(64)}`
const source = (id: string, kind: string) => (id.startsWith("lab~") ? external() : localSource()) ?? path(kind)
function seed(id: string) {
  messageStoreBus.getOrCreate(id).hydrateMessages("session", [{ id: "read", sessionId: "session", role: "assistant", status: "complete",
    parts: [{ id: "tool", type: "tool", name: "read", state: { status: "completed", input: { filePath: "C:/Exact/image.png" },
      content: [{ type: "file", mime: "image/png", name: "C:/Exact/image.png", uri: source(id, "markdown") }] } } as any] }])
}
seed("same"); seed("lab~same")
const record = { id: "user", sessionId: "session", role: "user", status: "complete", createdAt: 1, updatedAt: 1, revision: 1, partIds: [], parts: {} } as const
function Consumers(props: { id: string }) {
  return <>
    <Show when={relay && (props.id !== "same" || localHtml())}><div data-consumer="html"><Markdown instanceId={props.id} sessionId="session" part={{ id: "raw", type: "text", text: raw }} escapeRawHtml disableHighlight /></div></Show>
    <div data-consumer="tool"><ToolOutputImages instanceId={props.id} state={{ status: "completed", input: {}, content: [
      { type: "file", mime: "image/png", name: "tool.png", uri: source(props.id, "tool") },
    ] } as any} /></div>
    <div data-consumer="markdown"><Markdown instanceId={props.id} sessionId="session" part={{ id: "answer", type: "text", text: "![Markdown](C:/Exact/image.png)" } as any} /></div>
    <div data-consumer="attachment"><MessageItem record={record as any} instanceId={props.id} sessionId="session" technicalCleanupParts={() => []}
      parts={[{ id: "attachment", type: "file", mime: "image/png", filename: "attachment.png", url: source(props.id, "attachment") } as any]} /></div>
  </>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={visible()}>
  <section data-owner="local"><Consumers id="same" /></section>
  <section data-owner="remote"><Consumers id={remoteId()} /></section>
</Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).media = {
  calls, plainCalls, created, createdTypes, revoked, downloads, data, path,
  get pending() { return pending.length },
  hold: (phase: typeof held) => { held = phase },
  release: () => { held = undefined; pending.splice(0).forEach(resolve => resolve()) },
  replace: () => { setVersion(version() === "a" ? "b" : "a"); seed("same"); seed(remoteId()) },
  detach: () => detach(),
  reattach: () => { detach = backendEvents.attach("lab", remote.events) },
  missing: () => { detach(); registry.delete("lab"); setRemoteId("lab~missing"); seed("lab~missing") },
  unmount: () => setVisible(false),
  remount: () => setVisible(true),
  localHtml: () => setLocalHtml(true),
  external: (url: string) => { calls.length = 0; setExternal(url); seed(remoteId()) },
  local: (url: string) => { setLocalSource(url); seed("same") },
}

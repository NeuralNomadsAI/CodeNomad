import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ToolOutputImages } from "../../../src/components/tool-call/output-images"
import { Markdown } from "../../../src/components/markdown"
import MessageItem from "../../../src/components/message-item"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { backends, createBackendClient, localBackend, type BackendClient } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { resolveLocalImages } from "../../../src/lib/markdown-local-images"
import "../../../src/index.css"

const canvas = document.createElement("canvas")
canvas.width = 8; canvas.height = 8
const data = canvas.toDataURL("image/png")
const png = Uint8Array.from(atob(data.split(",")[1]), char => char.charCodeAt(0))
let body: BlobPart = png, declared = "image/png", transferred = 0, holdSignature = false, backendCalls = 0
const dataCalls: { credentials?: RequestCredentials }[] = []
const plainFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  if (String(input).startsWith("data:")) dataCalls.push({ credentials: init?.credentials })
  return plainFetch(input, init)
}
const pending: (() => void)[] = []
const created: { url: string; type: string }[] = []
const create = URL.createObjectURL.bind(URL)
URL.createObjectURL = blob => { const url = create(blob); created.push({ url, type: (blob as Blob).type }); return url }
const client = createBackendClient({ id: "security", baseUrl: "https://media.example.invalid", fetcher: async () => {
  backendCalls++
  const blob = new Blob([body], { type: declared })
  const arrayBuffer = blob.arrayBuffer.bind(blob)
  blob.arrayBuffer = async () => {
    if (holdSignature) await new Promise<void>(resolve => pending.push(resolve))
    return arrayBuffer()
  }
  const response = new Response(null, { headers: { "Content-Type": declared, "Content-Security-Policy": "sandbox; default-src 'none'" } })
  response.blob = async () => { transferred++; return blob }
  return response
} })
;(backends as Map<string, BackendClient>).set("security", client)
const detach = backendEvents.attach("security", client.events)
localBackend.api.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
localBackend.api.fetchStateOwner = async () => ({}) as any
const [version, setVersion] = createSignal(0), [override, setOverride] = createSignal<string>()
const markdownOverride = new URLSearchParams(location.search).has("public-markdown") ? "https://public.example.invalid/image.png" : undefined
const source = (remote: boolean, index: number) => remote
  ? (index === 1 ? markdownOverride : undefined) ?? override() ?? `/api/workspaces/same/session-media/s/m/0/${index}/${String(version() % 10).repeat(64)}` : data
function seed() {
  for (const [id, remote] of [["same", false], ["security~same", true]] as const) {
    messageStoreBus.getOrCreate(id).hydrateMessages("s", [{ id: "read", sessionId: "s", role: "assistant", status: "complete", parts: [
      { id: "tool", type: "tool", name: "read", state: { status: "completed", input: { filePath: "C:/Exact/image.png" },
        content: [{ type: "file", mime: "image/png", name: "C:/Exact/image.png", uri: source(remote, 1) }] } } as any,
    ] }])
  }
}
seed()
const record = { id: "user", sessionId: "s", role: "user", status: "complete", createdAt: 1, updatedAt: 1, revision: 1, partIds: [], parts: {} } as const
function Consumers(props: { remote: boolean }) {
  const id = props.remote ? "security~same" : "same"
  return <section data-owner={props.remote ? "remote" : "local"}>
    <div data-consumer="tool"><ToolOutputImages instanceId={id} state={{ status: "completed", input: {}, content: [
      { type: "file", mime: "image/png", name: "tool.png", uri: source(props.remote, 0) },
    ] } as any} /></div>
    <div data-consumer="markdown"><Markdown instanceId={id} sessionId="s" part={{ id: "answer", type: "text", text: "[![Markdown](C:/Exact/image.png)](https://example.invalid/open)" } as any} /></div>
    <div data-consumer="attachment"><MessageItem record={record as any} instanceId={id} sessionId="s" technicalCleanupParts={() => []}
      parts={[{ id: "attachment", type: "file", mime: "image/png", filename: "attachment.png", url: source(props.remote, 2) } as any]} /></div>
  </section>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Consumers remote={false} /><Consumers remote={true} /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).security = {
  created, data, png: [...png], detach, dataCalls,
  get backendCalls() { return backendCalls },
  get transferred() { return transferred }, get pending() { return pending.length },
  configure: (payload: number[] | string, type: string, inline?: string) => {
    body = typeof payload === "string" ? payload : new Uint8Array(payload)
    declared = type; transferred = 0; setOverride(inline); setVersion(version() + 1); seed()
  },
  hold: () => { holdSignature = true },
  release: () => { holdSignature = false; pending.splice(0).forEach(resolve => resolve()) },
  resolveExisting: () => {
    const container = document.querySelector('[data-owner="remote"] [data-consumer="markdown"]')!
    const source = document.querySelector<HTMLImageElement>('[data-owner="remote"] [data-consumer="tool"] img')!.src
    resolveLocalImages(container, [{ paths: ["C:/Exact/image.png"], source }], true)
  },
}
